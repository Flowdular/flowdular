import { describe, expect, it } from 'vitest';
import {
	createWebhookEgressPolicy,
	pinnedLookup,
	type HostAddressResolver,
	type ResolvedAddress,
} from '../src/services/egress.ts';

const HOST = 'hooks.example';
const PUBLIC_ADDRESS = '93.184.216.34';

/**
 * The rebinding answer: public while the policy asks, private from the moment
 * a connection would have asked again.
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
				? [{ address: PUBLIC_ADDRESS }]
				: [{ address: '10.1.2.3' }];
		},
	};
}

function answer(
	lookup: ReturnType<typeof pinnedLookup>,
	hostname: string,
	all: boolean,
): Promise<unknown> {
	return new Promise((resolve, reject) =>
		lookup(hostname, { all }, (error, address) =>
			error ? reject(error) : resolve(address),
		),
	);
}

describe('pinned webhook egress', () => {
	it('answers the addresses the policy accepted for the host', async () => {
		const rebinding = rebindingResolver();
		const accepted: readonly ResolvedAddress[] =
			await createWebhookEgressPolicy({
				allowlist: new Set([HOST]),
				resolve: rebinding.resolve,
			}).assertResolvable(HOST);
		expect(accepted.map((entry) => entry.address)).toEqual([PUBLIC_ADDRESS]);

		const lookup = pinnedLookup(HOST, accepted);
		expect(await answer(lookup, HOST, true)).toEqual([
			{ address: PUBLIC_ADDRESS, family: 4 },
		]);
		expect(await answer(lookup, HOST, false)).toBe(PUBLIC_ADDRESS);
		/* The check resolved once; the pinned lookup never asks again, so the
		   private second answer is unreachable. */
		expect(rebinding.calls()).toBe(1);
	});

	it('refuses to answer for a host it was not pinned to', async () => {
		const lookup = pinnedLookup(HOST, [{ address: PUBLIC_ADDRESS }]);
		await expect(answer(lookup, 'other.example', true)).rejects.toThrow(
			/No verified address is pinned/,
		);
	});

	it('refuses to answer at all when nothing was accepted', async () => {
		await expect(answer(pinnedLookup(HOST, []), HOST, true)).rejects.toThrow(
			/No verified address is pinned/,
		);
	});

	it('still refuses a host that resolves into a blocked range', async () => {
		await expect(
			createWebhookEgressPolicy({
				resolve: async () => [{ address: PUBLIC_ADDRESS }, { address: '::1' }],
			}).assertResolvable(HOST),
		).rejects.toMatchObject({ code: 'WEBHOOK_HOST_RESOLVES_PRIVATE' });
	});
});
