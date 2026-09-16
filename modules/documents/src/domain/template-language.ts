import type {
	TemplateInputSchema,
	TemplateObjectSchema,
} from './template-schema.ts';
import { DOCUMENT_TEMPLATE_LIMITS, type TemplateIssue } from './templates.ts';

export type TemplateExpression =
	| {
			readonly kind: 'path';
			/** Resolved from the current item alone, rather than searched outwards. */
			readonly fromThis: boolean;
			readonly segments: readonly string[];
	  }
	| { readonly kind: 'index' | 'number' | 'page' | 'pages' };

export type TemplateArgument =
	| { readonly kind: 'literal'; readonly value: string }
	| { readonly kind: 'value'; readonly expression: TemplateExpression };

export type TemplateFormatter =
	| { readonly name: 'money'; readonly currency: TemplateArgument }
	| { readonly name: 'number'; readonly digits: number | null }
	| { readonly name: 'date' | 'datetime' | 'upper' | 'yesno' };

export const TEMPLATE_FORMATTERS = [
	'money',
	'number',
	'date',
	'datetime',
	'upper',
	'yesno',
] as const;

export interface TemplatePlaceholder {
	readonly kind: 'placeholder';
	readonly value: TemplateExpression;
	readonly formatter: TemplateFormatter | null;
	readonly line: number;
}

export type TemplateCodeChild =
	| { readonly kind: 'text'; readonly value: string }
	| TemplatePlaceholder;

export type TemplateInline =
	| TemplateCodeChild
	| {
			readonly kind: 'strong' | 'emphasis';
			readonly children: readonly TemplateInline[];
	  }
	| { readonly kind: 'code'; readonly children: readonly TemplateCodeChild[] }
	| {
			readonly kind: 'link';
			readonly children: readonly TemplateInline[];
			readonly url: readonly TemplateCodeChild[];
	  }
	| { readonly kind: 'break' };

export interface TemplateListItem {
	readonly content: readonly TemplateInline[];
	readonly sublist: TemplateList | null;
}

export interface TemplateList {
	readonly ordered: boolean;
	readonly start: number;
	readonly items: readonly TemplateListItem[];
}

export type TableAlign = 'left' | 'center' | 'right';

export type TemplateRow =
	| {
			readonly kind: 'row';
			readonly cells: readonly (readonly TemplateInline[])[];
			readonly line: number;
	  }
	| {
			readonly kind: 'each';
			readonly path: TemplateExpression;
			readonly children: readonly TemplateRow[];
			readonly line: number;
	  }
	| {
			readonly kind: 'if';
			readonly path: TemplateExpression;
			readonly then: readonly TemplateRow[];
			readonly otherwise: readonly TemplateRow[];
			readonly line: number;
	  };

export type TemplateBlock =
	| {
			readonly kind: 'heading';
			readonly level: 1 | 2 | 3;
			readonly content: readonly TemplateInline[];
			readonly line: number;
	  }
	| {
			readonly kind: 'paragraph';
			readonly content: readonly TemplateInline[];
			readonly line: number;
	  }
	| ({ readonly kind: 'list'; readonly line: number } & TemplateList)
	| {
			readonly kind: 'quote';
			readonly paragraphs: readonly (readonly TemplateInline[])[];
			readonly line: number;
	  }
	| { readonly kind: 'rule' | 'pagebreak'; readonly line: number }
	| {
			readonly kind: 'table';
			readonly align: readonly TableAlign[];
			readonly header: readonly (readonly TemplateInline[])[];
			readonly rows: readonly TemplateRow[];
			readonly line: number;
	  }
	| {
			readonly kind: 'each';
			readonly path: TemplateExpression;
			readonly children: readonly TemplateBlock[];
			readonly line: number;
	  }
	| {
			readonly kind: 'if';
			readonly path: TemplateExpression;
			readonly then: readonly TemplateBlock[];
			readonly otherwise: readonly TemplateBlock[];
			readonly line: number;
	  };

export interface ParsedTemplate {
	readonly blocks: readonly TemplateBlock[];
	readonly issues: readonly TemplateIssue[];
}

