import type {
	TableAlign,
	TemplateArgument,
	TemplateBlock,
	TemplateCodeChild,
	TemplateExpression,
	TemplateFormatter,
	TemplateInline,
	TemplateList,
	TemplatePlaceholder,
	TemplateRow,
} from './template-language.ts';
import {
	DOCUMENT_TEMPLATE_LIMITS,
	type DocumentTemplateLocale,
} from './templates.ts';

export interface RenderedRun {
	readonly text: string;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly code: boolean;
}

export type RenderedLine = readonly RenderedRun[];

export interface RenderedList {
	readonly ordered: boolean;
	readonly start: number;
	readonly items: readonly {
		readonly runs: RenderedLine;
		readonly sublist: RenderedList | null;
	}[];
}

export type RenderedBlock =
	| {
			readonly kind: 'heading';
			readonly level: 1 | 2 | 3;
			readonly runs: RenderedLine;
	  }
	| { readonly kind: 'paragraph'; readonly runs: RenderedLine }
	| ({ readonly kind: 'list' } & RenderedList)
	| { readonly kind: 'quote'; readonly paragraphs: readonly RenderedLine[] }
	| { readonly kind: 'rule' | 'pagebreak' }
	| {
			readonly kind: 'table';
			readonly align: readonly TableAlign[];
			readonly header: readonly RenderedLine[];
			readonly rows: readonly (readonly RenderedLine[])[];
	  };

/** A header or footer: text with the page counters left for the renderer. */
export type RenderedMarginLine = readonly (
	| string
	| { readonly counter: 'page' | 'pages' }
)[];

export interface RenderedTemplate {
	readonly locale: DocumentTemplateLocale;
	readonly title: string;
	readonly header: RenderedMarginLine | null;
	readonly footer: RenderedMarginLine | null;
	readonly blocks: readonly RenderedBlock[];
	/** Rows and blocks the each blocks repeated, which the inline rule measures. */
	readonly repeatedRows: number;
}

export class TemplateRenderError extends Error {
	constructor(
		readonly code:
			| 'TEMPLATE_VALUE_INVALID'
			| 'TEMPLATE_ROWS_EXCEEDED'
			| 'TEMPLATE_OUTPUT_TOO_LARGE'
			| 'TEMPLATE_PAGES_EXCEEDED',
		message: string,
	) {
		super(message);
		this.name = 'TemplateRenderError';
	}
}

export interface EvaluateOptions {
	readonly locale: DocumentTemplateLocale;
	/** The workspace IANA zone date and datetime are shown in. */
	readonly timeZone: string;
}

interface Scope {
	readonly value: unknown;
	readonly index: number | null;
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const YES_NO: Readonly<
	Record<DocumentTemplateLocale, readonly [string, string]>
> = {
	en: ['Yes', 'No'],
	pl: ['Tak', 'Nie'],
};

let currencies: ReadonlySet<string> | null = null;

function knownCurrency(code: string): boolean {
	currencies ??= new Set(Intl.supportedValuesOf('currency'));
	return currencies.has(code);
}

function invalid(message: string): TemplateRenderError {
	return new TemplateRenderError('TEMPLATE_VALUE_INVALID', message);
}

function describe(expression: TemplateExpression): string {
	if (expression.kind !== 'path') return '@' + expression.kind;
	return (
		[...(expression.fromThis ? ['this'] : []), ...expression.segments].join(
			'.',
		) || 'this'
	);
}

class Evaluation {
	rows = 0;
	characters = 0;

	constructor(readonly options: EvaluateOptions) {}

	repeat(count: number): void {
		this.rows += count;
		if (this.rows > DOCUMENT_TEMPLATE_LIMITS.repeatedRows) {
			throw new TemplateRenderError(
				'TEMPLATE_ROWS_EXCEEDED',
				`A render repeats at most ${DOCUMENT_TEMPLATE_LIMITS.repeatedRows} rows or blocks.`,
			);
		}
	}

