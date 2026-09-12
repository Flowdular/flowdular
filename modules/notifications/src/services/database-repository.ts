import type {
	DatabaseHandle,
	DatabaseParameter,
	DatabaseRow,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import type {
	DeliveryAttempt,
	DeliveryChannel,
	DeliveryRouting,
	DeliveryStatus,
	MemberNotificationSettings,
	NotificationKind,
	NotificationPreference,
	NotificationsInbox,
	NotificationsInboxStatus,
	WebhookSubscription,
	WebhookSubscriptionStatus,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ClaimDeliveryInput,
	CompleteDeliveryInput,
	DeliveryFilters,
	ExportCursor,
	InboxFilters,
	NotificationsRepository,
	PublishEventInput,
	PublishEventResult,
	StoredWebhookSubscription,
} from './repository.ts';
import type { EncryptedSecret } from './secret-vault.ts';

interface InboxRow {
	id: string;
	tenant_id: string;
	recipient_account_id: string;
	kind: NotificationKind;
	title: string;
	body: string | null;
	source_module: string;
	source_ref: string;
	status: NotificationsInboxStatus;
	read_at: Date | string | null;
	created_at: number | bigint | string;
}

interface PreferenceRow {
	id: string;
	tenant_id: string;
	recipient_account_id: string;
	kind: NotificationKind;
	enabled: number | bigint | string;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface MemberPreferenceRow {
	tenant_id: string;
	recipient_account_id: string;
	email_delivery: number | bigint | string;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface SubscriptionRow {
	id: string;
	tenant_id: string;
	name: string;
	url: string;
	events_json: string;
	secret_key_id: string;
	secret_iv: string;
	secret_tag: string;
	secret_ciphertext: string;
	secret_fingerprint: string;
	secret_revision: number | bigint | string;
	status: WebhookSubscriptionStatus;
	description: string | null;
	last_delivery_at: number | bigint | string | null;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
	created_by: string;
}

/**
 * The claim the poll loop takes before a request leaves. It is a lease on a
 * pending attempt, not one of the four states the ledger publishes: it counts
 * no attempt, records no outcome, and every read path answers `pending` for it.
 */
type ClaimedDeliveryStatus = 'sending';

interface DeliveryRow {
	id: string;
	tenant_id: string;
	channel: DeliveryChannel;
	subscription_id: string | null;
	recipient_account_id: string | null;
	kind: NotificationKind;
	source_module: string;
	source_ref: string;
	title: string;
	sequence: number | bigint | string;
	attempt_number: number | bigint | string;
	status: DeliveryStatus | ClaimedDeliveryStatus;
	scheduled_for: number | bigint | string;
	claimed_at: number | bigint | string | null;
	completed_at: number | bigint | string | null;
	response_status: number | bigint | string | null;
	error_class: string | null;
	payload_digest: string;
	payload_bytes: number | bigint | string;
	occurred_at: number | bigint | string;
	created_at: number | bigint | string;
}

const SUBSCRIPTION_COLUMNS = `id, tenant_id, name, url, events_json,
	 secret_key_id, secret_iv, secret_tag, secret_ciphertext, secret_fingerprint,
	 secret_revision, status, description, last_delivery_at, created_at,
	 updated_at, created_by`;

const DELIVERY_COLUMNS = `id, tenant_id, channel, subscription_id,
	 recipient_account_id, kind, source_module, source_ref, title, sequence,
	 attempt_number, status, scheduled_for, completed_at, response_status,
	 error_class, payload_digest, payload_bytes, occurred_at, created_at`;

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const SQL = {
	inboxBySource: `SELECT id FROM notifications_inbox
	 WHERE tenant_id = $1 AND kind = $2 AND source_ref = $3
	 ORDER BY id`,
	deliveriesBySource: `SELECT id FROM notifications_deliveries
	 WHERE tenant_id = $1 AND kind = $2 AND source_ref = $3
	 ORDER BY id`,
	insertInbox: `INSERT INTO notifications_inbox
	 (id, tenant_id, recipient_account_id, kind, title, body, source_module,
	  source_ref, status, read_at, created_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	 ON CONFLICT DO NOTHING
	 RETURNING id`,
	listInbox: `SELECT * FROM notifications_inbox
	 WHERE tenant_id = $1 AND recipient_account_id = $2
	   AND ($3::text IS NULL OR status = $3)
	   AND ($4::text IS NULL OR kind = $4)
	 ORDER BY created_at DESC, id
	 LIMIT $5`,
	countUnread: `SELECT count(*) AS total FROM notifications_inbox
	 WHERE tenant_id = $1 AND recipient_account_id = $2 AND status = 'unread'`,
	getInboxItem: `SELECT * FROM notifications_inbox
	 WHERE tenant_id = $1 AND recipient_account_id = $2 AND id = $3`,
	/* The unique source index answers this; it is the key a publication is
	   idempotent on, so one member holds at most one item per event. */
	findInboxItem: `SELECT * FROM notifications_inbox
	 WHERE tenant_id = $1 AND recipient_account_id = $2 AND kind = $3
	   AND source_ref = $4`,
	setInboxStatus: `UPDATE notifications_inbox SET status = $4, read_at = $5
	 WHERE tenant_id = $1 AND recipient_account_id = $2 AND id = $3
	 RETURNING *`,
	/* Both walks run on notifications_inbox_retention_idx, so a page is a range
	   read of the batch rather than a sort of the workspace's history. */
	exportInbox: `SELECT * FROM notifications_inbox
	 WHERE tenant_id = $1
	   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
	 ORDER BY created_at, id
	 LIMIT $4`,
	deleteInboxBefore: `DELETE FROM notifications_inbox
	 WHERE id IN (
	   SELECT id FROM notifications_inbox
	   WHERE tenant_id = $1 AND created_at < $2
	   ORDER BY created_at, id LIMIT $3
	 )`,

	disabledRecipients: `SELECT recipient_account_id FROM notifications_preferences
	 WHERE tenant_id = $1 AND kind = $2 AND enabled = 0`,
	listPreferences: `SELECT * FROM notifications_preferences
	 WHERE tenant_id = $1 AND recipient_account_id = $2
	 ORDER BY kind`,
	savePreference: `INSERT INTO notifications_preferences
	 (id, tenant_id, recipient_account_id, kind, enabled, created_at, updated_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7)
	 ON CONFLICT (tenant_id, recipient_account_id, kind) DO UPDATE SET
	   enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
	 RETURNING *`,

	/* An absent row means the defaults, so only the members who asked for mail
	   are read back; the set bounds the e-mail rows one publication writes. */
	emailRecipients: `SELECT recipient_account_id
	 FROM notifications_member_preferences
	 WHERE tenant_id = $1 AND email_delivery = 1`,
	getMemberSettings: `SELECT * FROM notifications_member_preferences
	 WHERE tenant_id = $1 AND recipient_account_id = $2`,
	saveMemberSettings: `INSERT INTO notifications_member_preferences
	 (tenant_id, recipient_account_id, email_delivery, created_at, updated_at)
	 VALUES ($1, $2, $3, $4, $5)
	 ON CONFLICT (tenant_id, recipient_account_id) DO UPDATE SET
	   email_delivery = EXCLUDED.email_delivery, updated_at = EXCLUDED.updated_at
	 RETURNING *`,

	activeSubscriptionsForKind: `SELECT ${SUBSCRIPTION_COLUMNS}
	 FROM notifications_webhook_subscriptions
	 WHERE tenant_id = $1 AND status = 'active'
	   AND events_json::jsonb @> to_jsonb($2::text)
	 ORDER BY lower(name), id`,
	listSubscriptions: `SELECT ${SUBSCRIPTION_COLUMNS}
	 FROM notifications_webhook_subscriptions
	 WHERE tenant_id = $1 ORDER BY lower(name), id`,
	getSubscription: `SELECT ${SUBSCRIPTION_COLUMNS}
	 FROM notifications_webhook_subscriptions
	 WHERE tenant_id = $1 AND id = $2`,
	createSubscription: `INSERT INTO notifications_webhook_subscriptions
	 (${SUBSCRIPTION_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
	 ON CONFLICT DO NOTHING
	 RETURNING id`,
	updateSubscription: `UPDATE notifications_webhook_subscriptions
	 SET name = $3, url = $4, events_json = $5, description = $6, updated_at = $7
	 WHERE tenant_id = $1 AND id = $2`,
	setSubscriptionStatus: `UPDATE notifications_webhook_subscriptions
	 SET status = $3, updated_at = $4
	 WHERE tenant_id = $1 AND id = $2`,
	disableSubscription: `UPDATE notifications_webhook_subscriptions
	 SET status = 'disabled', updated_at = $3
	 WHERE tenant_id = $1 AND id = $2`,
	rotateSubscriptionSecret: `UPDATE notifications_webhook_subscriptions
	 SET secret_key_id = $3, secret_iv = $4, secret_tag = $5,
	     secret_ciphertext = $6, secret_fingerprint = $7,
	     secret_revision = secret_revision + 1, updated_at = $8
	 WHERE tenant_id = $1 AND id = $2`,
	deleteSubscription: `DELETE FROM notifications_webhook_subscriptions
	 WHERE tenant_id = $1 AND id = $2`,
	deletePendingDeliveries: `DELETE FROM notifications_deliveries
	 WHERE tenant_id = $1 AND subscription_id = $2 AND status = 'pending'`,
	stampSubscriptionDelivery: `UPDATE notifications_webhook_subscriptions
	 SET last_delivery_at = $3 WHERE tenant_id = $1 AND id = $2`,

	insertDelivery: `INSERT INTO notifications_deliveries (${DELIVERY_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
	 ON CONFLICT DO NOTHING
	 RETURNING id`,
	listDeliveries: `SELECT * FROM notifications_deliveries
	 WHERE tenant_id = $1
	   AND ($2::text IS NULL OR status = $2)
	   AND ($3::text IS NULL OR subscription_id = $3)
	 ORDER BY scheduled_for DESC, id
	 LIMIT $4`,
	getDelivery: `SELECT * FROM notifications_deliveries
	 WHERE tenant_id = $1 AND id = $2`,
	/* One statement does the read back under the tenant, the due check and the
	   claim, so nothing can change between deciding to send and sending. */
	claimDelivery: `UPDATE notifications_deliveries
	 SET status = 'sending', claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2 AND scheduled_for <= $3
	   AND (status = 'pending' OR (status = 'sending' AND claimed_at <= $4))
	 RETURNING *`,
	releaseDelivery: `UPDATE notifications_deliveries
	 SET status = 'pending', claimed_at = NULL, scheduled_for = $3
	 WHERE tenant_id = $1 AND id = $2 AND status = 'sending'`,
	completeDelivery: `UPDATE notifications_deliveries
	 SET status = $3, completed_at = $4, response_status = $5, error_class = $6
	 WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'sending')`,
	latestSequence: `SELECT coalesce(max(sequence), 0) AS sequence
	 FROM notifications_deliveries
	 WHERE tenant_id = $1 AND channel = $2
	   AND coalesce(subscription_id, recipient_account_id) = $3 AND kind = $4
	   AND source_ref = $5`,
	/* Read through the cross-tenant background lease; the attempt is read again
	   under the tenant this returned before anything leaves the process. */
	listDueDeliveries: `SELECT tenant_id, id, scheduled_for, status
	 FROM notifications_deliveries
	 WHERE status = 'pending' AND scheduled_for <= $1
	 ORDER BY scheduled_for, id LIMIT $2`,
	/* Kept apart from the due read so that one stays an ordered walk of the
	   routing index: a claim is a small partition, and folding it into the due
	   query with an OR would cost a sort of every due row instead. */
	listStrandedDeliveries: `SELECT tenant_id, id, scheduled_for, status
	 FROM notifications_deliveries
	 WHERE status = 'sending' AND claimed_at <= $1
	 ORDER BY claimed_at, id LIMIT $2`,
	listDeliveryTenants: `SELECT DISTINCT tenant_id FROM notifications_deliveries
	 WHERE tenant_id > $2 ORDER BY tenant_id LIMIT $1`,
	exportDeliveries: `SELECT * FROM notifications_deliveries
	 WHERE tenant_id = $1
	   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
	 ORDER BY created_at, id
	 LIMIT $4`,
	deleteCompletedBefore: `DELETE FROM notifications_deliveries
	 WHERE id IN (
	   SELECT id FROM notifications_deliveries
	   WHERE tenant_id = $1 AND status <> 'pending' AND completed_at IS NOT NULL
	     AND completed_at < $2
	   ORDER BY completed_at LIMIT $3
	 )`,
} as const;

/* 23505 is the SQLSTATE for a unique violation; the index name keeps a
   different unique index on the table from being mistaken for the name. The
   driver text is never surfaced, only the stable domain error. */
function isDuplicateName(error: unknown): boolean {
	const cause = error as { code?: unknown; constraint?: unknown };
	const text = String(error);
	return (
		(cause?.code === '23505' || text.includes('23505')) &&
		(String(cause?.constraint ?? '').includes(
			'notifications_webhook_subscriptions_name_idx',
		) ||
			text.includes('notifications_webhook_subscriptions_name_idx'))
	);
}

/* PostgreSQL returns BIGINT as a string, so every integer read crosses this
   instead of trusting the driver's representation. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The notifications database returned an invalid ${field}.`);
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
	field: string,
): number | null {
	return value === null ? null : integer(value, field);
}

/* The driver returns a timestamp as a Date; the domain keeps ISO text. */
function isoText(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

function inboxFromRow(row: InboxRow): NotificationsInbox {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		recipientAccountId: row.recipient_account_id,
		kind: row.kind,
		title: row.title,
		body: row.body,
		sourceModule: row.source_module,
		sourceRef: row.source_ref,
		status: row.status,
		readAt: row.read_at === null ? null : isoText(row.read_at),
		createdAt: integer(row.created_at, 'timestamp'),
	};
}

function memberSettingsFromRow(
	row: MemberPreferenceRow,
): MemberNotificationSettings {
	return {
		tenantId: row.tenant_id,
		recipientAccountId: row.recipient_account_id,
		emailDelivery: integer(row.email_delivery, 'preference flag') === 1,
		createdAt: integer(row.created_at, 'timestamp'),
		updatedAt: integer(row.updated_at, 'timestamp'),
	};
}

function preferenceFromRow(row: PreferenceRow): NotificationPreference {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		recipientAccountId: row.recipient_account_id,
		kind: row.kind,
		enabled: integer(row.enabled, 'preference flag') === 1,
		createdAt: integer(row.created_at, 'timestamp'),
		updatedAt: integer(row.updated_at, 'timestamp'),
	};
}

function subscriptionEvents(value: string): readonly NotificationKind[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is NotificationKind => typeof entry === 'string',
		);
	} catch {
		/* A row edited outside the module subscribes to nothing rather than to
		   everything; delivery fails closed. */
		return [];
	}
}