const MAX_ISSUES = 50;
const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const PATH = new RegExp(`^${IDENTIFIER}(\\.${IDENTIFIER}){0,7}$`);
const PUNCTUATION = /[!-/:-@[-`{-~]/;

class Issues {
	readonly list: TemplateIssue[] = [];
	constructor(readonly field: TemplateIssue['field']) {}

	add(code: string, message: string, line: number | null): void {
		if (this.list.length >= MAX_ISSUES) return;
		if (
			this.list.some(
				(issue) =>
					issue.code === code &&
					issue.line === line &&
					issue.message === message,
			)
		) {
			return;
		}
		this.list.push({
			code,
			message,
			line,
			...(this.field ? { field: this.field } : {}),
		});
	}
}

type Directive =
	| { readonly kind: 'each' | 'if'; readonly path: TemplateExpression }
	| { readonly kind: 'end-each' | 'end-if' | 'else' };

interface ExpressionContext {
	/** Header and footer lines, where page and pages are the page counters. */
	readonly pageCounters: boolean;
}

function parseValue(
	text: string,
	context: ExpressionContext,
): TemplateExpression | null {
	if (text === '@index') return { kind: 'index' };
	if (text === '@number') return { kind: 'number' };
	if (context.pageCounters && (text === 'page' || text === 'pages')) {
		return { kind: text };
	}
	if (text === 'this') return { kind: 'path', fromThis: true, segments: [] };
	if (!PATH.test(text)) return null;
	const segments = text.split('.');
	if (segments[0] === 'this') {
		return { kind: 'path', fromThis: true, segments: segments.slice(1) };
	}
	return { kind: 'path', fromThis: false, segments };
}

function parseFormatter(
	text: string,
	line: number,
	issues: Issues,
	context: ExpressionContext,
): TemplateFormatter | null {
	const colon = text.indexOf(':');
	const name = (colon < 0 ? text : text.slice(0, colon)).trim();
	const argument = colon < 0 ? null : text.slice(colon + 1).trim();
	if (!(TEMPLATE_FORMATTERS as readonly string[]).includes(name)) {
		issues.add(
			'TEMPLATE_FORMATTER',
			`"${name.slice(0, 32)}" is not a formatter; use ${TEMPLATE_FORMATTERS.join(', ')}.`,
			line,
		);
		return null;
	}
	if (name === 'money') {
		if (!argument) {
			issues.add(
				'TEMPLATE_FORMATTER',
				'money needs a currency: {{ amount | money: currency }}.',
				line,
			);
			return null;
		}
		const quoted = /^(['"])([A-Z]{3})\1$/.exec(argument);
		if (quoted) {
			return { name, currency: { kind: 'literal', value: quoted[2]! } };
		}
		const expression = parseValue(argument, context);
		if (!expression || expression.kind !== 'path') {
			issues.add(
				'TEMPLATE_FORMATTER',
				"The money currency is a field or a quoted ISO code such as 'PLN'.",
				line,
			);
			return null;
		}
		return { name, currency: { kind: 'value', expression } };
	}
	if (name === 'number') {
		if (argument === null) return { name, digits: null };
		if (!/^[0-6]$/.test(argument)) {
			issues.add(
				'TEMPLATE_FORMATTER',
				'number takes a count of decimals from 0 to 6.',
				line,
			);
			return null;
		}
		return { name, digits: Number(argument) };
	}
	if (argument !== null) {
		issues.add('TEMPLATE_FORMATTER', `${name} takes no argument.`, line);
		return null;
	}
	return { name: name as 'date' | 'datetime' | 'upper' | 'yesno' };
}

const DIRECTIVE = /^(#each|#if|\/each|\/if|else)(?:\s+(.*))?$/;

function parseDirective(
	inner: string,
	line: number,
	issues: Issues,
): Directive | null {
	const match = DIRECTIVE.exec(inner);
	if (!match) return null;
	const [, tag, rest] = match;
	if (tag === '#each' || tag === '#if') {
		const path = rest ? parseValue(rest.trim(), { pageCounters: false }) : null;
		if (!path || path.kind !== 'path') {
			issues.add('TEMPLATE_BLOCK', `{{${tag}}} needs a field path.`, line);
			return null;
		}
		return { kind: tag === '#each' ? 'each' : 'if', path };
	}
	if (rest) {
		issues.add('TEMPLATE_BLOCK', `{{${tag}}} takes nothing after it.`, line);
		return null;
	}
	return {
		kind: tag === '/each' ? 'end-each' : tag === '/if' ? 'end-if' : 'else',
	};
}

/** A line that is one block tag and nothing else. */
function lineDirective(
	text: string,
	line: number,
	issues: Issues,
): Directive | null | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{{') || !trimmed.endsWith('}}')) return undefined;
	const inner = trimmed.slice(2, -2).trim();
	if (inner.includes('{') || inner.includes('}') || !DIRECTIVE.test(inner)) {
		return undefined;
	}
	return parseDirective(inner, line, issues);
}

type Atom =
	| {
			readonly kind: 'char';
			readonly ch: string;
			readonly literal: boolean;
			readonly line: number;
	  }
	| { readonly kind: 'placeholder'; readonly node: TemplatePlaceholder }
	| { readonly kind: 'break' };

function atomsOf(
	text: string,
	line: number,
	issues: Issues,
	context: ExpressionContext,
): Atom[] {
	const atoms: Atom[] = [];
	let index = 0;
	while (index < text.length) {
		const ch = text[index]!;
		if (
			ch === '\\' &&
			index + 1 < text.length &&
			PUNCTUATION.test(text[index + 1]!)
		) {
			if (text.startsWith('{{', index + 1)) {
				atoms.push(
					{ kind: 'char', ch: '{', literal: true, line },
					{ kind: 'char', ch: '{', literal: true, line },
				);
				index += 3;
				continue;
			}
			atoms.push({ kind: 'char', ch: text[index + 1]!, literal: true, line });
			index += 2;
			continue;
		}
		if (text.startsWith('{{', index)) {
			if (text[index + 2] === '{') {
				issues.add(
					'TEMPLATE_PLACEHOLDER',
					'Triple braces are not supported; a value is always printed as text with {{ field }}.',
					line,
				);
			}
			const close = text.indexOf('}}', index + 2);
			if (close < 0) {
				issues.add(
					'TEMPLATE_PLACEHOLDER',
					'A placeholder opened with {{ is not closed with }} on the same line.',
					line,
				);
				for (const rest of text.slice(index))
					atoms.push({ kind: 'char', ch: rest, literal: true, line });
				break;
			}
			const inner = text.slice(index + 2, close).trim();
			index = close + 2;
			if (
				DIRECTIVE.test(inner) ||
				inner.startsWith('#') ||
				inner.startsWith('/')
			) {
				issues.add(
					'TEMPLATE_BLOCK',
					`{{${inner.slice(0, 40)}}} is a block tag and stands alone on its line.`,
					line,
				);
				continue;
			}
			const pipe = inner.indexOf('|');
			const valueText = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
			const formatterText = pipe < 0 ? null : inner.slice(pipe + 1).trim();
			const value = parseValue(valueText, context);
			if (!value) {
				issues.add(
					'TEMPLATE_PLACEHOLDER',
					`"{{ ${inner.slice(0, 60)} }}" is not a field path such as {{ customer.name }}.`,
					line,
				);
				continue;
			}
			if (formatterText !== null && formatterText.includes('|')) {
				issues.add(
					'TEMPLATE_FORMATTER',
					'A placeholder takes one formatter.',
					line,
				);
				continue;
			}
			const formatter =
				formatterText === null
					? null
					: parseFormatter(formatterText, line, issues, context);
			if (formatterText !== null && !formatter) continue;
			atoms.push({
				kind: 'placeholder',
				node: { kind: 'placeholder', value, formatter, line },
			});
			continue;
		}
		atoms.push({ kind: 'char', ch, literal: false, line });
		index += 1;
	}
	return atoms;
}

function isChar(atom: Atom | undefined, ch: string): boolean {
	return atom?.kind === 'char' && !atom.literal && atom.ch === ch;
}

function wordChar(atom: Atom | undefined): boolean {
	return atom?.kind === 'char' && /[\p{L}\p{N}]/u.test(atom.ch);
}

/* Styles nest this deep at most; a delimiter past it is printed as text. */
const INLINE_DEPTH = 8;

/**
 * Everything the inline parser looks ahead for, computed once per paragraph,
 * so an opener without a closer costs a binary search rather than a scan to
 * the end of the text. A hostile body of unmatched brackets or underscores
 * then parses in n log n instead of n squared.
 */
class InlineScan {
	readonly atoms: readonly Atom[];
	/** Length of the delimiter run starting at an index, 0 elsewhere. */
	readonly run: Int32Array;
	/** Run starts of each delimiter that close a strong span (two or more). */
	readonly strong = new Map<string, number[]>();
	/** Run starts of a single delimiter that close an emphasis span. */
	readonly emphasis = new Map<string, number[]>();
	/** Backtick run starts by run length. */
	readonly code = new Map<number, number[]>();
	/** The bracket closing each opening bracket, -1 when none does. */
	readonly bracket: Int32Array;
	/** The first closing parenthesis and whitespace at or after an index. */
	readonly nextParen: Int32Array;
	readonly nextSpace: Int32Array;

	constructor(atoms: readonly Atom[]) {
		this.atoms = atoms;
		const size = atoms.length;
		this.run = new Int32Array(size);
		this.bracket = new Int32Array(size).fill(-1);
		this.nextParen = new Int32Array(size + 1).fill(size);
		this.nextSpace = new Int32Array(size + 1).fill(size);
		const open: number[] = [];
		for (let index = 0; index < size; index += 1) {
			const atom = atoms[index]!;
			if (atom.kind !== 'char' || atom.literal) continue;
			const ch = atom.ch;
			if (
				(ch === '*' || ch === '_' || ch === '`') &&
				!isChar(atoms[index - 1], ch)
			) {
				let length = 1;
				while (isChar(atoms[index + length], ch)) length += 1;
				this.run[index] = length;
				if (ch === '`') {
					push(this.code, length, index);
				} else if (length >= 2) {
					push(this.strong, ch, index);
				} else if (ch !== '_' || !wordChar(atoms[index + 1])) {
					push(this.emphasis, ch, index);
				}
			}
			if (ch === '[') open.push(index);
			if (ch === ']' && open.length > 0) this.bracket[open.pop()!] = index;
		}
		for (let index = size - 1; index >= 0; index -= 1) {
			const atom = atoms[index]!;
			this.nextParen[index] = isChar(atom, ')')
				? index
				: this.nextParen[index + 1]!;
			this.nextSpace[index] =
				atom.kind === 'char' && /\s/.test(atom.ch)
					? index
					: this.nextSpace[index + 1]!;
		}
	}

	/** The first run start after `from` and before `to`, or -1. */
	static after(
		starts: readonly number[] | undefined,
		from: number,
		to: number,
	): number {
		if (!starts) return -1;
		let low = 0;
		let high = starts.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (starts[middle]! <= from) low = middle + 1;
			else high = middle;
		}
		const found = starts[low];
		return found !== undefined && found < to ? found : -1;
	}
}

