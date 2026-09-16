import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import {
	researchService,
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

let shared: ResearchTestDatabase;
let fixtures: Fixtures;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	fixtures = await writeFixtures({
		queries: {},
		pages: {
			'https://a.example.org/one': { title: 'One', text: 'First page' },
			'https://a.example.org/two': { title: 'Two', text: 'Second page' },
		},
	});
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await fixtures?.dispose();
	await shared?.dispose();
});

describe('research evidence', () => {
	it('RESEARCH-EVIDENCE-ATTACH links once, refuses foreign and reserved ids, and lists newest first', async () => {
		let clock = 1_000;
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ recordedFixturesPath: fixtures.path }),
			now: () => clock,
		});
		const read = async (tenantId: string, url: string) => {
			clock += 10;
			return (await service.fetch({ tenantId, url, caller: 'member' }))
				.evidenceId;
		};
		const first = await read('tenant-a', 'https://a.example.org/one');
		const second = await read('tenant-a', 'https://a.example.org/two');
		const foreign = await read('tenant-b', 'https://a.example.org/one');

		await service.attach('tenant-a', 'sales.core', 'case-7', [first, second]);
		await service.attach('tenant-a', 'sales.core', 'case-7', [second, second]);
		await expect(
			service.attach('tenant-a', 'sales.core', 'case-8', [first, foreign]),
		).rejects.toMatchObject({
			code: 'RESEARCH_EVIDENCE_NOT_FOUND',
			status: 404,
		});
		await expect(
			service.attach('tenant-a', 'research.core', 'query:x', [first]),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			service.attach('tenant-a', 'sales.core', 'case-9', []),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });

		const listed = await service.listAttached(
			'tenant-a',
			'sales.core',
			'case-7',
		);
		expect(listed.map((entry) => entry.id)).toEqual([second, first]);
		expect(listed[0]).toEqual({
			id: second,
			url: 'https://a.example.org/two',
			title: 'Two',
			excerpt: 'Second page',
			contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			retrievedAt: expect.any(Number),
			runId: null,
			documentId: null,
		});
		expect(
			await service.listAttached('tenant-a', 'sales.core', 'case-8'),
		).toEqual([]);
		expect(await service.getEvidence('tenant-a', foreign)).toBeNull();
		expect((await service.getEvidence('tenant-b', foreign))?.id).toBe(foreign);
		expect((await service.evidenceDetail('tenant-a', first)).links).toEqual([
			{ ownerModule: 'sales.core', recordRef: 'case-7' },
		]);
	});
});
