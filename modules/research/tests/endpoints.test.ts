import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESEARCH_PERMISSIONS } from '../src/acl/permissions.ts';
import type { ResearchSettings } from '../src/domain/types.ts';
import {
	openHarness,
	type Harness,
	type Workspace,
} from './support/harness.ts';
import {
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

let harness: Harness;
let owner: Workspace;
let fixtures: Fixtures;
let settings: ResearchSettings;

const SLUG = 'research-endpoints';

beforeAll(async () => {
	fixtures = await writeFixtures({
		queries: {
			acme: Array.from({ length: 5 }, (_, index) => ({
				url: `https://a.example.org/${index}`,
				title: `Result ${index}`,
				snippet: `Snippet ${index}`,
				source: 'a.example.org',
			})),
		},
		pages: { 'https://a.example.org/page': { title: 'Page', text: 'Text' } },
	});
	settings = testSettings({ recordedFixturesPath: fixtures.path });
	harness = await openHarness(() => settings);
	owner = await harness.signUp('owner@example.com', SLUG);
});

afterAll(async () => {
	await harness?.dispose();
	await fixtures?.dispose();
});

interface Page<T> {
	readonly items: readonly T[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

const post = (
	path: string,
	session: Workspace,
	body: unknown,
	csrfToken: string | null = session.csrfToken,
) =>
	harness.call(path, {
		method: 'POST',
		session,
		body,
		...(csrfToken === null ? {} : { csrfToken }),
	});

describe('RESEARCH-DENY every route answers before it reads anything', () => {
	it('answers 401 without a session and 403 without the permission', async () => {
		const anonymous = await Promise.all([
			harness.call('/api/research/evidence'),
			harness.call('/api/research/evidence/some-id'),
			harness.call('/api/research/queries'),
			harness.call('/api/research/search', {
				method: 'POST',
				body: { query: 'acme' },
			}),
			harness.call('/api/research/fetch', {
				method: 'POST',
				body: { url: 'https://a.example.org/page' },
			}),
			harness.call('/api/research/evidence/attach', {
				method: 'POST',
				body: {},
			}),
		]);
		expect(anonymous.map((response) => response.status)).toEqual([
			401, 401, 401, 401, 401, 401,
		]);

		const plain = await harness.member(owner, SLUG, 'plain@example.com', []);
		expect(
			(await harness.call('/api/research/evidence', { session: plain })).status,
		).toBe(403);

		const reader = await harness.member(owner, SLUG, 'reader@example.com', [
			RESEARCH_PERMISSIONS.read,
		]);
		expect(
			(await harness.call('/api/research/queries', { session: reader })).status,
		).toBe(200);
		expect(
			(await post('/api/research/search', reader, { query: 'acme' })).status,
		).toBe(403);
		const queries = (await (
			await harness.call('/api/research/queries', { session: owner })
		).json()) as Page<unknown>;
		expect(queries.items).toEqual([]);
	});
});

describe('RESEARCH-CSRF mutations need the session proof', () => {
	it('refuses a search, a fetch and an attach without the CSRF header and counts nothing', async () => {
		const answers = await Promise.all([
			post('/api/research/search', owner, { query: 'acme' }, null),
			post(
				'/api/research/fetch',
				owner,
				{ url: 'https://a.example.org/page' },
				null,
			),
			post(
				'/api/research/evidence/attach',
				owner,
				{ ownerModule: 'sales.core', recordRef: 'r', evidenceIds: ['x'] },
				null,
			),
		]);
		expect(answers.map((response) => response.status)).toEqual([403, 403, 403]);
		const queries = (await (
			await harness.call('/api/research/queries', { session: owner })
		).json()) as Page<unknown>;
		expect(queries.items).toEqual([]);
	});
});

describe('RESEARCH-LISTS the lists page newest first and the record carries its links', () => {
	it('searches, fetches and attaches as a member, then walks both lists and opens a record', async () => {
		const search = await post('/api/research/search', owner, {
			query: 'acme',
			limit: 5,
		});
		expect(search.status).toBe(200);
		const answer = (await search.json()) as {
			results: { evidenceId: string }[];
			adapter: string;
		};
		expect(answer.results).toHaveLength(5);
		const fetched = await post('/api/research/fetch', owner, {
			url: 'https://a.example.org/page',
		});
		expect(fetched.status).toBe(200);
		const page = (
			(await fetched.json()) as { page: { evidenceId: string; text: string } }
		).page;
		expect(page.text).toBe('Text');
		const attached = await post('/api/research/evidence/attach', owner, {
			ownerModule: 'users.core',
			recordRef: 'member-1',
			evidenceIds: [page.evidenceId],
		});
		expect(attached.status).toBe(200);
		const refused = await post('/api/research/evidence/attach', owner, {
			ownerModule: 'users.core',
			recordRef: 'member-1',
			evidenceIds: 'nope',
		});
		expect(refused.status).toBe(400);
		/* No scope of sales.* is held, so no citation lands on its records. */
		const foreign = await post('/api/research/evidence/attach', owner, {
			ownerModule: 'sales.core',
			recordRef: 'case-1',
			evidenceIds: [page.evidenceId],
		});
		expect(foreign.status).toBe(403);
		expect(
			((await foreign.json()) as { error: { code: string } }).error.code,
		).toBe('RESEARCH_ATTACH_FORBIDDEN');

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const response = await harness.call(
				'/api/research/evidence?limit=4' +
					(cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`),
				{ session: owner },
			);
			const body = (await response.json()) as Page<{
				id: string;
				retrievedAt: number;
			}>;
			seen.push(...body.items.map((item) => item.id));
			cursor = body.page.nextCursor;
			pages += 1;
		} while (cursor !== null);
		expect(pages).toBe(2);
		expect(new Set(seen).size).toBe(6);
		expect(seen[0]).toBe(page.evidenceId);

		const first = (await (
			await harness.call('/api/research/evidence?limit=1', { session: owner })
		).json()) as Page<unknown>;
		const tampered = await harness.call(
			`/api/research/evidence?cursor=${encodeURIComponent(first.page.nextCursor + 'x')}`,
			{ session: owner },
		);
		expect(tampered.status).toBe(400);
		expect(
			((await tampered.json()) as { error: { code: string } }).error.code,
		).toBe('CURSOR_INVALID');
		const crossList = await harness.call(
			`/api/research/queries?cursor=${encodeURIComponent(first.page.nextCursor!)}`,
			{ session: owner },
		);
		expect(crossList.status).toBe(400);

		const queries = (await (
			await harness.call('/api/research/queries', { session: owner })
		).json()) as Page<{ query: string; resultCount: number; caller: string }>;
		expect(queries.items).toEqual([
			expect.objectContaining({
				query: 'acme',
				resultCount: 5,
				caller: 'member',
			}),
		]);

		const record = await harness.call(
			`/api/research/evidence/${page.evidenceId}`,
			{
				session: owner,
			},
		);
		expect(record.status).toBe(200);
		expect(
			(
				(await record.json()) as {
					evidence: { links: unknown[]; title: string };
				}
			).evidence,
		).toMatchObject({
			title: 'Page',
			links: [{ ownerModule: 'users.core', recordRef: 'member-1' }],
		});
		const missing = await harness.call('/api/research/evidence/unknown', {
			session: owner,
		});
		expect(missing.status).toBe(404);
	});
});
