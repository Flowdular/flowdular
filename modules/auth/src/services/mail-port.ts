import { MailError, type MailPort } from '@flowdular/server';
import type { AuthMailDelivery, AuthMailMessage } from './mail-delivery.ts';
import { authMailMessage } from './mail-message.ts';

/**
 * auth.core as a sender on the platform mail port. The transport, its bounds
 * and its refusals belong to the port; this only renders the message and keeps
 * the relay's words out of what the caller sees.
 */
export function createMailPortDelivery(mail: MailPort): AuthMailDelivery {
	return {
		async send(message: AuthMailMessage, locale: string): Promise<void> {
			try {
				await mail.send(authMailMessage(message, locale));
			} catch (error) {
				const code = error instanceof MailError ? error.code : 'MAIL_FAILED';
				console.error(`[auth.core] mail delivery failed (${message.kind})`, {
					code,
				});
				throw new Error(`Mail delivery failed for ${message.kind}.`);
			}
		},
	};
}