function push<Key>(map: Map<Key, number[]>, key: Key, value: number): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

function codeChildren(
	atoms: readonly Atom[],
	from: number,
	to: number,
): TemplateCodeChild[] {
	const children: TemplateCodeChild[] = [];
	for (let index = from; index < to; index += 1) {
		const atom = atoms[index]!;
		if (atom.kind === 'placeholder') children.push(atom.node);
		else pushText(children, atom.kind === 'break' ? ' ' : atom.ch);
	}
	return children;
}

function pushText(
	nodes: (TemplateInline | TemplateCodeChild)[],
	value: string,
): void {
	const last = nodes.at(-1);
	if (last?.kind === 'text') {
		nodes[nodes.length - 1] = { kind: 'text', value: last.value + value };
	} else {
		nodes.push({ kind: 'text', value });
	}
}

function inlineNodes(
	scan: InlineScan,
	from: number,
	to: number,
	issues: Issues,
	depth: number,
	inLink: boolean,
): TemplateInline[] {
	const atoms = scan.atoms;
	const nodes: TemplateInline[] = [];
	let index = from;
	while (index < to) {
		const atom = atoms[index]!;
		if (atom.kind === 'placeholder') {
			nodes.push(atom.node);
			index += 1;
			continue;
		}
		if (atom.kind === 'break') {
			nodes.push({ kind: 'break' });
			index += 1;
			continue;
		}
		if (atom.literal) {
			pushText(nodes, atom.ch);
			index += 1;
			continue;
		}
		const ch = atom.ch;
		const run = Math.min(scan.run[index]!, to - index);
		if (ch === '`' && run > 0) {
			const close = InlineScan.after(scan.code.get(run), index, to);
			if (close < 0 || close + run > to) {
				pushText(nodes, '`'.repeat(run));
				index += run;
				continue;
			}
			nodes.push({
				kind: 'code',
				children: codeChildren(atoms, index + run, close),
			});
			index = close + run;
			continue;
		}
		if (ch === '!' && isChar(atoms[index + 1], '[')) {
			issues.add(
				'TEMPLATE_IMAGE',
				'Images are not supported in a template.',
				atom.line,
			);
		}
		if (ch === '[' && isChar(atoms[index + 1], '^')) {
			issues.add(
				'TEMPLATE_FOOTNOTE',
				'Footnotes are not supported in a template.',
				atom.line,
			);
		}
		if (ch === '<') {
			const next = atoms[index + 1];
			if (next?.kind === 'char' && /[A-Za-z/!?]/.test(next.ch)) {
				issues.add(
					'TEMPLATE_HTML',
					'HTML is not supported in a template; write Markdown.',
					atom.line,
				);
			}
		}
		if ((ch === '*' || ch === '_') && run > 0) {
			const intraword = ch === '_' && wordChar(atoms[index - 1]);
			if (!intraword && depth < INLINE_DEPTH) {
				const size = run >= 2 ? 2 : 1;
				const close =
					size === 2
						? InlineScan.after(scan.strong.get(ch), index + 1, to)
						: InlineScan.after(scan.emphasis.get(ch), index, to);
				if (close > index + size - 1 && close + size <= to) {
					nodes.push({
						kind: size === 2 ? 'strong' : 'emphasis',
						children: inlineNodes(
							scan,
							index + size,
							close,
							issues,
							depth + 1,
							inLink,
						),
					});
					index = close + size;
					continue;
				}
			}
			pushText(nodes, ch.repeat(run));
			index += run;
			continue;
		}
		if (ch === '[' && !inLink && depth < INLINE_DEPTH) {
			const labelEnd = scan.bracket[index]!;
			const urlStart = labelEnd + 2;
			if (labelEnd > 0 && labelEnd < to && isChar(atoms[labelEnd + 1], '(')) {
				const urlEnd = scan.nextParen[urlStart]!;
				if (
					urlEnd > urlStart &&
					urlEnd < to &&
					scan.nextSpace[urlStart]! > urlEnd
				) {
					nodes.push({
						kind: 'link',
						children: inlineNodes(
							scan,
							index + 1,
							labelEnd,
							issues,
							depth + 1,
							true,
						),
						url: codeChildren(atoms, urlStart, urlEnd),
					});
					index = urlEnd + 1;
					continue;
				}
			}
		}
		pushText(nodes, ch);
		index += 1;
	}
	return nodes;
}

