import { describe, expect, it } from 'vitest';
import {
	pluralFamilyIssues,
	requiredPluralCategories,
	translationKeys,
} from '../src/translations.ts';

const EN = {
	'table.title': 'Documents',
	'table.count.one': '{count} document',
	'table.count.other': '{count} documents',
};

const PL = {
	'table.title': 'Dokumenty',
	'table.count.one': '{count} dokument',
	'table.count.few': '{count} dokumenty',
	'table.count.many': '{count} dokumentów',
	'table.count.other': '{count} dokumentu',
};

describe('plural families', () => {
	it('derives the categories a whole-number count selects', () => {
		expect(requiredPluralCategories('en')).toEqual(['one', 'other']);
		expect(requiredPluralCategories('pl')).toEqual([
			'one',
			'few',
			'many',
			'other',
		]);
		expect(requiredPluralCategories('fr')).toEqual(['one', 'many', 'other']);
		expect(requiredPluralCategories('ja')).toEqual(['other']);
	});

	it('folds each family into its base key so en and pl compare equal', () => {
		expect(translationKeys(EN)).toEqual(['table.count', 'table.title']);
		expect(translationKeys(PL)).toEqual(translationKeys(EN));
	});

	it('keeps a category-named key without an other sibling as its own key', () => {
		expect(translationKeys({ 'status.one': 'One', 'status.two': 'Two' })).toEqual(
			['status.one', 'status.two'],
		);
	});

	it('still tells a family apart from a plain key of the same name', () => {
		expect(translationKeys({ 'table.count': '{count} documents' })).not.toEqual(
			translationKeys(EN),
		);
	});

	it('accepts complete families', () => {
		expect(pluralFamilyIssues(EN, 'en')).toEqual([]);
		expect(pluralFamilyIssues(PL, 'pl')).toEqual([]);
	});

	it('reports a Polish family that copies the English forms', () => {
		expect(pluralFamilyIssues(EN, 'pl')).toEqual([
			'table.count lacks table.count.few, table.count.many for pl',
		]);
	});

	it('reports a category the locale never selects', () => {
		expect(pluralFamilyIssues(PL, 'en')).toEqual([
			'table.count.few is never selected for en',
			'table.count.many is never selected for en',
		]);
	});
});
