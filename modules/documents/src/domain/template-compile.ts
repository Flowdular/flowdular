import type { CompiledTemplateParts } from './template-evaluate.ts';
import {
	checkTemplateFields,
	checkTemplateLineFields,
	parseTemplate,
	parseTemplateLine,
} from './template-language.ts';
import {
	templateSchemaProblem,
	type TemplateObjectSchema,
} from './template-schema.ts';
import {
	DEFAULT_TEMPLATE_MARGINS,
	DOCUMENT_TEMPLATE_FORMATS,
	DOCUMENT_TEMPLATE_LIMITS,
	DOCUMENT_TEMPLATE_LOCALES,
	DOCUMENT_TEMPLATE_PAGE_SIZES,
	type DocumentTemplateFormat,
	type DocumentTemplateLayout,
	type DocumentTemplateLocale,
	type DocumentTemplateMargins,
	type TemplateIssue,
} from './templates.ts';

/** Everything one template version renders from. */
export interface TemplateContent {
	readonly body: string;
	readonly layout: DocumentTemplateLayout;
	readonly inputSchema: TemplateObjectSchema;
	readonly locale: DocumentTemplateLocale;
	readonly format: DocumentTemplateFormat;
}

export interface CompiledTemplate extends CompiledTemplateParts {
	readonly content: TemplateContent;
}

function layoutIssue(message: string): TemplateIssue {
	return { code: 'TEMPLATE_LAYOUT', message, line: null, field: 'layout' };
}

function plain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A layout with every absent field filled in, or the refusals of the fields
 * that were given. A blank header or footer is none.
 */
export function normalizeTemplateLayout(
	value: unknown,
	fallbackTitle: string,
): {
	readonly layout: DocumentTemplateLayout;
	readonly issues: readonly TemplateIssue[];
} {
	const issues: TemplateIssue[] = [];
	const source = plain(value) ? value : {};
	if (value !== undefined && value !== null && !plain(value)) {
		issues.push(layoutIssue('The layout must be an object.'));
	}
	const pageSize = source.pageSize ?? 'A4';
	if (
		!(DOCUMENT_TEMPLATE_PAGE_SIZES as readonly unknown[]).includes(pageSize)
	) {
		issues.push(layoutIssue('The page size is A4 or Letter.'));
	}
	const margins: Record<keyof DocumentTemplateMargins, number> = {
		...DEFAULT_TEMPLATE_MARGINS,
	};
	if (source.margins !== undefined) {
		if (!plain(source.margins)) {
			issues.push(
				layoutIssue(
					'The margins must be an object of top, right, bottom and left.',
				),
			);
		} else {
			for (const side of ['top', 'right', 'bottom', 'left'] as const) {
				const given = source.margins[side];
				if (given === undefined) continue;
				if (
					!Number.isSafeInteger(given) ||
					(given as number) < DOCUMENT_TEMPLATE_LIMITS.marginMinMm ||
					(given as number) > DOCUMENT_TEMPLATE_LIMITS.marginMaxMm
				) {
					issues.push(
						layoutIssue(
							`The ${side} margin is a whole number of millimetres from ${DOCUMENT_TEMPLATE_LIMITS.marginMinMm} to ${DOCUMENT_TEMPLATE_LIMITS.marginMaxMm}.`,
						),
					);
				} else {
					margins[side] = given as number;
				}
			}
		}
	}
	const line = (field: 'header' | 'footer'): string | null => {
		const given = source[field];
		if (given === undefined || given === null) return null;
		if (typeof given !== 'string') {
			issues.push(layoutIssue(`The ${field} must be text.`));
			return null;
		}
		return given.trim() === '' ? null : given;
	};
	const header = line('header');
	const footer = line('footer');
	let title = fallbackTitle;
	if (source.title !== undefined && source.title !== null) {
		if (typeof source.title !== 'string') {
			issues.push(layoutIssue('The title must be text.'));
		} else if (source.title.trim() !== '') {
			title = source.title;
		}
	}
	return {
		layout: {
			pageSize: (DOCUMENT_TEMPLATE_PAGE_SIZES as readonly unknown[]).includes(
				pageSize,
			)
				? (pageSize as DocumentTemplateLayout['pageSize'])
				: 'A4',
			margins,
			header,
			footer,
			title,
		},
		issues,
	};
}

/**
 * Parses and checks one version. The body, the title, the header and the
 * footer are each parsed and checked against the input schema, so a refusal
 * names where it was found.
 */
export function compileTemplate(content: TemplateContent): {
	readonly compiled: CompiledTemplate | null;
	readonly issues: readonly TemplateIssue[];
} {
	const issues: TemplateIssue[] = [];
	const schemaProblem = templateSchemaProblem(content.inputSchema);
	if (schemaProblem) {
		issues.push({
			code: 'TEMPLATE_SCHEMA_INVALID',
			message: schemaProblem,
			line: null,
			field: 'layout',
		});
		return { compiled: null, issues };
	}
	if (
		!(DOCUMENT_TEMPLATE_LOCALES as readonly string[]).includes(content.locale)
	) {
		issues.push(layoutIssue('The locale is en or pl.'));
	}
	if (
		!(DOCUMENT_TEMPLATE_FORMATS as readonly string[]).includes(content.format)
	) {
		issues.push(layoutIssue('The format is pdf or docx.'));
	}
	if (typeof content.body !== 'string') {
		issues.push({
			code: 'TEMPLATE_SYNTAX',
			message: 'The body must be text.',
			line: null,
			field: 'body',
		});
		return { compiled: null, issues };
	}
	const parsed = parseTemplate(content.body);
	issues.push(...parsed.issues);
	if (parsed.issues.length === 0) {
		issues.push(...checkTemplateFields(parsed.blocks, content.inputSchema));
	}
	const lines = {} as Record<
		'title' | 'header' | 'footer',
		CompiledTemplateParts['title'] | null
	>;
	for (const field of ['title', 'header', 'footer'] as const) {
		const text = content.layout[field];
		if (text === null) {
			lines[field] = null;
			continue;
		}
		const line = parseTemplateLine(text, field);
		issues.push(...line.issues);
		if (line.issues.length === 0) {
			issues.push(
				...checkTemplateLineFields(line.content, field, content.inputSchema),
			);
		}
		lines[field] = line.content;
	}
	if (issues.length > 0) return { compiled: null, issues };
	return {
		compiled: {
			content,
			blocks: parsed.blocks,
			title: lines.title ?? [],
			header: lines.header,
			footer: lines.footer,
		},
		issues,
	};
}