	printed(text: string): string {
		const clean = text.replace(CONTROL, '');
		this.characters += clean.length;
		if (this.characters > DOCUMENT_TEMPLATE_LIMITS.printedCharacters) {
			throw new TemplateRenderError(
				'TEMPLATE_OUTPUT_TOO_LARGE',
				`A render prints at most ${DOCUMENT_TEMPLATE_LIMITS.printedCharacters} characters.`,
			);
		}
		return clean;
	}

	resolve(expression: TemplateExpression, scopes: readonly Scope[]): unknown {
		const top = scopes.at(-1)!;
		if (expression.kind === 'index') return top.index;
		if (expression.kind === 'number')
			return top.index === null ? null : top.index + 1;
		if (expression.kind !== 'path') return null;
		if (expression.fromThis) return walk(top.value, expression.segments);
		for (let depth = scopes.length - 1; depth >= 0; depth -= 1) {
			const value = scopes[depth]!.value;
			if (plain(value) && Object.hasOwn(value, expression.segments[0]!)) {
				return walk(value, expression.segments);
			}
		}
		return undefined;
	}

	format(node: TemplatePlaceholder, scopes: readonly Scope[]): string {
		const value = this.resolve(node.value, scopes);
		const formatter = node.formatter;
		if (!formatter) return this.printed(plainText(value, node.value));
		return this.printed(
			this.applyFormatter(formatter, value, node.value, scopes),
		);
	}

	applyFormatter(
		formatter: TemplateFormatter,
		value: unknown,
		expression: TemplateExpression,
		scopes: readonly Scope[],
	): string {
		if (value === null || value === undefined) return '';
		const { locale, timeZone } = this.options;
		const name = describe(expression);
		switch (formatter.name) {
			case 'money': {
				if (!Number.isSafeInteger(value)) {
					throw invalid(`${name} must be an amount in minor units.`);
				}
				const currency = this.argument(formatter.currency, scopes);
				if (
					typeof currency !== 'string' ||
					!/^[A-Z]{3}$/.test(currency) ||
					!knownCurrency(currency)
				) {
					throw invalid(`The currency of ${name} is not an ISO 4217 code.`);
				}
				const money = new Intl.NumberFormat(locale, {
					style: 'currency',
					currency,
				});
				const digits = money.resolvedOptions().maximumFractionDigits ?? 2;
				return money.format((value as number) / 10 ** digits);
			}
			case 'number':
				if (typeof value !== 'number' || !Number.isFinite(value)) {
					throw invalid(`${name} must be a number.`);
				}
				return new Intl.NumberFormat(
					locale,
					formatter.digits === null
						? {}
						: {
								minimumFractionDigits: formatter.digits,
								maximumFractionDigits: formatter.digits,
							},
				).format(value);
			case 'date':
			case 'datetime': {
				const moment = instant(value);
				if (!moment) throw invalid(`${name} is not a date.`);
				return new Intl.DateTimeFormat(locale, {
					dateStyle: 'long',
					...(formatter.name === 'datetime' ? { timeStyle: 'short' } : {}),
					timeZone: moment.day ? 'UTC' : timeZone,
				}).format(moment.at);
			}
			case 'upper':
				if (typeof value !== 'string') throw invalid(`${name} must be text.`);
				return value.toLocaleUpperCase(locale);
			case 'yesno':
				if (typeof value !== 'boolean')
					throw invalid(`${name} must be true or false.`);
				return YES_NO[locale][value ? 0 : 1];
		}
	}

	argument(argument: TemplateArgument, scopes: readonly Scope[]): unknown {
		return argument.kind === 'literal'
			? argument.value
			: this.resolve(argument.expression, scopes);
	}
}

function plain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(value: unknown, segments: readonly string[]): unknown {
	let current = value;
	for (const name of segments) {
		if (!plain(current) || !Object.hasOwn(current, name)) return undefined;
		current = current[name];
	}
	return current;
}

function plainText(value: unknown, expression: TemplateExpression): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value);
	throw invalid(`${describe(expression)} is not text and cannot be printed.`);
}

