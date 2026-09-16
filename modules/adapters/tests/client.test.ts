import { describe, expect, it } from 'vitest';
import { draftOf, rulesOf } from '../src/client/mapping-form.ts';
import { readMapping } from '../src/domain/mapping.ts';

describe('the mapping editor of the Data adapters screen', () => {
	it('turns the edited rows back into the rules the server reads, dropping blank rows', () => {
		const declared = readMapping(
			[
				{ from: 'id', to: 'code', transform: 'rename' },
				{ to: 'source', transform: 'constant', value: 'erp' },
				{
					from: 'level',
					to: 'tier',
					transform: 'lookup',
					table: { g: 'gold' },
				},
			],
			'source',
		);
		const drafts = [
			...declared.map(draftOf),
			{ ...draftOf(null), to: '   ' },
			{
				...draftOf(null),
				to: 'joined',
				transform: 'format' as const,
				from: 'since',
				value: 'date:DD.MM.YYYY',
			},
		];
		const lookup = drafts[2]!;
		drafts[2] = {
			...lookup,
			table: `${lookup.table}\ns=silver\nbroken line\n__proto__=x`,
		};
		const rules = rulesOf(drafts);
		expect(rules).toEqual([
			{ to: 'code', transform: 'rename', from: 'id' },
			{ to: 'source', transform: 'constant', value: 'erp' },
			{
				to: 'tier',
				transform: 'lookup',
				from: 'level',
				table: { g: 'gold', s: 'silver', ['__proto__']: 'x' },
			},
			{
				to: 'joined',
				transform: 'format',
				from: 'since',
				value: 'date:DD.MM.YYYY',
			},
		]);
		expect(() =>
			readMapping(JSON.parse(JSON.stringify(rules)), 'source'),
		).not.toThrow();
		expect(Object.getPrototypeOf(rules[2]!.table)).toBe(Object.prototype);
	});
});
