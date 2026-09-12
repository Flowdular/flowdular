import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { authDirectory } from '../src/services/auth-directory.ts';
import type { DirectoryAuditEvent } from '../src/services/directory.ts';
import { openHarness, type Harness } from './support/harness.ts';

let harness: Harness;
let tenantId: string;
let recorded: readonly DirectoryAuditEvent[];

const WIDE = { from: 0, to: Number.MAX_SAFE_INTEGER };

beforeAll(async () => {
	harness = await openHarness();
	const workspace = await harness.signUp('window@example.com', 'window-one');
	tenantId = workspace.tenantId;
	await harness.signIn('window@example.com', 'window-one');
	recorded = await authDirectory(harness.auth).auditPage(
		tenantId,
		WIDE,
		null,
		100,
	);
});

afterAll(async () => {
	await harness?.dispose();
});

function idsIn(events: readonly DirectoryAuditEvent[]): readonly number[] {
	return events.map((event) => event.id);
}

describe('the audit window adapter', () => {
	/* The window is a predicate of the read. Seeding the keyset at a ceiling and
	   watching for a floor instead would read rows the window excludes and pay
	   for them in every page. */
	it('states the window on the query instead of seeding a cursor at it', async () => {
		const queries: unknown[] = [];
		const auth = {
			service: async () => ({
				queryAudit: async (query: unknown) => {
					queries.push(query);
					return { events: [], nextCursor: null };
				},
			}),
		} as unknown as AuthRuntime;
		const directory = authDirectory(auth);

		await directory.auditPage('tenant-a', { from: 10, to: 20 }, null, 100);
		await directory.auditPage(
			'tenant-a',
			{ from: 10, to: 20 },
			{ occurredAt: 15, id: 7 },
			100,
		);

		expect(queries).toEqual([
			{ tenantId: 'tenant-a', from: 10, to: 20, limit: 100, cursor: null },
			{ tenantId: 'tenant-a', from: 10, to: 20, limit: 100, cursor: '15:7' },
		]);
	});

	it('reads a workspace that has recorded something', () => {
		expect(recorded.length).toBeGreaterThan(1);
	});

	/* Both ends are inclusive, so an event on the first or the last millisecond
	   of a window belongs to it. A window that lost either end would drop the
	   first or the last day of every report a reader asks for. */
	it('carries the events on the first and the last millisecond of the window', async () => {
		const oldest = recorded.at(-1)!;
		const newest = recorded[0]!;
		const directory = authDirectory(harness.auth);

		const inside = await directory.auditPage(
			tenantId,
			{ from: oldest.occurredAt, to: newest.occurredAt },
			null,
			100,
		);

		expect(idsIn(inside)).toContain(oldest.id);
		expect(idsIn(inside)).toContain(newest.id);
	});

	it('leaves out an event one millisecond before the window', async () => {
		const oldest = recorded.at(-1)!;
		const newest = recorded[0]!;

		const page = await authDirectory(harness.auth).auditPage(
			tenantId,
			{ from: oldest.occurredAt + 1, to: newest.occurredAt },
			null,
			100,
		);

		expect(idsIn(page)).not.toContain(oldest.id);
	});

	it('leaves out an event one millisecond after the window', async () => {
		const oldest = recorded.at(-1)!;
		const newest = recorded[0]!;

		const page = await authDirectory(harness.auth).auditPage(
			tenantId,
			{ from: oldest.occurredAt, to: newest.occurredAt - 1 },
			null,
			100,
		);

		expect(idsIn(page)).not.toContain(newest.id);
	});
});
