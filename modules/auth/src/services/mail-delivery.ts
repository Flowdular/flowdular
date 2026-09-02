/* Delivery is deliberately an injected port. auth.core creates opaque links but
   never selects an SMTP, transactional-email, or provider SDK on its own. */
export interface AuthMailDelivery {
	send(message: {
		readonly to: string;
		readonly kind: 'password-reset' | 'tenant-invitation';
		readonly url: string;
	}): Promise<void>;
}

export class DevelopmentMailDelivery implements AuthMailDelivery {
	readonly messages: {
		to: string;
		kind: 'password-reset' | 'tenant-invitation';
		url: string;
	}[] = [];

	async send(message: {
		readonly to: string;
		readonly kind: 'password-reset' | 'tenant-invitation';
		readonly url: string;
	}): Promise<void> {
		/* Local-only evidence for tests and the dev composition. It is intentionally
		   in memory, never exposed over HTTP or written to logs. */
		this.messages.push({ ...message });
	}
}
