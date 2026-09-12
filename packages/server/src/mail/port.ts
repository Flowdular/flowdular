import type { MailConfig } from './config.ts';
import {
	acceptMailMessage,
	MailError,
	NO_MAIL,
	type DeliveredMail,
	type MailMessage,
	type MailPort,
} from './contracts.ts';
import { createSmtpMailAdapter, type SmtpTransportFactory } from './smtp.ts';

/**
 * What the development outbox keeps. It exists for a test and a local run, so
 * it is a ring: a long dev session sends messages forever and must not grow the
 * process by one retained body per message.
 */
export const DEVELOPMENT_OUTBOX_LIMIT = 100;

export interface MailPortOptions {
	/**
	 * Opens an SMTP connection. The platform composition passes nodemailer's;
	 * this package declares the interface and depends on no mail client.
	 */
	readonly createSmtpTransport?: SmtpTransportFactory;
	readonly now?: () => number;
}

class DevelopmentMailPort implements MailPort {
	readonly adapter = 'development' as const;
	readonly configured = true;
	readonly #messages: DeliveredMail[] = [];
	readonly #now: () => number;

	constructor(now: () => number) {
		this.#now = now;
	}

	get outbox(): readonly DeliveredMail[] {
		return this.#messages;
	}

	async send(message: MailMessage): Promise<void> {
		/* Local-only evidence for tests and the dev composition. It is in memory
		   on purpose, never exposed over HTTP and never written to a log. */
		this.#messages.push({ ...acceptMailMessage(message), sentAt: this.#now() });
		if (this.#messages.length > DEVELOPMENT_OUTBOX_LIMIT) {
			this.#messages.splice(
				0,
				this.#messages.length - DEVELOPMENT_OUTBOX_LIMIT,
			);
		}
	}
}

const UNCONFIGURED: MailPort = Object.freeze({
	adapter: 'none' as const,
	configured: false,
	outbox: NO_MAIL,
	/* Refused before the message is even inspected, so the code a sender sees is
	   the same for every message: this deployment has no transport. */
	send: async (): Promise<void> => {
		throw new MailError(
			'MAIL_NOT_CONFIGURED',
			'No mail transport is configured for this deployment.',
		);
	},
});

/**
 * The platform's outbound mail. `none` refuses every message with a stable
 * code, `development` collects them in memory and is refused in production by
 * the configuration reader, `smtp` hands them to a deployment-owned relay.
 */
export function createMailPort(
	config: MailConfig,
	options: MailPortOptions = {},
): MailPort {
	if (config.adapter === 'none') return UNCONFIGURED;
	if (config.adapter === 'development') {
		return new DevelopmentMailPort(options.now ?? Date.now);
	}
	if (!options.createSmtpTransport) {
		throw new Error(
			`${config.variables.transport}=smtp needs an SMTP transport factory from the composition.`,
		);
	}
	const adapter = createSmtpMailAdapter({
		url: config.smtp.url,
		from: config.from,
		rejectUnauthorized: config.smtp.rejectUnauthorized,
		requireTLS: config.smtp.requireTLS,
		createTransport: options.createSmtpTransport,
		variables: { url: config.variables.url, from: config.variables.from },
	});
	return {
		adapter: 'smtp',
		configured: true,
		outbox: NO_MAIL,
		send: (message) => adapter.send(message),
	};
}
