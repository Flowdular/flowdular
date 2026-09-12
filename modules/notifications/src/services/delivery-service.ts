import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { MailError, type MailPort } from '@flowdular/server';
import { NOTIFICATIONS_PERMISSIONS } from '../acl/permissions.ts';
import { DEFAULT_MAIL_LOCALE } from '../domain/locale.ts';
import {
	DELIVERY_STATUSES,
	type DeliveryAttempt,
	type DeliveryErrorClass,
	type DeliveryRouting,
	type NotificationsInbox,
} from '../domain/types.ts';
import {
	emailPayloadFingerprint,
	webhookPayloadFingerprint,
} from './delivery-payload.ts';
import {
	emailDeliveryAttempt,
	notificationMailMessage,
} from './email-channel.ts';
import {
	normalizeHost,
	pinnedLookup,
	WebhookEgressError,
	type ResolvedAddress,
	type WebhookEgressPolicy,
} from './egress.ts';
import type {
	DeliveryFilters,
	NotificationsRepository,
	StoredWebhookSubscription,
} from './repository.ts';
import { secretContext, type SecretVault } from './secret-vault.ts';
import { bounded, NotificationsServiceError, oneOf } from './service-error.ts';
import { webhookSignatureHeader } from './signature.ts';

/** Hard request bounds. Neither is configurable: they are the egress contract. */
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_RESPONSE_CAP_BYTES = 64 * 1_024;
/** First retry gap; each further attempt doubles it up to the tenant maximum. */
export const DELIVERY_BASE_BACKOFF_MS = 60_000;
/**
 * A claim older than this was abandoned by a process that died mid-send: the
 * request bound plus room for the ledger write that follows it. Another process
 * takes such an attempt over instead of leaving it stranded.
 */
export const DELIVERY_CLAIM_TIMEOUT_MS = DELIVERY_TIMEOUT_MS + 30_000;
/**
 * How far a held attempt is parked when its subscription is not active. Long
 * enough that a paused backlog cannot keep taking the routing page from every
 * other tenant, short enough that a resumed subscription drains within a minute.
 */
export const DELIVERY_HOLD_MS = 60_000;
/**
 * Routing rows one tick inspects per queue read, and rows one retention pass
 * removes.
 */
export const DELIVERY_TICK_LIMIT = 50;
export const RETENTION_BATCH_LIMIT = 500;
export const RETENTION_TENANT_LIMIT = 100;
export const DELIVERY_PAGE_LIMIT = 200;

export interface TenantDeliverySettings {
	readonly retryMaxAttempts: number;
	readonly retryMaxBackoffMinutes: number;
	readonly retentionDays: number;
}

/** A tenant member and the scopes it currently holds, from auth.core. */
export interface TenantMemberScopes {
	readonly accountId: string;
	/** Resolved at send time, never copied into this module's tables. */
	readonly email: string;
	readonly scopes: readonly string[];
}

/**
 * One workspace's members as one pass sees them. auth.core is asked once per
 * tenant per pass; the index is what keeps addressing an attempt O(1) rather
 * than a scan of the workspace per queued message.
 */
interface TenantMembers {
	readonly list: readonly TenantMemberScopes[];
	readonly byAccount: ReadonlyMap<string, TenantMemberScopes>;
}

type MemberLookup = (tenantId: string) => Promise<TenantMembers>;

/** One pass over the delivery queue, and the workspace lookups it holds. */
export interface DeliveryPass {
	/**
	 * Reads one routing row again under the workspace it named and takes it. Null
	 * for an attempt that moved since the routing read, or one another process is
	 * already sending: neither is this pass's work, and neither is an attempt it
	 * has to report as one.
	 */
	claim(routing: DeliveryRouting, at: number): Promise<DeliveryAttempt | null>;
	/** Sends one attempt this pass claimed and records what came back. */
	deliver(attempt: DeliveryAttempt, at: number): Promise<void>;
}

export interface DeliveryOutcome {
	readonly status: 'succeeded' | 'failed';
	readonly responseStatus: number | null;
	readonly errorClass: DeliveryErrorClass | null;
}

export interface DeliveryTransport {
	send(request: {
		readonly url: string;
		readonly body: string;
		readonly timestamp: string;
		readonly signature: string;
		/** The addresses the policy accepted; the socket may reach no other. */
		readonly addresses: readonly ResolvedAddress[];
	}): Promise<DeliveryOutcome>;
}