function parseInline(
	segments: readonly {
		readonly text: string;
		readonly line: number;
		readonly hardBreak: boolean;
	}[],
	issues: Issues,
	context: ExpressionContext = { pageCounters: false },
): TemplateInline[] {
	const atoms: Atom[] = [];
	segments.forEach((segment, position) => {
		if (position > 0) {
			atoms.push(
				segments[position - 1]!.hardBreak
					? { kind: 'break' }
					: { kind: 'char', ch: ' ', literal: true, line: segment.line },
			);
		}
		for (const atom of atomsOf(segment.text, segment.line, issues, context)) {
			atoms.push(atom);
		}
	});
	return inlineNodes(new InlineScan(atoms), 0, atoms.length, issues, 0, false);
}

/* Hand-written rather than regular expressions, whose backtracking over a
   long line of spaces would take quadratic time. */
function headingOf(
	text: string,
): { readonly level: number; readonly content: string } | null {
	const indent = indentOf(text);
	if (indent > 3) return null;
	let index = indent;
	while (text[index] === '#') index += 1;
	const level = index - indent;
	if (level < 1 || level > 6) return null;
	if (index < text.length && text[index] !== ' ' && text[index] !== '\t')
		return null;
	let content = text.slice(index).trim();
	let end = content.length;
	while (end > 0 && content[end - 1] === '#') end -= 1;
	if (end === 0) content = '';
	else if (
		end < content.length &&
		(content[end - 1] === ' ' || content[end - 1] === '\t')
	) {
		content = content.slice(0, end).trimEnd();
	}
	return { level, content };
}

function isRule(text: string): boolean {
	if (indentOf(text) > 3) return false;
	const trimmed = text.trim();
	const marker = trimmed[0];
	if (marker !== '-' && marker !== '*' && marker !== '_') return false;
	let count = 0;
	for (const ch of trimmed) {
		if (ch === marker) count += 1;
		else if (ch !== ' ' && ch !== '\t') return false;
	}
	return count >= 3;
}

