import { expect, it } from 'vitest';
import {
	parseInputFieldText,
	setInputValue,
	updateInputField,
	removeInputField,
} from '../src/client/input-model.ts';

it('preserves literal text and empty strings without coercing them to missing', () => {
	expect(parseInputFieldText('string', '')).toBe('');
	expect(parseInputFieldText('string', 'false')).toBe('false');
	expect(
		JSON.parse(setInputValue('{}', 'name', parseInputFieldText('string', ''))),
	).toEqual({ name: '' });
});
it('refuses incomplete JSON and values of the wrong declared type', () => {
	for (const [type, value] of [
		['object', '{'],
		['object', '[]'],
		['array', '{}'],
		['integer', '1.2'],
		['number', '"42"'],
		['boolean', '"false"'],
		['number', '1e999'],
	])
		expect(() => parseInputFieldText(type, value!)).toThrow();
	expect(parseInputFieldText('number', '-1.25')).toBe(-1.25);
	expect(parseInputFieldText('object', '{"amount":42}')).toEqual({
		amount: 42,
	});
	expect(parseInputFieldText('array', '[1,2]')).toEqual([1, 2]);
	expect(parseInputFieldText('boolean', 'false')).toBe(false);
});
it('keeps sibling values when changing or clearing one field', () => {
	expect(JSON.parse(setInputValue('{"a":1,"b":2}', 'a', undefined))).toEqual({
		b: 2,
	});
	expect(() => setInputValue('[1]', 'a', 2)).toThrow();
});
it('updates input metadata and required keys without duplicates or unsafe names', () => {
	const first = updateInputField(
		{},
		null,
		'amount',
		{ type: 'number', title: 'Amount' },
		true,
	);
	expect(first.required).toEqual(['amount']);
	expect(() => updateInputField(first, null, 'amount', {}, false)).toThrow();
	expect(() =>
		updateInputField(first, null, 'constructor', {}, false),
	).toThrow();
	const renamed = updateInputField(
		first,
		'amount',
		'total',
		{ type: 'number' },
		true,
	);
	expect(renamed.required).toEqual(['total']);
	expect(removeInputField(renamed, 'total')).toMatchObject({
		properties: {},
		required: [],
	});
});