/**
 * Test seam for the outbound socket; never reachable from configuration. A
 * deployment leaves it unset, so a delivery dials the address the policy
 * verified and trusts the system store. A test maps that address onto the
 * loopback port its server listens on and adds that server's certificate, which
 * runs the delivery path with exactly the address rules a deployment has. `ca`
 * only ever widens trust: there is no form of this seam that turns verification
 * off.
 */
export interface WebhookConnectSeam {
	readonly dial?: ((address: string) => string) | undefined;
	readonly ca?: string | undefined;
}

export interface DeliveryServiceOptions {
	readonly repository: NotificationsRepository;
	readonly vault: SecretVault;
	readonly policy: () => WebhookEgressPolicy;
	readonly settings: (tenantId: string) => TenantDeliverySettings;
	readonly members: (
		tenantId: string,
	) => Promise<readonly TenantMemberScopes[]>;
	/** Platform-owned outbound mail; the e-mail channel sends through it. */
	readonly mail: MailPort;
	/** The language one workspace's messages say they are written in. */
	readonly locale?: (tenantId: string) => string;
	readonly now?: () => number;
	readonly transport?: DeliveryTransport;
	readonly connect?: WebhookConnectSeam | undefined;
}

function classifyResponse(status: number): DeliveryOutcome {
	if (status >= 200 && status < 300) {
		return { status: 'succeeded', responseStatus: status, errorClass: null };
	}
	/* A redirect is a refusal, not a hop: node never follows one, so the 3xx comes
	   back and the delivery is recorded as refused rather than chased. */
	const errorClass: DeliveryErrorClass =
		status >= 500
			? 'response-5xx'
			: status >= 400
				? 'response-4xx'
				: status >= 300
					? 'egress-refused'
					: 'network';
	return { status: 'failed', responseStatus: status, errorClass };
}

function failed(errorClass: DeliveryErrorClass): DeliveryOutcome {
	return { status: 'failed', responseStatus: null, errorClass };
}

/**
 * An e-mail failure no later pass would survive. The ledger records the class
 * and the attempt ends there instead of spending the whole retry budget.
 */
interface PermanentEmailFailure {
	readonly deadLetter: DeliveryErrorClass;
}

const UNREACHABLE_RECIPIENT: PermanentEmailFailure = {
	deadLetter: 'recipient-unknown',
};

/* A rejected message is these bytes being unacceptable to the port, so every
   attempt of the same message is refused the same way and the first one ends
   it. A deployment that composed no transport may still compose one, and a
   transport failure is the relay being unreachable; both keep the budget a
   network error gets, under the class the ledger shows. */
function classifyMailError(
	error: unknown,
): DeliveryOutcome | PermanentEmailFailure {
	if (error instanceof MailError) {
		if (error.code === 'MAIL_MESSAGE_REJECTED') {
			return { deadLetter: 'mail-refused' };
		}
		return failed(
			error.code === 'MAIL_DELIVERY_FAILED' ? 'network' : 'mail-refused',
		);
	}
	return failed('network');
}

function classifyError(error: unknown): DeliveryOutcome {
	if (error instanceof WebhookEgressError) {
		return failed(
			error.code === 'WEBHOOK_HOST_UNRESOLVED' ? 'dns' : 'egress-refused',
		);
	}
	const name = (error as { name?: unknown })?.name;
	if (name === 'TimeoutError' || name === 'AbortError')
		return failed('timeout');
	/* node reports the resolver failure on the error, fetch reported it on the
	   cause; both shapes are read so the class stays the same either way. */
	const failure = error as { code?: unknown; cause?: { code?: unknown } };
	const code = String(failure?.code ?? failure?.cause?.code);
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return failed('dns');
	return failed('network');
}

/**
 * Reads at most the cap and drops the rest. The body is never stored; it is
 * consumed only so the connection is released instead of left half-open.
 */
async function drainResponse(response: IncomingMessage): Promise<void> {
	let read = 0;
	try {
		for await (const chunk of response) {
			read += (chunk as Buffer).byteLength;
			if (read >= DELIVERY_RESPONSE_CAP_BYTES) return;
		}
	} finally {
		response.destroy();
	}
}

/** Reads as an abort so the classifier records a timeout, not a reset. */
function abortFailure(): Error {
	const error = new Error('The webhook delivery was aborted.');
	error.name = 'AbortError';
	return error;
}

