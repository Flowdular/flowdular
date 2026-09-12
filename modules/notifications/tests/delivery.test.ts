import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	backoffMs,
	DELIVERY_CLAIM_TIMEOUT_MS,
	DELIVERY_HOLD_MS,
	DELIVERY_RESPONSE_CAP_BYTES,
	DELIVERY_TICK_LIMIT,
	DELIVERY_TIMEOUT_MS,
	type DeliveryTransport,
} from '../src/services/delivery-service.ts';
import { verifyOutboundSignature } from '../src/services/signature.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { openEndpoint } from './support/endpoint.ts';
import {
	createHarness,
	publicResolver,
	seedSubscription as seed,
	testConnect,
	testResolver,
	TEST_HOST,
	TEST_SETTINGS,
} from './support/harness.ts';
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from './support/tls.ts';
import { RETENTION_TENANT_LIMIT } from '../src/services/delivery-service.ts';

const TENANT = 'tenant-delivery';
const MEMBERS = [
	{
		accountId: 'account-ada',
		email: 'ada@example.com',
		scopes: ['notifications.deliveries.read'],
	},
	{
		accountId: 'account-bo',
		email: 'bo@example.com',
		scopes: ['notifications.inbox.read'],
	},
];

let shared: NotificationsTestDatabase;
let clock = Date.UTC(2026, 0, 2, 9, 0, 0);

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
	clock = Date.UTC(2026, 0, 2, 9, 0, 0);
});

function harness(options: { readonly transport?: DeliveryTransport } = {}) {
	return createHarness({
		repository: shared.repository,
		now: () => clock,
		resolve: testResolver(),
		connect: testConnect(),
		members: MEMBERS,
		...options,
	});
}

function seedSubscription(
	vault: ReturnType<typeof harness>['vault'],
	url: string,
	events: readonly string[] = ['agent-run-failed'],
	status: 'active' | 'paused' = 'active',
): Promise<{ readonly id: string; readonly secret: string }> {
	return seed({
		repository: shared.repository,
		vault,
		tenantId: TENANT,
		url,
		now: clock,
		events,
		status,
	});
}

async function publish(
	publisher: ReturnType<typeof harness>['publisher'],
	sourceRef: string,
) {
	return publisher.publish({
		tenantId: TENANT,
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef,
		title: 'Nightly reconciliation failed',
		recipients: [],
	});
}

const failing: DeliveryTransport = {
	send: async () => ({
		status: 'failed',
		responseStatus: 503,
		errorClass: 'response-5xx',
	}),
};

