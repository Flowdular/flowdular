/* Delivery is deliberately an injected port. auth.core creates opaque links but
   never selects an SMTP, transactional-email, or provider SDK on its own. */
export type AuthMailKind =
	| 'password-reset'
	| 'tenant-invitation'
	| 'email-confirmation';

export interface AuthMailMessage {
	readonly to: string;
	readonly kind: AuthMailKind;
	readonly url: string;
}

export interface AuthMailDelivery {
	/** `locale` is the workspace default the wording is rendered in. */
	send(message: AuthMailMessage, locale: string): Promise<void>;
}

export class DevelopmentMailDelivery implements AuthMailDelivery {
	readonly messages: (AuthMailMessage & { readonly locale: string })[] = [];

	async send(message: AuthMailMessage, locale: string): Promise<void> {
		/* Local-only evidence for tests and the dev composition. It is intentionally
		   in memory, never exposed over HTTP or written to logs. */
		this.messages.push({ ...message, locale });
	}
}