/**
 * One request over TLS to an address the egress policy already accepted. The
 * agent is built per delivery and destroyed with it: a pooled socket would
 * outlive the address check that admitted it, which is the window this closes.
 */
function sendPinned(
	target: URL,
	init: {
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
		readonly addresses: readonly ResolvedAddress[];
		readonly signal: AbortSignal;
		readonly ca?: string | undefined;
	},
): Promise<number> {
	const agent = new Agent({
		keepAlive: false,
		maxSockets: 1,
		lookup: pinnedLookup(normalizeHost(target.hostname), init.addresses),
		...(init.ca === undefined ? {} : { ca: init.ca }),
	});
	return new Promise<number>((resolve, reject) => {
		const fail = (error: unknown) =>
			reject(init.signal.aborted ? abortFailure() : error);
		const request = httpsRequest(target, {
			method: 'POST',
			agent,
			/* An explicit length rather than a chunked body: a customer endpoint
			   that refuses chunked requests must still see the same request it saw
			   before the transport changed. */
			headers: {
				...init.headers,
				'content-length': String(Buffer.byteLength(init.body, 'utf8')),
			},
			signal: init.signal,
		});
		request.on('error', fail);
		request.on('response', (response) => {
			/* The drain shares this rejection: an endpoint that answers with headers
			   and then stalls its body makes the read reject on the request
			   deadline, and that rejection is this attempt's outcome, not the whole
			   pass's. */
			void drainResponse(response).then(
				() => resolve(response.statusCode ?? 0),
				fail,
			);
		});
		request.write(init.body);
		request.end();
	}).finally(() => agent.destroy());
}

/* The verified addresses as they are dialled. A deployment dials exactly what
   it verified; the seam is what lets a test reach its own server. */
function dialable(
	connect: WebhookConnectSeam,
	addresses: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
	const dial = connect.dial;
	if (!dial) return addresses;
	return addresses.map((entry) => ({ address: dial(entry.address) }));
}

export function createDeliveryTransport(
	connect: WebhookConnectSeam = {},
): DeliveryTransport {
	return {
		async send(request) {
			try {
				const status = await sendPinned(new URL(request.url), {
					addresses: dialable(connect, request.addresses),
					/* One deadline over the headers and the body, so an endpoint that
					   answers and then stalls mid-body is still bounded. */
					signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
					headers: {
						'content-type': 'application/json',
						'x-flowdular-signature': request.signature,
						'x-flowdular-timestamp': request.timestamp,
					},
					body: request.body,
					...(connect.ca === undefined ? {} : { ca: connect.ca }),
				});
				return classifyResponse(status);
			} catch (error) {
				return classifyError(error);
			}
		},
	};
}

/**
 * Drains the delivery queue. The cross-tenant poll reads routing columns on the
 * read-only background lease; every attempt is then read, sent and written
 * again under the tenant the routing row named.
 */
export class DeliveryService {
	readonly #options: DeliveryServiceOptions;
	readonly #transport: DeliveryTransport;
	readonly #now: () => number;
	readonly #locale: (tenantId: string) => string;
	/** Last tenant a retention pass reached; '' restarts the rotation. */
	#retentionCursor = '';

	constructor(options: DeliveryServiceOptions) {
		this.#options = options;
		this.#transport =
			options.transport ?? createDeliveryTransport(options.connect);
		this.#now = options.now ?? Date.now;
		this.#locale = options.locale ?? (() => DEFAULT_MAIL_LOCALE);
	}

