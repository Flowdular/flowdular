import { describe, expect, it } from 'vitest';
import {
	domPropertyMisspellings,
	fixDomPropertyMisspellings,
} from '../src/dom-properties.ts';

describe('DOM property spelling', () => {
	it('finds lowercase properties on host elements with their lines', () => {
		const source = [
			'export function Form() @{',
			'\t<input class="ui-input" maxlength={props.limit} autoComplete="off" />',
			"\t<div tabindex={active ? 0 : -1} onClick={() => select('a>b')}>",
			'\t\t<textarea spellcheck={false} readonly />',
			'\t</div>',
			'}',
		].join('\n');
		expect(
			domPropertyMisspellings(source).map((found) => [
				found.line,
				found.name,
				found.expected,
			]),
		).toEqual([
			[2, 'maxlength', 'maxLength'],
			[3, 'tabindex', 'tabIndex'],
			[4, 'spellcheck', 'spellCheck'],
		]);
	});

	it('leaves components, expressions and quoted values alone', () => {
		const source = [
			'<Field maxlength={4} />',
			'<input value={"maxlength=4"} placeholder="tabindex=1" />',
			'<button onClick={() => { const tabindex= 1; }} type="button">x</button>',
			'<label for="name">Name</label>',
		].join('\n');
		expect(domPropertyMisspellings(source)).toEqual([]);
	});

	it('renames every misspelling and nothing else', () => {
		const source =
			'<input maxlength={120} autocomplete="email" inputmode="numeric" data-maxlength="1" />';
		expect(fixDomPropertyMisspellings(source)).toBe(
			'<input maxLength={120} autoComplete="email" inputMode="numeric" data-maxlength="1" />',
		);
	});
});
