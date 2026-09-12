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
	send(message: AuthMailMessage): Promise<void>;
}

export class DevelopmentMailDelivery implements AuthMailDelivery {
	readonly messages: AuthMailMessage[] = [];

	async send(message: AuthMailMessage): Promise<void> {
		/* Local-only evidence for tests and the dev composition. It is intentionally
		   in memory, never exposed over HTTP or written to logs. */
		this.messages.push({ ...message });
	}
}