function instant(value: unknown): { at: number; day: boolean } | null {
	if (typeof value === 'number')
		return Number.isFinite(value) ? { at: value, day: false } : null;
	if (typeof value !== 'string') return null;
	const day = DATE.exec(value);
	if (day) {
		const at = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
		const check = new Date(at);
		if (
			check.getUTCMonth() + 1 !== Number(day[2]) ||
			check.getUTCDate() !== Number(day[3])
		)
			return null;
		return { at, day: true };
	}
	if (!DATETIME.test(value)) return null;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : { at, day: false };
}

function truthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return Boolean(value);
}

type Style = {
	readonly bold: boolean;
	readonly italic: boolean;
	readonly code: boolean;
};

function append(into: RenderedRun[], run: RenderedRun): void {
	if (run.text === '') return;
	const last = into.at(-1);
	if (
		last &&
		last.bold === run.bold &&
		last.italic === run.italic &&
		last.code === run.code
	) {
		into[into.length - 1] = { ...last, text: last.text + run.text };
	} else {
		into.push(run);
	}
}

function runs(
	nodes: readonly (TemplateInline | TemplateCodeChild)[],
	scopes: readonly Scope[],
	evaluation: Evaluation,
	style: Style = { bold: false, italic: false, code: false },
	into: RenderedRun[] = [],
): RenderedRun[] {
	const push = (text: string) => append(into, { text, ...style });
	for (const node of nodes) {
		switch (node.kind) {
			case 'text':
				push(evaluation.printed(node.value));
				break;
			case 'placeholder':
				push(evaluation.format(node, scopes));
				break;
			case 'break':
				push('\n');
				break;
			case 'strong':
				runs(node.children, scopes, evaluation, { ...style, bold: true }, into);
				break;
			case 'emphasis':
				runs(
					node.children,
					scopes,
					evaluation,
					{ ...style, italic: true },
					into,
				);
				break;
			case 'code':
				runs(node.children, scopes, evaluation, { ...style, code: true }, into);
				break;
			case 'link': {
				const label = runs(node.children, scopes, evaluation, style, []);
				const url = runs(node.url, scopes, evaluation, style, [])
					.map((run) => run.text)
					.join('');
				for (const run of label) append(into, run);
				if (label.map((run) => run.text).join('') !== url) push(` (${url})`);
				break;
			}
		}
	}
	return into;
}

function list(
	source: TemplateList,
	scopes: readonly Scope[],
	evaluation: Evaluation,
): RenderedList {
	return {
		ordered: source.ordered,
		start: source.start,
		items: source.items.map((item) => ({
			runs: runs(item.content, scopes, evaluation),
			sublist: item.sublist ? list(item.sublist, scopes, evaluation) : null,
		})),
	};
}

function items(
	path: TemplateExpression,
	scopes: readonly Scope[],
	evaluation: Evaluation,
): readonly unknown[] {
	const value = evaluation.resolve(path, scopes);
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) throw invalid(`${describe(path)} is not a list.`);
	evaluation.repeat(value.length);
	return value;
}

function rows(
	source: readonly TemplateRow[],
	scopes: readonly Scope[],
	evaluation: Evaluation,
	into: (readonly RenderedLine[])[],
): void {
	for (const row of source) {
		if (row.kind === 'row') {
			into.push(row.cells.map((cell) => runs(cell, scopes, evaluation)));
		} else if (row.kind === 'each') {
			items(row.path, scopes, evaluation).forEach((value, index) =>
				rows(row.children, [...scopes, { value, index }], evaluation, into),
			);
		} else {
			rows(
				truthy(evaluation.resolve(row.path, scopes)) ? row.then : row.otherwise,
				scopes,
				evaluation,
				into,
			);
		}
	}
}