describe('notifications delivery', () => {
	it('NOTIFICATIONS-DELIVERY-SIGNED signs the request the shared scheme verifies and records the outcome without the payload', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, runner } = harness();
			const subscription = await seedSubscription(vault, endpoint.url);
			await publish(publisher, 'run-signed');

			expect(await runner.tick()).toEqual({
				claimed: 1,
				performed: 1,
				failed: 0,
				claimLost: 0,
			});

			expect(endpoint.received).toHaveLength(1);
			const request = endpoint.received[0]!;
			expect(
				verifyOutboundSignature({
					secret: subscription.secret,
					signature: request.headers['x-flowdular-signature'] ?? null,
					timestamp: request.headers['x-flowdular-timestamp'] ?? null,
					body: request.body,
					now: clock,
				}),
			).toBe(true);
			expect(
				verifyOutboundSignature({
					secret: 'another-secret',
					signature: request.headers['x-flowdular-signature'] ?? null,
					timestamp: request.headers['x-flowdular-timestamp'] ?? null,
					body: request.body,
					now: clock,
				}),
			).toBe(false);
			/* The whole body, key order included: a customer signs these bytes, so
			   an added, renamed or reordered field is a break of the contract. */
			expect(JSON.parse(request.body)).toEqual({
				version: 'notifications.v1',
				event: 'agent-run-failed',
				tenantId: TENANT,
				subscriptionId: subscription.id,
				sourceModule: 'agents.core',
				sourceRef: 'run-signed',
				title: 'Nightly reconciliation failed',
				occurredAt: clock,
			});
			expect(Object.keys(JSON.parse(request.body) as object)).toEqual([
				'version',
				'event',
				'tenantId',
				'subscriptionId',
				'sourceModule',
				'sourceRef',
				'title',
				'occurredAt',
			]);

			const attempts = await deliveries.list(TENANT, {});
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				status: 'succeeded',
				responseStatus: 200,
				errorClass: null,
				attemptNumber: 1,
				sequence: 1,
				title: 'Nightly reconciliation failed',
				occurredAt: clock,
				payloadDigest: createHash('sha256')
					.update(request.body, 'utf8')
					.digest('hex'),
				payloadBytes: Buffer.byteLength(request.body, 'utf8'),
			});
			/* The title is a ledger field; the payload bytes, the signature and the
			   secret are not, and the row shape is what keeps them out. */
			expect(Object.keys(attempts[0]!).sort()).toEqual([
				'attemptNumber',
				'channel',
				'completedAt',
				'createdAt',
				'errorClass',
				'id',
				'kind',
				'occurredAt',
				'payloadBytes',
				'payloadDigest',
				'recipientAccountId',
				'responseStatus',
				'scheduledFor',
				'sequence',
				'sourceModule',
				'sourceRef',
				'status',
				'subscriptionId',
				'tenantId',
				'title',
			]);
			expect(JSON.stringify(attempts)).not.toContain(subscription.secret);
		} finally {
			await endpoint.close();
		}
	});

	it('NOTIFICATIONS-DELIVERY-SIGNED refuses a redirect instead of following it', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, runner } = harness();
			await seedSubscription(vault, endpoint.url);
			endpoint.respond((_request, reply) =>
				reply(302, { location: 'https://elsewhere.example/receiver' }),
			);
			await publish(publisher, 'run-redirect');

			await runner.tick();

			expect(endpoint.received).toHaveLength(1);
			const [attempt] = await deliveries.list(TENANT, { status: 'failed' });
			expect(attempt).toMatchObject({
				status: 'failed',
				responseStatus: 302,
				errorClass: 'egress-refused',
			});
		} finally {
			await endpoint.close();
		}
	});

	it('NOTIFICATIONS-DELIVERY-SIGNED stops reading a response at the cap', async () => {
		const offered = 16 * 1_024 * 1_024;
		const chunk = Buffer.alloc(64 * 1_024, 0x61);
		let written = 0;
		const server = createServer(
			{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
			(request, response) => {
				request.resume();
				request.on('end', () => {
					response.writeHead(200, { 'content-type': 'text/plain' });
					const pump = (): void => {
						while (written < offered) {
							if (response.destroyed || response.writableEnded) return;
							written += chunk.byteLength;
							if (!response.write(chunk)) {
								response.once('drain', pump);
								return;
							}
						}
						response.end();
					};
					pump();
				});
			},
		);
		await new Promise<void>((resolve) =>
			server.listen(0, '127.0.0.1', resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			const { vault, publisher, deliveries, runner } = harness();
			await seedSubscription(vault, `https://${TEST_HOST}:${port}/receiver`);
			await publish(publisher, 'run-large');

			await runner.tick();

			const [attempt] = await deliveries.list(TENANT, {});
			expect(attempt?.status).toBe('succeeded');
			expect(attempt?.responseStatus).toBe(200);
			/* Without the cap the client drains all 16 MB. Socket buffering lets a
			   little past 64 KB through; the margin is wide so a loaded machine
			   cannot turn the bound into a flake. */
			expect(written).toBeLessThan(8 * 1_024 * 1_024);
			expect(DELIVERY_RESPONSE_CAP_BYTES).toBe(64 * 1_024);
		} finally {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('NOTIFICATIONS-DELIVERY-SIGNED aborts a silent endpoint after the request timeout', async () => {
		const held: { destroy(): void }[] = [];
		const server = createServer(
			{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
			(request, response) => {
				request.resume();
				held.push(response);
			},
		);
		await new Promise<void>((resolve) =>
			server.listen(0, '127.0.0.1', resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			const { vault, publisher, deliveries, runner } = harness();
			await seedSubscription(vault, `https://${TEST_HOST}:${port}/receiver`);
			await publish(publisher, 'run-timeout');

			const started = Date.now();
			await runner.tick();
			const elapsed = Date.now() - started;

			const [attempt] = await deliveries.list(TENANT, { status: 'failed' });
			expect(attempt).toMatchObject({
				attemptNumber: 1,
				responseStatus: null,
				errorClass: 'timeout',
			});
			expect(elapsed).toBeGreaterThanOrEqual(DELIVERY_TIMEOUT_MS - 500);
		} finally {
			for (const response of held) response.destroy();
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 25_000);

	/* Answering with headers and then stalling the body is the one shape that used
	   to escape the request's own error handling: the rejection came out of the
	   drain, left the attempt pending and took the rest of the pass with it. */
	it('NOTIFICATIONS-DELIVERY-SIGNED records a stalled response body as a timeout and finishes the rest of the pass', async () => {
		const held: { destroy(): void }[] = [];
		const stalling = createServer(
			{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
			(request, response) => {
				request.resume();
				request.on('end', () => {
					response.writeHead(200, { 'content-type': 'text/plain' });
					response.write('a');
					held.push(response);
				});
			},
		);
		await new Promise<void>((resolve) =>
			stalling.listen(0, '127.0.0.1', resolve),
		);
		const { port } = stalling.address() as AddressInfo;
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, runner } = harness();
			const stalled = await seedSubscription(
				vault,
				`https://${TEST_HOST}:${port}/receiver`,
				['agent-run-failed'],
			);
			await seedSubscription(vault, endpoint.url, ['workflow-run-failed']);
			await publish(publisher, 'run-stalled');
			clock += 1_000;
			await publisher.publish({
				tenantId: TENANT,
				kind: 'workflow-run-failed',
				sourceModule: 'workflows.core',
				sourceRef: 'run-after-stall',
				title: 'Queued behind the stall',
				recipients: [],
			});

			expect(await runner.tick()).toEqual({
				claimed: 2,
				performed: 2,
				failed: 0,
				claimLost: 0,
			});

			const [attempt] = await deliveries.list(TENANT, {
				subscriptionId: stalled.id,
				status: 'failed',
			});
			expect(attempt).toMatchObject({
				attemptNumber: 1,
				responseStatus: null,
				errorClass: 'timeout',
			});
			/* The row behind it in the same page was still delivered. */
			expect(endpoint.received).toHaveLength(1);
		} finally {
			await endpoint.close();
			for (const response of held) response.destroy();
			stalling.closeAllConnections?.();
			await new Promise<void>((resolve) => stalling.close(() => resolve()));
		}
	}, 25_000);

	it('NOTIFICATIONS-EGRESS fails every delivery once the host starts resolving to a private address', async () => {
		const { vault, publisher } = harness();
		const subscription = await seedSubscription(
			vault,
			`https://${TEST_HOST}:9/receiver`,
		);
		await publish(publisher, 'run-egress');
		const blocked = createHarness({
			repository: shared.repository,
			now: () => clock,
			resolve: publicResolver({ [TEST_HOST]: '10.1.2.3' }),
			members: MEMBERS,
		});

		await blocked.runner.tick();

		const [attempt] = await blocked.deliveries.list(TENANT, {
			subscriptionId: subscription.id,
			status: 'failed',
		});
		expect(attempt).toMatchObject({
			attemptNumber: 1,
			responseStatus: null,
			errorClass: 'egress-refused',
		});
	});

	it('NOTIFICATIONS-RETRY-DEADLETTER grows the backoff, stops at the tenant maximum and notifies every reader of deliveries', async () => {
		const { vault, publisher, deliveries, inbox, runner } = harness({
			transport: failing,
		});
		const subscription = await seedSubscription(
			vault,
			`https://${TEST_HOST}:9/x`,
		);
		await publish(publisher, 'run-retry');

		const scheduled: number[] = [];
		for (let pass = 0; pass < TEST_SETTINGS.retryMaxAttempts; pass += 1) {
			const [due] = await deliveries.list(TENANT, { status: 'pending' });
			expect(due).toBeDefined();
			scheduled.push(due!.scheduledFor);
			clock = due!.scheduledFor;
			await runner.tick();
		}

		expect(scheduled.map((at, index) => at - scheduled[0]!)).toEqual([
			0, 60_000, 180_000,
		]);
		const ledger = await deliveries.list(TENANT, {
			subscriptionId: subscription.id,
		});
		expect(ledger).toHaveLength(3);
		expect(ledger.map((entry) => entry.attemptNumber).sort()).toEqual([
			1, 2, 3,
		]);
		expect(ledger.filter((entry) => entry.status === 'failed').length).toBe(2);
		const dead = ledger.find((entry) => entry.status === 'dead-letter');
		expect(dead).toMatchObject({
			attemptNumber: 3,
			responseStatus: 503,
			errorClass: 'response-5xx',
		});
		expect(await deliveries.list(TENANT, { status: 'pending' })).toHaveLength(
			0,
		);

		const notified = await inbox.list(TENANT, 'account-ada');
		expect(notified.map((item) => [item.kind, item.sourceRef])).toEqual([
			['webhook-dead-letter', dead!.id],
		]);
		expect(await inbox.list(TENANT, 'account-bo')).toHaveLength(0);
	});

	it('NOTIFICATIONS-INBOX-PREFERENCE leaves the dead letter out of the inbox of a member who disabled the kind', async () => {
		const { vault, publisher, deliveries, inbox, runner } = createHarness({
			repository: shared.repository,
			now: () => clock,
			resolve: testResolver(),
			members: [
				{
					accountId: 'account-ada',
					email: 'ada@example.com',
					scopes: ['notifications.deliveries.read'],
				},
				{
					accountId: 'account-cy',
					email: 'cy@example.com',
					scopes: ['notifications.deliveries.read'],
				},
			],
			transport: failing,
		});
		await seedSubscription(vault, `https://${TEST_HOST}:9/x`);
		await inbox.savePreference(
			TENANT,
			'account-ada',
			'webhook-dead-letter',
			false,
		);
		await publish(publisher, 'run-deadletter-preference');
		for (let pass = 0; pass < TEST_SETTINGS.retryMaxAttempts; pass += 1) {
			const [due] = await deliveries.list(TENANT, { status: 'pending' });
			clock = due!.scheduledFor;
			await runner.tick();
		}

		expect(
			await deliveries.list(TENANT, { status: 'dead-letter' }),
		).toHaveLength(1);
		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(0);
		expect(
			(await inbox.list(TENANT, 'account-cy')).map((item) => item.kind),
		).toEqual(['webhook-dead-letter']);
	});

	/* lastDeliveryAt is the completion time of the most recent attempt whatever
	   its outcome, so the webhooks screen can show "last tried" next to a status
	   instead of only "last succeeded". */
	it('stamps lastDeliveryAt from a failed attempt as well as a successful one', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, webhooks, runner } = harness();
			const subscription = await seedSubscription(vault, endpoint.url, [
				'agent-run-failed',
			]);
			endpoint.respond((_request, reply) => reply(503));
			await publish(publisher, 'run-stamp');

			await runner.tick();
			const failedAt = clock;
			expect((await webhooks.get(TENANT, subscription.id)).lastDeliveryAt).toBe(
				failedAt,
			);

			endpoint.respond((_request, reply) => reply(200));
			const [retry] = await deliveries.list(TENANT, { status: 'pending' });
			clock = retry!.scheduledFor;
			await runner.tick();

			const stamped = await webhooks.get(TENANT, subscription.id);
			expect(stamped.lastDeliveryAt).toBe(clock);
			expect(stamped.lastDeliveryAt).toBeGreaterThan(failedAt);
		} finally {
			await endpoint.close();
		}
	});

	it('NOTIFICATIONS-RETRY-DEADLETTER clamps the backoff to the tenant maximum', () => {
		expect(backoffMs(1, 360)).toBe(60_000);
		expect(backoffMs(2, 360)).toBe(120_000);
		expect(backoffMs(9, 360)).toBe(256 * 60_000);
		expect(backoffMs(10, 360)).toBe(360 * 60_000);
		expect(backoffMs(4, 2)).toBe(120_000);
	});

	it('NOTIFICATIONS-REPLAY queues a fresh attempt run and keeps the earlier ledger', async () => {
		const { vault, publisher, deliveries, runner } = harness({
			transport: failing,
		});
		await seedSubscription(vault, `https://${TEST_HOST}:9/x`);
		await publish(publisher, 'run-replay');
		for (let pass = 0; pass < TEST_SETTINGS.retryMaxAttempts; pass += 1) {
			const [due] = await deliveries.list(TENANT, { status: 'pending' });
			clock = due!.scheduledFor;
			await runner.tick();
		}
		const dead = (await deliveries.list(TENANT, { status: 'dead-letter' }))[0]!;

		const replayed = await deliveries.replay(TENANT, dead.id);

		expect(replayed).toMatchObject({
			status: 'pending',
			sequence: 2,
			attemptNumber: 1,
			payloadDigest: dead.payloadDigest,
		});
		const ledger = await deliveries.list(TENANT, {});
		expect(ledger).toHaveLength(4);
		expect(ledger.find((entry) => entry.id === dead.id)?.status).toBe(
			'dead-letter',
		);
	});

	it('NOTIFICATIONS-REPLAY refuses a delivery that is not dead-lettered', async () => {
		const { vault, publisher, deliveries } = harness({ transport: failing });
		await seedSubscription(vault, `https://${TEST_HOST}:9/x`);
		await publish(publisher, 'run-live');
		const [pending] = await deliveries.list(TENANT, { status: 'pending' });

		await expect(deliveries.replay(TENANT, pending!.id)).rejects.toMatchObject({
			code: 'DELIVERY_NOT_DEAD_LETTER',
			status: 409,
		});
		await expect(deliveries.replay(TENANT, 'missing')).rejects.toMatchObject({
			code: 'DELIVERY_NOT_FOUND',
			status: 404,
		});
	});

	it('NOTIFICATIONS-PAUSE keeps deliveries pending without counting attempts until the subscription resumes', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, webhooks, runner } = harness();
			const subscription = await seedSubscription(vault, endpoint.url);
			await publish(publisher, 'run-paused');
			await webhooks.pause(TENANT, subscription.id);

			clock += 600_000;
			await runner.tick();

			const [held] = await deliveries.list(TENANT, {});
			expect(held).toMatchObject({
				status: 'pending',
				attemptNumber: 1,
				completedAt: null,
				errorClass: null,
				/* Parked rather than pinned: the attempt keeps its place in the queue
				   and its retry budget, but stops taking the routing page. */
				scheduledFor: clock + DELIVERY_HOLD_MS,
			});
			expect(endpoint.received).toHaveLength(0);

			await webhooks.resume(TENANT, subscription.id);
			clock += DELIVERY_HOLD_MS;
			await runner.tick();
			expect(endpoint.received).toHaveLength(1);
			expect((await deliveries.list(TENANT, {}))[0]?.status).toBe('succeeded');
		} finally {
			await endpoint.close();
		}
	});

	/* A paused subscription with more pending attempts than one routing page used
	   to own that page for good: nothing moved its rows, so the page came back
	   identical every pass and no other subscription was ever reached. */
	it('NOTIFICATIONS-PAUSE parks a held backlog larger than one page and still delivers an active subscription', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, runner } = harness();
			const paused = await seedSubscription(
				vault,
				`https://${TEST_HOST}:9/held`,
				['agent-run-failed'],
				'paused',
			);
			await seedSubscription(vault, endpoint.url, ['workflow-run-failed']);
			const backlog = DELIVERY_TICK_LIMIT + 1;
			for (let index = 0; index < backlog; index += 1) {
				await shared.repository.appendDelivery({
					id: `held-${String(index).padStart(3, '0')}`,
					tenantId: TENANT,
					channel: 'webhook',
					subscriptionId: paused.id,
					recipientAccountId: null,
					kind: 'agent-run-failed',
					sourceModule: 'agents.core',
					sourceRef: `run-held-${index}`,
					title: 'Held event',
					sequence: 1,
					attemptNumber: 1,
					status: 'pending',
					scheduledFor: clock - 1_000,
					completedAt: null,
					responseStatus: null,
					errorClass: null,
					payloadDigest: 'digest',
					payloadBytes: 10,
					occurredAt: clock - 1_000,
					createdAt: clock - 1_000,
				});
			}
			await publisher.publish({
				tenantId: TENANT,
				kind: 'workflow-run-failed',
				sourceModule: 'workflows.core',
				sourceRef: 'run-active',
				title: 'Active event',
				recipients: [],
			});

			await runner.tick();
			await runner.tick();

			expect(endpoint.received).toHaveLength(1);
			const held = await deliveries.list(TENANT, { subscriptionId: paused.id });
			expect(held).toHaveLength(backlog);
			/* NOTIFICATIONS-PAUSE still holds for every one of them: no attempt was
			   counted, no outcome written, only the due time moved. */
			expect(
				held.filter(
					(entry) =>
						entry.status === 'pending' &&
						entry.attemptNumber === 1 &&
						entry.completedAt === null &&
						entry.errorClass === null &&
						entry.scheduledFor === clock + DELIVERY_HOLD_MS,
				),
			).toHaveLength(backlog);
		} finally {
			await endpoint.close();
		}
	});

	it('NOTIFICATIONS-RETENTION deletes completed attempts past the window in bounded batches and keeps newer rows and inbox items', async () => {
		const { vault, publisher, deliveries, inbox } = harness();
		const subscription = await seedSubscription(
			vault,
			`https://${TEST_HOST}:9/x`,
		);
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-old',
			title: 'Old event',
			recipients: ['account-ada'],
		});
		const [old] = await deliveries.list(TENANT, { status: 'pending' });
		await shared.repository.completeDelivery({
			tenantId: TENANT,
			id: old!.id,
			status: 'succeeded',
			completedAt: clock - 40 * 86_400_000,
			responseStatus: 200,
			errorClass: null,
		});
		await publish(publisher, 'run-fresh');
		const [fresh] = await deliveries.list(TENANT, { status: 'pending' });
		await shared.repository.completeDelivery({
			tenantId: TENANT,
			id: fresh!.id,
			status: 'succeeded',
			completedAt: clock - 86_400_000,
			responseStatus: 200,
			errorClass: null,
		});

		expect(await deliveries.collectRetention(clock)).toBe(1);

		const remaining = await deliveries.list(TENANT, {
			subscriptionId: subscription.id,
		});
		expect(remaining.map((entry) => entry.sourceRef)).toEqual(['run-fresh']);
		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(1);
	});

	it('NOTIFICATIONS-RETENTION sweeps every tenant in turn instead of only the first page', async () => {
		const seen: string[] = [];
		/* A full page means more tenants may follow, so the next pass resumes
		   after its last one; a short page means the rotation is complete. */
		const full = Array.from(
			{ length: RETENTION_TENANT_LIMIT },
			(_, index) => `tenant-${String(index).padStart(3, '0')}`,
		);
		const pages = [full, ['tenant-tail'], full];
		const { deliveries } = createHarness({
			repository: {
				...shared.repository,
				listDeliveryTenants: async (limit: number, after: string) => {
					expect(limit).toBe(RETENTION_TENANT_LIMIT);
					seen.push(after);
					return pages[seen.length - 1] ?? [];
				},
				deleteCompletedDeliveriesBefore: async () => 0,
			} as never,
			now: () => clock,
			members: MEMBERS,
		});

		await deliveries.collectRetention(clock);
		await deliveries.collectRetention(clock);
		await deliveries.collectRetention(clock);

		expect(seen).toEqual(['', full[full.length - 1], '']);
	});

	it('leaves an attempt whose subscription is gone out of the queue', async () => {
		const { vault, publisher, deliveries, runner } = harness();
		const subscription = await seedSubscription(
			vault,
			`https://${TEST_HOST}:9/x`,
		);
		await publish(publisher, 'run-orphan');
		await shared.repository.setSubscriptionStatus(
			TENANT,
			subscription.id,
			'disabled',
			clock,
		);
		await shared.repository.deleteSubscription(TENANT, subscription.id);

		/* Deleting drops the pending queue, so nothing is left to send. */
		expect(await runner.tick()).toEqual({
			claimed: 0,
			performed: 0,
			failed: 0,
			claimLost: 0,
		});
		expect(await deliveries.list(TENANT, {})).toHaveLength(0);
	});

	/* Two processes drain the same queue during a rolling update. Both poll loops
	   see the row; only the one that claims it may send it. */
	it('sends one request and records one attempt when two poll loops reach the same row', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, runner } = harness();
			const other = harness();
			await seedSubscription(vault, endpoint.url);
			await publish(publisher, 'run-claimed');

			const passes = await Promise.all([runner.tick(), other.runner.tick()]);

			/* Both routing reads answered the row; the claim is the fence, so only
			   one of the two passes took it, and only that pass reports work. */
			expect(passes.map((report) => report.claimed).sort()).toEqual([0, 1]);
			expect(passes.map((report) => report.performed).sort()).toEqual([0, 1]);
			expect(endpoint.received).toHaveLength(1);
			const ledger = await deliveries.list(TENANT, {});
			expect(ledger).toHaveLength(1);
			expect(ledger[0]).toMatchObject({
				status: 'succeeded',
				attemptNumber: 1,
				responseStatus: 200,
			});
		} finally {
			await endpoint.close();
		}
	});

	it('takes over a claim its process abandoned once it goes stale', async () => {
		const endpoint = await openEndpoint();
		try {
			const { vault, publisher, deliveries, runner } = harness();
			await seedSubscription(vault, endpoint.url);
			await publish(publisher, 'run-stranded');
			const [queued] = await deliveries.list(TENANT, { status: 'pending' });
			/* The claim a process takes just before it dies; nothing completes it. */
			expect(
				await shared.repository.claimDelivery({
					tenantId: TENANT,
					id: queued!.id,
					now: clock,
					strandedBefore: clock - DELIVERY_CLAIM_TIMEOUT_MS,
				}),
			).not.toBeNull();
			/* The claim is a lease, not a fifth state: the ledger still reads it as
			   pending, with the attempt it was queued with. */
			expect((await deliveries.list(TENANT, {}))[0]).toMatchObject({
				status: 'pending',
				attemptNumber: 1,
				completedAt: null,
			});

			expect(await runner.tick()).toEqual({
				claimed: 0,
				performed: 0,
				failed: 0,
				claimLost: 0,
			});
			expect(endpoint.received).toHaveLength(0);

			clock += DELIVERY_CLAIM_TIMEOUT_MS + 1;
			expect(await runner.tick()).toEqual({
				claimed: 1,
				performed: 1,
				failed: 0,
				claimLost: 0,
			});

			expect(endpoint.received).toHaveLength(1);
			const ledger = await deliveries.list(TENANT, {});
			expect(ledger).toHaveLength(1);
			expect(ledger[0]).toMatchObject({
				status: 'succeeded',
				attemptNumber: 1,
			});
		} finally {
			await endpoint.close();
		}
	});
});
