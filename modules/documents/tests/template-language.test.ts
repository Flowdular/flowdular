import { describe, expect, it } from 'vitest';
import {
	compileTemplate,
	normalizeTemplateLayout,
} from '../src/domain/template-compile.ts';
import {
	evaluateTemplate,
	TemplateRenderError,
	type RenderedBlock,
	type RenderedLine,
} from '../src/domain/template-evaluate.ts';
import type { TemplateObjectSchema } from '../src/domain/template-schema.ts';
import type { TemplateIssue } from '../src/domain/templates.ts';

const SCHEMA: TemplateObjectSchema = {
	type: 'object',
	required: ['customer', 'items'],
	properties: {
		customer: {
			type: 'object',
			properties: {
				name: { type: 'string', maxLength: 200 },
				vip: { type: 'boolean' },
			},
		},
		currency: { type: 'string' },
		total: { type: 'integer' },
		ratio: { type: 'number' },
		issuedOn: { type: 'string' },
		sentAt: { type: 'string' },
		note: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					price: { type: 'integer' },
				},
			},
		},
	},
};

function compile(
	body: string,
	layout: Record<string, unknown> = {},
	schema = SCHEMA,
) {
	const normalized = normalizeTemplateLayout(layout, 'Offer');
	return compileTemplate({
		body,
		layout: normalized.layout,
		inputSchema: schema,
		locale: 'pl',
		format: 'pdf',
	});
}

function render(
	body: string,
	input: unknown,
	layout: Record<string, unknown> = {},
	locale: 'en' | 'pl' = 'pl',
) {
	const { compiled, issues } = compile(body, layout);
	expect(issues).toEqual([]);
	return evaluateTemplate(compiled!, input, {
		locale,
		timeZone: 'Europe/Warsaw',
	});
}

/* Intl separates a currency symbol with a no-break space. */
function text(line: RenderedLine): string {
	return line
		.map((run) => run.text)
		.join('')
		.replace(/\u00a0/g, ' ');
}

function codes(
	issues: readonly TemplateIssue[],
): readonly (readonly [string, number | null])[] {
	return issues.map((issue) => [issue.code, issue.line] as const);
}

const INPUT = {
	customer: { name: 'Zażółć', vip: true },
	currency: 'PLN',
	total: 123456,
	items: [
		{ name: 'Alpha', price: 1000 },
		{ name: 'Beta', price: 250 },
	],
};

