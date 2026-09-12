/* The one outbound mail contract of the platform. A module never selects an
   SMTP, a transactional-email service or a provider SDK: it receives this port
   on the server context and hands it a bounded message. */

export const MAIL_ADAPTERS = ['none', 'development', 'smtp'] as const;

export type MailAdapterId = (typeof MAIL_ADAPTERS)[number];

/**
 * Hard message bounds. None of them is configurable: they are the contract a
 * sender codes against, and the ceiling on what one message can cost.
 */
export const MAIL_LIMITS = {
	recipients: 16,
	address: 320,
	subject: 200,
	text: 64 * 1_024,
	html: 256 * 1_024,
	headers: 16,
	headerName: 64,
	/** The line length RFC 5322 allows without folding. */
	headerValue: 998,
	locale: 16,
} as const;

export type MailErrorCode =
	/** No transport is composed; the message was not queued anywhere. */
	| 'MAIL_NOT_CONFIGURED'
	/** The message broke a bound or carried something a header could not. */
	| 'MAIL_MESSAGE_REJECTED'
	/** The transport refused it. The relay's own words never travel with it. */
	| 'MAIL_DELIVERY_FAILED';

export class MailError extends Error {
	readonly code: MailErrorCode;

	constructor(code: MailErrorCode, message: string) {
		super(message);
		this.name = 'MailError';
		this.code = code;
	}
}

export interface MailMessage {
	readonly to: string | readonly string[];
	readonly subject: string;
	readonly text: string;
	readonly html?: string;
	/** BCP 47 tag of the rendered body; travels as Content-Language. */
	readonly locale?: string;
	/** Extra headers, names restricted and values single line. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** A message as the port accepted it: bounds checked, recipients deduplicated. */
export interface AcceptedMailMessage {
	readonly to: readonly string[];
	readonly subject: string;
	readonly text: string;
	readonly html: string | null;
	readonly locale: string | null;
	readonly headers: Readonly<Record<string, string>>;
}

export interface DeliveredMail extends AcceptedMailMessage {
	readonly sentAt: number;
}

export interface MailPort {
	readonly adapter: MailAdapterId;
	/**
	 * False for the `none` adapter. A sender reads it to decide whether a feature
	 * that needs mail is available at all, instead of provoking a refusal.
	 */
	readonly configured: boolean;
	/**
	 * Rejects with a `MailError`. Nothing about the relay, the credentials or the
	 * remote banner reaches the caller.
	 */
	send(message: MailMessage): Promise<void>;
	/**
	 * The development adapter's evidence, oldest first and capped. Always empty
	 * for the other adapters, so a test reads one place whatever is composed.
	 */
	readonly outbox: readonly DeliveredMail[];
}

const EMPTY_HEADERS: Readonly<Record<string, string>> = Object.freeze({});
export const NO_MAIL: readonly DeliveredMail[] = Object.freeze([]);

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
/* RFC 5322 specials. Unquoted, any of them makes a parser read a second
   address, or an address the sender never named, out of the display name. */
const DISPLAY_NAME_SPECIALS = /[",;:<>@]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/* Everything the envelope owns. A sender that could set one of these could
   redirect the message or rewrite what the recipient sees it as. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
	'bcc',
	'cc',
	'content-language',
	'content-transfer-encoding',
	'content-type',
	'date',
	'from',
	'message-id',
	'mime-version',
	'received',
	'reply-to',
	'return-path',
	'sender',
	'subject',
	'to',
]);

function reject(message: string): MailError {
	return new MailError('MAIL_MESSAGE_REJECTED', message);
}

/** Refuses anything that is not a single deliverable address. */
export function mailAddress(value: string, field: string): string {
	const address = value.trim();
	if (address.length > MAIL_LIMITS.address || !ADDRESS_PATTERN.test(address)) {
		throw reject(`${field} is not deliverable.`);
	}
	return address;
}

/**
 * `Name <address>` or a bare address, on one line. A sender carrying CR or LF
 * would append its own headers to every message the transport sends.
 */
