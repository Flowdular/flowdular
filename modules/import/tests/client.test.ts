import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { IMPORT_PERMISSIONS } from '../src/acl/permissions.ts';
import { IMPORT_MODES } from '../src/domain/ports.ts';
import {
	IMPORT_JOB_STATUSES,
	IMPORT_ROW_OUTCOMES,
	type ImportJobView,
} from '../src/domain/types.ts';
import { importNavigation, IMPORTS_VIEW } from '../src/client/navigation.ts';
import {
	modeLabel,
	outcomeLabel,
	outcomeTone,
	reasonLabel,
	statusLabel,
	statusTone,
} from '../src/client/presentation.ts';
import { jobTargets } from '../src/client/state.ts';

const LOCALES = ['en', 'pl'];

function job(target: string, id: string): ImportJobView {
	return {
		id,
		tenantId: 'tenant-a',
		target,
		documentId: 'document-1',
		documentRef: 'import-1',
		mode: 'create-only',
		dryRun: true,
		validOnly: false,
		status: 'completed',
		totalRows: 5,
		validRows: 4,
		writtenRows: 0,
		failedRows: 1,
		requesterAccountId: 'account-ada',
		columns: {},
		failureCode: null,
		startedAt: 1_760_000_000_000,
		completedAt: 1_760_000_001_000,
	};
}

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'import.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
});

afterAll(() => {
	setActiveLocale('en');
});

describe('the import navigation entry', () => {
	it('points at a view under Operations behind the read permission', () => {
		expect(importNavigation).toHaveLength(1);
		expect(importNavigation[0]).toMatchObject({
			id: 'import.navigation',
			viewId: IMPORTS_VIEW,
			group: 'Operations',
			scope: IMPORT_PERMISSIONS.read,
		});
	});

	it('reads its label again after the locale changes', () => {
		setActiveLocale('en');
		const english = importNavigation[0]!.label;
		setActiveLocale('pl');
		expect(importNavigation[0]!.label).not.toBe(english);
		setActiveLocale('en');
		expect(importNavigation[0]!.label).toBe(english);
	});
});

describe('the import screen copy', () => {
	it('translates every status, outcome and mode in both locales', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const status of IMPORT_JOB_STATUSES) {
				expect([locale, status, statusLabel(status)]).not.toContain(
					`import.status.${status}`,
				);
			}
			for (const outcome of IMPORT_ROW_OUTCOMES) {
				expect([locale, outcome, outcomeLabel(outcome)]).not.toContain(
					`import.outcome.${outcome}`,
				);
			}
			for (const mode of IMPORT_MODES) {
				expect([locale, mode, modeLabel(mode)]).not.toContain(
					`import.mode.${mode}`,
				);
			}
		}
		setActiveLocale('en');
	});

	it('gives a settled job a tone a reader can act on', () => {
		expect(statusTone('completed')).toBe('success');
		expect(statusTone('failed')).toBe('danger');
		expect(statusTone('parsing')).toBe('warning');
		expect(outcomeTone('created')).toBe('success');
		expect(outcomeTone('invalid')).toBe('danger');
		expect(outcomeTone('skipped')).toBe('neutral');
	});

	it('shows a port’s own reason when this module has no copy for it', () => {
		setActiveLocale('en');
		expect(reasonLabel('FIELD_REQUIRED')).toBe(
			translationsEn['reason.FIELD_REQUIRED'],
		);
		expect(reasonLabel('SOMETHING_ONLY_THE_PORT_KNOWS')).toBe(
			'SOMETHING_ONLY_THE_PORT_KNOWS',
		);
		expect(reasonLabel(null)).toBe('');
	});

	it('reads a failure code’s own sentence rather than showing the bare code', () => {
		setActiveLocale('en');
		/* A code this module refuses requests with can also settle a job, and one
		   sentence answers both, so a failed job never shows the raw code. */
		expect(reasonLabel('TARGET_FORBIDDEN')).toBe(
			translationsEn['error.code.TARGET_FORBIDDEN'],
		);
		expect(reasonLabel('CSV_TOO_MANY_ROWS')).toBe(
			translationsEn['reason.CSV_TOO_MANY_ROWS'],
		);
	});
});

describe('the list filter options', () => {
	it('offers each target once, in order', () => {
		expect(
			jobTargets([
				job('users.core.members', 'a'),
				job('catalog.core.items', 'b'),
				job('users.core.members', 'c'),
			]),
		).toEqual(['catalog.core.items', 'users.core.members']);
	});
});
