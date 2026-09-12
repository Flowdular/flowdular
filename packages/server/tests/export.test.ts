import { describe, expect, it } from 'vitest';
import {
	CSV_BOM,
	csvField,
	csvRecord,
	defineListExport,
	ListExportError,
	LIST_EXPORT_LIMITS,
	runListExport,
	type DefinedListExport,
	type ListExportCell,
	type ListExportPrincipal,
} from '../src/index.ts';

interface Row {
	readonly id: number;
	readonly name: string;
}

const PRINCIPAL: ListExportPrincipal = {
	accountId: 'account-ada',
	tenantId: 'tenant-one',
	scopes: ['users.members.read'],
};

function rows(count: number, from = 0): Row[] {
	return Array.from({ length: count }, (_, index) => ({
		id: from + index + 1,
		name: `row ${from + index + 1}`,
	}));
}

/**
 * A list that pages `source` in slices of the limit it is given, with the
 * limits it was asked for kept alongside it.
 */
function listOf(source: readonly Row[]): {
	readonly defined: DefinedListExport;
	readonly limits: number[];
} {
	const limits: number[] = [];
	const defined = defineListExport<Row>({
		id: 'users.core.members',
		label: 'Members',
		permission: 'users.members.read',
		columns: [
			{ key: 'id', header: 'Id', value: (row) => row.id },
			{ key: 'name', header: 'Name', value: (row) => row.name },
		],
		page: async (_principal, cursor, limit) => {
			limits.push(limit);
			const offset = cursor === null ? 0 : Number(cursor);
			const slice = source.slice(offset, offset + limit);
			const next = offset + slice.length;
			return {
				rows: slice,
				nextCursor: next < source.length ? String(next) : null,
			};
		},
	});
	return { defined, limits };
}

function text(body: Uint8Array): string {
	return Buffer.from(body).toString('utf8');
}

describe('csvField', () => {
	it('leaves a field RFC 4180 reserves nothing of alone', () => {
		expect(csvField('ada@example.com')).toBe('ada@example.com');
		expect(csvField('')).toBe('');
		expect(csvField('a b;c|d')).toBe('a b;c|d');
	});

	it.each([
		['a,b', '"a,b"'],
		['a"b', '"a""b"'],
		['a\nb', '"a\nb"'],
		['a\rb', '"a\rb"'],
		['"', '""""'],
	])('quotes %j as %j', (value, expected) => {
		expect(csvField(value)).toBe(expected);
	});
});

describe('csvRecord', () => {
	it('joins with commas and terminates with CRLF', () => {
		expect(csvRecord(['a', 'b'])).toBe('a,b\r\n');
		expect(csvRecord([])).toBe('\r\n');
	});
});

describe('defineListExport', () => {
	const base = {
		id: 'users.core.members',
		label: 'Members',
		permission: 'users.members.read',
		columns: [{ key: 'id', header: 'Id', value: (row: Row) => row.id }],
		page: async () => ({ rows: [], nextCursor: null }),
	};

	it.each([
		['an id that is not dotted', { id: 'members' }],
		['an empty id', { id: '' }],
		['a permission that is not a permission id', { permission: 'read' }],
		['no columns', { columns: [] }],
		[
			'a column key with a space',
			{ columns: [{ key: 'the id', header: 'Id', value: () => '' }] },
		],
		[
			'the same column twice',
			{
				columns: [
					{ key: 'id', header: 'Id', value: () => '' },
					{ key: 'id', header: 'Also id', value: () => '' },
				],
			},
		],
		[
			'a column with an empty header',
			{ columns: [{ key: 'id', header: '', value: () => '' }] },
		],
	])('refuses %s', (_case, overrides) => {
		expect(() => defineListExport({ ...base, ...overrides } as never)).toThrow(
			ListExportError,
		);
		try {
			defineListExport({ ...base, ...overrides } as never);
		} catch (error) {
			expect(error).toMatchObject({ code: 'EXPORT_DEFINITION_INVALID' });
		}
	});

	it('refuses more columns than a list may declare', () => {
		const columns = Array.from(
			{ length: LIST_EXPORT_LIMITS.columns + 1 },
			(_, index) => ({
				key: `c${index}`,
				header: `C${index}`,
				value: () => '',
			}),
		);
		expect(() => defineListExport({ ...base, columns })).toThrow(
			ListExportError,
		);
	});

	it('publishes the columns and the header record for a screen to read', () => {
		const { defined } = listOf([]);
		expect(defined.columns).toEqual([
			{ key: 'id', header: 'Id' },
			{ key: 'name', header: 'Name' },
		]);
		expect(defined.header).toBe('Id,Name\r\n');
		expect(defined.label).toBe('Members');
		expect(defined.permission).toBe('users.members.read');
	});
});