	async list(
		tenantId: string,
		filters: DeliveryFilters = {},
	): Promise<readonly DeliveryAttempt[]> {
		return this.#options.repository.listDeliveries(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				status: filters.status
					? oneOf(filters.status, 'status', DELIVERY_STATUSES)
					: undefined,
				subscriptionId: filters.subscriptionId
					? bounded(filters.subscriptionId, 'subscriptionId', 1, 128)
					: undefined,
			},
			DELIVERY_PAGE_LIMIT,
		);
	}

	/** Queues a fresh attempt run for a dead-lettered delivery. */
	async replay(tenantId: string, id: string): Promise<DeliveryAttempt> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = await this.#options.repository.getDelivery(
			trustedTenantId,
			bounded(id, 'deliveryId', 1, 128),
		);
		if (!existing) {
			throw new NotificationsServiceError(
				'DELIVERY_NOT_FOUND',
				'Delivery attempt not found.',
				404,
			);
		}
		if (existing.status !== 'dead-letter') {
			throw new NotificationsServiceError(
				'DELIVERY_NOT_DEAD_LETTER',
				'Only a dead-lettered delivery can be replayed.',
				409,
			);
		}
		const sequence =
			(await this.#options.repository.latestDeliverySequence(existing)) + 1;
		const queued = await this.#append(existing, sequence, 1, this.#now());
		if (!queued) {
			throw new NotificationsServiceError(
				'DELIVERY_REPLAY_CONFLICT',
				'A replay of this delivery is already queued.',
				409,
			);
		}
		return queued;
	}

	/**
	 * One pass over the delivery queue. The workspace lookups it needs are asked
	 * for once and held by the pass alone, bounded by the tenants its routing
	 * rows named, so a membership or an address change is picked up by the next
	 * pass rather than by the next attempt.
	 */
	pass(): DeliveryPass {
		const members = this.#passMembers();
		return {
			/* The routing read crossed tenants; the row is authoritative only now,
			   read back and claimed under its own tenant in one statement. The claim
			   is what keeps two poll loops from repeating one request. */
			claim: (routing, at) =>
				this.#options.repository.claimDelivery({
					tenantId: routing.tenantId,
					id: routing.id,
					now: at,
					strandedBefore: at - DELIVERY_CLAIM_TIMEOUT_MS,
				}),
			deliver: (attempt, at) => this.#deliver(attempt, at, members),
		};
	}

	#passMembers(): MemberLookup {
		const pending = new Map<string, Promise<TenantMembers>>();
		return (tenantId) => {
			let members = pending.get(tenantId);
			if (!members) {
				members = this.#options.members(tenantId).then((list) => ({
					list,
					byAccount: new Map(list.map((member) => [member.accountId, member])),
				}));
				pending.set(tenantId, members);
			}
			return members;
		};
	}

	/**
	 * Deletes completed attempts past each tenant's retention window. One pass
	 * covers at most RETENTION_TENANT_LIMIT tenants and resumes from where the
	 * last one stopped, so no tenant is starved by the ones sorting before it.
	 */
	async collectRetention(now = this.#now()): Promise<number> {
		const tenants = await this.#options.repository.listDeliveryTenants(
			RETENTION_TENANT_LIMIT,
			this.#retentionCursor,
		);
		this.#retentionCursor =
			tenants.length < RETENTION_TENANT_LIMIT
				? ''
				: (tenants[tenants.length - 1] ?? '');
		let removed = 0;
		for (const tenantId of tenants) {
			const { retentionDays } = this.#options.settings(tenantId);
			removed += await this.#options.repository.deleteCompletedDeliveriesBefore(
				tenantId,
				now - retentionDays * 86_400_000,
				RETENTION_BATCH_LIMIT,
			);
		}
		return removed;
	}

	async #deliver(
		attempt: DeliveryAttempt,
		now: number,
		members: MemberLookup,
	): Promise<void> {
		const tenantId = attempt.tenantId;
		if (attempt.channel === 'email') {
			const outcome = await this.#sendEmail(attempt, members);
			/* A member who left the workspace or an item that is gone is the e-mail
			   channel's missing subscription, and a message the port refuses is
			   refused again on every attempt: no later pass would do better, so the
			   attempt ends here instead of spending the retry budget. */
			if ('deadLetter' in outcome) {
				await this.#deadLetter(attempt, now, outcome.deadLetter);
				return;
			}
			await this.#record(attempt, null, outcome, now, members);
			return;
		}
		const subscription = await this.#options.repository.getSubscription(
			tenantId,
			attempt.subscriptionId ?? '',
		);
		if (!subscription) {
			await this.#deadLetter(attempt, now, 'egress-refused');
			return;
		}
		/* A paused or disabled subscription holds its queue: the attempt returns to
		   it unchanged and nothing is counted against the retry budget. It is
		   parked past this pass, because a held backlog larger than the page would
		   otherwise take the routing page from every other subscription forever. */
		if (subscription.status !== 'active') {
			await this.#options.repository.releaseDelivery(
				tenantId,
				attempt.id,
				now + DELIVERY_HOLD_MS,
			);
			return;
		}

		const payload = webhookPayloadFingerprint({
			tenantId,
			subscriptionId: subscription.id,
			kind: attempt.kind,
			sourceModule: attempt.sourceModule,
			sourceRef: attempt.sourceRef,
			title: attempt.title,
			occurredAt: attempt.occurredAt,
		});
		const outcome = await this.#send(subscription, payload.body, now);
		await this.#record(attempt, subscription, outcome, now, members);
	}

	/** Ends one attempt without an outcome to retry; the ledger keeps the class. */
	async #deadLetter(
		attempt: DeliveryAttempt,
		now: number,
		errorClass: DeliveryErrorClass,
	): Promise<void> {
		await this.#options.repository.completeDelivery({
			tenantId: attempt.tenantId,
			id: attempt.id,
			status: 'dead-letter',
			completedAt: now,
			responseStatus: null,
			errorClass,
		});
	}

	/**
	 * One message to one member, through the platform port. The address comes
	 * from auth.core at send time and the body from the member's own inbox item,
	 * so nothing about the person is stored in this module's queue. A
	 * `deadLetter` result means no later pass would do better.
	 */
	async #sendEmail(
		attempt: DeliveryAttempt,
		members: MemberLookup,
	): Promise<DeliveryOutcome | PermanentEmailFailure> {
		const recipient = attempt.recipientAccountId;
		if (!recipient) return UNREACHABLE_RECIPIENT;
		let member: TenantMemberScopes | undefined;
		try {
			member = (await members(attempt.tenantId)).byAccount.get(recipient);
		} catch {
			/* auth.core being unavailable is not this member's fault: the attempt
			   keeps its budget and the next pass asks again. */
			return failed('network');
		}
		/* The workspace no longer holds the member, so there is no address to
		   resolve and none is kept here to fall back on. */
		if (!member?.email) return UNREACHABLE_RECIPIENT;
		const item = await this.#options.repository.findInboxItem(
			attempt.tenantId,
			recipient,
			attempt.kind,
			attempt.sourceRef,
		);
		if (!item) return UNREACHABLE_RECIPIENT;
		try {
			await this.#options.mail.send(
				notificationMailMessage(
					item,
					member.email,
					this.#locale(attempt.tenantId),
				),
			);
			return { status: 'succeeded', responseStatus: null, errorClass: null };
		} catch (error) {
			return classifyMailError(error);
		}
	}

	async #send(
		subscription: StoredWebhookSubscription,
		body: string,
		now: number,
	): Promise<DeliveryOutcome> {
		let url: URL;
		let addresses: readonly ResolvedAddress[];
		try {
			url = new URL(subscription.url);
			/* The save path is the only writer of this row and refuses anything but
			   https, but the socket is opened here, so the scheme is refused again
			   immediately before it. */
			if (url.protocol !== 'https:') {
				throw new WebhookEgressError(
					'WEBHOOK_URL_BLOCKED',
					'A webhook is delivered over https only.',
				);
			}
			/* Resolution is re-checked on every delivery: a name that was public at
			   save time can start answering with a private address. The accepted
			   addresses are the only ones the connection is allowed to reach, so
			   nothing between this check and the socket may resolve the name again. */
			addresses = await this.#options.policy().assertResolvable(url.hostname);
		} catch (error) {
			return classifyError(error);
		}
		let secret: string;
		try {
			secret = this.#options.vault.decrypt(
				subscription.secret,
				secretContext(subscription.tenantId, subscription.id),
			);
		} catch {
			return {
				status: 'failed',
				responseStatus: null,
				errorClass: 'egress-refused',
			};
		}
		const timestamp = String(now);
		return this.#transport.send({
			url: url.toString(),
			body,
			timestamp,
			signature: webhookSignatureHeader(secret, timestamp, body),
			addresses,
		});
	}

	async #record(
		attempt: DeliveryAttempt,
		subscription: StoredWebhookSubscription | null,
		outcome: DeliveryOutcome,
		now: number,
		members: MemberLookup,
	): Promise<void> {
		const { retryMaxAttempts, retryMaxBackoffMinutes } = this.#options.settings(
			attempt.tenantId,
		);
		const exhausted = attempt.attemptNumber >= retryMaxAttempts;
		const status =
			outcome.status === 'succeeded'
				? 'succeeded'
				: exhausted
					? 'dead-letter'
					: 'failed';
		const written = await this.#options.repository.completeDelivery({
			tenantId: attempt.tenantId,
			id: attempt.id,
			status,
			completedAt: now,
			responseStatus: outcome.responseStatus,
			errorClass: outcome.errorClass,
		});
		/* Another worker finished this attempt first; it owns what follows. */
		if (!written) return;
		if (subscription) {
			await this.#options.repository.stampSubscriptionDelivery(
				attempt.tenantId,
				subscription.id,
				now,
			);
		}
		if (status === 'succeeded') return;
		if (status === 'failed') {
			await this.#append(
				attempt,
				attempt.sequence,
				attempt.attemptNumber + 1,
				now + backoffMs(attempt.attemptNumber, retryMaxBackoffMinutes),
			);
			return;
		}
		/* An e-mail attempt has no subscription, and its dead letter writes no
		   inbox item either. That item would be mailed to every member who asked
		   for mail, fail the same way and dead-letter again under a new source
		   reference; the ledger is where a failed message is read. */
		if (!subscription) return;
		await this.#notifyDeadLetter(attempt, subscription, now, members);
	}

	async #append(
		source: DeliveryAttempt,
		sequence: number,
		attemptNumber: number,
		scheduledFor: number,
	): Promise<DeliveryAttempt | null> {
		/* Both fingerprints are taken from the row alone, so the digest of a retry
		   and of a replay matches the one the first attempt recorded. */
		const payload =
			source.channel === 'email'
				? emailPayloadFingerprint({
						tenantId: source.tenantId,
						recipientAccountId: source.recipientAccountId ?? '',
						kind: source.kind,
						sourceModule: source.sourceModule,
						sourceRef: source.sourceRef,
						title: source.title,
						occurredAt: source.occurredAt,
					})
				: webhookPayloadFingerprint({
						tenantId: source.tenantId,
						subscriptionId: source.subscriptionId ?? '',
						kind: source.kind,
						sourceModule: source.sourceModule,
						sourceRef: source.sourceRef,
						title: source.title,
						occurredAt: source.occurredAt,
					});
		return this.#options.repository.appendDelivery({
			id: randomUUID(),
			tenantId: source.tenantId,
			channel: source.channel,
			subscriptionId: source.subscriptionId,
			recipientAccountId: source.recipientAccountId,
			kind: source.kind,
			sourceModule: source.sourceModule,
			sourceRef: source.sourceRef,
			title: source.title,
			sequence,
			attemptNumber,
			status: 'pending',
			scheduledFor,
			completedAt: null,
			responseStatus: null,
			errorClass: null,
			payloadDigest: payload.digest,
			payloadBytes: payload.bytes,
			occurredAt: source.occurredAt,
			createdAt: this.#now(),
		});
	}

	/* Every member who can read the dead letter and has not switched the kind off
	   is told about it; the preference is applied by the same inbox write the
	   publication path uses. The row is keyed by the exhausted attempt, so a
	   second pass writes nothing. */
	async #notifyDeadLetter(
		attempt: DeliveryAttempt,
		subscription: StoredWebhookSubscription,
		now: number,
		lookup: MemberLookup,
	): Promise<void> {
		let members: readonly TenantMemberScopes[];
		try {
			members = (await lookup(attempt.tenantId)).list;
		} catch {
			/* auth.core being unavailable must not undo a recorded dead letter. */
			return;
		}
		const records: NotificationsInbox[] = [];
		for (const member of members) {
			if (!member.scopes.includes(NOTIFICATIONS_PERMISSIONS.deliveriesRead)) {
				continue;
			}
			records.push({
				id: randomUUID(),
				tenantId: attempt.tenantId,
				recipientAccountId: member.accountId,
				kind: 'webhook-dead-letter',
				title: `Webhook delivery failed: ${subscription.name}`,
				body: `Delivery of ${attempt.kind} for ${attempt.sourceRef} was moved to the dead letter after ${attempt.attemptNumber} attempts.`,
				sourceModule: 'notifications.core',
				sourceRef: attempt.id,
				status: 'unread',
				readAt: null,
				createdAt: now,
			});
		}
		await this.#options.repository.appendInboxItems(
			attempt.tenantId,
			records,
			(item) => emailDeliveryAttempt(item, this.#now()),
		);
	}
}

/** One minute, doubling per attempt, clamped to the tenant maximum. */
export function backoffMs(
	attemptNumber: number,
	maximumMinutes: number,
): number {
	const doublings = Math.min(Math.max(attemptNumber, 1) - 1, 30);
	return Math.min(
		DELIVERY_BASE_BACKOFF_MS * 2 ** doublings,
		maximumMinutes * 60_000,
	);
}
