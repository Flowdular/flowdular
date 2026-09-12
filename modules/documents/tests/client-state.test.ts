import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import type { DocumentAttachment } from '../src/domain/attachments.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	downloadRefusal,
	tableEmpty,
	uploadRefusal,
} from '../src/client/presentation.ts';
import {
	mergeDocumentPage,
	mergeOwnerModules,
	ownerModules,
	searchPending,
} from '../src/client/state.ts';

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

function attachment(
	id: string,
	overrides: Partial<DocumentAttachment> = {},
): DocumentAttachment {
	return {
		id,
		ownerModule: 'directory.core',
		recordRef: 'party-4711',
		filename: id + '.pdf',
		contentType: 'application/pdf',
		bytes: 1_024,
		checksum: null,
		scan: 'clean',
		status: 'stored',
		uploaderAccountId: 'account-ada',
		description: null,
		createdAt: Date.UTC(2026, 2, 1),
		...overrides,
	};
}

describe('documents list state', () => {
	/* A page continues the listing the reader walked; a new listing replaces
	   it, so a changed filter can never mix two result sets. */
	it('appends a page or replaces the listing', () => {
		const first = [attachment('a'), attachment('b')];
		const second = [attachment('c')];
		expect(
			mergeDocumentPage(first, second, true).map((entry) => entry.id),
		).toEqual(['a', 'b', 'c']);
		expect(
			mergeDocumentPage(first, second, false).map((entry) => entry.id),
		).toEqual(['c']);
	});

	/* The filter's options come from every page seen, not from the one on
	   screen: an option that disappears as the reader pages is not a filter. */
	it('keeps the owner modules of every page it has seen', () => {
		const seen = mergeOwnerModules(
			[],
			[attachment('a'), attachment('b', { ownerModule: 'users.core' })],
		);
		expect(seen).toEqual(['directory.core', 'users.core']);
		expect(
			mergeOwnerModules(seen, [attachment('c', { ownerModule: 'audit.core' })]),
		).toEqual(['audit.core', 'directory.core', 'users.core']);
		expect(ownerModules([attachment('a'), attachment('b')])).toEqual([
			'directory.core',
		]);
	});

	/* The term is a query filter, so the rows on screen answer it only once a
	   listing was loaded with it: the screen never narrows a page itself. */
	it('holds a typed term pending until a listing was loaded with it', () => {
		expect(searchPending('invoice', '')).toBe(true);
		expect(searchPending('invoice', 'invoice')).toBe(false);
		/* The term is sent trimmed, so the space that follows it asks nothing. */
		expect(searchPending('invoice  ', 'invoice')).toBe(false);
		expect(searchPending('   ', '')).toBe(false);
		/* Clearing the box is a request of its own: the unnarrowed listing. */
		expect(searchPending('', 'invoice')).toBe(true);
	});
});

describe('documents placeholders and refusals', () => {
	it('replaces the empty state when the screen is in error', () => {
		const populated = {
			icon: 'file-text',
			title: 'No documents yet',
			hint: 'Upload one.',
		};
		expect(tableEmpty('idle', populated)).toBe(populated);
		const failed = tableEmpty('error', populated);
		expect(failed.title).not.toBe(populated.title);
		expect(failed.title).not.toBe('documents.loadFailed.title');
	});

	it('says why a row cannot be downloaded', () => {
		expect(downloadRefusal(attachment('a'))).toBe('');
		expect(downloadRefusal(attachment('a', { scan: 'infected' }))).not.toBe('');
		expect(downloadRefusal(attachment('a', { status: 'deleted' }))).not.toBe(
			'',
		);
	});

	/* The port refuses an oversized file after it has been sent; the screen
	   states the same ceiling before it spends the upload. */
	it('refuses a file past the object limit and nothing below it', () => {
		expect(uploadRefusal(1_024, 4_096)).toBe('');
		expect(uploadRefusal(4_096, 4_096)).toBe('');
		const refused = uploadRefusal(4_097, 4_096);
		expect(refused).not.toBe('');
		expect(refused).toContain('4 KB');
		/* Limits the screen could not read leave the decision to the server. */
		expect(uploadRefusal(Number.MAX_SAFE_INTEGER, null)).toBe('');
	});
});
