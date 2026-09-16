import type { TagTone } from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import {
	compileTemplate,
	normalizeTemplateLayout,
} from '../domain/template-compile.ts';
import type {
	TemplateInputSchema,
	TemplateObjectSchema,
} from '../domain/template-schema.ts';
import {
	DEFAULT_TEMPLATE_MARGINS,
	type DocumentTemplateLayout,
	type DocumentTemplateOrigin,
	type TemplateIssue,
} from '../domain/templates.ts';
import type {
	TemplateInputIssue,
	TemplateVersionView,
} from './templates-api.ts';

/** The body lines a gutter numbers; an empty body is one empty line. */
export function lineNumbers(text: string): readonly number[] {
	const count = text.split('\n').length;
	return Array.from({ length: count }, (_, index) => index + 1);
}

export type DiffLine = {
	readonly kind: 'same' | 'added' | 'removed';
	readonly text: string;
};

/** Cells an LCS table may hold; a larger pair is shown as removed then added. */
export const DIFF_CELL_LIMIT = 4_000_000;

/**
 * A line diff of two bodies. The common head and tail are matched first, so a
 * one-line edit of a long template spends the LCS on that line alone.
 */
export function lineDiff(before: string, after: string): readonly DiffLine[] {
	const left = before.split('\n');
	const right = after.split('\n');
	let head = 0;
	while (
		head < left.length &&
		head < right.length &&
		left[head] === right[head]
	)
		head += 1;
	let tail = 0;
	while (
		tail < left.length - head &&
		tail < right.length - head &&
		left[left.length - 1 - tail] === right[right.length - 1 - tail]
	) {
		tail += 1;
	}
	const same = (text: string): DiffLine => ({ kind: 'same', text });
	const middleLeft = left.slice(head, left.length - tail);
	const middleRight = right.slice(head, right.length - tail);
	const lines: DiffLine[] = left.slice(0, head).map(same);
	const rows = middleLeft.length;
	const columns = middleRight.length;
	if ((rows + 1) * (columns + 1) > DIFF_CELL_LIMIT) {
		lines.push(
			...middleLeft.map((text): DiffLine => ({ kind: 'removed', text })),
			...middleRight.map((text): DiffLine => ({ kind: 'added', text })),
		);
	} else {
		const width = columns + 1;
		const table = new Uint32Array((rows + 1) * width);
		for (let row = rows - 1; row >= 0; row -= 1) {
			for (let column = columns - 1; column >= 0; column -= 1) {
				table[row * width + column] =
					middleLeft[row] === middleRight[column]
						? table[(row + 1) * width + column + 1]! + 1
						: Math.max(
								table[(row + 1) * width + column]!,
								table[row * width + column + 1]!,
							);
			}
		}
		let row = 0;
		let column = 0;
		while (row < rows || column < columns) {
			if (
				row < rows &&
				column < columns &&
				middleLeft[row] === middleRight[column]
			) {
				lines.push(same(middleLeft[row]!));
				row += 1;
				column += 1;
			} else if (
				column < columns &&
				(row >= rows ||
					table[row * width + column + 1]! >=
						table[(row + 1) * width + column]!)
			) {
				lines.push({ kind: 'added', text: middleRight[column]! });
				column += 1;
			} else {
				lines.push({ kind: 'removed', text: middleLeft[row]! });
				row += 1;
			}
		}
	}
	lines.push(...left.slice(left.length - tail).map(same));
	return lines;
}

/** A value of every declared field, so a sample input starts from the right shape. */
export function schemaSkeleton(schema: TemplateInputSchema): unknown {
	switch (schema.type) {
		case 'object':
			return Object.fromEntries(
				Object.entries(schema.properties).map(([name, child]) => [
					name,
					schemaSkeleton(child),
				]),
			);
		case 'array':
			return [schemaSkeleton(schema.items)];
		case 'string':
			return schema.enum?.[0] ?? '';
		case 'integer':
		case 'number':
			return 0;
		case 'boolean':
			return false;
	}
}