export function mailSender(value: string, variable: string): string {
	const sender = value.trim();
	if (CONTROL_CHARACTER.test(sender)) {
		throw reject(`${variable} must be a single line.`);
	}
	const named = /^(.*)<([^<>]*)>$/.exec(sender);
	if (!named) {
		mailAddressOrThrow(sender, variable);
		return sender;
	}
	const name = named[1]?.trim() ?? '';
	if (name.length > 128 || DISPLAY_NAME_SPECIALS.test(name)) {
		throw reject(`${variable} has an unsupported display name.`);
	}
	mailAddressOrThrow((named[2] ?? '').trim(), variable);
	return sender;
}

function mailAddressOrThrow(address: string, variable: string): void {
	if (address.length > MAIL_LIMITS.address || !ADDRESS_PATTERN.test(address)) {
		throw reject(`${variable} must be an address or "Name <address>".`);
	}
}

function acceptedRecipients(to: MailMessage['to']): readonly string[] {
	const list = typeof to === 'string' ? [to] : to;
	if (list.length === 0) throw reject('A message must name a recipient.');
	if (list.length > MAIL_LIMITS.recipients) {
		throw reject(
			`A message must name at most ${MAIL_LIMITS.recipients} recipients.`,
		);
	}
	/* Deduplicated so one address cannot be billed, rate limited or reported
	   twice by naming it repeatedly. */
	return [...new Set(list.map((entry) => mailAddress(entry, 'A recipient')))];
}

function acceptedHeaders(
	headers: MailMessage['headers'],
	locale: string | null,
): Readonly<Record<string, string>> {
	const entries = headers ? Object.entries(headers) : [];
	if (entries.length === 0 && locale === null) return EMPTY_HEADERS;
	if (entries.length > MAIL_LIMITS.headers) {
		throw reject(
			`A message must carry at most ${MAIL_LIMITS.headers} headers.`,
		);
	}
	const accepted: Record<string, string> = {};
	for (const [name, value] of entries) {
		const key = name.trim().toLowerCase();
		if (key.length > MAIL_LIMITS.headerName || !HEADER_NAME_PATTERN.test(key)) {
			throw reject(`The header name ${JSON.stringify(name)} is not allowed.`);
		}
		if (RESERVED_HEADERS.has(key)) {
			throw reject(`The header ${key} is owned by the transport.`);
		}
		if (
			typeof value !== 'string' ||
			value.length > MAIL_LIMITS.headerValue ||
			CONTROL_CHARACTER.test(value)
		) {
			throw reject(`The header ${key} must carry one line of text.`);
		}
		accepted[key] = value;
	}
	if (locale !== null) accepted['content-language'] = locale;
	return Object.freeze(accepted);
}

/**
 * The single gate every adapter runs before it touches a transport. It is what
 * makes "no header injection" a property of the port rather than of each
 * sender: a subject, an address or a header value carrying CR or LF is refused
 * here, once.
 */
export function acceptMailMessage(message: MailMessage): AcceptedMailMessage {
	const to = acceptedRecipients(message.to);
	const subject = message.subject.trim();
	if (subject.length === 0 || subject.length > MAIL_LIMITS.subject) {
		throw reject(
			`A subject must be 1 to ${MAIL_LIMITS.subject} characters long.`,
		);
	}
	if (CONTROL_CHARACTER.test(subject)) {
		throw reject('A subject must be a single line.');
	}
	const textBytes = Buffer.byteLength(message.text, 'utf8');
	if (message.text.length === 0 || textBytes > MAIL_LIMITS.text) {
		throw reject(`A text body must be 1 to ${MAIL_LIMITS.text} bytes long.`);
	}
	if (
		message.html !== undefined &&
		Buffer.byteLength(message.html, 'utf8') > MAIL_LIMITS.html
	) {
		throw reject(
			`An HTML body must be at most ${MAIL_LIMITS.html} bytes long.`,
		);
	}
	const locale = message.locale?.trim() ?? '';
	if (
		locale !== '' &&
		(locale.length > MAIL_LIMITS.locale || !LOCALE_PATTERN.test(locale))
	) {
		throw reject('A locale must be a BCP 47 language tag.');
	}
	const resolvedLocale = locale === '' ? null : locale;
	return {
		to,
		subject,
		text: message.text,
		html: message.html ?? null,
		locale: resolvedLocale,
		headers: acceptedHeaders(message.headers, resolvedLocale),
	};
}
