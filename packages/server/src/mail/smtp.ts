import {
	acceptMailMessage,
	MailError,
	mailSender,
	type AcceptedMailMessage,
	type MailMessage,
} from './contracts.ts';

/* A deployment-owned SMTP relay behind the port. The only supported
   configuration source is the process environment, so every validation error
   names the variable an operator has to fix. */

const CONNECTION_TIMEOUT_MS = 10_000;

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
	readonly headers?: Readonly<Record<string, string>>;
}

/** The nodemailer surface this adapter uses, so tests need no socket. */
export interface SmtpTransport {
	sendMail(message: SmtpMessage): Promise<unknown>;
}

export type SmtpTransportFactory = (
	options: SmtpTransportOptions,
) => SmtpTransport | Promise<SmtpTransport>;

export interface SmtpMailAdapterOptions {
	/** `smtp://` or `smtps://`, credentials included. Never logged. */
	readonly url: string;
	/** `Name <addr>` or `addr`. */
	readonly from: string;
	readonly rejectUnauthorized?: boolean;
	/** Refuse a cleartext `smtp://` session that offers no STARTTLS. Default true. */
	readonly requireTLS?: boolean;
	/**
	 * Opens the relay connection. Required: the SMTP client is a dependency of
	 * whoever composes the port, never of this package, so the server layer
	 * carries no transitive mail library.
	 */
	readonly createTransport: SmtpTransportFactory;
	/** Variables the refusals name; a deployment may still use retired ones. */
	readonly variables?: { readonly url: string; readonly from: string };
}

const DEFAULT_VARIABLES = {
	url: 'FD_MAIL_SMTP_URL',
	from: 'FD_MAIL_FROM',
} as const;

function smtpTransportOptions(
	url: string,
	rejectUnauthorized: boolean,
	requireTLS: boolean,
	variable: string,
): SmtpTransportOptions {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		/* The thrown value never carries the URL: it holds the relay password. */
		throw new Error(`${variable} must be a valid URL.`);
	}
	if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
		throw new Error(`${variable} must use smtp:// or smtps://.`);
	}
	if (!parsed.hostname) {
		throw new Error(`${variable} must name a host.`);
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
		throw new Error(`${variable} credentials must be percent-encoded.`);
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

/**
 * Sends accepted messages through one relay. The connection is opened on the
 * first message and reused; it is not pooled, so a socket lives only for the
 * message it carries and disposal has nothing to release.
 */
export class SmtpMailAdapter {
	readonly #from: string;
	readonly #options: SmtpTransportOptions;
	readonly #createTransport: SmtpTransportFactory;
	#transport: Promise<SmtpTransport> | undefined;

	constructor(options: SmtpMailAdapterOptions) {
		const variables = options.variables ?? DEFAULT_VARIABLES;
		this.#from = mailSender(options.from, variables.from);
		this.#options = smtpTransportOptions(
			options.url,
			options.rejectUnauthorized ?? true,
			options.requireTLS ?? true,
			variables.url,
		);
		this.#createTransport = options.createTransport;
	}

	async send(message: MailMessage): Promise<void> {
		await this.deliver(acceptMailMessage(message));
	}

	/** The accepted form, for a sender that already ran the port's gate. */
	async deliver(message: AcceptedMailMessage): Promise<void> {
		let transport: SmtpTransport;
		try {
			transport = await this.#open();
		} catch {
			/* A factory rejection carries the relay host and the options it was
			   handed, the credentials among them; only the code travels. */
			throw new MailError(
				'MAIL_DELIVERY_FAILED',
				'The mail transport could not be opened.',
			);
		}
		try {
			await transport.sendMail({
				from: this.#from,
				to: message.to.join(', '),
				subject: message.subject,
				text: message.text,
				html: message.html ?? '',
				...(Object.keys(message.headers).length === 0
					? {}
					: { headers: message.headers }),
			});
		} catch {
			/* An SMTP rejection quotes the envelope and the server banner, and a
			   connection error carries the relay host. Neither reaches the caller
			   and neither is logged here: the sender owns what it records. */
			throw new MailError(
				'MAIL_DELIVERY_FAILED',
				'The mail transport refused the message.',
			);
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

export function createSmtpMailAdapter(
	options: SmtpMailAdapterOptions,
): SmtpMailAdapter {
	return new SmtpMailAdapter(options);
}