describe('cell values', () => {
	function cellOf(value: ListExportCell): Promise<string> {
		const defined = defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'cell', header: 'Cell', value: () => value }],
			page: async () => ({ rows: rows(1), nextCursor: null }),
		});
		return defined
			.page(PRINCIPAL, null, 10)
			.then((page) => page.records[0] ?? '');
	}

	it.each([
		[null, '\r\n'],
		[undefined, '\r\n'],
		['plain', 'plain\r\n'],
		[42, '42\r\n'],
		[0, '0\r\n'],
		[true, 'true\r\n'],
		[false, 'false\r\n'],
	])('writes %j as %j', async (value, expected) => {
		expect(await cellOf(value)).toBe(expected);
	});

	it('writes a date as an ISO 8601 instant', async () => {
		expect(await cellOf(new Date('2026-09-12T08:30:00.000Z'))).toBe(
			'2026-09-12T08:30:00.000Z\r\n',
		);
	});

	it.each([
		['a number a file cannot carry', Number.POSITIVE_INFINITY],
		['a number that is not one', Number.NaN],
		['an invalid date', new Date('nope')],
		['a value that is not exportable', { toString: () => 'x' }],
	])('refuses %s', async (_case, value) => {
		await expect(cellOf(value as ListExportCell)).rejects.toMatchObject({
			code: 'EXPORT_CELL_INVALID',
		});
	});

	it('refuses a cell longer than the platform bound', async () => {
		await expect(
			cellOf('x'.repeat(LIST_EXPORT_LIMITS.cell + 1)),
		).rejects.toMatchObject({ code: 'EXPORT_CELL_TOO_LARGE' });
	});
});

describe('the page contract', () => {
	function pageAnswering(
		answer: unknown,
		value: (row: Row) => ListExportCell = (row) => row.name,
	): DefinedListExport {
		return defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'name', header: 'Name', value }],
			page: async () => answer as never,
		});
	}

	it('answers one stable code when the list raises', async () => {
		const boom = new Error('the query exploded');
		const defined = defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'name', header: 'Name', value: (row) => row.name }],
			page: async () => {
				throw boom;
			},
		});
		await expect(defined.page(PRINCIPAL, null, 10)).rejects.toMatchObject({
			code: 'EXPORT_LIST_FAILED',
			cause: boom,
		});
	});

	it('answers one stable code when a column raises', async () => {
		const defined = pageAnswering({ rows: rows(1), nextCursor: null }, () => {
			throw new Error('no name');
		});
		await expect(defined.page(PRINCIPAL, null, 10)).rejects.toMatchObject({
			code: 'EXPORT_LIST_FAILED',
		});
	});

	it('refuses a page longer than the limit it was given', async () => {
		const defined = pageAnswering({ rows: rows(3), nextCursor: null });
		await expect(defined.page(PRINCIPAL, null, 2)).rejects.toMatchObject({
			code: 'EXPORT_PAGE_OVERSIZE',
		});
	});

	it('refuses a next cursor that does not advance the walk', async () => {
		const defined = pageAnswering({ rows: rows(1), nextCursor: 'same' });
		await expect(defined.page(PRINCIPAL, 'same', 10)).rejects.toMatchObject({
			code: 'EXPORT_LIST_STALLED',
		});
	});

	it('refuses an empty page that still promises more', async () => {
		const defined = pageAnswering({ rows: [], nextCursor: 'next' });
		await expect(defined.page(PRINCIPAL, null, 10)).rejects.toMatchObject({
			code: 'EXPORT_LIST_STALLED',
		});
	});

	it('refuses a page that carries no rows at all', async () => {
		const defined = pageAnswering({ nextCursor: null });
		await expect(defined.page(PRINCIPAL, null, 10)).rejects.toMatchObject({
			code: 'EXPORT_LIST_FAILED',
		});
	});
});

