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
	/**
	 * False while nothing can carry a message. A settings-backed delivery
	 * answers it per read, because an operator configures a relay without a
	 * restart; a delivery that omits it can always send.
	 */
	readonly configured?: boolean;
}

/** Whether a sender may mint a token that only a delivered message redeems. */
export function mailDeliveryConfigured(
	delivery: AuthMailDelivery | undefined,
): delivery is AuthMailDelivery {
	return delivery !== undefined && delivery.configured !== false;
}

export class DevelopmentMailDelivery implements AuthMailDelivery {
	readonly messages: (AuthMailMessage & { readonly locale: string })[] = [];

	async send(message: AuthMailMessage, locale: string): Promise<void> {
		/* Local-only evidence for tests and the dev composition. It is intentionally
		   in memory, never exposed over HTTP or written to logs. */
		this.messages.push({ ...message, locale });
	}
}
