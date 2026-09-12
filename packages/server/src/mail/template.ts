import { MAIL_LIMITS, MailError } from './contracts.ts';

/* A mail template is a sender's own text with named holes in it. It is not a
   general template language on purpose: one pass, no expressions, no includes,
   no recursion, so what a value contains can never become markup or another
   placeholder. */

export interface MailTemplate {
	readonly subject: string;
	readonly text: string;
	readonly html?: string;
	/** BCP 47 tag of this wording; the rendered message carries it. */
	readonly locale?: string;
}

export interface RenderedMailTemplate {
	readonly subject: string;
	readonly text: string;
	readonly html?: string;
	readonly locale?: string;
}

/** Bounds of one rendering; the rendered message is bounded again by the port. */
export const MAIL_TEMPLATE_LIMITS = {
	values: 32,
	valueLength: 4_096,
} as const;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,32})\s*\}\}/g;

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function reject(message: string): MailError {
	return new MailError('MAIL_MESSAGE_REJECTED', message);
}

function substitute(
	source: string,
	values: Readonly<Record<string, string>>,
	escape: boolean,
): string {
	/* One pass over the source: a value that itself looks like a placeholder is
	   written out, never rendered again. */
	return source.replaceAll(PLACEHOLDER, (_match, name: string) => {
		/* Own keys only: a hole named after something on Object.prototype, such as
		   {{constructor}}, is an unknown value like any other. */
		if (!Object.hasOwn(values, name)) {
			throw reject(`The mail template names the unknown value ${name}.`);
		}
		const value = values[name]!;
		return escape ? escapeHtml(value) : value;
	});
}

/**
 * Fills `{{ name }}` holes in a template. Values reach the text parts as they
 * are and the HTML part escaped, so a display name or a workspace title can
 * never open a tag or an attribute in the rendered message.
 */
export function renderMailTemplate(
	template: MailTemplate,
	values: Readonly<Record<string, string>> = {},
): RenderedMailTemplate {
	const entries = Object.entries(values);
	if (entries.length > MAIL_TEMPLATE_LIMITS.values) {
		throw reject(
			`A template takes at most ${MAIL_TEMPLATE_LIMITS.values} values.`,
		);
	}
	for (const [name, value] of entries) {
		if (typeof value !== 'string') {
			throw reject(`The template value ${name} must be text.`);
		}
		if (value.length > MAIL_TEMPLATE_LIMITS.valueLength) {
			throw reject(
				`The template value ${name} must be at most ${MAIL_TEMPLATE_LIMITS.valueLength} characters long.`,
			);
		}
	}
	if (
		template.subject.length > MAIL_LIMITS.subject ||
		Buffer.byteLength(template.text, 'utf8') > MAIL_LIMITS.text ||
		(template.html !== undefined &&
			Buffer.byteLength(template.html, 'utf8') > MAIL_LIMITS.html)
	) {
		throw reject('The mail template is larger than a message may be.');
	}
	const html =
		template.html === undefined
			? undefined
			: substitute(template.html, values, true);
	return {
		subject: substitute(template.subject, values, false),
		text: substitute(template.text, values, false),
		...(html === undefined ? {} : { html }),
		...(template.locale === undefined ? {} : { locale: template.locale }),
	};
}