function subscriptionFromRow(row: SubscriptionRow): StoredWebhookSubscription {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		name: row.name,
		url: row.url,
		events: subscriptionEvents(row.events_json),
		secretFingerprint: row.secret_fingerprint,
		secretRevision: integer(row.secret_revision, 'secret revision'),
		status: row.status,
		description: row.description,
		lastDeliveryAt: optionalInteger(row.last_delivery_at, 'timestamp'),
		createdAt: integer(row.created_at, 'timestamp'),
		updatedAt: integer(row.updated_at, 'timestamp'),
		createdBy: row.created_by,
		secret: {
			keyId: row.secret_key_id,
			iv: row.secret_iv,
			tag: row.secret_tag,
			ciphertext: row.secret_ciphertext,
		},
	};
}

/* A claimed attempt has not completed, so the ledger keeps calling it pending:
   the four states the specification defines are the only ones any read path,
   screen or filter ever sees. */
function deliveryStatus(
	status: DeliveryStatus | ClaimedDeliveryStatus,
): DeliveryStatus {
	return status === 'sending' ? 'pending' : status;
}

function deliveryFromRow(row: DeliveryRow): DeliveryAttempt {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		channel: row.channel,
		subscriptionId: row.subscription_id,
		recipientAccountId: row.recipient_account_id,
		kind: row.kind,
		sourceModule: row.source_module,
		sourceRef: row.source_ref,
		title: row.title,
		sequence: integer(row.sequence, 'sequence'),
		attemptNumber: integer(row.attempt_number, 'attempt number'),
		status: deliveryStatus(row.status),
		scheduledFor: integer(row.scheduled_for, 'timestamp'),
		completedAt: optionalInteger(row.completed_at, 'timestamp'),
		responseStatus: optionalInteger(row.response_status, 'response status'),
		errorClass: row.error_class,
		payloadDigest: row.payload_digest,
		payloadBytes: integer(row.payload_bytes, 'payload size'),
		occurredAt: integer(row.occurred_at, 'timestamp'),
		createdAt: integer(row.created_at, 'timestamp'),
	};
}

