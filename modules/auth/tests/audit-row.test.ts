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
import type { ErrorReport, ModuleMetrics } from '@flowdular/server';
import { AuthService } from '../src/services/auth-service.ts';
import type { AuthRepository } from '../src/services/repository.ts';

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

describe('audit write failures', () => {
	it('counts the failed write and reports it without the driver detail', async () => {
		const counters: { name: string; labels: Record<string, string> }[] = [];
		const reports: ErrorReport[] = [];
		const metrics: ModuleMetrics = {
			counter: (name, labels) => counters.push({ name, labels: { ...labels } }),
			histogram: () => undefined,
		};
		const driverDetail =
			'insert failed: bound value "secret@example.com" for column actor_label';
		const repository = {
			appendAudit: () => Promise.reject(new Error(driverDetail)),
		} as unknown as AuthRepository;
		const service = new AuthService(repository, {
			now: () => 1_000,
			metrics,
			errorSink: {
				kind: 'none',
				report: (report) => void reports.push(report),
				flush: () => Promise.resolve(),
				stats: () => ({ queued: 0, delivered: 0, dropped: 0, failures: 0 }),
				dispose: () => Promise.resolve(),
			},
		});

		await expect(
			service.recordSettingsUpdate(
				{
					accountId: 'acc_1',
					tenantId: 'tenant-a',
					email: 'secret@example.com',
					role: 'owner',
					scopes: [],
				},
				{
					moduleId: 'auth.core',
					key: 'allowSignUp',
					tenantId: 'tenant-a',
					cleared: false,
					previous: false,
					next: true,
					actor: { accountId: 'acc_1', tenantId: 'tenant-a' },
				},
			),
		).resolves.toBeUndefined();

		expect(counters).toEqual([
			{
				name: 'audit_write_failures_total',
				labels: { action: 'settings.updated' },
			},
		]);
		expect(reports).toEqual([
			{
				at: 1_000,
				name: 'AuditWriteFailed',
				module: 'auth.core',
				message: 'Audit write failed for settings.updated.',
			},
		]);
		expect(JSON.stringify(reports)).not.toContain('secret@example.com');
		expect(JSON.stringify(reports)).not.toContain('insert failed');
	});
});