const FENCE = /^ {0,3}(```|~~~)/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const BULLET = /^( *)([-*+])[ \t]+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)][ \t]+(.*)$/;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:/;
const SETEXT = /^ {0,3}=+[ \t]*$/;
const PAGE_BREAK = '---pagebreak---';

function expandTabs(text: string): string {
	return text.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    '));
}

function indentOf(text: string): number {
	return /^ */.exec(text)![0].length;
}

/* Splits a pipe row on the pipes that are neither escaped nor inside a
   placeholder, since a formatter is written after a pipe too. */
function tableCells(text: string): string[] {
	let row = text.trim();
	if (row.startsWith('|')) row = row.slice(1);
	if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
	const cells: string[] = [];
	let current = '';
	for (let index = 0; index < row.length; index += 1) {
		const ch = row[index]!;
		if (ch === '\\' && row[index + 1] === '|') {
			current += '\\|';
			index += 1;
			continue;
		}
		if (row.startsWith('{{', index)) {
			const close = row.indexOf('}}', index + 2);
			const end = close < 0 ? row.length : close + 2;
			current += row.slice(index, end);
			index = end - 1;
			continue;
		}
		if (ch === '|') {
			cells.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	cells.push(current.trim());
	return cells;
}

function hasPipe(text: string): boolean {
	return tableCells(text).length > 1 || /^\s*\|/.test(text);
}

function delimiterRow(text: string | undefined): TableAlign[] | null {
	if (
		text === undefined ||
		!text.includes('-') ||
		(!hasPipe(text) && !/^\s*:?-+:?\s*$/.test(text))
	)
		return null;
	const cells = tableCells(text);
	const aligns: TableAlign[] = [];
	for (const cell of cells) {
		const match = /^(:?)-+(:?)$/.exec(cell);
		if (!match) return null;
		aligns.push(match[1] && match[2] ? 'center' : match[2] ? 'right' : 'left');
	}
	return aligns;
}

interface Container {
	readonly kind: 'root' | 'each' | 'if';
	readonly line: number;
	readonly path: TemplateExpression | null;
	readonly then: TemplateBlock[];
	readonly otherwise: TemplateBlock[];
	inElse: boolean;
}

interface OpenList {
	readonly ordered: boolean;
	readonly start: number;
	readonly indent: number;
	readonly line: number;
	readonly items: {
		lines: { text: string; line: number; hardBreak: boolean }[];
		sublist: {
			readonly ordered: boolean;
			readonly start: number;
			readonly indent: number;
			readonly items: {
				lines: { text: string; line: number; hardBreak: boolean }[];
			}[];
		} | null;
	}[];
}

function segment(text: string, line: number) {
	const backslash = text.endsWith('\\');
	const hardBreak = backslash || text.endsWith('  ');
	return {
		text: (backslash ? text.slice(0, -1) : text).trim(),
		line,
		hardBreak,
	};
}

/**
 * Parses a template body into blocks. Placeholders become nodes of their own
 * here, before any value exists, so nothing an input carries can open a block
 * or a style. Every refusal carries the 1-based line it was found on.
 */
export function parseTemplate(body: string): ParsedTemplate {
	const issues = new Issues('body');
	if (body.length > DOCUMENT_TEMPLATE_LIMITS.bodyCharacters) {
		issues.add(
			'TEMPLATE_TOO_LARGE',
			`A template body holds at most ${DOCUMENT_TEMPLATE_LIMITS.bodyCharacters} characters.`,
			null,
		);
		return { blocks: [], issues: issues.list };
	}
	const lines = stripComments(body.split(/\r\n|\r|\n/), issues).map(expandTabs);
	const root: Container = {
		kind: 'root',
		line: 0,
		path: null,
		then: [],
		otherwise: [],
		inElse: false,
	};
	const stack: Container[] = [root];
	const target = () => {
		const top = stack.at(-1)!;
		return top.inElse ? top.otherwise : top.then;
	};
	let paragraph: { text: string; line: number; hardBreak: boolean }[] = [];
	let list = null as OpenList | null;
	let quote = null as {
		lines: { text: string; line: number }[];
		line: number;
	} | null;

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		target().push({
			kind: 'paragraph',
			content: parseInline(paragraph, issues),
			line: paragraph[0]!.line,
		});
		paragraph = [];
	};
	const flushList = () => {
		if (!list) return;
		target().push({
			kind: 'list',
			ordered: list.ordered,
			start: list.start,
			line: list.line,
			items: list.items.map((item) => ({
				content: parseInline(item.lines, issues),
				sublist: item.sublist
					? {
							ordered: item.sublist.ordered,
							start: item.sublist.start,
							items: item.sublist.items.map((child) => ({
								content: parseInline(child.lines, issues),
								sublist: null,
							})),
						}
					: null,
			})),
		});
		list = null;
	};
	const flushQuote = () => {
		if (!quote) return;
		const paragraphs: (readonly TemplateInline[])[] = [];
		let current: { text: string; line: number; hardBreak: boolean }[] = [];
		for (const entry of [...quote.lines, { text: '', line: 0 }]) {
			if (entry.text.trim() === '') {
				if (current.length) paragraphs.push(parseInline(current, issues));
				current = [];
			} else {
				current.push(segment(entry.text, entry.line));
			}
		}
		target().push({ kind: 'quote', paragraphs, line: quote.line });
		quote = null;
	};
	const flushAll = () => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let index = 0; index < lines.length; index += 1) {
		const text = lines[index]!;
		const line = index + 1;
		const trimmed = text.trim();

		if (quote && !QUOTE.test(text)) flushQuote();
		if (trimmed === '') {
			flushAll();
			continue;
		}

		const directive = lineDirective(text, line, issues);
		if (directive !== undefined) {
			flushAll();
			if (directive) applyDirective(directive, line, stack, issues);
			continue;
		}
		if (trimmed === PAGE_BREAK) {
			flushAll();
			target().push({ kind: 'pagebreak', line });
			continue;
		}
		if (FENCE.test(text)) {
			flushAll();
			issues.add(
				'TEMPLATE_CODE_BLOCK',
				'Code blocks are not supported in a template.',
				line,
			);
			const fence = FENCE.exec(text)![1]!;
			while (
				index + 1 < lines.length &&
				!lines[index + 1]!.trim().startsWith(fence)
			)
				index += 1;
			index += 1;
			continue;
		}
		if (/^ {0,3}<[A-Za-z/!?]/.test(text)) {
			flushAll();
			issues.add(
				'TEMPLATE_HTML',
				'HTML is not supported in a template; write Markdown.',
				line,
			);
			continue;
		}
		const definition = DEFINITION.exec(text);
		if (definition) {
			flushAll();
			if (definition[1]!.startsWith('^')) {
				issues.add(
					'TEMPLATE_FOOTNOTE',
					'Footnotes are not supported in a template.',
					line,
				);
			} else {
				issues.add(
					'TEMPLATE_SYNTAX',
					'Reference links are not supported; write [text](url).',
					line,
				);
			}
			continue;
		}
		const heading = headingOf(text);
		if (heading) {
			flushAll();
			const level = heading.level;
			if (level > 3) {
				issues.add(
					'TEMPLATE_HEADING_LEVEL',
					'Headings go from level 1 to 3.',
					line,
				);
				continue;
			}
			target().push({
				kind: 'heading',
				level: level as 1 | 2 | 3,
				content: parseInline([segment(heading.content, line)], issues),
				line,
			});
			continue;
		}
		if (isRule(text)) {
			flushAll();
			target().push({ kind: 'rule', line });
			continue;
		}
		if (SETEXT.test(text) && paragraph.length > 0) {
			issues.add(
				'TEMPLATE_SYNTAX',
				'Underlined headings are not supported; start the line with #.',
				line,
			);
			continue;
		}
		const quoted = QUOTE.exec(text);
		if (quoted) {
			flushParagraph();
			flushList();
			if (/^\s*>/.test(quoted[1]!)) {
				issues.add('TEMPLATE_SYNTAX', 'Block quotes do not nest.', line);
			}
			quote ??= { lines: [], line };
			quote.lines.push({ text: quoted[1]!, line });
			continue;
		}
		const aligns = hasPipe(text) ? delimiterRow(lines[index + 1]) : null;
		if (aligns) {
			flushAll();
			index = parseTable(lines, index, aligns, target(), issues);
			continue;
		}
		const item = BULLET.exec(text) ?? ORDERED.exec(text);
		if (item) {
			flushParagraph();
			const indent = item[1]!.length;
			const ordered = /\d/.test(item[2]!);
			const start = ordered ? Number(item[2]) : 1;
			const entry = segment(item[3]!, line);
			if (!list && indent >= 4) {
				issues.add(
					'TEMPLATE_CODE_BLOCK',
					'An indented line is a code block, which a template does not support.',
					line,
				);
				continue;
			}
			const open = list;
			if (open && indent >= open.indent + 2) {
				const parent = open.items.at(-1)!;
				if (parent.sublist && indent >= parent.sublist.indent + 2) {
					issues.add('TEMPLATE_LIST_DEPTH', 'Lists nest one level deep.', line);
					continue;
				}
				parent.sublist ??= { ordered, start, indent, items: [] };
				parent.sublist.items.push({ lines: [entry] });
				continue;
			}
			if (open && open.ordered !== ordered) flushList();
			list ??= { ordered, start, indent, line, items: [] };
			list.items.push({ lines: [entry], sublist: null });
			continue;
		}
		if (indentOf(text) >= 4 && !list && paragraph.length === 0) {
			issues.add(
				'TEMPLATE_CODE_BLOCK',
				'An indented line is a code block, which a template does not support.',
				line,
			);
			continue;
		}
		if (list) {
			const last = list.items.at(-1)!;
			const holder =
				last.sublist && indentOf(text) >= last.sublist.indent + 2
					? last.sublist.items.at(-1)!
					: last;
			holder.lines.push(segment(text, line));
			continue;
		}
		paragraph.push(segment(text, line));
	}
	flushAll();
	for (const open of stack.slice(1)) {
		issues.add(
			'TEMPLATE_BLOCK',
			`{{#${open.kind}}} is not closed with {{/${open.kind}}}.`,
			open.line,
		);
	}
	while (stack.length > 1) closeContainer(stack);
	return { blocks: root.then, issues: issues.list };
}

