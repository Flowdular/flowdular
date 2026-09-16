import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';

let shared: ResearchTestDatabase;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await shared?.dispose();
});

const SHA = 'c'.repeat(64);

async function seed(tenantId: string): Promise<void> {
	const repository = shared.repository;
	await repository.reserveQuery(
		{
			tenantId,
			id: `query-${tenantId}`,
			query: 'acme',
			adapter: 'recorded',
			caller: 'agent',
			callerRef: 'run-shared',
			resultCount: 0,
			costUnits: 1,
			createdAt: 1,
		},
		'run-shared',
		{ limit: 10, since: 0 },
	);
	await repository.completeQuery(tenantId, `query-${tenantId}`, [
		{
			tenantId,
			id: `evidence-${tenantId}`,
			url: 'https://a.example.org/',
			title: 'A',
			excerpt: 'A',
			contentSha256: SHA,
			retrievedAt: 1,
			runId: 'run-shared',
			documentId: null,
			createdBy: null,
			fullText: null,
		},
	]);
	await repository.savePage(tenantId, {
		url: 'https://a.example.org/',
		title: 'A',
		contentSha256: SHA,
		text: tenantId,
		fetchedAt: 1,
		expiresAt: 10,
	});
	await repository.takeRunFetch(tenantId, 'run-shared', 64, 1);
	await repository.insertAttempts(tenantId, [
		{
			tenantId,
			id: `attempt-${tenantId}`,
			queryId: `query-${tenantId}`,
			kind: 'search',
			adapter: 'searxng',
			attempt: 1,
			outcome: 'permanent',
			errorCode: 'RESEARCH_ADAPTER_UNAUTHORIZED',
			durationMs: 3,
			createdAt: 1,
		},
	]);
	await repository.recordAdapterFailure(
		tenantId,
		'searxng',
		'RESEARCH_ADAPTER_UNAUTHORIZED',
		1,
		tenantId === 'tenant-a' ? 1 : 5,
		1_000,
	);
}

describe('research tenant boundary', () => {
	it('RESEARCH-TENANT-BOUNDARY RESEARCH-ADAPTER-TENANT shows each workspace only its own rows and rejects a foreign tenant id', async () => {
		await seed('tenant-a');
		await seed('tenant-b');

		for (const table of [
			'research_evidence',
			'research_evidence_links',
			'research_pages',
			'research_queries',
			'research_run_counters',
			'research_attempts',
			'research_adapter_health',
		]) {
			const visible = await shared.runtime.transaction(
				(transaction) =>
					transaction.query<{ tenant_id: string }>({
						text: `SELECT tenant_id FROM ${table}`,
					}),
				{ access: 'read', tenantId: 'tenant-a' },
			);
			expect([
				table,
				[...new Set(visible.rows.map((row) => row.tenant_id))],
			]).toEqual([table, ['tenant-a']]);
		}
		expect(
			(
				await shared.repository.findPage(
					'tenant-a',
					'https://a.example.org/',
					5,
				)
			)?.text,
		).toBe('tenant-a');
		expect(
			await shared.repository.findEvidence('tenant-a', 'evidence-tenant-b'),
		).toBeNull();
		expect(await shared.repository.monthUsage('tenant-a', 0)).toBe(1);
		expect(
			(await shared.repository.listAttempts('tenant-a', 'query-tenant-b', 10))
				.length,
		).toBe(0);
		/* The same adapter's circuit is open in one workspace and closed in the other. */
		expect(await shared.repository.adapterHealth('tenant-a')).toEqual([
			expect.objectContaining({ adapter: 'searxng', openUntil: 1_001 }),
		]);
		expect(await shared.repository.adapterHealth('tenant-b')).toEqual([
			expect.objectContaining({ adapter: 'searxng', openUntil: null }),
		]);
		expect(
			await shared.repository.claimAdapterProbe(
				'tenant-b',
				'searxng',
				5_000,
				9_000,
			),
		).toBe(false);
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO research_adapter_health (tenant_id, adapter, consecutive_failures)
						 VALUES ('tenant-b', 'firecrawl', 0)`,
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow();

		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO research_pages (tenant_id, url, title, content_sha256, text, fetched_at, expires_at)
						 VALUES ('tenant-b', 'https://b.example.org/', 'B', $1, 'b', 1, 2)`,
						parameters: [SHA],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow();
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.query({ text: 'SELECT id FROM research_evidence' }),
				{ access: 'read' },
			),
		).rejects.toThrow();
	});
});
