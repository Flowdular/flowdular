import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	dispositionFilename,
	type TemplateListItem,
} from '../src/client/templates-api.ts';
import {
	DIFF_CELL_LIMIT,
	draftIssues,
	issueLabel,
	layoutDraft,
	layoutFromDraft,
	lineDiff,
	lineNumbers,
	opensInViewer,
	originLabel,
	parseSampleInput,
	sampleInputText,
	schemaSkeleton,
	versionLabel,
} from '../src/client/templates-presentation.ts';
import { matchingTemplates } from '../src/client/templates-state.ts';
import { DOCUMENT_TEMPLATE_ORIGINS } from '../src/domain/templates.ts';
import { OFFER_BODY, OFFER_SCHEMA } from './support/templates.ts';

const LOCALES = ['en', 'pl'];

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

const LAYOUT = {
	pageSize: 'A4' as const,
	margins: { top: 20, right: 15, bottom: 25, left: 15 },
	header: null,
	footer: 'Page {{ page }} of {{ pages }}',
	title: 'Offer {{ customer }}',
};

describe('templates presentation', () => {
	it('numbers every line of the body, an empty one included', () => {
		expect(lineNumbers('')).toEqual([1]);
		expect(lineNumbers('# Title\n\nText\n')).toEqual([1, 2, 3, 4]);
	});

	it('diffs two bodies by line around the common head and tail', () => {
		expect(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'added', text: 'B' },
			{ kind: 'removed', text: 'b' },
			{ kind: 'same', text: 'c' },
			{ kind: 'same', text: 'd' },
			{ kind: 'added', text: 'e' },
		]);
		expect(lineDiff('x', 'x')).toEqual([{ kind: 'same', text: 'x' }]);
		expect(
			lineDiff('', 'one\ntwo').filter((line) => line.kind === 'added'),
		).toHaveLength(2);
	});

	it('keeps the matched lines in order through the LCS', () => {
		const before = ['h', '1', '2', '3', '4', 't'].join('\n');
		const after = ['h', '0', '2', '3', '5', 't'].join('\n');
		const diff = lineDiff(before, after);
		expect(
			diff.filter((line) => line.kind !== 'added').map((line) => line.text),
		).toEqual(before.split('\n'));
		expect(
			diff.filter((line) => line.kind !== 'removed').map((line) => line.text),
		).toEqual(after.split('\n'));
		expect(
			diff.filter((line) => line.kind === 'same').map((line) => line.text),
		).toEqual(['h', '2', '3', 't']);
	});

	it('shows a pair past the table bound as removed then added instead of building the table', () => {
		const size = Math.ceil(Math.sqrt(DIFF_CELL_LIMIT)) + 1;
		const before = Array.from({ length: size }, (_, index) => `a${index}`).join(
			'\n',
		);
		const after = Array.from({ length: size }, (_, index) => `b${index}`).join(
			'\n',
		);
		const diff = lineDiff(before, after);
		expect(diff).toHaveLength(size * 2);
		expect(diff[0]).toEqual({ kind: 'removed', text: 'a0' });
		expect(diff[size]).toEqual({ kind: 'added', text: 'b0' });
	});

	it('starts a sample input from the shape of the schema', () => {
		expect(schemaSkeleton(OFFER_SCHEMA)).toEqual({
			customer: '',
			currency: 'PLN',
			items: [{ name: '', price: 0 }],
		});
		expect(JSON.parse(sampleInputText(OFFER_SCHEMA))).toEqual(
			schemaSkeleton(OFFER_SCHEMA),
		);
		expect(parseSampleInput('{"customer":"x"}')).toEqual({
			value: { customer: 'x' },
			error: '',
		});
		expect(parseSampleInput('{').error).not.toBe('');
		expect(parseSampleInput('{').error).not.toContain('documents.');
	});

	it('round trips a layout through the editor fields, a blank margin keeping the default', () => {
		const draft = layoutDraft(LAYOUT);
		expect(draft).toMatchObject({
			top: '20',
			header: '',
			footer: LAYOUT.footer,
		});
		expect(layoutFromDraft(draft)).toEqual(LAYOUT);
		expect(
			layoutFromDraft({ ...draft, left: ' ', header: '  ' }),
		).toMatchObject({
			margins: { left: 20 },
			header: null,
		});
	});

	it('validates a draft in the browser with the line an error sits on', () => {
		const base = {
			inputSchema: OFFER_SCHEMA,
			locale: 'pl' as const,
			format: 'pdf' as const,
		};
		expect(draftIssues(OFFER_BODY, layoutDraft(LAYOUT), base, 'Offer')).toEqual(
			[],
		);
		const issues = draftIssues(
			'# Title\n\n<b>x</b>',
			layoutDraft(LAYOUT),
			base,
			'Offer',
		);
		expect(issues.map((issue) => [issue.code, issue.line])).toEqual([
			['TEMPLATE_HTML', 3],
		]);
		const layoutIssues = draftIssues(
			OFFER_BODY,
			{ ...layoutDraft(LAYOUT), top: '2', footer: '{{ secret }}' },
			base,
			'Offer',
		);
		expect(layoutIssues.map((issue) => [issue.code, issue.field])).toEqual([
			['TEMPLATE_LAYOUT', 'layout'],
			['TEMPLATE_FIELD_UNKNOWN', 'footer'],
		]);
	});

	it('names an issue by its line, path or field in every locale', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			const labels = [
				issueLabel({
					code: 'TEMPLATE_HTML',
					message: 'No HTML.',
					line: 7,
					field: 'body',
				}),
				issueLabel({
					path: 'items[2].name',
					code: 'REQUIRED',
					message: 'items[2].name is required.',
				}),
				issueLabel({
					code: 'TEMPLATE_LAYOUT',
					message: 'Bad.',
					line: null,
					field: 'footer',
				}),
			];
			for (const label of labels) {
				expect([locale, label.includes('documents.')]).toEqual([locale, false]);
			}
			expect(labels[0]).toContain('7');
			expect(labels[1]).toContain('items[2].name');
		}
		setActiveLocale('en');
		expect(
			issueLabel({ code: 'TEMPLATE_HTML', message: 'No HTML.', line: 7 }),
		).toBe('Line 7: No HTML.');
	});

	it('labels versions and origins without falling back to a key', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const origin of [...DOCUMENT_TEMPLATE_ORIGINS, null]) {
				expect([locale, originLabel(origin).includes('documents.')]).toEqual([
					locale,
					false,
				]);
			}
			expect(versionLabel(null).includes('documents.')).toBe(false);
			expect(versionLabel(3)).toContain('3');
		}
	});

	it('names the preview file from the response and opens only a PDF in the viewer', () => {
		expect(
			dispositionFilename(
				`inline; filename="Oferta __.pdf"; filename*=UTF-8''${encodeURIComponent('Oferta Żółw.pdf')}`,
				'orders.core.offer',
				'pdf',
			),
		).toBe('Oferta Żółw.pdf');
		expect(dispositionFilename(null, 'orders.core.offer', 'docx')).toBe(
			'orders.core.offer.docx',
		);
		expect(
			dispositionFilename("inline; filename*=UTF-8''%E0%A4", 'k', 'pdf'),
		).toBe('k.pdf');
		expect(
			dispositionFilename(
				`inline; filename*=UTF-8''${encodeURIComponent('../x.pdf')}`,
				'k',
				'pdf',
			),
		).toBe('.._x.pdf');
		expect(opensInViewer('application/pdf')).toBe(true);
		expect(opensInViewer('application/pdf; charset=binary')).toBe(true);
		expect(
			opensInViewer(
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			),
		).toBe(false);
	});

	it('narrows the registered templates by key, title or module', () => {
		const item = (
			key: string,
			title: string,
			ownerModule: string,
		): TemplateListItem => ({
			key,
			title,
			ownerModule,
			format: 'pdf',
			locale: 'en',
			version: null,
			origin: null,
			updatedBy: null,
			updatedAt: null,
		});
		const templates = [
			item('orders.core.offer', 'Offer', 'orders.core'),
			item('vendors.core.screening', 'Screening report', 'vendors.core'),
		];
		expect(matchingTemplates(templates, '  ')).toBe(templates);
		expect(
			matchingTemplates(templates, 'REPORT').map((entry) => entry.key),
		).toEqual(['vendors.core.screening']);
		expect(
			matchingTemplates(templates, 'orders').map((entry) => entry.key),
		).toEqual(['orders.core.offer']);
	});
});