function stripComments(lines: string[], issues: Issues): string[] {
	const kept = [...lines];
	for (let index = 0; index < kept.length; index += 1) {
		if (!kept[index]!.trim().startsWith('<!--')) continue;
		const opened = index;
		let closeLine = -1;
		for (let scan = index; scan < kept.length; scan += 1) {
			const from = scan === index ? kept[scan]!.indexOf('<!--') + 4 : 0;
			const close = kept[scan]!.indexOf('-->', from);
			if (close >= 0) {
				if (kept[scan]!.slice(close + 3).trim() !== '') {
					issues.add(
						'TEMPLATE_HTML',
						'A comment stands on lines of its own.',
						scan + 1,
					);
				}
				closeLine = scan;
				break;
			}
		}
		if (closeLine < 0) {
			issues.add(
				'TEMPLATE_HTML',
				'The comment opened here is never closed with -->.',
				opened + 1,
			);
			closeLine = kept.length - 1;
		}
		for (let scan = opened; scan <= closeLine; scan += 1) kept[scan] = '';
		index = closeLine;
	}
	return kept;
}

function applyDirective(
	directive: Directive,
	line: number,
	stack: Container[],
	issues: Issues,
): void {
	const top = stack.at(-1)!;
	switch (directive.kind) {
		case 'each':
		case 'if':
			if (stack.length > DOCUMENT_TEMPLATE_LIMITS.blockDepth) {
				issues.add(
					'TEMPLATE_BLOCK',
					`Blocks nest at most ${DOCUMENT_TEMPLATE_LIMITS.blockDepth} deep.`,
					line,
				);
			}
			stack.push({
				kind: directive.kind,
				line,
				path: directive.path,
				then: [],
				otherwise: [],
				inElse: false,
			});
			return;
		case 'else':
			if (top.kind !== 'if' || top.inElse) {
				issues.add(
					'TEMPLATE_BLOCK',
					'{{else}} belongs inside {{#if}} once.',
					line,
				);
				return;
			}
			top.inElse = true;
			return;
		case 'end-each':
		case 'end-if': {
			const kind = directive.kind === 'end-each' ? 'each' : 'if';
			if (top.kind !== kind) {
				issues.add(
					'TEMPLATE_BLOCK',
					`{{/${kind}}} closes no open {{#${kind}}}.`,
					line,
				);
				return;
			}
			closeContainer(stack);
		}
	}
}

function closeContainer(stack: Container[]): void {
	const closed = stack.pop()!;
	const parent = stack.at(-1)!;
	const into = parent.inElse ? parent.otherwise : parent.then;
	if (closed.kind === 'each') {
		into.push({
			kind: 'each',
			path: closed.path!,
			children: closed.then,
			line: closed.line,
		});
	} else {
		into.push({
			kind: 'if',
			path: closed.path!,
			then: closed.then,
			otherwise: closed.otherwise,
			line: closed.line,
		});
	}
}

