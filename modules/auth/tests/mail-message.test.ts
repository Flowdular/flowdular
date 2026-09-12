import { describe, expect, it } from 'vitest';
import { createMailPort, mailConfigFromEnvironment } from '@flowdular/server';
import type { AuthMailKind } from '../src/services/mail-delivery.ts';
import { authMailMessage } from '../src/services/mail-message.ts';

const KINDS: readonly AuthMailKind[] = [
	'password-reset',
	'tenant-invitation',
	'email-confirmation',
];

const LINK = 'https://erp.example/auth/reset-password?token=abc&next=1';

describe('auth.core mail messages', () => {
	/* The wording is English, and a message that does not say so is rendered by
	   the client in whatever language it guesses from the account. */
	it('declares the language its wording is written in', async () => {
		const port = createMailPort(
			mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'development' }),
		);
		for (const kind of KINDS) {
			const message = authMailMessage({
				to: 'person@example.com',
				kind,
				url: LINK,
			});
			expect([kind, message.locale]).toEqual([kind, 'en']);
			await port.send(message);
		}

		expect(port.outbox.map((sent) => sent.headers['content-language'])).toEqual(
			KINDS.map(() => 'en'),
		);
	});
});