describe('template language', () => {
	it('DOCUMENTS-TEMPLATE-LANGUAGE renders every block and inline style', () => {
		const rendered = render(
			[
				'# Offer for {{ customer.name }}',
				'## Terms',
				'### Detail',
				'',
				'Plain **bold {{ customer.name }}** and *italic* and `code {{ currency }}` and [site](https://example.com).',
				'',
				'- first',
				'- second',
				'  - nested',
				'',
				'1. one',
				'2. two',
				'',
				'> quoted line',
				'> continues',
				'',
				'---',
				'---pagebreak---',
				'',
				'| Item | Price |',
				'| --- | ---: |',
				'{{#each items}}',
				'| {{ name }} | {{ price | money: currency }} |',
				'{{/each}}',
				'| Total | {{ total | money: currency }} |',
			].join('\n'),
			INPUT,
		);
		const kinds = rendered.blocks.map((block) => block.kind);
		expect(kinds).toEqual([
			'heading',
			'heading',
			'heading',
			'paragraph',
			'list',
			'list',
			'quote',
			'rule',
			'pagebreak',
			'table',
		]);
		const [h1, , , paragraph, bullets, numbers, quote, , , table] =
			rendered.blocks as RenderedBlock[];
		expect(h1).toMatchObject({ kind: 'heading', level: 1 });
		expect(text((h1 as { runs: RenderedLine }).runs)).toBe('Offer for Zażółć');
		expect((paragraph as { runs: RenderedLine }).runs).toEqual([
			{ text: 'Plain ', bold: false, italic: false, code: false },
			{ text: 'bold Zażółć', bold: true, italic: false, code: false },
			{ text: ' and ', bold: false, italic: false, code: false },
			{ text: 'italic', bold: false, italic: true, code: false },
			{ text: ' and ', bold: false, italic: false, code: false },
			{ text: 'code PLN', bold: false, italic: false, code: true },
			{
				text: ' and site (https://example.com).',
				bold: false,
				italic: false,
				code: false,
			},
		]);
		expect(bullets).toMatchObject({ kind: 'list', ordered: false });
		const list = bullets as Extract<RenderedBlock, { kind: 'list' }>;
		expect(list.items.map((item) => text(item.runs))).toEqual([
			'first',
			'second',
		]);
		expect(
			list.items[1]!.sublist!.items.map((item) => text(item.runs)),
		).toEqual(['nested']);
		expect(numbers).toMatchObject({ kind: 'list', ordered: true, start: 1 });
		expect(
			(quote as Extract<RenderedBlock, { kind: 'quote' }>).paragraphs.map(text),
		).toEqual(['quoted line continues']);
		const grid = table as Extract<RenderedBlock, { kind: 'table' }>;
		expect(grid.align).toEqual(['left', 'right']);
		expect(grid.header.map(text)).toEqual(['Item', 'Price']);
		expect(grid.rows.map((row) => row.map(text))).toEqual([
			['Alpha', '10,00 zł'],
			['Beta', '2,50 zł'],
			['Total', '1234,56 zł'],
		]);
		expect(rendered.repeatedRows).toBe(2);
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE prints input Markdown and braces as literal text', () => {
		const rendered = render('Hello {{ customer.name }}', {
			...INPUT,
			customer: {
				name: '**bold** {{ total }} <b>x</b> [a](b) ---pagebreak---',
			},
		});
		expect(rendered.blocks).toHaveLength(1);
		expect((rendered.blocks[0] as { runs: RenderedLine }).runs).toEqual([
			{
				text: 'Hello **bold** {{ total }} <b>x</b> [a](b) ---pagebreak---',
				bold: false,
				italic: false,
				code: false,
			},
		]);
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE repeats blocks with this, @index and @number and merges the lists', () => {
		const rendered = render(
			[
				'{{#each items}}',
				'1. {{ @number }}/{{ @index }} {{ this.name }} in {{ currency }}',
				'{{/each}}',
				'',
				'{{#each tags}}',
				'- {{ this }}',
				'{{/each}}',
			].join('\n'),
			{ ...INPUT, tags: ['x', 'y'] },
		);
		expect(rendered.blocks).toHaveLength(2);
		const ordered = rendered.blocks[0] as Extract<
			RenderedBlock,
			{ kind: 'list' }
		>;
		expect(ordered.items.map((item) => text(item.runs))).toEqual([
			'1/0 Alpha in PLN',
			'2/1 Beta in PLN',
		]);
		const bullets = rendered.blocks[1] as Extract<
			RenderedBlock,
			{ kind: 'list' }
		>;
		expect(bullets.items.map((item) => text(item.runs))).toEqual(['x', 'y']);
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE picks the if branch in blocks and in table rows', () => {
		const body = [
			'{{#if customer.vip}}',
			'VIP',
			'{{else}}',
			'Regular',
			'{{/if}}',
			'',
			'| A |',
			'| - |',
			'{{#if note}}',
			'| {{ note }} |',
			'{{else}}',
			'| none |',
			'{{/if}}',
		].join('\n');
		const vip = render(body, { ...INPUT, note: 'hi' });
		expect(text((vip.blocks[0] as { runs: RenderedLine }).runs)).toBe('VIP');
		expect(
			(vip.blocks[1] as Extract<RenderedBlock, { kind: 'table' }>).rows.map(
				(row) => row.map(text),
			),
		).toEqual([['hi']]);
		const regular = render(body, {
			...INPUT,
			customer: { name: 'x', vip: false },
		});
		expect(text((regular.blocks[0] as { runs: RenderedLine }).runs)).toBe(
			'Regular',
		);
		expect(
			(regular.blocks[1] as Extract<RenderedBlock, { kind: 'table' }>).rows.map(
				(row) => row.map(text),
			),
		).toEqual([['none']]);
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE formats every formatter in the locale and the workspace zone', () => {
		const body = [
			"{{ total | money: currency }}|{{ total | money: 'EUR' }}",
			'{{ ratio | number: 2 }}|{{ ratio | number }}',
			'{{ issuedOn | date }}|{{ sentAt | date }}|{{ sentAt | datetime }}',
			'{{ customer.name | upper }}|{{ customer.vip | yesno }}',
		].join('\\\n');
		const input = {
			...INPUT,
			ratio: 1234.5,
			issuedOn: '2026-01-31',
			sentAt: '2026-06-30T22:30:00Z',
		};
		const polish = render(body, input);
		expect(
			text((polish.blocks[0] as { runs: RenderedLine }).runs).split('\n'),
		).toEqual([
			'1234,56 zł|1234,56 €',
			'1234,50|1234,5',
			'31 stycznia 2026|1 lipca 2026|1 lipca 2026 00:30',
			'ZAŻÓŁĆ|Tak',
		]);
		const english = render(body, input, {}, 'en');
		expect(
			text((english.blocks[0] as { runs: RenderedLine }).runs).split('\n'),
		).toEqual([
			'PLN 1,234.56|€1,234.56',
			'1,234.50|1,234.5',
			'January 31, 2026|July 1, 2026|July 1, 2026 at 12:30 AM',
			'ZAŻÓŁĆ|Yes',
		]);
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE fills the title, header and footer and keeps the page counters', () => {
		const rendered = render('Body', INPUT, {
			title: 'Offer {{ customer.name }}',
			header: '{{ customer.name | upper }}',
			footer: 'Page {{ page }} of {{ pages }}',
		});
		expect(rendered.title).toBe('Offer Zażółć');
		expect(rendered.header).toEqual(['ZAŻÓŁĆ']);
		expect(rendered.footer).toEqual([
			'Page ',
			{ counter: 'page' },
			' of ',
			{ counter: 'pages' },
		]);
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE drops HTML comments on lines of their own', () => {
		const rendered = render(
			'# Title\n\n<!-- Rendered as pdf.\nFields: name. -->\nText',
			INPUT,
		);
		expect(rendered.blocks.map((block) => block.kind)).toEqual([
			'heading',
			'paragraph',
		]);
	});
});

