import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { NOTIFICATIONS_PERMISSIONS } from '../acl/permissions.ts';
import {
	DELIVERY_STATUSES,
	type DeliveryAttempt,
	type DeliveryErrorClass,
	type NotificationsInbox,
} from '../domain/types.ts';
import { webhookPayloadFingerprint } from './delivery-payload.ts';
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
	readonly scopes: readonly string[];
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

function classifyError(error: unknown): DeliveryOutcome {
	const failed = (errorClass: DeliveryErrorClass): DeliveryOutcome => ({
		status: 'failed',
		responseStatus: null,
		errorClass,
	});
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
	/** Last tenant a retention pass reached; '' restarts the rotation. */
	#retentionCursor = '';

	constructor(options: DeliveryServiceOptions) {
		this.#options = options;
		this.#transport =
			options.transport ?? createDeliveryTransport(options.connect);
		this.#now = options.now ?? Date.now;
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
			(await this.#options.repository.latestDeliverySequence(
				trustedTenantId,
				existing.subscriptionId,
				existing.kind,
				existing.sourceRef,
			)) + 1;
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

	/** One poll pass: due attempts first, then a bounded retention sweep. */
	async tick(limit = DELIVERY_TICK_LIMIT): Promise<number> {
		const now = this.#now();
		const routing = [
			...(await this.#options.repository.listDueDeliveries(now, limit)),
			/* A claim is invisible to the due read, so a process that died between
			   claiming a row and writing its outcome would strand it. The poll asks
			   for stale claims separately, under the same page bound. */
			...(await this.#options.repository.listStrandedDeliveries(
				now - DELIVERY_CLAIM_TIMEOUT_MS,
				limit,
			)),
		];
		let delivered = 0;
		for (const candidate of routing) {
			if (await this.#deliver(candidate.tenantId, candidate.id, now)) {
				delivered += 1;
			}
		}
		await this.collectRetention(now);
		return delivered;
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
		tenantId: string,
		deliveryId: string,
		now: number,
	): Promise<boolean> {
		/* The routing read crossed tenants; the row is authoritative only now,
		   read back and claimed under its own tenant in one statement. A row that
		   moved since, or one another process is already sending, is left alone:
		   the claim is what keeps two poll loops from repeating one request. */
		const attempt = await this.#options.repository.claimDelivery({
			tenantId,
			id: deliveryId,
			now,
			strandedBefore: now - DELIVERY_CLAIM_TIMEOUT_MS,
		});
		if (!attempt) return false;
		const subscription = await this.#options.repository.getSubscription(
			tenantId,
			attempt.subscriptionId,
		);
		if (!subscription) {
			await this.#options.repository.completeDelivery({
				tenantId,
				id: attempt.id,
				status: 'dead-letter',
				completedAt: now,
				responseStatus: null,
				errorClass: 'egress-refused',
			});
			return false;
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
			return false;
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
		await this.#record(attempt, subscription, outcome, now);
		return outcome.status === 'succeeded';
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
		subscription: StoredWebhookSubscription,
		outcome: DeliveryOutcome,
		now: number,
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
		await this.#options.repository.stampSubscriptionDelivery(
			attempt.tenantId,
			subscription.id,
			now,
		);
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
		await this.#notifyDeadLetter(attempt, subscription, now);
	}

	async #append(
		source: DeliveryAttempt,
		sequence: number,
		attemptNumber: number,
		scheduledFor: number,
	): Promise<DeliveryAttempt | null> {
		const payload = webhookPayloadFingerprint({
			tenantId: source.tenantId,
			subscriptionId: source.subscriptionId,
			kind: source.kind,
			sourceModule: source.sourceModule,
			sourceRef: source.sourceRef,
			title: source.title,
			occurredAt: source.occurredAt,
		});
		return this.#options.repository.appendDelivery({
			id: randomUUID(),
			tenantId: source.tenantId,
			subscriptionId: source.subscriptionId,
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
	): Promise<void> {
		let members: readonly TenantMemberScopes[];
		try {
			members = await this.#options.members(attempt.tenantId);
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
		await this.#options.repository.appendInboxItems(attempt.tenantId, records);
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
