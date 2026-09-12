import { describe, expect, it } from 'vitest';
import {
	createHarness,
	fakeProvider,
	hit,
	nullRepository,
	principal,
} from './support/harness.ts';

const MEMBERS = 'users.members.read';
const INBOX = 'notifications.inbox.read';

describe('SEARCH-TIMEOUT', () => {
	it('answers with the other providers and reports the slow one unavailable', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			budget: { providerTimeoutMs: 200, hitsPerProvider: 20 },
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('ada', 9)]],
						}),
					],
				},
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							hangs: true,
						}),
					],
				},
			],
		});

		const started = Date.now();
		const page = await harness.service.search({
			principal: principal([MEMBERS, INBOX]),
			query: 'ada',
			limit: 50,
		});

		expect(page.hits.map((entry) => entry.ref)).toEqual(['ada']);
		expect(page.unavailable).toEqual(['notifications.inbox']);
		/* The budget bounds the wait: the whole search settles near it, not at
		   whatever the slow provider would eventually have taken. */
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it('aborts the signal it handed the slow provider', async () => {
		let observed: AbortSignal | undefined;
		const harness = createHarness({
			repository: nullRepository(),
			budget: { providerTimeoutMs: 50, hitsPerProvider: 20 },
			providers: [
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							hangs: true,
							onCall: (input) => {
								observed = input.signal;
							},
						}),
					],
				},
			],
		});

		await harness.service.search({
			principal: principal([INBOX]),
			query: 'note',
			limit: 50,
		});

		expect(observed?.aborted).toBe(true);
	});

	it('reports a failing provider unavailable without failing the search', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('ada', 9)]],
						}),
					],
				},
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							fails: true,
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS, INBOX]),
			query: 'ada',
			limit: 50,
		});

		expect(page.hits.map((entry) => entry.ref)).toEqual(['ada']);
		expect(page.unavailable).toEqual(['notifications.inbox']);
	});
});
