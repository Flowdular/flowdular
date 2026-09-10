import { beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	auditDetails,
	auditStamp,
	auditTone,
} from '../src/client/audit/audit-row.ts';
import type { AuditRow } from '../src/client/audit/api.ts';

function row(metadata: Readonly<Record<string, unknown>>): AuditRow {
	return {
		id: 'evt_1',
		occurredAt: 0,
		actor: 'admin@example.com',
		action: 'auth.sign-in',
		subjectType: 'account',
		subjectId: 'acc_1',
		metadata,
	};
}

describe('audit row presentation', () => {
	beforeAll(() => {
		registerModuleTranslations([
			{
				moduleId: 'auth.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('en');
	});

	it('formats the timestamp in the active locale', () => {
		const value = Date.UTC(2026, 8, 1, 14, 5, 9);
		expect(auditStamp(value)).toBe(
			new Intl.DateTimeFormat('en', {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(value),
		);
	});

	it('ranks failure over removal over sign-in traffic', () => {
		expect(auditTone('auth.sign-in.failed')).toBe('danger');
		expect(auditTone('auth.account.locked')).toBe('danger');
		expect(auditTone('users.member.removed')).toBe('warning');
		expect(auditTone('roles.role.deleted')).toBe('warning');
		expect(auditTone('auth.sign-in')).toBe('info');
		expect(auditTone('auth.sign-out')).toBe('info');
		expect(auditTone('catalog.item.created')).toBe('neutral');
	});

	it('summarizes metadata and counts array values instead of listing them', () => {
		expect(auditDetails(row({}))).toBe('');
		expect(auditDetails(row({ role: 'owner', count: 2 }))).toBe(
			'role: owner · count: 2',
		);
		expect(auditDetails(row({ scopes: ['a', 'b', 'c'] }))).toBe(
			'scopes: 3 items',
		);
	});
});
