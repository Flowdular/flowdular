import { readFileSync } from 'node:fs';
import { csvRecord } from '@flowdular/server';
import { describe, expect, it } from 'vitest';
import {
	applyMapping,
	assertMappingTarget,
	formatValue,
	readMapping,
} from '../src/domain/mapping.ts';
import { readPath, writePath } from '../src/domain/paths.ts';
import { recordedAnswer } from '../src/domain/recorded.ts';
import { parseCsvRecord } from '../src/services/csv-record.ts';

const PORT = {
	direction: 'source' as const,
	fields: [
		{ id: 'code', required: true },
		{ id: 'name', required: true },
		{ id: 'joined', required: false },
		{ id: 'tier', required: false },
		{ id: 'source', required: false },
	],
};

function mappingError(work: () => void): string {
	try {
		work();
	} catch (error) {
		return String((error as { code?: unknown }).code);
	}
	return 'ACCEPTED';
}

describe('ADAPTERS-MAPPING the mapping rules', () => {
	it('renames, writes constants, formats and looks values up, leaving absent values absent', () => {
		const rules = readMapping(
			[
				{ from: 'account.id', to: 'code', transform: 'rename' },
				{ from: 'title', to: 'name', transform: 'format', value: 'trim' },
				{
					from: 'since',
					to: 'joined',
					transform: 'format',
					value: 'date:DD.MM.YYYY',
				},
				{
					from: 'level',
					to: 'tier',
					transform: 'lookup',
					value: 'tier',
					table: { g: 'gold', s: 'silver' },
				},
				{ to: 'source', transform: 'constant', value: 'erp' },
			],
			'source',
		);
		assertMappingTarget(rules, PORT);
		expect(
			applyMapping(rules, {
				account: { id: 42 },
				title: '  Acme ',
				since: '01.02.2024',
				level: 'g',
			}),
		).toEqual({
			ok: true,
			values: {
				code: '42',
				name: 'Acme',
				joined: '2024-02-01',
				tier: 'gold',
				source: 'erp',
			},
		});
		expect(
			applyMapping(rules, { account: { id: 'A' }, title: 'B', level: null }),
		).toEqual({
			ok: true,
			values: { code: 'A', name: 'B', source: 'erp' },
		});
	});

	it('refuses a record each rule cannot write, with a stable code', () => {
		const rules = readMapping(
			[
				{ from: 'id', to: 'code', transform: 'rename' },
				{ from: 'since', to: 'joined', transform: 'format', value: 'iso-date' },
				{
					from: 'level',
					to: 'tier',
					transform: 'lookup',
					table: { g: 'gold' },
				},
			],
			'source',
		);
		expect(applyMapping(rules, { id: { nested: true } })).toEqual({
			ok: false,
			field: 'code',
			code: 'MAPPING_VALUE_INVALID',
		});
		expect(applyMapping(rules, { id: 'x'.repeat(2001) })).toMatchObject({
			code: 'MAPPING_VALUE_INVALID',
		});
		expect(applyMapping(rules, { id: 'A', since: '2024-02-30' })).toEqual({
			ok: false,
			field: 'joined',
			code: 'MAPPING_FORMAT_INVALID',
		});
		expect(applyMapping(rules, { id: 'A', level: 'toString' })).toEqual({
			ok: false,
			field: 'tier',
			code: 'MAPPING_LOOKUP_UNMATCHED',
		});
	});

	it('parses every named format and refuses what does not parse', () => {
		expect(
			[
				['lower', ' ABC '],
				['upper', 'abc'],
				['integer', '-0042'],
				['integer', '4.2'],
				['decimal', '12,50'],
				['decimal', '1.2.3'],
				['boolean', 'Yes'],
				['boolean', 'maybe'],
				['iso-date', '2026-09-16T10:00:00Z'],
				['date:YYYY/MM/DD', '2026/09/16'],
				['date:MM-DD-YYYY', '13-01-2026'],
			].map(([format, value]) => formatValue(format!, value!)),
		).toEqual([
			'abc',
			'ABC',
			'-42',
			null,
			'12.50',
			null,
			'true',
			null,
			'2026-09-16',
			'2026-09-16',
			null,
		]);
	});

	it('answers MAPPING_INVALID for a mapping that cannot hold against the port or the list', () => {
		const rename = { from: 'id', to: 'code', transform: 'rename' };
		const name = { from: 'title', to: 'name', transform: 'rename' };
		expect(
			mappingError(() =>
				assertMappingTarget(
					readMapping(
						[rename, name, { from: 'x', to: 'unknown', transform: 'rename' }],
						'source',
					),
					PORT,
				),
			),
		).toBe('MAPPING_INVALID');
		expect(
			mappingError(() =>
				assertMappingTarget(readMapping([rename], 'source'), PORT),
			),
		).toBe('MAPPING_INVALID');
		expect(
			mappingError(() =>
				readMapping(
					[{ from: 'id', to: 'code', transform: 'format', value: 'roman' }],
					'source',
				),
			),
		).toBe('MAPPING_INVALID');
		expect(
			mappingError(() =>
				readMapping([rename, { ...rename, from: 'other' }], 'source'),
			),
		).toBe('MAPPING_INVALID');
		expect(
			mappingError(() =>
				readMapping([{ to: 'code', transform: 'constant' }], 'source'),
			),
		).toBe('MAPPING_INVALID');
		expect(
			mappingError(() =>
				assertMappingTarget(
					readMapping(
						[{ from: 'missing', to: 'id', transform: 'rename' }],
						'sink',
					),
					{
						direction: 'sink',
						columns: ['code'],
					},
				),
			),
		).toBe('MAPPING_INVALID');
	});
});

describe('the building blocks a run relies on', () => {
	it('reads back every record the list export writer serializes', () => {
		for (const cells of [
			['plain', '', 'with, comma', 'with "quote"', 'line\r\nbreak', ''],
			[''],
			['a'],
		]) {
			expect(parseCsvRecord(csvRecord(cells))).toEqual(cells);
		}
	});

	it('reads and writes dotted paths without touching the object it was given', () => {
		const input = { path: '/v', query: { limit: 2 } };
		const written = writePath(input, 'query.cursor', 'c2');
		expect(written).toEqual({ path: '/v', query: { limit: 2, cursor: 'c2' } });
		expect(input).toEqual({ path: '/v', query: { limit: 2 } });
		expect(readPath({ a: { b: [1] } }, 'a.b')).toEqual([1]);
		expect(readPath({ a: 1 }, 'a.b')).toBeUndefined();
		expect(readPath([1, 2], '')).toEqual([1, 2]);
	});

	it('matches a recorded call exactly first and by the keys it names second', () => {
		const fixture = {
			adapter: 'vendors.core.x',
			operation: 'post',
			calls: [
				{ input: { path: '/import' }, body: { any: true } },
				{
					input: { path: '/import', body: { records: [] } },
					body: { empty: true },
				},
			],
		};
		expect(
			recordedAnswer(fixture, { path: '/import', body: { records: [] } }),
		).toEqual({
			empty: true,
		});
		expect(
			recordedAnswer(fixture, { path: '/import', body: { records: [1] } }),
		).toEqual({
			any: true,
		});
		expect(recordedAnswer(fixture, { path: '/other' })).toBeUndefined();
	});

	it('keeps the cron grammar identical to automations.core', () => {
		expect(
			readFileSync(new URL('../src/domain/cron.ts', import.meta.url), 'utf8'),
		).toBe(
			readFileSync(
				new URL('../../automations/src/domain/cron.ts', import.meta.url),
				'utf8',
			),
		);
	});
});