export function sampleInputText(schema: TemplateObjectSchema): string {
	return JSON.stringify(schemaSkeleton(schema), null, 2);
}

/** The sample input the editor holds, or why it is not JSON. */
export function parseSampleInput(
	text: string,
):
	| { readonly value: unknown; readonly error: '' }
	| { readonly value: null; readonly error: string } {
	try {
		return { value: JSON.parse(text) as unknown, error: '' };
	} catch {
		return {
			value: null,
			error: t('documents.templates.editor.sampleInvalid'),
		};
	}
}

/** The layout fields as the editor holds them: margins as the text of their inputs. */
export interface LayoutDraft {
	readonly pageSize: string;
	readonly top: string;
	readonly right: string;
	readonly bottom: string;
	readonly left: string;
	readonly header: string;
	readonly footer: string;
	readonly title: string;
}

export function layoutDraft(layout: DocumentTemplateLayout): LayoutDraft {
	return {
		pageSize: layout.pageSize,
		top: String(layout.margins.top),
		right: String(layout.margins.right),
		bottom: String(layout.margins.bottom),
		left: String(layout.margins.left),
		header: layout.header ?? '',
		footer: layout.footer ?? '',
		title: layout.title,
	};
}

function margin(text: string, fallback: number): number {
	const trimmed = text.trim();
	return trimmed === '' ? fallback : Number(trimmed);
}

/** The layout the server receives; a blank margin keeps the default and a blank header is none. */
export function layoutFromDraft(draft: LayoutDraft): Record<string, unknown> {
	return {
		pageSize: draft.pageSize,
		margins: {
			top: margin(draft.top, DEFAULT_TEMPLATE_MARGINS.top),
			right: margin(draft.right, DEFAULT_TEMPLATE_MARGINS.right),
			bottom: margin(draft.bottom, DEFAULT_TEMPLATE_MARGINS.bottom),
			left: margin(draft.left, DEFAULT_TEMPLATE_MARGINS.left),
		},
		header: draft.header.trim() === '' ? null : draft.header,
		footer: draft.footer.trim() === '' ? null : draft.footer,
		title: draft.title,
	};
}

/**
 * The same checks the server makes on save, run in the browser as the reader
 * types: the layout, then the body, title, header and footer against the
 * template's input schema.
 */
export function draftIssues(
	body: string,
	draft: LayoutDraft,
	base: Pick<TemplateVersionView, 'inputSchema' | 'locale' | 'format'>,
	fallbackTitle: string,
): readonly TemplateIssue[] {
	const normalized = normalizeTemplateLayout(
		layoutFromDraft(draft),
		fallbackTitle,
	);
	const compiled = compileTemplate({
		body,
		layout: normalized.layout,
		inputSchema: base.inputSchema,
		locale: base.locale,
		format: base.format,
	});
	return [...normalized.issues, ...compiled.issues];
}

/** One issue as a line of the error list: its line or its field, and the server's sentence. */
export function issueLabel(issue: TemplateIssue | TemplateInputIssue): string {
	if ('path' in issue) {
		return issue.path === ''
			? issue.message
			: t('documents.templates.issue.path', {
					path: issue.path,
					message: issue.message,
				});
	}
	if (issue.line !== null) {
		return t('documents.templates.issue.line', {
			line: issue.line,
			message: issue.message,
		});
	}
	const field = issue.field ?? 'layout';
	return t('documents.templates.issue.field', {
		field: t('documents.templates.field.' + field),
		message: issue.message,
	});
}

export function originLabel(origin: DocumentTemplateOrigin | null): string {
	return t('documents.templates.origin.' + (origin ?? 'default'));
}

export function originTone(origin: DocumentTemplateOrigin | null): TagTone {
	if (origin === 'edit') return 'info';
	return 'neutral';
}

export function versionLabel(version: number | null): string {
	return version === null
		? t('documents.templates.version.default')
		: t('documents.templates.version.number', { version });
}

/** Whether a response is a PDF the browser's own viewer opens, rather than a file to save. */
export function opensInViewer(contentType: string): boolean {
	return contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf';
}