describe('template refusals', () => {
	it.each([
		['<div>html</div>', 'TEMPLATE_HTML', 1],
		['Text\nwith <b>bold</b>', 'TEMPLATE_HTML', 2],
		['<!-- open\nnever closed', 'TEMPLATE_HTML', 1],
		['<!-- note --> trailing', 'TEMPLATE_HTML', 1],
		['Intro\n\n![logo](x.png)', 'TEMPLATE_IMAGE', 3],
		['Claim[^1]', 'TEMPLATE_FOOTNOTE', 1],
		['[^1]: note', 'TEMPLATE_FOOTNOTE', 1],
		['[site]: https://example.com', 'TEMPLATE_SYNTAX', 1],
		['```\ncode\n```', 'TEMPLATE_CODE_BLOCK', 1],
		['Intro\n\n    indented code', 'TEMPLATE_CODE_BLOCK', 3],
		['#### Deep', 'TEMPLATE_HEADING_LEVEL', 1],
		['Title\n===', 'TEMPLATE_SYNTAX', 2],
		['- a\n  - b\n    - c', 'TEMPLATE_LIST_DEPTH', 3],
		['> a\n> > b', 'TEMPLATE_SYNTAX', 2],
		['{{#each items}}\n{{ name }}', 'TEMPLATE_BLOCK', 1],
		['text\n{{/if}}', 'TEMPLATE_BLOCK', 2],
		['{{else}}', 'TEMPLATE_BLOCK', 1],
		['Inline {{#if note}} tag', 'TEMPLATE_BLOCK', 1],
		['{{ total | shout }}', 'TEMPLATE_FORMATTER', 1],
		['{{ total | money }}', 'TEMPLATE_FORMATTER', 1],
		['{{ total | number: 9 }}', 'TEMPLATE_FORMATTER', 1],
		['{{ total | upper | yesno }}', 'TEMPLATE_FORMATTER', 1],
		['x\n{{ customer.name', 'TEMPLATE_PLACEHOLDER', 2],
		['{{ a-b }}', 'TEMPLATE_PLACEHOLDER', 1],
		['{{{ note }}}', 'TEMPLATE_PLACEHOLDER', 1],
		['{{ @index }}', 'TEMPLATE_PLACEHOLDER', 1],
		['| a | b |\n| - | - |\n| 1 | 2 | 3 |', 'TEMPLATE_TABLE', 3],
		['| a | b |\n| - |', 'TEMPLATE_TABLE', 1],
		['{{ secret }}', 'TEMPLATE_FIELD_UNKNOWN', 1],
		['\n{{#each customer}}\nx\n{{/each}}', 'TEMPLATE_FIELD_TYPE', 2],
		['{{ items }}', 'TEMPLATE_FIELD_TYPE', 1],
		['{{ note | yesno }}', 'TEMPLATE_FIELD_TYPE', 1],
		['{{ total | money: total }}', 'TEMPLATE_FIELD_TYPE', 1],
	])('refuses %j with %s on line %i', (body, code, line) => {
		const { compiled, issues } = compile(body);
		expect(compiled).toBeNull();
		expect(codes(issues)).toContainEqual([code, line]);
	});

	it('refuses a body past its bound and nesting past eight blocks', () => {
		expect(codes(compile('x'.repeat(65_537)).issues)).toEqual([
			['TEMPLATE_TOO_LARGE', null],
		]);
		const deep = [
			...Array.from({ length: 9 }, () => '{{#if note}}'),
			'x',
			...Array.from({ length: 9 }, () => '{{/if}}'),
		].join('\n');
		expect(codes(compile(deep).issues)).toContainEqual(['TEMPLATE_BLOCK', 9]);
	});

	it('refuses layout fields with a stable code and the field', () => {
		const normalized = normalizeTemplateLayout(
			{ pageSize: 'A3', margins: { top: 2 } },
			'Offer',
		);
		expect(normalized.issues.map((issue) => [issue.code, issue.field])).toEqual(
			[
				['TEMPLATE_LAYOUT', 'layout'],
				['TEMPLATE_LAYOUT', 'layout'],
			],
		);
		expect(normalized.layout).toMatchObject({
			pageSize: 'A4',
			margins: { top: 20 },
			title: 'Offer',
			header: null,
		});
		const fields = compileTemplate({
			body: 'x',
			layout: {
				pageSize: 'A4',
				margins: { top: 20, right: 20, bottom: 20, left: 20 },
				header: 'a\nb',
				footer: 'Page {{ page }} {{ unknown }}',
				title: '{{ page }}',
			},
			inputSchema: SCHEMA,
			locale: 'pl',
			format: 'pdf',
		}).issues;
		expect(fields.map((issue) => [issue.code, issue.field])).toEqual([
			['TEMPLATE_FIELD_UNKNOWN', 'title'],
			['TEMPLATE_LAYOUT', 'header'],
			['TEMPLATE_FIELD_UNKNOWN', 'footer'],
		]);
	});

	it('refuses values the formatters cannot print and the render bounds', () => {
		const failure = (body: string, input: unknown) => {
			const { compiled } = compile(body);
			try {
				evaluateTemplate(compiled!, input, { locale: 'en', timeZone: 'UTC' });
			} catch (error) {
				return (error as TemplateRenderError).code;
			}
			return null;
		};
		expect(
			failure('{{ ratio | money: currency }}', { ...INPUT, ratio: 1.5 }),
		).toBe('TEMPLATE_VALUE_INVALID');
		expect(
			failure('{{ total | money: currency }}', { ...INPUT, currency: 'XYZ' }),
		).toBe('TEMPLATE_VALUE_INVALID');
		expect(
			failure('{{ issuedOn | date }}', { ...INPUT, issuedOn: '2026-02-30' }),
		).toBe('TEMPLATE_VALUE_INVALID');
		expect(
			failure('{{ sentAt | datetime }}', {
				...INPUT,
				sentAt: '2026-01-01T10:00',
			}),
		).toBe('TEMPLATE_VALUE_INVALID');
		const many = Array.from({ length: 2001 }, (_, index) => ({
			name: String(index),
			price: 1,
		}));
		expect(
			failure('| a |\n| - |\n{{#each items}}\n| {{ name }} |\n{{/each}}', {
				...INPUT,
				items: many,
			}),
		).toBe('TEMPLATE_ROWS_EXCEEDED');
		const long = Array.from({ length: 200 }, () => ({
			name: 'x'.repeat(10_000),
			price: 1,
		}));
		expect(
			failure('{{#each items}}\n{{ name }}\n{{/each}}', {
				...INPUT,
				items: long,
			}),
		).toBe('TEMPLATE_OUTPUT_TOO_LARGE');
	});
});