function parseTable(
	lines: readonly string[],
	headerIndex: number,
	aligns: TableAlign[],
	into: TemplateBlock[],
	issues: Issues,
): number {
	const headerLine = headerIndex + 1;
	const headerCells = tableCells(lines[headerIndex]!);
	if (headerCells.length !== aligns.length) {
		issues.add(
			'TEMPLATE_TABLE',
			`The header row has ${headerCells.length} cells and the delimiter row ${aligns.length}.`,
			headerLine,
		);
	}
	const header = aligns.map((_, column) =>
		parseInline([segment(headerCells[column] ?? '', headerLine)], issues),
	);
	type RowFrame = {
		kind: 'root' | 'each' | 'if';
		line: number;
		path: TemplateExpression | null;
		then: TemplateRow[];
		otherwise: TemplateRow[];
		inElse: boolean;
	};
	const stack: RowFrame[] = [
		{
			kind: 'root',
			line: headerLine,
			path: null,
			then: [],
			otherwise: [],
			inElse: false,
		},
	];
	const target = () => {
		const top = stack.at(-1)!;
		return top.inElse ? top.otherwise : top.then;
	};
	let index = headerIndex + 2;
	for (; index < lines.length; index += 1) {
		const text = lines[index]!;
		const line = index + 1;
		if (text.trim() === '') break;
		const directive = lineDirective(text, line, issues);
		if (directive !== undefined) {
			if (!directive) continue;
			const top = stack.at(-1)!;
			if (directive.kind === 'each' || directive.kind === 'if') {
				if (stack.length > DOCUMENT_TEMPLATE_LIMITS.blockDepth) {
					issues.add(
						'TEMPLATE_BLOCK',
						`Blocks nest at most ${DOCUMENT_TEMPLATE_LIMITS.blockDepth} deep.`,
						line,
					);
				}
				stack.push({
					kind: directive.kind,
					line,
					path: directive.path,
					then: [],
					otherwise: [],
					inElse: false,
				});
			} else if (directive.kind === 'else') {
				if (top.kind !== 'if' || top.inElse) {
					issues.add(
						'TEMPLATE_BLOCK',
						'{{else}} belongs inside {{#if}} once.',
						line,
					);
				} else {
					top.inElse = true;
				}
			} else {
				const kind = directive.kind === 'end-each' ? 'each' : 'if';
				if (top.kind !== kind) {
					issues.add(
						'TEMPLATE_BLOCK',
						`{{/${kind}}} closes no open {{#${kind}}} inside this table.`,
						line,
					);
				} else {
					closeRowFrame(stack);
				}
			}
			continue;
		}
		if (!hasPipe(text)) break;
		const cells = tableCells(text);
		if (cells.length > aligns.length) {
			issues.add(
				'TEMPLATE_TABLE',
				`The row has ${cells.length} cells and the table ${aligns.length} columns.`,
				line,
			);
		}
		target().push({
			kind: 'row',
			cells: aligns.map((_, column) =>
				parseInline([segment(cells[column] ?? '', line)], issues),
			),
			line,
		});
	}
	for (const open of stack.slice(1)) {
		issues.add(
			'TEMPLATE_BLOCK',
			`{{#${open.kind}}} inside the table is not closed before the table ends.`,
			open.line,
		);
	}
	while (stack.length > 1) closeRowFrame(stack);
	into.push({
		kind: 'table',
		align: aligns,
		header,
		rows: stack[0]!.then,
		line: headerLine,
	});
	return index - 1;
}

function closeRowFrame(
	stack: {
		kind: 'root' | 'each' | 'if';
		line: number;
		path: TemplateExpression | null;
		then: TemplateRow[];
		otherwise: TemplateRow[];
		inElse: boolean;
	}[],
): void {
	const closed = stack.pop()!;
	const parent = stack.at(-1)!;
	const into = parent.inElse ? parent.otherwise : parent.then;
	if (closed.kind === 'each') {
		into.push({
			kind: 'each',
			path: closed.path!,
			children: closed.then,
			line: closed.line,
		});
	} else {
		into.push({
			kind: 'if',
			path: closed.path!,
			then: closed.then,
			otherwise: closed.otherwise,
			line: closed.line,
		});
	}
}

/**
 * Parses a one-line template field: the title, or a header or footer, where
 * {{page}} and {{pages}} count the pages. Markdown is not read here.
 */
export function parseTemplateLine(
	text: string,
	field: 'title' | 'header' | 'footer',
): {
	readonly content: readonly TemplateCodeChild[];
	readonly issues: readonly TemplateIssue[];
} {
	const issues = new Issues(field);
	if (
		text.length > DOCUMENT_TEMPLATE_LIMITS.lineCharacters ||
		/[\r\n]/.test(text)
	) {
		issues.add(
			'TEMPLATE_LAYOUT',
			`The ${field} is one line of at most ${DOCUMENT_TEMPLATE_LIMITS.lineCharacters} characters.`,
			null,
		);
		return { content: [], issues: issues.list };
	}
	const atoms = atomsOf(text, 1, issues, { pageCounters: field !== 'title' });
	return {
		content: codeChildren(atoms, 0, atoms.length),
		issues: issues.list.map((issue) => ({ ...issue, line: null })),
	};
}

type SchemaScope = {
	readonly schema: TemplateInputSchema;
	readonly item: boolean;
};

function describe(expression: TemplateExpression): string {
	if (expression.kind !== 'path') return '@' + expression.kind;
	return (
		[...(expression.fromThis ? ['this'] : []), ...expression.segments].join(
			'.',
		) || 'this'
	);
}

function walk(
	schema: TemplateInputSchema,
	segments: readonly string[],
): TemplateInputSchema | null {
	let current: TemplateInputSchema = schema;
	for (const name of segments) {
		if (current.type !== 'object' || !Object.hasOwn(current.properties, name))
			return null;
		current = current.properties[name]!;
	}
	return current;
}

/** The schema a value expression reads, or null when the input cannot hold it. */
export function schemaOfExpression(
	expression: TemplateExpression,
	scopes: readonly SchemaScope[],
): TemplateInputSchema | 'counter' | null {
	if (expression.kind !== 'path') return 'counter';
	if (expression.fromThis)
		return walk(scopes.at(-1)!.schema, expression.segments);
	for (let depth = scopes.length - 1; depth >= 0; depth -= 1) {
		const scope = scopes[depth]!.schema;
		if (
			scope.type === 'object' &&
			Object.hasOwn(scope.properties, expression.segments[0]!)
		) {
			return walk(scope, expression.segments);
		}
	}
	return null;
}

const FORMATTER_TYPES: Readonly<
	Record<TemplateFormatter['name'], readonly string[]>
> = {
	money: ['integer', 'number'],
	number: ['integer', 'number'],
	date: ['string', 'integer', 'number'],
	datetime: ['string', 'integer', 'number'],
	upper: ['string'],
	yesno: ['boolean'],
};

