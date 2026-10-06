import { describe, expect, it } from 'vitest';
import { renderToString } from 'octane/server';
import {
	parseInline,
	parseMarkdown,
	safeHref,
} from '../src/client/markdown.ts';
import { Markdown } from '../src/client/Markdown.tsrx';

function html(text: string): string {
	return renderToString(Markdown, { text }).html.replace(
		/<!--[\s\S]*?-->/g,
		'',
	);
}

describe('agent message Markdown', () => {
	it('reads the structure an agent reply uses', () => {
		const blocks = parseMarkdown(
			[
				'**What the draft says**',
				'- **Three permissions:**',
				'  - `equipment.items.read`: list',
				'  - `equipment.items.manage`: edit',
				'- **Retiring:** only through its own action.',
				'',
				'| Decision | Answer |',
				'|---|:--:|',
				'| Roles | Staff \\| managers |',
				'',
				'```yaml',
				'status: draft',
				'```',
			].join('\n'),
		);

		expect(blocks.map((block) => block.kind)).toEqual([
			'paragraph',
			'list',
			'table',
			'code',
		]);
		const list = blocks[1]!;
		expect(list.kind === 'list' && list.items).toHaveLength(2);
		expect(list.kind === 'list' && list.items[0]!.map((b) => b.kind)).toEqual([
			'paragraph',
			'list',
		]);
		const table = blocks[2]!;
		expect(table.kind === 'table' && table.align).toEqual([null, 'center']);
		expect(table.kind === 'table' && table.rows[0]![1]).toEqual([
			{ kind: 'text', text: 'Staff | managers' },
		]);
		expect(blocks[3]).toEqual({
			kind: 'code',
			language: 'yaml',
			text: 'status: draft',
		});
	});

	it('keeps identifiers and arithmetic as text', () => {
		expect(parseInline('snake_case_name and 2 * 3 * 4')).toEqual([
			{ kind: 'text', text: 'snake_case_name and 2 * 3 * 4' },
		]);
		expect(parseInline('`a **b** c` then **d**')).toEqual([
			{ kind: 'code', text: 'a **b** c' },
			{ kind: 'text', text: ' then ' },
			{ kind: 'strong', children: [{ kind: 'text', text: 'd' }] },
		]);
		expect(parseInline('*a **b** c*')).toEqual([
			{
				kind: 'emphasis',
				children: [
					{ kind: 'text', text: 'a ' },
					{ kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
					{ kind: 'text', text: ' c' },
				],
			},
		]);
	});

	it('starts a list after a sentence but not at a year in one', () => {
		expect(
			parseMarkdown('Files:\n- one\n- two').map((block) => block.kind),
		).toEqual(['paragraph', 'list']);
		expect(
			parseMarkdown('It shipped in\n2024. Since then').map(
				(block) => block.kind,
			),
		).toEqual(['paragraph']);
	});

	it('links only absolute web and mail addresses', () => {
		expect(safeHref('https://example.com/a b')).toBe(
			'https://example.com/a%20b',
		);
		expect(safeHref('mailto:ops@example.com')).toBe('mailto:ops@example.com');
		for (const unsafe of [
			'javascript:alert(1)',
			' JaVaScRiPt:alert(1)',
			'java\tscript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox',
			'modules/equipment/spec/module.yaml',
			'//evil.example',
		])
			expect(safeHref(unsafe)).toBeNull();
	});

	it('renders markup in a message as text and refused links as their words', () => {
		const rendered = html(
			[
				'<script>alert(1)</script>',
				'[open](javascript:alert(1)) [spec](modules/a/spec/module.yaml)',
				'See https://github.com/Flowdular/flowdular/pull/1.',
				'```html',
				'<b onclick="x()">raw</b>',
				'```',
			].join('\n'),
		);

		expect(rendered).not.toMatch(/<script|<b[\s>]/);
		expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(rendered).not.toContain('javascript:');
		expect(rendered).toContain('open');
		expect(rendered).not.toContain('href="modules');
		expect(rendered).toContain(
			'<a href="https://github.com/Flowdular/flowdular/pull/1" target="_blank" rel="noopener noreferrer nofollow">https://github.com/Flowdular/flowdular/pull/1</a>.',
		);
		expect(rendered).toContain('&lt;b onclick="x()"&gt;raw&lt;/b&gt;');
	});

	it('returns for hostile nesting and unmatched delimiters', () => {
		const deep = parseMarkdown('> '.repeat(5_000) + 'quoted');
		expect(deep).toHaveLength(1);
		const flat = parseInline('*a _b [d (e ](f '.repeat(20_000));
		expect(flat.map((node) => node.kind)).toEqual(['text']);
	});
});