function blocks(
	source: readonly TemplateBlock[],
	scopes: readonly Scope[],
	evaluation: Evaluation,
	into: RenderedBlock[],
): void {
	for (const block of source) {
		switch (block.kind) {
			case 'heading':
				into.push({
					kind: 'heading',
					level: block.level,
					runs: runs(block.content, scopes, evaluation),
				});
				break;
			case 'paragraph':
				into.push({
					kind: 'paragraph',
					runs: runs(block.content, scopes, evaluation),
				});
				break;
			case 'list': {
				const rendered = list(block, scopes, evaluation);
				const previous = into.at(-1);
				if (
					previous?.kind === 'list' &&
					previous.ordered === rendered.ordered
				) {
					into[into.length - 1] = {
						...previous,
						items: [...previous.items, ...rendered.items],
					};
				} else {
					into.push({ kind: 'list', ...rendered });
				}
				break;
			}
			case 'quote':
				into.push({
					kind: 'quote',
					paragraphs: block.paragraphs.map((paragraph) =>
						runs(paragraph, scopes, evaluation),
					),
				});
				break;
			case 'rule':
			case 'pagebreak':
				into.push({ kind: block.kind });
				break;
			case 'table': {
				const body: (readonly RenderedLine[])[] = [];
				rows(block.rows, scopes, evaluation, body);
				into.push({
					kind: 'table',
					align: block.align,
					header: block.header.map((cell) => runs(cell, scopes, evaluation)),
					rows: body,
				});
				break;
			}
			case 'each':
				items(block.path, scopes, evaluation).forEach((value, index) =>
					blocks(
						block.children,
						[...scopes, { value, index }],
						evaluation,
						into,
					),
				);
				break;
			case 'if':
				blocks(
					truthy(evaluation.resolve(block.path, scopes))
						? block.then
						: block.otherwise,
					scopes,
					evaluation,
					into,
				);
				break;
		}
	}
}

function marginLine(
	content: readonly TemplateCodeChild[] | null,
	scopes: readonly Scope[],
	evaluation: Evaluation,
): RenderedMarginLine | null {
	if (content === null) return null;
	const parts: (string | { readonly counter: 'page' | 'pages' })[] = [];
	for (const node of content) {
		if (
			node.kind === 'placeholder' &&
			(node.value.kind === 'page' || node.value.kind === 'pages')
		) {
			parts.push({ counter: node.value.kind });
			continue;
		}
		const text =
			node.kind === 'text'
				? evaluation.printed(node.value)
				: evaluation.format(node, scopes);
		const last = parts.at(-1);
		if (typeof last === 'string') parts[parts.length - 1] = last + text;
		else parts.push(text);
	}
	return parts;
}

export interface CompiledTemplateParts {
	readonly blocks: readonly TemplateBlock[];
	readonly title: readonly TemplateCodeChild[];
	readonly header: readonly TemplateCodeChild[] | null;
	readonly footer: readonly TemplateCodeChild[] | null;
}

/**
 * Substitutes an input, already checked against the template's schema, into a
 * parsed template. Every value lands in a text run; nothing is parsed again.
 */
export function evaluateTemplate(
	template: CompiledTemplateParts,
	input: unknown,
	options: EvaluateOptions,
): RenderedTemplate {
	const evaluation = new Evaluation(options);
	const scopes: Scope[] = [{ value: input, index: null }];
	const rendered: RenderedBlock[] = [];
	blocks(template.blocks, scopes, evaluation, rendered);
	const title = runs(template.title, scopes, evaluation)
		.map((run) => run.text)
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
	return {
		locale: options.locale,
		title,
		header: marginLine(template.header, scopes, evaluation),
		footer: marginLine(template.footer, scopes, evaluation),
		blocks: rendered,
		repeatedRows: evaluation.rows,
	};
}