function checkPlaceholder(
	node: TemplatePlaceholder,
	scopes: readonly SchemaScope[],
	issues: Issues,
): void {
	const inItem = scopes.at(-1)!.item;
	if (
		(node.value.kind === 'index' || node.value.kind === 'number') &&
		!inItem
	) {
		issues.add(
			'TEMPLATE_PLACEHOLDER',
			`{{ ${describe(node.value)} }} counts items and belongs inside {{#each}}.`,
			node.line,
		);
		return;
	}
	const schema = schemaOfExpression(node.value, scopes);
	if (schema === null) {
		issues.add(
			'TEMPLATE_FIELD_UNKNOWN',
			`{{ ${describe(node.value)} }} is not a field of the template input.`,
			node.line,
		);
		return;
	}
	const type = schema === 'counter' ? 'integer' : schema.type;
	if (node.formatter) {
		if (!FORMATTER_TYPES[node.formatter.name].includes(type)) {
			issues.add(
				'TEMPLATE_FIELD_TYPE',
				`${node.formatter.name} cannot format ${describe(node.value)}, which is ${type}.`,
				node.line,
			);
		}
		if (
			node.formatter.name === 'money' &&
			node.formatter.currency.kind === 'value'
		) {
			const currency = schemaOfExpression(
				node.formatter.currency.expression,
				scopes,
			);
			if (currency === null) {
				issues.add(
					'TEMPLATE_FIELD_UNKNOWN',
					`The currency ${describe(node.formatter.currency.expression)} is not a field of the template input.`,
					node.line,
				);
			} else if (currency === 'counter' || currency.type !== 'string') {
				issues.add(
					'TEMPLATE_FIELD_TYPE',
					`The currency ${describe(node.formatter.currency.expression)} must be text.`,
					node.line,
				);
			}
		}
	} else if (type === 'object' || type === 'array') {
		issues.add(
			'TEMPLATE_FIELD_TYPE',
			`{{ ${describe(node.value)} }} is ${type === 'array' ? 'a list' : 'an object'} and cannot be printed; name one of its fields.`,
			node.line,
		);
	}
}

function checkInlines(
	nodes: readonly TemplateInline[],
	scopes: readonly SchemaScope[],
	issues: Issues,
): void {
	for (const node of nodes) {
		if (node.kind === 'placeholder') checkPlaceholder(node, scopes, issues);
		else if (
			node.kind === 'strong' ||
			node.kind === 'emphasis' ||
			node.kind === 'code'
		)
			checkInlines(node.children, scopes, issues);
		else if (node.kind === 'link') {
			checkInlines(node.children, scopes, issues);
			checkInlines(node.url, scopes, issues);
		}
	}
}

function itemScope(
	path: TemplateExpression,
	line: number,
	scopes: readonly SchemaScope[],
	issues: Issues,
): SchemaScope[] | null {
	const schema = schemaOfExpression(path, scopes);
	if (schema === null) {
		issues.add(
			'TEMPLATE_FIELD_UNKNOWN',
			`{{#each ${describe(path)}}} names no field of the template input.`,
			line,
		);
		return null;
	}
	if (schema === 'counter' || schema.type !== 'array') {
		issues.add(
			'TEMPLATE_FIELD_TYPE',
			`{{#each ${describe(path)}}} needs a list.`,
			line,
		);
		return null;
	}
	return [...scopes, { schema: schema.items, item: true }];
}

function checkCondition(
	path: TemplateExpression,
	line: number,
	scopes: readonly SchemaScope[],
	issues: Issues,
): void {
	if (schemaOfExpression(path, scopes) === null) {
		issues.add(
			'TEMPLATE_FIELD_UNKNOWN',
			`{{#if ${describe(path)}}} names no field of the template input.`,
			line,
		);
	}
}

function checkRows(
	rows: readonly TemplateRow[],
	scopes: readonly SchemaScope[],
	issues: Issues,
): void {
	for (const row of rows) {
		if (row.kind === 'row') {
			for (const cell of row.cells) checkInlines(cell, scopes, issues);
		} else if (row.kind === 'each') {
			const inner = itemScope(row.path, row.line, scopes, issues);
			if (inner) checkRows(row.children, inner, issues);
		} else {
			checkCondition(row.path, row.line, scopes, issues);
			checkRows(row.then, scopes, issues);
			checkRows(row.otherwise, scopes, issues);
		}
	}
}

function checkBlocks(
	blocks: readonly TemplateBlock[],
	scopes: readonly SchemaScope[],
	issues: Issues,
): void {
	for (const block of blocks) {
		switch (block.kind) {
			case 'heading':
			case 'paragraph':
				checkInlines(block.content, scopes, issues);
				break;
			case 'list':
				for (const item of block.items) {
					checkInlines(item.content, scopes, issues);
					for (const child of item.sublist?.items ?? [])
						checkInlines(child.content, scopes, issues);
				}
				break;
			case 'quote':
				for (const paragraph of block.paragraphs)
					checkInlines(paragraph, scopes, issues);
				break;
			case 'table':
				for (const cell of block.header) checkInlines(cell, scopes, issues);
				checkRows(block.rows, scopes, issues);
				break;
			case 'each': {
				const inner = itemScope(block.path, block.line, scopes, issues);
				if (inner) checkBlocks(block.children, inner, issues);
				break;
			}
			case 'if':
				checkCondition(block.path, block.line, scopes, issues);
				checkBlocks(block.then, scopes, issues);
				checkBlocks(block.otherwise, scopes, issues);
				break;
		}
	}
}

/** Every placeholder, each and if checked against the input schema. */
export function checkTemplateFields(
	blocks: readonly TemplateBlock[],
	schema: TemplateObjectSchema,
): readonly TemplateIssue[] {
	const issues = new Issues('body');
	checkBlocks(blocks, [{ schema, item: false }], issues);
	return issues.list;
}

export function checkTemplateLineFields(
	content: readonly TemplateCodeChild[],
	field: 'title' | 'header' | 'footer',
	schema: TemplateObjectSchema,
): readonly TemplateIssue[] {
	const issues = new Issues(field);
	checkInlines(content, [{ schema, item: false }], issues);
	return issues.list.map((issue) => ({ ...issue, line: null }));
}
