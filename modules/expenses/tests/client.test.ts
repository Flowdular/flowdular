import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	amountToMinorUnits,
	expenseCategoryLabel,
	expenseStatusLabel,
	expenseStatusTone,
	formatExpenseAmount,
	showsExpenseActionColumn,
} from '../src/client/expense-claims.ts';
import { EXPENSE_NOTE_VARIABLES } from '../src/domain/variables.ts';

describe('expense claim client helpers', () => {
	it('ships the same translation keys in English and Polish', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('translates the variable picker and every note variable label', () => {
		registerModuleTranslations([
			{
				moduleId: 'expenses.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const key of [
				'expenses.template.insert',
				'expenses.template.available',
				'expenses.template.empty',
				'expenses.template.sample.title',
				...EXPENSE_NOTE_VARIABLES.map(
					(variable) => 'expenses.variables.' + variable.key + '.label',
				),
			]) {
				expect(t(key)).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('translates every dynamic status and category label', () => {
		registerModuleTranslations([
			{
				moduleId: 'expenses.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		expect(expenseCategoryLabel('equipment')).toBe('Wyposażenie');
		expect(expenseStatusLabel('submitted')).toBe('Wysłane');
		expect(t('expenses.status.draft')).toBe('Wersja robocza');
		expect(t('expenses.status.approved')).toBe('Zatwierdzone');
		expect(t('expenses.status.rejected')).toBe('Odrzucone');
		expect(t('expenses.category.travel')).toBe('Podróż');
		expect(t('expenses.category.meals')).toBe('Posiłki');
		expect(t('expenses.category.other')).toBe('Inne');
		setActiveLocale('en');
	});

	it('translates every value written to claim history', () => {
		registerModuleTranslations([
			{
				moduleId: 'expenses.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const action of [
				'created',
				'updated',
				'submitted',
				'deleted',
				'approved',
				'rejected',
			]) {
				const key = 'expenses.history.action.' + action;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const actor of ['user', 'agent']) {
				const key = 'expenses.history.actor.' + actor;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			const serviceKey = 'expenses.history.actor.serviceConfiguredBy';
			expect(
				t(serviceKey, { name: 'Ada' }),
				`${locale}: ${serviceKey}`,
			).not.toBe(serviceKey);
			for (const field of [
				'title',
				'amountMinor',
				'currency',
				'category',
				'expenseDate',
				'note',
				'noteTemplate',
				'status',
				'decisionComment',
			]) {
				const key = 'expenses.history.field.' + field;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it.each([
		['0', 0],
		['1', 100],
		['12.5', 1_250],
		['12.50', 1_250],
		[' 19.99 ', 1_999],
	])('converts %s to minor units', (value, expected) => {
		expect(amountToMinorUnits(value)).toBe(expected);
	});

	it.each(['', '-1', '1.001', 'value', '1,50'])(
		'rejects invalid amount %s',
		(value) => {
			expect(amountToMinorUnits(value)).toBeNull();
		},
	);

	it('formats amount, category, and status display values', () => {
		expect(formatExpenseAmount(1_250, 'EUR')).toMatch(/12[.,]50/);
		expect(expenseCategoryLabel('equipment')).toBe('Equipment');
		expect(expenseStatusLabel('submitted')).toBe('Submitted');
		expect(expenseStatusTone('submitted')).toBe('warning');
		expect(expenseStatusTone('approved')).toBe('success');
		expect(expenseStatusTone('rejected')).toBe('danger');
		expect(expenseStatusTone('draft')).toBe('neutral');
	});

	it('keeps the action column stable for every action-capable principal', () => {
		expect(showsExpenseActionColumn(false, false)).toBe(false);
		expect(showsExpenseActionColumn(true, false)).toBe(true);
		expect(showsExpenseActionColumn(false, true)).toBe(true);
		expect(showsExpenseActionColumn(true, true)).toBe(true);
	});
});
