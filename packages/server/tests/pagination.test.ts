import { createContext } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	HttpProblem,
	keysetWhere,
	MAX_CURSOR_LENGTH,
	pageResponse,
	problemResponse,
	readPageQuery,
} from '../src/index.ts';

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(9);

function query(search: string): URL {
	return new URL(`https://example.test/api/claims${search}`);
}

describe('readPageQuery', () => {
	it('answers the platform default without a query string', () => {
		expect(readPageQuery(query(''))).toEqual({ limit: 50, cursor: null });
		expect(readPageQuery(query('?limit=&cursor='))).toEqual({
			limit: 50,
			cursor: null,
		});
	});

	it('accepts a limit inside the endpoint bound', () => {
		expect(
			readPageQuery(query('?limit=25'), { maxLimit: 25, defaultLimit: 10 }),
		).toEqual({ limit: 25, cursor: null });
		expect(
			readPageQuery(query(''), { maxLimit: 25, defaultLimit: 10 }),
		).toEqual({ limit: 10, cursor: null });
	});

	it.each(['abc', '0', '-1', '1.5', '201', '1e3'])(
		'refuses the limit %s with a 400',
		(limit) => {
			expect(() => readPageQuery(query(`?limit=${limit}`))).toThrow(
				HttpProblem,
			);
			try {
				readPageQuery(query(`?limit=${limit}`));
			} catch (error) {
				expect(error).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
			}
		},
	);

	it('refuses a limit above the endpoint bound even when the platform allows it', () => {
		expect(() => readPageQuery(query('?limit=100'), { maxLimit: 25 })).toThrow(
			/between 1 and 25/,
		);
	});

	it('refuses a cursor that is too long or not cursor-shaped', () => {
		const long = 'a'.repeat(MAX_CURSOR_LENGTH + 1);
		for (const cursor of [long, 'not a cursor', 'c1.$$$']) {
			try {
				readPageQuery(query(`?cursor=${encodeURIComponent(cursor)}`));
				throw new Error('expected a refusal');
			} catch (error) {
				expect(error).toMatchObject({ code: 'CURSOR_INVALID', status: 400 });
			}
		}
	});

	it('refuses an endpoint bound the platform does not allow', () => {
		expect(() => readPageQuery(query(''), { maxLimit: 500 })).toThrow(
			/at most 200/,
		);
		expect(() =>
			readPageQuery(query(''), { maxLimit: 10, defaultLimit: 20 }),
		).toThrow(/between 1 and maxLimit/);
	});
});

describe('cursor codec', () => {
	it('round trips the keyset of the last row', () => {
		const cursor = encodeCursor(
			{ createdAt: 1_757_000_000_000, id: 'claim-42' },
			secret,
		);
		expect(decodeCursor(cursor, secret)).toEqual({
			createdAt: 1_757_000_000_000,
			id: 'claim-42',
		});
		expect(readPageQuery(query(`?cursor=${cursor}`)).cursor).toBe(cursor);
	});

	it('refuses a tampered payload, signature, version and secret', () => {
		const cursor = encodeCursor({ createdAt: 1, id: 'claim-1' }, secret);
		const [version, body, signature] = cursor.split('.') as [
			string,
			string,
			string,
		];
		const forged = Buffer.from(
			JSON.stringify({ createdAt: 1, id: 'claim-999' }),
			'utf8',
		).toString('base64url');

		for (const candidate of [
			`${version}.${forged}.${signature}`,
			`${version}.${body}.${signature.slice(0, -2)}AA`,
			`c2.${body}.${signature}`,
			`${version}.${body}`,
			`${version}.${body}.${signature}.extra`,
			'',
		]) {
			expect(() => decodeCursor(candidate, secret)).toThrow(HttpProblem);
			try {
				decodeCursor(candidate, secret);
			} catch (error) {
				expect(error).toMatchObject({ code: 'CURSOR_INVALID', status: 400 });
			}
		}
		expect(() => decodeCursor(cursor, otherSecret)).toThrow(HttpProblem);
	});

	it('refuses a signed payload that is not a flat record', () => {
		expect(() => encodeCursor({ createdAt: Number.NaN }, secret)).toThrow(
			/finite number/,
		);
		expect(() => encodeCursor({ id: 'claim-1' }, new Uint8Array(16))).toThrow(
			/32 bytes/,
		);
		expect(() =>
			encodeCursor({ note: 'x'.repeat(MAX_CURSOR_LENGTH) }, secret),
		).toThrow(/at most 1024 characters/);
	});

	it('answers a cursor problem as a 400 through problemResponse', async () => {
		let refusal: unknown;
		try {
			decodeCursor('c1.bogus.bogus', secret);
		} catch (error) {
			refusal = error;
		}
		const response = problemResponse(refusal);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				code: 'CURSOR_INVALID',
				message: 'The page cursor is not valid.',
			},
		});
	});
});

