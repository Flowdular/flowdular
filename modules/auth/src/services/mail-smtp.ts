import type {
	AuthMailDelivery,
	AuthMailKind,
	AuthMailMessage,
} from './mail-delivery.ts';

/* A deployment-owned SMTP relay behind the injected port. The only supported
   configuration source is the process environment, so the validation errors
   name the variable an operator has to fix. */

const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_ADDRESS_LENGTH = 320;
const MAX_SENDER_NAME_LENGTH = 128;
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER_PATTERN = /^(.*)<([^<>]*)>$/;

export interface SmtpTransportOptions {
	readonly host: string;
	readonly port: number;
	readonly secure: boolean;
	readonly auth?: { readonly user: string; readonly pass: string };
	/** STARTTLS or nothing; set only on the cleartext scheme, which needs it. */
	readonly requireTLS?: boolean;
	readonly tls: { readonly rejectUnauthorized: boolean };
	readonly connectionTimeout: number;
	readonly greetingTimeout: number;
}

export interface SmtpMessage {
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly html: string;
}

/** The nodemailer surface this module uses, so tests need no socket. */
export interface SmtpTransport {
	sendMail(message: SmtpMessage): Promise<unknown>;
}

export type SmtpTransportFactory = (
	options: SmtpTransportOptions,
) => SmtpTransport | Promise<SmtpTransport>;

export interface SmtpMailDeliveryOptions {
	/** `smtp://` or `smtps://`, credentials included. Never logged. */
	readonly url: string;
	/** `Name <addr>` or `addr`. */
	readonly from: string;
	readonly rejectUnauthorized?: boolean;
	/** Refuse a cleartext `smtp://` session that offers no STARTTLS. Default true. */
	readonly requireTLS?: boolean;
	readonly createTransport?: SmtpTransportFactory;
}

interface MailTemplate {
	readonly subject: string;
	readonly intro: string;
	readonly action: string;
}

const TEMPLATES: Record<AuthMailKind, MailTemplate> = {
	'password-reset': {
		subject: 'Reset your password',
		intro:
			'A password reset was requested for this address. Open the link below to choose a new password.',
		action: 'Reset your password',
	},
	'tenant-invitation': {
		subject: 'You have been invited to a workspace',
		intro:
			'You have been invited to a workspace. Open the link below to accept the invitation and set up your account.',
		action: 'Accept the invitation',
	},
	'email-confirmation': {
		subject: 'Confirm your email address',
		intro:
			'Confirm this address to finish setting up your account. Open the link below to complete the confirmation.',
		action: 'Confirm your address',
	},
};

const CLOSING =
	'The link expires and can be used only once. If you did not expect this message, you can ignore it.';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function assertRecipient(to: string): void {
	if (to.length > MAX_ADDRESS_LENGTH || !ADDRESS_PATTERN.test(to)) {
		throw new Error('The recipient address is not deliverable.');
	}
}

function senderAddress(from: string): string {
	const value = from.trim();
	/* A sender carrying CR or LF would append its own headers to the message. */
	if (/[\r\n]/.test(value)) {
		throw new Error('FD_AUTH_MAIL_FROM must be a single line.');
	}
	const named = SENDER_PATTERN.exec(value);
	const address = (named?.[2] ?? value).trim();
	const name = named?.[1]?.trim() ?? '';
	if (name.length > MAX_SENDER_NAME_LENGTH || name.includes('"')) {
		throw new Error('FD_AUTH_MAIL_FROM has an unsupported display name.');
	}
	if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS_PATTERN.test(address)) {
		throw new Error(
			'FD_AUTH_MAIL_FROM must be an address or "Name <address>".',
		);
	}
	return value;
}

function smtpTransportOptions(
	url: string,
	rejectUnauthorized: boolean,
	requireTLS: boolean,
): SmtpTransportOptions {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		/* The thrown value never carries the URL: it holds the relay password. */
		throw new Error('FD_AUTH_SMTP_URL must be a valid URL.');
	}
	if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
		throw new Error('FD_AUTH_SMTP_URL must use smtp:// or smtps://.');
	}
	if (!parsed.hostname) {
		throw new Error('FD_AUTH_SMTP_URL must name a host.');
	}
	const secure = parsed.protocol === 'smtps:';
	let user: string;
	let pass: string;
	try {
		user = decodeURIComponent(parsed.username);
		pass = decodeURIComponent(parsed.password);
	} catch {
		/* A stray percent is a URIError naming neither the variable nor the fix,
		   and the value it carries is the relay password. */
		throw new Error('FD_AUTH_SMTP_URL credentials must be percent-encoded.');
	}
	return {
		host: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : secure ? 465 : 587,
		secure,
		...(user ? { auth: { user, pass } } : {}),
		/* Without it nodemailer sends over a plain socket whenever the relay
		   omits STARTTLS or a downgrade strips it, and the credentials and the
		   single-use links in the message go with it. */
		...(secure ? {} : { requireTLS }),
		tls: { rejectUnauthorized },
		connectionTimeout: CONNECTION_TIMEOUT_MS,
		greetingTimeout: CONNECTION_TIMEOUT_MS,
	};
}

async function nodemailerTransport(
	options: SmtpTransportOptions,
): Promise<SmtpTransport> {
	/* Resolved on the first delivery, so a deployment that configures no mail
	   transport never loads the dependency. */
	const { createTransport } = await import('nodemailer');
	return createTransport(options);
}

export class SmtpMailDelivery implements AuthMailDelivery {
	readonly #from: string;
	readonly #options: SmtpTransportOptions;
	readonly #createTransport: SmtpTransportFactory;
	/* One transport per runtime. It is not pooled, so a connection lives only
	   for the message it carries and disposal has nothing to release. */
	#transport: Promise<SmtpTransport> | undefined;

	constructor(options: SmtpMailDeliveryOptions) {
		this.#from = senderAddress(options.from);
		this.#options = smtpTransportOptions(
			options.url,
			options.rejectUnauthorized ?? true,
			options.requireTLS ?? true,
		);
		this.#createTransport = options.createTransport ?? nodemailerTransport;
	}

	async send(message: AuthMailMessage): Promise<void> {
		assertRecipient(message.to);
		const template = TEMPLATES[message.kind];
		const transport = await this.#open();
		try {
			await transport.sendMail({
				from: this.#from,
				to: message.to,
				subject: template.subject,
				text: `${template.intro}\n\n${message.url}\n\n${CLOSING}\n`,
				html: `<p>${escapeHtml(template.intro)}</p><p><a href="${escapeHtml(message.url)}">${escapeHtml(template.action)}</a></p><p>${escapeHtml(message.url)}</p><p>${escapeHtml(CLOSING)}</p>`,
			});
		} catch {
			/* An SMTP rejection quotes the envelope and the server banner, and a
			   connection error carries the relay host. The caller learns the kind
			   that failed and nothing else. */
			console.error(`[auth.core] smtp delivery failed (${message.kind})`);
			throw new Error(`Mail delivery failed for ${message.kind}.`);
		}
	}

	#open(): Promise<SmtpTransport> {
		if (this.#transport) return this.#transport;
		const opening = Promise.resolve(this.#createTransport(this.#options));
		this.#transport = opening;
		/* A failed transport must not poison every later delivery. */
		void opening.catch(() => {
			if (this.#transport === opening) this.#transport = undefined;
		});
		return opening;
	}
}
