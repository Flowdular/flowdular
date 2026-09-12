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
	DOCUMENTS_VIEW,
} from '../src/client/navigation.ts';
import { byteLabel, scanLabel } from '../src/client/presentation.ts';
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
});
