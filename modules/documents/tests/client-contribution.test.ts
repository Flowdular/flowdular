import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { DOCUMENTS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { DocumentAttachment } from '../src/domain/attachments.ts';
import {
	documentsNavigation,
	DOCUMENT_TEMPLATES_VIEW,
	DOCUMENTS_VIEW,
} from '../src/client/navigation.ts';
import {
	byteLabel,
	scanLabel,
	textPageList,
	textReasonLabel,
	textRetryable,
	textStatusLabel,
} from '../src/client/presentation.ts';
import type { DocumentText } from '../src/domain/text.ts';
import { ownerModules } from '../src/client/state.ts';

const LOCALES = ['en', 'pl'];

const DOCUMENT: DocumentAttachment = {
	id: 'document-0001',
	ownerModule: 'directory.core',
	recordRef: 'party-4711',
	filename: 'contract.pdf',
	contentType: 'application/pdf',
	bytes: 1_024,
	checksum: 'sha256:0',
	scan: 'clean',
	status: 'stored',
	uploaderAccountId: 'account-ada',
	description: null,
	createdAt: 1_760_000_000_000,
};

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'documents.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterAll(() => {
	setActiveLocale('en');
});

describe('documents client contribution', () => {
	it('places the screen in Workspace behind the read permission', () => {
		expect(
			documentsNavigation.map((entry) => [
				entry.id,
				entry.viewId,
				entry.group,
				entry.scope,
			]),
		).toEqual([
			[
				'documents.navigation',
				DOCUMENTS_VIEW,
				'Workspace',
				DOCUMENTS_PERMISSIONS.read,
			],
			[
				'documents.navigation.templates',
				DOCUMENT_TEMPLATES_VIEW,
				'Administration',
				DOCUMENTS_PERMISSIONS.templatesRead,
			],
		]);
	});

	it('DOCUMENTS-TEMPLATES-SCREEN puts Templates in the platform section of Administration behind the templates read permission', () => {
		const entry = documentsNavigation.find(
			(candidate) => candidate.viewId === DOCUMENT_TEMPLATES_VIEW,
		);
		expect([entry?.group, entry?.section, entry?.scope, entry?.glyph]).toEqual([
			'Administration',
			'platform',
			DOCUMENTS_PERMISSIONS.templatesRead,
			'file-text',
		]);
	});

	/* A label read through a missing key renders the key itself, so both locales
	   have to answer with copy rather than with `documents.navigation.label`. */
	it('resolves its navigation copy in every shipped locale', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const entry of documentsNavigation) {
				expect([locale, entry.label.includes('documents.')]).toEqual([
					locale,
					false,
				]);
				expect([locale, (entry.description ?? '').length > 0]).toEqual([
					locale,
					true,
				]);
			}
		}
	});

	it('reads a size in the unit a person expects', () => {
		setActiveLocale('en');
		expect([
			byteLabel(512),
			byteLabel(2048),
			byteLabel(5 * 1024 * 1024),
		]).toEqual(['512 B', '2 KB', '5 MB']);
	});

	it('names every scan verdict without falling back to the raw key', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const scan of ['unscanned', 'clean', 'infected'] as const) {
				expect([locale, scan, scanLabel(scan).includes('documents.')]).toEqual([
					locale,
					scan,
					false,
				]);
			}
		}
	});

	it('offers one filter option per owner module present', () => {
		const documents = ['users.core', 'directory.core', 'users.core'].map(
			(ownerModule) => ({ ...DOCUMENT, ownerModule }),
		);
		expect(ownerModules(documents)).toEqual(['directory.core', 'users.core']);
	});

	it('shows the text page by page with numbers from the first page answered', () => {
		const text: DocumentText = {
			status: 'ok',
			reason: null,
			text: 'Terms\fSignatures',
			pages: 3,
			from: 2,
			to: 3,
			truncated: false,
			contentSha256: '0'.repeat(64),
		};
		expect(textPageList(text)).toEqual([
			{ number: 2, text: 'Terms' },
			{ number: 3, text: 'Signatures' },
		]);
		expect(textPageList({ ...text, text: '', to: 1 })).toEqual([]);
		expect(textPageList({ ...text, status: 'pending' })).toEqual([]);
	});

	it('offers Retry only to a manager for unscanned text while OCR is available', () => {
		const unscanned = { status: 'unscanned' as const, ocrAvailable: true };
		expect(textRetryable(unscanned, true)).toBe(true);
		expect(textRetryable(unscanned, false)).toBe(false);
		expect(textRetryable({ ...unscanned, ocrAvailable: false }, true)).toBe(
			false,
		);
		expect(textRetryable({ ...unscanned, status: 'ok' }, true)).toBe(false);
	});

	it('names every text status and reason without falling back to the raw key', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const status of [
				'ok',
				'pending',
				'unscanned',
				'unsupported',
				'too-large',
			] as const) {
				expect([
					locale,
					textStatusLabel(status).includes('documents.'),
				]).toEqual([locale, false]);
			}
			expect(textReasonLabel('DOCUMENT_OCR_UNCONFIGURED')).not.toBe(
				'DOCUMENT_OCR_UNCONFIGURED',
			);
			expect(textReasonLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
		}
	});
});
