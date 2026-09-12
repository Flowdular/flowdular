import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HostAddressResolver } from '../src/services/egress.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { openEndpoint } from './support/endpoint.ts';
import {
	createHarness,
	seedSubscription,
	testConnect,
	testResolver,
	TEST_HOST,
	TEST_PUBLIC_ADDRESS,
} from './support/harness.ts';

const TENANT = 'tenant-delivery-pinning';
const CLOCK = Date.UTC(2026, 0, 2, 9, 0, 0);

/**
 * The rebinding answer: public while the policy asks, private from the moment
 * the connection would have asked again. Anything that resolves the name a
 * second time reaches the private address.
 */
function rebindingResolver(): {
	readonly resolve: HostAddressResolver;
	readonly calls: () => number;
} {
	let calls = 0;
	return {
		calls: () => calls,
		resolve: async () => {
			calls += 1;
			return calls === 1
				? [{ address: TEST_PUBLIC_ADDRESS }]
				: [{ address: '10.1.2.3' }];
		},
	};
}

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

function harness(resolve: HostAddressResolver, dialled: string[]) {
	return createHarness({
		repository: shared.repository,
		now: () => CLOCK,
		resolve,
		connect: testConnect(dialled),
		members: [],
	});
}

describe('pinned webhook delivery', () => {
	/* Before the connection was pinned, fetch resolved the host itself after the
	   check had passed, so the second answer was the one it connected to. */
	it('NOTIFICATIONS-EGRESS dials only the verified address when the name rebinds after the check', async () => {
		const endpoint = await openEndpoint();
		try {
			const rebinding = rebindingResolver();
			const dialled: string[] = [];
			const { vault, publisher, deliveries } = harness(
				rebinding.resolve,
				dialled,
			);
			await seedSubscription({
				repository: shared.repository,
				vault,
				tenantId: TENANT,
				url: endpoint.url,
				now: CLOCK,
			});
			await publisher.publish({
				tenantId: TENANT,
				kind: 'agent-run-failed',
				sourceModule: 'agents.core',
				sourceRef: 'run-rebinding',
				title: 'Nightly reconciliation failed',
				recipients: [],
			});

			expect(await deliveries.tick()).toBe(1);

			expect(dialled).toEqual([TEST_PUBLIC_ADDRESS]);
			/* The policy asked once; nothing between the check and the socket went
			   back to the resolver, so the private second answer is unreachable. */
			expect(rebinding.calls()).toBe(1);
			expect(endpoint.received).toHaveLength(1);
			/* The name is untouched, so the Host header and the certificate the
			   handshake verified are the ones the subscription named. */
			expect(endpoint.received[0]!.headers.host).toBe(
				`${TEST_HOST}:${endpoint.port}`,
			);
			expect((await deliveries.list(TENANT, {}))[0]).toMatchObject({
				status: 'succeeded',
				responseStatus: 200,
			});
		} finally {
			await endpoint.close();
		}
	});

	it('NOTIFICATIONS-EGRESS refuses a stored URL that is not https before anything leaves', async () => {
		const endpoint = await openEndpoint();
		try {
			const dialled: string[] = [];
			const { vault, publisher, deliveries } = harness(testResolver(), dialled);
			await seedSubscription({
				repository: shared.repository,
				vault,
				tenantId: TENANT,
				url: `http://${TEST_HOST}:${endpoint.port}/receiver`,
				now: CLOCK,
			});
			await publisher.publish({
				tenantId: TENANT,
				kind: 'agent-run-failed',
				sourceModule: 'agents.core',
				sourceRef: 'run-plain-http',
				title: 'Nightly reconciliation failed',
				recipients: [],
			});

			await deliveries.tick();

			expect(dialled).toEqual([]);
			expect(endpoint.received).toHaveLength(0);
			expect(
				(await deliveries.list(TENANT, { status: 'failed' }))[0],
			).toMatchObject({
				attemptNumber: 1,
				responseStatus: null,
				errorClass: 'egress-refused',
			});
		} finally {
			await endpoint.close();
		}
	});
});