function inboxParameters(
	record: NotificationsInbox,
): readonly DatabaseParameter[] {
	return [
		record.id,
		record.tenantId,
		record.recipientAccountId,
		record.kind,
		record.title,
		record.body,
		record.sourceModule,
		record.sourceRef,
		record.status,
		record.readAt,
		record.createdAt,
	];
}

function deliveryParameters(
	record: DeliveryAttempt,
): readonly DatabaseParameter[] {
	return [
		record.id,
		record.tenantId,
		record.channel,
		record.subscriptionId,
		record.recipientAccountId,
		record.kind,
		record.sourceModule,
		record.sourceRef,
		record.title,
		record.sequence,
		record.attemptNumber,
		record.status,
		record.scheduledFor,
		record.completedAt,
		record.responseStatus,
		record.errorClass,
		record.payloadDigest,
		record.payloadBytes,
		record.occurredAt,
		record.createdAt,
	];
}

/** A publication that addresses nobody reads no preferences. */
const NO_RECIPIENTS: ReadonlySet<string> = new Set();

export interface NotificationsDatabaseHandles {
	readonly runtime: DatabaseHandle;
	/** Cross-tenant, read only, granted the delivery routing columns alone. */
	readonly background: DatabaseHandle;
}

/** A repository over platform-owned PostgreSQL leases. */
export class DatabaseNotificationsRepository
	implements NotificationsRepository
{
	constructor(private readonly handles: NotificationsDatabaseHandles) {}

	async #read<Row extends DatabaseRow>(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<readonly Row[]> {
		const result = await this.handles.runtime.transaction(
			(transaction) => transaction.query<Row>(statement),
			{ access: 'read', tenantId },
		);
		return result.rows;
	}

	async #write(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<number> {
		const result = await this.handles.runtime.transaction(
			(transaction) => transaction.execute(statement),
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}

	async publish(input: PublishEventInput): Promise<PublishEventResult> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const existing = await this.#existingEvent(transaction, input);
				if (existing) return existing;
				const disabled =
					input.recipients.length === 0
						? NO_RECIPIENTS
						: await this.#disabledRecipients(
								transaction,
								input.tenantId,
								input.kind,
							);
				const mailed =
					input.recipients.length === 0
						? NO_RECIPIENTS
						: await this.#emailRecipients(transaction, input.tenantId);
				const inboxItemIds: string[] = [];
				const deliveryIds: string[] = [];
				let addressed = 0;
				let queued = 0;
				for (const recipient of input.recipients) {
					if (disabled.has(recipient)) continue;
					addressed += 1;
					const item = input.inboxItem(recipient);
					const written = await transaction.query<{ id: string }>({
						text: SQL.insertInbox,
						parameters: [...inboxParameters(item)],
					});
					const id = written.rows[0]?.id;
					if (id !== undefined) inboxItemIds.push(id);
					/* The kind switch decided there is an item at all; this decides
					   whether the item that exists is also mailed. */
					if (!mailed.has(recipient)) continue;
					queued += 1;
					const mail = await transaction.query<{ id: string }>({
						text: SQL.insertDelivery,
						parameters: [...deliveryParameters(input.emailDelivery(item))],
					});
					const mailId = mail.rows[0]?.id;
					if (mailId !== undefined) deliveryIds.push(mailId);
				}
				const subscriptions = await transaction.query<SubscriptionRow>({
					text: SQL.activeSubscriptionsForKind,
					parameters: [input.tenantId, input.kind],
				});
				for (const row of subscriptions.rows) {
					const written = await transaction.query<{ id: string }>({
						text: SQL.insertDelivery,
						parameters: [
							...deliveryParameters(input.delivery(subscriptionFromRow(row))),
						],
					});
					const id = written.rows[0]?.id;
					if (id !== undefined) deliveryIds.push(id);
				}
				/* Fewer rows than the inserts carried means a concurrent publication
				   of the same event committed after the idempotency read took its
				   snapshot: its rows hold the unique indexes. They are this event's
				   rows, so they are read back rather than answered with the empty
				   result of an insert that conflicted. */
				if (
					inboxItemIds.length < addressed ||
					deliveryIds.length < subscriptions.rows.length + queued
				) {
					const written = await this.#existingEvent(transaction, input);
					if (written) return written;
				}
				/* Sorted, because the repeat path reads them back ordered by id: a
				   caller comparing the two results must see the same arrays. */
				return {
					inboxItemIds: inboxItemIds.sort(),
					deliveryIds: deliveryIds.sort(),
				};
			},
			{ access: 'write', tenantId: input.tenantId },
		);
	}

	/* The idempotency read and every insert share one transaction, so a repeat
	   cannot interleave between the check and the writes it guards. */
	async #existingEvent(
		transaction: DatabaseTransaction,
		input: PublishEventInput,
	): Promise<PublishEventResult | null> {
		const parameters = [input.tenantId, input.kind, input.sourceRef];
		const inbox = await transaction.query<{ id: string }>({
			text: SQL.inboxBySource,
			parameters,
		});
		const deliveries = await transaction.query<{ id: string }>({
			text: SQL.deliveriesBySource,
			parameters,
		});
		if (inbox.rows.length === 0 && deliveries.rows.length === 0) return null;
		return {
			inboxItemIds: inbox.rows.map((row) => row.id),
			deliveryIds: deliveries.rows.map((row) => row.id),
		};
	}

	/* An absent row means the member never asked for mail, so only the ones who
	   did are read back. Read once per publication, not once per recipient. */
	async #emailRecipients(
		transaction: DatabaseTransaction,
		tenantId: string,
	): Promise<ReadonlySet<string>> {
		const result = await transaction.query<{ recipient_account_id: string }>({
			text: SQL.emailRecipients,
			parameters: [tenantId],
		});
		return new Set(result.rows.map((row) => row.recipient_account_id));
	}

	/* An absent preference row means enabled, so only the members who switched
	   the kind off are read back. Every path that writes an inbox item crosses
	   this, a publication and a fan-out alike, so no caller can hand a member an
	   item of a kind they disabled. */
	async #disabledRecipients(
		transaction: DatabaseTransaction,
		tenantId: string,
		kind: NotificationKind,
	): Promise<ReadonlySet<string>> {
		const result = await transaction.query<{ recipient_account_id: string }>({
			text: SQL.disabledRecipients,
			parameters: [tenantId, kind],
		});
		return new Set(result.rows.map((row) => row.recipient_account_id));
	}

	async listInbox(
		tenantId: string,
		recipientAccountId: string,
		filters: InboxFilters,
		limit: number,
	): Promise<readonly NotificationsInbox[]> {
		const rows = await this.#read<InboxRow>(tenantId, {
			text: SQL.listInbox,
			parameters: [
				tenantId,
				recipientAccountId,
				filters.status ?? null,
				filters.kind ?? null,
				limit,
			],
		});
		return rows.map(inboxFromRow);
	}

	async exportInboxPage(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly NotificationsInbox[]> {
		const rows = await this.#read<InboxRow>(tenantId, {
			text: SQL.exportInbox,
			parameters: [
				tenantId,
				after?.createdAt ?? null,
				after?.id ?? null,
				limit,
			],
		});
		return rows.map(inboxFromRow);
	}

	async deleteInboxItemsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#write(tenantId, {
			text: SQL.deleteInboxBefore,
			parameters: [tenantId, before, limit],
		});
	}

	async countUnreadInbox(
		tenantId: string,
		recipientAccountId: string,
	): Promise<number> {
		const rows = await this.#read<{ total: number | bigint | string }>(
			tenantId,
			{ text: SQL.countUnread, parameters: [tenantId, recipientAccountId] },
		);
		return integer(rows[0]?.total ?? 0, 'unread count');
	}

	async getInboxItem(
		tenantId: string,
		recipientAccountId: string,
		id: string,
	): Promise<NotificationsInbox | null> {
		const rows = await this.#read<InboxRow>(tenantId, {
			text: SQL.getInboxItem,
			parameters: [tenantId, recipientAccountId, id],
		});
		return rows[0] ? inboxFromRow(rows[0]) : null;
	}

	async setInboxStatus(
		tenantId: string,
		recipientAccountId: string,
		id: string,
		status: NotificationsInboxStatus,
		readAt: string | null,
	): Promise<NotificationsInbox | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<InboxRow>({
					text: SQL.setInboxStatus,
					parameters: [tenantId, recipientAccountId, id, status, readAt],
				}),
			{ access: 'write', tenantId },
		);
		const row = result.rows[0];
		return row ? inboxFromRow(row) : null;
	}

	async appendInboxItems(
		tenantId: string,
		records: readonly NotificationsInbox[],
		emailDelivery: (item: NotificationsInbox) => DeliveryAttempt,
	): Promise<readonly string[]> {
		if (records.length === 0) return [];
		return this.handles.runtime.transaction(
			async (transaction) => {
				const disabled = new Map<NotificationKind, ReadonlySet<string>>();
				const mailed = await this.#emailRecipients(transaction, tenantId);
				const written: string[] = [];
				for (const record of records) {
					let skipped = disabled.get(record.kind);
					if (!skipped) {
						skipped = await this.#disabledRecipients(
							transaction,
							tenantId,
							record.kind,
						);
						disabled.set(record.kind, skipped);
					}
					if (skipped.has(record.recipientAccountId)) continue;
					const result = await transaction.query<{ id: string }>({
						text: SQL.insertInbox,
						parameters: [...inboxParameters(record)],
					});
					const id = result.rows[0]?.id;
					if (id === undefined) continue;
					written.push(id);
					/* Only a fresh item is mailed: a repeat wrote nothing, and the
					   member was already told. */
					if (!mailed.has(record.recipientAccountId)) continue;
					await transaction.query<{ id: string }>({
						text: SQL.insertDelivery,
						parameters: [...deliveryParameters(emailDelivery(record))],
					});
				}
				return written;
			},
			{ access: 'write', tenantId },
		);
	}

	async findInboxItem(
		tenantId: string,
		recipientAccountId: string,
		kind: NotificationKind,
		sourceRef: string,
	): Promise<NotificationsInbox | null> {
		const rows = await this.#read<InboxRow>(tenantId, {
			text: SQL.findInboxItem,
			parameters: [tenantId, recipientAccountId, kind, sourceRef],
		});
		return rows[0] ? inboxFromRow(rows[0]) : null;
	}

	async getMemberSettings(
		tenantId: string,
		recipientAccountId: string,
	): Promise<MemberNotificationSettings | null> {
		const rows = await this.#read<MemberPreferenceRow>(tenantId, {
			text: SQL.getMemberSettings,
			parameters: [tenantId, recipientAccountId],
		});
		return rows[0] ? memberSettingsFromRow(rows[0]) : null;
	}

	async saveMemberSettings(
		record: MemberNotificationSettings,
	): Promise<MemberNotificationSettings> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<MemberPreferenceRow>({
					text: SQL.saveMemberSettings,
					parameters: [
						record.tenantId,
						record.recipientAccountId,
						record.emailDelivery ? 1 : 0,
						record.createdAt,
						record.updatedAt,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return memberSettingsFromRow(result.rows[0]!);
	}

	async listPreferences(
		tenantId: string,
		recipientAccountId: string,
	): Promise<readonly NotificationPreference[]> {
		const rows = await this.#read<PreferenceRow>(tenantId, {
			text: SQL.listPreferences,
			parameters: [tenantId, recipientAccountId],
		});
		return rows.map(preferenceFromRow);
	}

	async savePreference(
		record: NotificationPreference,
	): Promise<NotificationPreference> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<PreferenceRow>({
					text: SQL.savePreference,
					parameters: [
						record.id,
						record.tenantId,
						record.recipientAccountId,
						record.kind,
						record.enabled ? 1 : 0,
						record.createdAt,
						record.updatedAt,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return preferenceFromRow(result.rows[0]!);
	}

	async listSubscriptions(
		tenantId: string,
	): Promise<readonly StoredWebhookSubscription[]> {
		const rows = await this.#read<SubscriptionRow>(tenantId, {
			text: SQL.listSubscriptions,
			parameters: [tenantId],
		});
		return rows.map(subscriptionFromRow);
	}

	async getSubscription(
		tenantId: string,
		id: string,
	): Promise<StoredWebhookSubscription | null> {
		const rows = await this.#read<SubscriptionRow>(tenantId, {
			text: SQL.getSubscription,
			parameters: [tenantId, id],
		});
		return rows[0] ? subscriptionFromRow(rows[0]) : null;
	}

	async createSubscription(
		record: StoredWebhookSubscription,
	): Promise<StoredWebhookSubscription | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: SQL.createSubscription,
					parameters: [
						record.id,
						record.tenantId,
						record.name,
						record.url,
						JSON.stringify(record.events),
						record.secret.keyId,
						record.secret.iv,
						record.secret.tag,
						record.secret.ciphertext,
						record.secretFingerprint,
						record.secretRevision,
						record.status,
						record.description,
						record.lastDeliveryAt,
						record.createdAt,
						record.updatedAt,
						record.createdBy,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return result.rows.length === 1 ? record : null;
	}

	async updateSubscription(
		record: Pick<
			WebhookSubscription,
			| 'tenantId'
			| 'id'
			| 'name'
			| 'url'
			| 'events'
			| 'description'
			| 'updatedAt'
		>,
	): Promise<StoredWebhookSubscription | null | 'conflict'> {
		let affected: number;
		try {
			affected = await this.#write(record.tenantId, {
				text: SQL.updateSubscription,
				parameters: [
					record.tenantId,
					record.id,
					record.name,
					record.url,
					JSON.stringify(record.events),
					record.description,
					record.updatedAt,
				],
			});
		} catch (error) {
			if (isDuplicateName(error)) return 'conflict';
			throw error;
		}
		return affected === 1
			? await this.getSubscription(record.tenantId, record.id)
			: null;
	}

	async setSubscriptionStatus(
		tenantId: string,
		id: string,
		status: WebhookSubscriptionStatus,
		updatedAt: number,
	): Promise<StoredWebhookSubscription | null> {
		const affected = await this.#write(tenantId, {
			text: SQL.setSubscriptionStatus,
			parameters: [tenantId, id, status, updatedAt],
		});
		return affected === 1 ? await this.getSubscription(tenantId, id) : null;
	}

	/* The status change and the queue drop share one transaction, so the poll
	   loop can never read a still-active row whose pending attempts are already
	   gone, or send an attempt the operator has just dropped. */
	async disableSubscription(
		tenantId: string,
		id: string,
		updatedAt: number,
	): Promise<StoredWebhookSubscription | null> {
		const disabled = await this.handles.runtime.transaction(
			async (transaction) => {
				const updated = await transaction.execute({
					text: SQL.disableSubscription,
					parameters: [tenantId, id, updatedAt],
				});
				if (updated.affectedRows !== 1) return false;
				await transaction.execute({
					text: SQL.deletePendingDeliveries,
					parameters: [tenantId, id],
				});
				return true;
			},
			{ access: 'write', tenantId },
		);
		return disabled ? await this.getSubscription(tenantId, id) : null;
	}

	async rotateSubscriptionSecret(
		tenantId: string,
		id: string,
		secret: EncryptedSecret,
		fingerprint: string,
		updatedAt: number,
	): Promise<StoredWebhookSubscription | null> {
		const affected = await this.#write(tenantId, {
			text: SQL.rotateSubscriptionSecret,
			parameters: [
				tenantId,
				id,
				secret.keyId,
				secret.iv,
				secret.tag,
				secret.ciphertext,
				fingerprint,
				updatedAt,
			],
		});
		return affected === 1 ? await this.getSubscription(tenantId, id) : null;
	}

	async deleteSubscription(tenantId: string, id: string): Promise<boolean> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				await transaction.execute({
					text: SQL.deletePendingDeliveries,
					parameters: [tenantId, id],
				});
				const removed = await transaction.execute({
					text: SQL.deleteSubscription,
					parameters: [tenantId, id],
				});
				return removed.affectedRows === 1;
			},
			{ access: 'write', tenantId },
		);
	}

	async stampSubscriptionDelivery(
		tenantId: string,
		id: string,
		at: number,
	): Promise<void> {
		await this.#write(tenantId, {
			text: SQL.stampSubscriptionDelivery,
			parameters: [tenantId, id, at],
		});
	}

	async listDeliveries(
		tenantId: string,
		filters: DeliveryFilters,
		limit: number,
	): Promise<readonly DeliveryAttempt[]> {
		const rows = await this.#read<DeliveryRow>(tenantId, {
			text: SQL.listDeliveries,
			parameters: [
				tenantId,
				filters.status ?? null,
				filters.subscriptionId ?? null,
				limit,
			],
		});
		return rows.map(deliveryFromRow);
	}

	async getDelivery(
		tenantId: string,
		id: string,
	): Promise<DeliveryAttempt | null> {
		const rows = await this.#read<DeliveryRow>(tenantId, {
			text: SQL.getDelivery,
			parameters: [tenantId, id],
		});
		return rows[0] ? deliveryFromRow(rows[0]) : null;
	}

	async appendDelivery(
		record: DeliveryAttempt,
	): Promise<DeliveryAttempt | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: SQL.insertDelivery,
					parameters: [...deliveryParameters(record)],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return result.rows.length === 1 ? record : null;
	}

	async claimDelivery(
		input: ClaimDeliveryInput,
	): Promise<DeliveryAttempt | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<DeliveryRow>({
					text: SQL.claimDelivery,
					parameters: [
						input.tenantId,
						input.id,
						input.now,
						input.strandedBefore,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row ? deliveryFromRow(row) : null;
	}

	async releaseDelivery(
		tenantId: string,
		id: string,
		scheduledFor: number,
	): Promise<boolean> {
		const affected = await this.#write(tenantId, {
			text: SQL.releaseDelivery,
			parameters: [tenantId, id, scheduledFor],
		});
		return affected === 1;
	}

	async completeDelivery(input: CompleteDeliveryInput): Promise<boolean> {
		const affected = await this.#write(input.tenantId, {
			text: SQL.completeDelivery,
			parameters: [
				input.tenantId,
				input.id,
				input.status,
				input.completedAt,
				input.responseStatus,
				input.errorClass,
			],
		});
		return affected === 1;
	}

	async latestDeliverySequence(
		attempt: Pick<
			DeliveryAttempt,
			| 'tenantId'
			| 'channel'
			| 'subscriptionId'
			| 'recipientAccountId'
			| 'kind'
			| 'sourceRef'
		>,
	): Promise<number> {
		const rows = await this.#read<{ sequence: number | bigint | string }>(
			attempt.tenantId,
			{
				text: SQL.latestSequence,
				parameters: [
					attempt.tenantId,
					attempt.channel,
					attempt.subscriptionId ?? attempt.recipientAccountId,
					attempt.kind,
					attempt.sourceRef,
				],
			},
		);
		return integer(rows[0]?.sequence ?? 0, 'sequence');
	}

	async listDueDeliveries(
		now: number,
		limit: number,
	): Promise<readonly DeliveryRouting[]> {
		return this.#route(SQL.listDueDeliveries, now, limit);
	}

	async listStrandedDeliveries(
		before: number,
		limit: number,
	): Promise<readonly DeliveryRouting[]> {
		return this.#route(SQL.listStrandedDeliveries, before, limit);
	}

	async #route(
		text: string,
		bound: number,
		limit: number,
	): Promise<readonly DeliveryRouting[]> {
		const result = await this.handles.background.query<{
			tenant_id: string;
			id: string;
			scheduled_for: number | bigint | string;
			status: DeliveryStatus | ClaimedDeliveryStatus;
		}>({ text, parameters: [bound, limit] });
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			scheduledFor: integer(row.scheduled_for, 'timestamp'),
			status: deliveryStatus(row.status),
		}));
	}

	async listDeliveryTenants(
		limit: number,
		after: string,
	): Promise<readonly string[]> {
		const result = await this.handles.background.query<{ tenant_id: string }>({
			text: SQL.listDeliveryTenants,
			parameters: [limit, after],
		});
		return result.rows.map((row) => row.tenant_id);
	}

	async deleteCompletedDeliveriesBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#write(tenantId, {
			text: SQL.deleteCompletedBefore,
			parameters: [tenantId, before, limit],
		});
	}

	async exportDeliveriesPage(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly DeliveryAttempt[]> {
		const rows = await this.#read<DeliveryRow>(tenantId, {
			text: SQL.exportDeliveries,
			parameters: [
				tenantId,
				after?.createdAt ?? null,
				after?.id ?? null,
				limit,
			],
		});
		return rows.map(deliveryFromRow);
	}
}

export async function migrateNotificationsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(
		database,
		'notifications.core',
		databaseMigrations,
	);
}