describe('keysetWhere', () => {
	it('orders by (created_at, id) after the parameters the statement already binds', () => {
		expect(
			keysetWhere(['created_at', 'id'], [1_757_000_000_000, 'claim-42'], {
				parameterOffset: 1,
			}),
		).toEqual({
			text: '(created_at < $2 OR (created_at = $2 AND id < $3))',
			parameters: [1_757_000_000_000, 'claim-42'],
		});
	});

	it('reverses the comparison for an ascending order', () => {
		expect(keysetWhere(['id'], ['claim-1'], { direction: 'asc' }).text).toBe(
			'(id > $1)',
		);
	});

	it('refuses column names that are not plain identifiers', () => {
		expect(() => keysetWhere(['created_at; DROP TABLE'], [1])).toThrow(
			/plain identifier/,
		);
		expect(() => keysetWhere(['created_at', 'id'], [1])).toThrow(
			/one cursor value per column/,
		);
		expect(() => keysetWhere([], [])).toThrow(/1 to 4 columns/);
	});
});

interface Claim {
	readonly id: string;
	readonly createdAt: number;
}

const CLAIMS: readonly Claim[] = Array.from({ length: 5 }, (_, index) => ({
	id: `claim-${5 - index}`,
	createdAt: 1_757_000_000_000 - index,
}));

/* The recipe a list endpoint follows: read the query, decode the cursor, take
   one row more than the page, and sign the keyset of the last row returned. */
const claims = defineEndpoint({
	id: 'expenses.claims.list',
	path: '/api/claims',
	methods: ['GET'],
	access: { kind: 'public' },
	handler: ({ octane }) => {
		try {
			const page = readPageQuery(new URL(octane.request.url), {
				maxLimit: 100,
			});
			const after = page.cursor ? decodeCursor(page.cursor, secret) : null;
			const start = after
				? CLAIMS.findIndex((claim) => claim.id === after['id']) + 1
				: 0;
			const window = CLAIMS.slice(start, start + page.limit + 1);
			const items = window.slice(0, page.limit);
			const last = items[items.length - 1];
			return pageResponse({
				items,
				limit: page.limit,
				total: CLAIMS.length,
				nextCursor:
					window.length > page.limit && last
						? encodeCursor({ createdAt: last.createdAt, id: last.id }, secret)
						: null,
			});
		} catch (error) {
			return problemResponse(error);
		}
	},
});

async function readPage(search: string): Promise<{
	readonly items: readonly Claim[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}> {
	const response = await claims.serverRoute.handler(
		createContext(new Request(`https://example.test/api/claims${search}`), {}),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as never;
}

describe('a list endpoint', () => {
	it('pages a fixture list twice and stops at the last page', async () => {
		const first = await readPage('?limit=2');
		expect(first.items.map((claim) => claim.id)).toEqual([
			'claim-5',
			'claim-4',
		]);
		expect(first.page).toMatchObject({ limit: 2 });
		expect(first.page.nextCursor).toBeTruthy();

		const second = await readPage(
			`?limit=2&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
		);
		expect(second.items.map((claim) => claim.id)).toEqual([
			'claim-3',
			'claim-2',
		]);

		const third = await readPage(
			`?limit=2&cursor=${encodeURIComponent(second.page.nextCursor!)}`,
		);
		expect(third.items.map((claim) => claim.id)).toEqual(['claim-1']);
		expect(third.page.nextCursor).toBeNull();
	});

	it('reports the page shape with the total the caller supplied', async () => {
		const response = await claims.serverRoute.handler(
			createContext(new Request('https://example.test/api/claims?limit=2'), {}),
		);
		expect(await response.json()).toEqual({
			items: [CLAIMS[0], CLAIMS[1]],
			page: { nextCursor: expect.any(String), limit: 2, total: 5 },
		});
	});

	it('refuses a forged cursor with 400 CURSOR_INVALID instead of a page', async () => {
		const forged = encodeCursor({ id: 'claim-5' }, otherSecret);
		const response = await claims.serverRoute.handler(
			createContext(
				new Request(
					`https://example.test/api/claims?cursor=${encodeURIComponent(forged)}`,
				),
				{},
			),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: 'CURSOR_INVALID' },
		});
	});
});
