import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	expiryFieldValue,
	expiryToTimestamp,
	outcomeTone,
	reasonLabel,
	rotateAction,
	tableEmpty,
	timestampLabel,
	tokenDisplayStatus,
	tokenStatusLabel,
	tokenStatusTone,
} from '../src/client/presentation.ts';

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'directory.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterAll(() => {
	setActiveLocale('en');
});

describe('directory presentation', () => {
	it('separates a refusal from an applied and an unchanged outcome', () => {
		expect(outcomeTone('applied')).toBe('success');
		expect(outcomeTone('unchanged')).toBe('neutral');
		expect(outcomeTone('refused')).toBe('danger');
		expect(tokenStatusTone('active')).toBe('success');
		expect(tokenStatusTone('revoked')).toBe('neutral');
	});

	it('reads a token that has never been used as never', () => {
		expect(timestampLabel(null)).toBe('Never');
		expect(timestampLabel(Date.UTC(2026, 0, 2, 10, 30))).not.toBe('Never');
	});

	/* A reason code this build does not know still has to reach the reader
	   rather than render as an empty cell. */
	it('shows an unknown reason code as it arrived', () => {
		expect(reasonLabel('LAST_OWNER')).not.toBe('LAST_OWNER');
		expect(reasonLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
		expect(reasonLabel(null)).toBe('');
		expect(reasonLabel('')).toBe('');
	});

	it('turns the expiry control value into a timestamp or nothing', () => {
		expect(expiryToTimestamp('')).toBeNull();
		expect(expiryToTimestamp('   ')).toBeNull();
		expect(expiryToTimestamp('not a date')).toBeNull();
		expect(expiryToTimestamp('2026-06-01T12:00')).toBe(
			Date.parse('2026-06-01T12:00'),
		);
	});
});

describe('directory token status', () => {
	const token = {
		status: 'active' as const,
		expiresAt: Date.UTC(2026, 0, 2, 10, 30),
	};

	/* An active token past its expiry authenticates nothing, so the row must
	   not read the same as one that still works. */
	it('separates an expired token from an active and a revoked one', () => {
		expect(tokenDisplayStatus(token, token.expiresAt - 1)).toBe('active');
		expect(tokenDisplayStatus(token, token.expiresAt)).toBe('expired');
		expect(tokenDisplayStatus({ status: 'active', expiresAt: null })).toBe(
			'active',
		);
		expect(tokenDisplayStatus({ status: 'revoked', expiresAt: null }, 0)).toBe(
			'revoked',
		);
		expect(tokenStatusTone('expired')).toBe('warning');
		expect(tokenStatusLabel('expired')).not.toBe(
			'directory.tokens.status.expired',
		);
	});

	/* A reader who cannot see the greyed button hears the action's name and its
	   description. An action whose name changes under it is a different action,
	   so the refusal belongs in the reason and never in the label. */
	it('names the rotate action the same way whatever the token is', () => {
		const live = rotateAction(token, token.expiresAt - 1);
		const expired = rotateAction(token, token.expiresAt);

		expect(live).toEqual({
			label: t('directory.tokens.action.rotate'),
			disabled: false,
			reason: '',
		});
		expect(expired.label).toBe(live.label);
		expect(expired.disabled).toBe(true);
		expect(expired.reason).not.toBe('');
		expect(expired.reason).not.toContain(live.label);
	});

	it('round trips the expiry field value through the timestamp it submits', () => {
		const at = Date.UTC(2026, 5, 1, 12, 34, 56);
		const field = expiryFieldValue(at);
		expect(field).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		/* The control holds whole minutes, so the reading loses the seconds. */
		expect(expiryToTimestamp(field)).toBe(at - (at % 60_000));
	});
});

describe('table placeholder', () => {
	const populated = {
		icon: 'key',
		title: 'No tokens yet',
		hint: 'Create one.',
	};

	/* A failed load read nothing, so it must not answer with a statement about
	   what the workspace holds. */
	it('replaces the empty state when the screen is in error', () => {
		expect(tableEmpty('idle', populated)).toBe(populated);
		expect(tableEmpty('loading', populated)).toBe(populated);
		const failed = tableEmpty('error', populated);
		expect(failed).not.toBe(populated);
		expect(failed.title).not.toBe(populated.title);
		expect(failed.title).not.toBe('directory.common.loadFailed');
	});
});
