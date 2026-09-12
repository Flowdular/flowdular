import {
	acceptMailMessage,
	createSmtpMailAdapter,
	type SmtpMailAdapter,
	type SmtpTransport,
	type SmtpTransportFactory,
	type SmtpTransportOptions,
} from '@flowdular/server';
import type { AuthMailDelivery, AuthMailMessage } from './mail-delivery.ts';
import { authMailMessage } from './mail-message.ts';

/* The relay itself is the platform's SMTP adapter; auth.core owns the mail
   client dependency, the message wording and the variables its own
   configuration path names. */

export type {
	SmtpMessage,
	SmtpTransport,
	SmtpTransportFactory,
	SmtpTransportOptions,
} from '@flowdular/server';

const VARIABLES = {
	url: 'FD_AUTH_SMTP_URL',
	from: 'FD_AUTH_MAIL_FROM',
} as const;

export interface SmtpMailDeliveryOptions {
	/** `smtp://` or `smtps://`, credentials included. Never logged. */
	readonly url: string;
	/** `Name <addr>` or `addr`. */
	readonly from: string;
	readonly rejectUnauthorized?: boolean;
	/** Refuse a cleartext `smtp://` session that offers no STARTTLS. Default true. */
	readonly requireTLS?: boolean;
	readonly createTransport?: SmtpTransportFactory;
	/** Names the refusals use; a deployment on the platform variables passes them. */
	readonly variables?: { readonly url: string; readonly from: string };
}

/**
 * Opens the relay with nodemailer. Resolved on the first delivery, so a
 * deployment that configures no mail transport never loads the dependency. The
 * platform composition takes this factory for its own mail port: auth.core is
 * the module that declares the SMTP client.
 */
export async function nodemailerSmtpTransport(
	options: SmtpTransportOptions,
): Promise<SmtpTransport> {
	const { createTransport } = await import('nodemailer');
	return createTransport(options);
}

export class SmtpMailDelivery implements AuthMailDelivery {
	readonly #adapter: SmtpMailAdapter;

	constructor(options: SmtpMailDeliveryOptions) {
		this.#adapter = createSmtpMailAdapter({
			url: options.url,
			from: options.from,
			...(options.rejectUnauthorized === undefined
				? {}
				: { rejectUnauthorized: options.rejectUnauthorized }),
			...(options.requireTLS === undefined
				? {}
				: { requireTLS: options.requireTLS }),
			createTransport: options.createTransport ?? nodemailerSmtpTransport,
			variables: options.variables ?? VARIABLES,
		});
	}

	async send(message: AuthMailMessage, locale: string): Promise<void> {
		/* Accepted before the connection is opened, so an implausible recipient
		   never reaches the relay and the caller learns why. */
		const accepted = acceptMailMessage(authMailMessage(message, locale));
		try {
			await this.#adapter.deliver(accepted);
		} catch {
			/* The adapter already dropped the relay's words; the kind that failed is
			   all a deployment log needs. */
			console.error(`[auth.core] smtp delivery failed (${message.kind})`);
			throw new Error(`Mail delivery failed for ${message.kind}.`);
		}
	}
}