describe('runListExport', () => {
	const bounds = { maxRows: 1_000, maxBytes: 1_000_000 };

	it('writes a BOM, the header and every row in list order', async () => {
		const result = await runListExport({
			definition: listOf(rows(5)).defined,
			principal: PRINCIPAL,
			bounds: { ...bounds, pageLimit: 2 },
		});
		expect(text(result.body)).toBe(
			CSV_BOM +
				'Id,Name\r\n' +
				'1,row 1\r\n2,row 2\r\n3,row 3\r\n4,row 4\r\n5,row 5\r\n',
		);
		expect(result.rows).toBe(5);
		expect(result.pages).toBe(3);
		expect(result.bytes).toBe(result.body.byteLength);
	});

	it('writes the header alone for a list with no rows', async () => {
		const result = await runListExport({
			definition: listOf([]).defined,
			principal: PRINCIPAL,
			bounds,
		});
		expect(text(result.body)).toBe(CSV_BOM + 'Id,Name\r\n');
		expect(result.rows).toBe(0);
		expect(result.pages).toBe(1);
	});

	it('quotes a value that carries a separator or a newline', async () => {
		const defined = defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'name', header: 'Name', value: (row) => row.name }],
			page: async () => ({
				rows: [{ id: 1, name: 'Lovelace, Ada "AL"\nLondon' }],
				nextCursor: null,
			}),
		});
		const result = await runListExport({
			definition: defined,
			principal: PRINCIPAL,
			bounds,
		});
		expect(text(result.body)).toBe(
			CSV_BOM + 'Name\r\n"Lovelace, Ada ""AL""\nLondon"\r\n',
		);
	});

	it('never asks a list for more than the page limit', async () => {
		const list = listOf(rows(5));
		await runListExport({
			definition: list.defined,
			principal: PRINCIPAL,
			bounds: { ...bounds, pageLimit: 2 },
		});
		expect(Math.max(...list.limits)).toBe(2);
	});

	it('completes a list that fills the row bound exactly', async () => {
		const result = await runListExport({
			definition: listOf(rows(10)).defined,
			principal: PRINCIPAL,
			bounds: { maxRows: 10, maxBytes: 1_000_000, pageLimit: 4 },
		});
		expect(result.rows).toBe(10);
	});

	it('refuses a list one row past the bound instead of truncating it', async () => {
		await expect(
			runListExport({
				definition: listOf(rows(11)).defined,
				principal: PRINCIPAL,
				bounds: { maxRows: 10, maxBytes: 1_000_000, pageLimit: 4 },
			}),
		).rejects.toMatchObject({ code: 'EXPORT_ROWS_EXCEEDED' });
	});

	it('refuses an export past the byte bound instead of truncating it', async () => {
		await expect(
			runListExport({
				definition: listOf(rows(100)).defined,
				principal: PRINCIPAL,
				bounds: { maxRows: 1_000, maxBytes: 64, pageLimit: 10 },
			}),
		).rejects.toMatchObject({ code: 'EXPORT_BYTES_EXCEEDED' });
	});

	it('refuses a byte bound the header alone would cross', async () => {
		await expect(
			runListExport({
				definition: listOf(rows(1)).defined,
				principal: PRINCIPAL,
				bounds: { maxRows: 10, maxBytes: 4 },
			}),
		).rejects.toMatchObject({ code: 'EXPORT_BYTES_EXCEEDED' });
	});

	it('counts bytes as UTF-8, not as characters', async () => {
		const defined = defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'name', header: 'N', value: (row) => row.name }],
			page: async () => ({
				rows: [{ id: 1, name: 'zażółć' }],
				nextCursor: null,
			}),
		});
		const result = await runListExport({
			definition: defined,
			principal: PRINCIPAL,
			bounds,
		});
		expect(result.bytes).toBe(result.body.byteLength);
		expect(result.bytes).toBeGreaterThan(text(result.body).length);
	});

	it('stops the walk when the claim is aborted', async () => {
		const controller = new AbortController();
		let pages = 0;
		const defined = defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'id', header: 'Id', value: (row) => row.id }],
			page: async (_principal, cursor) => {
				pages += 1;
				controller.abort(new Error('CLAIM_LOST'));
				const offset = cursor === null ? 0 : Number(cursor);
				return { rows: rows(1, offset), nextCursor: String(offset + 1) };
			},
		});
		await expect(
			runListExport({
				definition: defined,
				principal: PRINCIPAL,
				bounds,
				signal: controller.signal,
			}),
		).rejects.toThrow('CLAIM_LOST');
		expect(pages).toBe(1);
	});

	it('hands the list the requester it was started by', async () => {
		const seen: ListExportPrincipal[] = [];
		const defined = defineListExport<Row>({
			id: 'users.core.members',
			label: 'Members',
			permission: 'users.members.read',
			columns: [{ key: 'id', header: 'Id', value: (row) => row.id }],
			page: async (principal) => {
				seen.push(principal);
				return { rows: [], nextCursor: null };
			},
		});
		await runListExport({ definition: defined, principal: PRINCIPAL, bounds });
		expect(seen).toEqual([PRINCIPAL]);
	});

	it.each([0, -1, 1.5])('refuses the row bound %s', async (maxRows) => {
		await expect(
			runListExport({
				definition: listOf(rows(1)).defined,
				principal: PRINCIPAL,
				bounds: { maxRows, maxBytes: 1_000 },
			}),
		).rejects.toThrow('maxRows');
	});
});