describe('template parser cost', () => {
	/* Every body below took seconds or overflowed the stack when an opener
	   without a closer scanned to the end of its paragraph. */
	it('DOCUMENTS-TEMPLATE-REFUSALS parses hostile bodies at the size bound in linear time', () => {
		const hostile = {
			brackets: '['.repeat(65_536),
			underscores: '_a '.repeat(21_845),
			stars: '*a '.repeat(21_845),
			nested: '['.repeat(10_000) + 'x' + '](u)'.repeat(10_000),
			backticks: Array.from({ length: 300 }, (_, i) => '`'.repeat(i + 1)).join(
				' ',
			),
			heading: '# ' + ' '.repeat(65_000) + 'x',
			directive: '{{#each' + ' '.repeat(65_000) + 'x',
			links: '[a](b '.repeat(10_000),
		};
		for (const [name, body] of Object.entries(hostile)) {
			const started = performance.now();
			expect(() => compile(body.slice(0, 65_536))).not.toThrow();
			expect([name, performance.now() - started < 1_000]).toEqual([name, true]);
		}
	});

	it('DOCUMENTS-TEMPLATE-LANGUAGE prints a link inside a link label as text', () => {
		const rendered = render('[outer [inner](a) text](b)', INPUT);
		expect(text((rendered.blocks[0] as { runs: RenderedLine }).runs)).toBe(
			'outer [inner](a) text (b)',
		);
	});
});
