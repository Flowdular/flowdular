import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DELIVERY_CONCURRENCY } from '../src/services/delivery-runner.ts';
import type { DeliveryTransport } from '../src/services/delivery-service.ts';
import type {
	ClaimDeliveryInput,
	NotificationsRepository,
} from '../src/services/repository.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import {
	createHarness,
	seedSubscription as seed,
	testResolver,
	TEST_HOST,
} from './support/harness.ts';

const TENANT = 'tenant-delivery-runner';
const CLOCK = Date.UTC(2026, 0, 2, 9, 0, 0);

const succeeding: DeliveryTransport = {
	send: async () => ({
		status: 'succeeded',
		responseStatus: 200,
		errorClass: null,
	}),
};

let shared: NotificationsTestDatabase;

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function harness(
	repository: NotificationsRepository,
	transport: DeliveryTransport,
) {
	return createHarness({
		repository,
		now: () => CLOCK,
		resolve: testResolver(),
		transport,
		members: [],
	});
}

/**
 * The real repository with one row's claim raising, as a database that refuses
 * a single statement would. A proxy rather than a copy: every other method
 * keeps running on the repository itself, which is where its state lives.
 */
function claimFailsFor(
	id: string,
	repository: NotificationsRepository,
): NotificationsRepository {
	return new Proxy(repository, {
		get(target, property) {
			const value = Reflect.get(target, property) as unknown;
			if (property === 'claimDelivery') {
				return async (input: ClaimDeliveryInput) => {
					if (input.id === id) throw new Error('the claim statement failed');
					return repository.claimDelivery(input);
				};
			}
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

async function seedSubscription(
	vault: ReturnType<typeof harness>['vault'],
	name: string,
): Promise<{ readonly id: string }> {
	return seed({
		repository: shared.repository,
		vault,
		tenantId: TENANT,
		url: `https://${TEST_HOST}:9/${name}`,
		now: CLOCK,
	});
}

/** Resolves once the condition holds, or answers false instead of hanging. */
async function settle(check: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

describe('the delivery pass on the platform runner', () => {
	it('finishes the pass when one attempt raises instead of failing', async () => {
		const { vault, publisher } = harness(shared.repository, succeeding);
		await seedSubscription(vault, 'first');
		await seedSubscription(vault, 'second');
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-isolated',
			title: 'Nightly reconciliation failed',
			recipients: [],
		});
		const queued = await shared.repository.listDeliveries(
			TENANT,
			{ status: 'pending' },
			10,
		);
		expect(queued).toHaveLength(2);
		const raising = queued[0]!;
		const { deliveries, runner } = harness(
			claimFailsFor(raising.id, shared.repository),
			succeeding,
		);

		/* The row that raised was never taken, so the pass reports the one attempt
		   it actually claimed and sent. */
		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});

		/* The row behind the one that raised was still delivered. */
		expect(
			(await deliveries.list(TENANT, { status: 'succeeded' })).map(
				(entry) => entry.id,
			),
		).toEqual([queued[1]!.id]);
		/* The attempt that raised was never claimed, so it kept its place in the
		   queue and its budget: the next pass offers it again. */
		expect(await deliveries.list(TENANT, { status: 'pending' })).toEqual([
			expect.objectContaining({ id: raising.id, attemptNumber: 1 }),
		]);
	});

	it('counts only the attempts it could take, not the rows it read', async () => {
		const { vault, publisher } = harness(shared.repository, succeeding);
		await seedSubscription(vault, 'taken');
		await seedSubscription(vault, 'mine');
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-contended',
			title: 'Nightly reconciliation failed',
			recipients: [],
		});
		const queued = await shared.repository.listDeliveries(
			TENANT,
			{ status: 'pending' },
			10,
		);
		expect(queued).toHaveLength(2);
		/* The row another process is already sending: the routing read still
		   answers it, and the claim is what refuses it. */
		const held = queued[0]!;
		const { deliveries, runner } = harness(
			new Proxy(shared.repository, {
				get(target, property) {
					const value = Reflect.get(target, property) as unknown;
					if (property === 'claimDelivery') {
						return async (input: ClaimDeliveryInput) =>
							input.id === held.id ? null : target.claimDelivery(input);
					}
					return typeof value === 'function' ? value.bind(target) : value;
				},
			}),
			succeeding,
		);

		/* One row read, one row claimed, one attempt sent: a pass that reported
		   the row it could not take would claim two and perform two. */
		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		expect(
			(await deliveries.list(TENANT, { status: 'succeeded' })).map(
				(entry) => entry.id,
			),
		).toEqual([queued[1]!.id]);
	});

	it('sends four attempts at once so one slow endpoint cannot hold the queue', async () => {
		let release = (): void => undefined;
		const open = new Promise<void>((resolve) => {
			release = resolve;
		});
		let inFlight = 0;
		let peak = 0;
		const { vault, publisher, deliveries, runner } = harness(
			shared.repository,
			{
				send: async () => {
					inFlight += 1;
					peak = Math.max(peak, inFlight);
					await open;
					inFlight -= 1;
					return {
						status: 'succeeded',
						responseStatus: 200,
						errorClass: null,
					};
				},
			},
		);
		for (let index = 0; index < DELIVERY_CONCURRENCY + 1; index += 1) {
			await seedSubscription(vault, `receiver-${index}`);
		}
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-concurrent',
			title: 'Nightly reconciliation failed',
			recipients: [],
		});

		const pass = runner.tick();
		/* A pass that sent one attempt at a time would never reach this, and the
		   endpoints hold every request until it does. */
		expect(await settle(() => inFlight === DELIVERY_CONCURRENCY)).toBe(true);
		release();

		expect(await pass).toEqual({
			claimed: DELIVERY_CONCURRENCY + 1,
			performed: DELIVERY_CONCURRENCY + 1,
			failed: 0,
			claimLost: 0,
		});
		/* The bound holds in both directions: the fifth attempt waited for one of
		   the four to finish. */
		expect(peak).toBe(DELIVERY_CONCURRENCY);
		expect(await deliveries.list(TENANT, { status: 'succeeded' })).toHaveLength(
			DELIVERY_CONCURRENCY + 1,
		);
	});
});
