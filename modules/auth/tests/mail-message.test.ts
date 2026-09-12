import { describe, expect, it } from 'vitest';
import { createMailPort, mailConfigFromEnvironment } from '@flowdular/server';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import type { AuthMailKind } from '../src/services/mail-delivery.ts';
import { authMailMessage } from '../src/services/mail-message.ts';

const KINDS: readonly AuthMailKind[] = [
	'password-reset',
	'tenant-invitation',
	'email-confirmation',
];

const LINK = 'https://erp.example/auth/reset-password?token=abc&next=1';

const BUNDLES: Record<string, Record<string, string>> = {
	en: translationsEn,
	pl: translationsPl,
};

describe('auth.core mail messages', () => {
	it('words the subject and the body from the bundle of the locale it is given', () => {
		for (const locale of ['en', 'pl']) {
			const bundle = BUNDLES[locale]!;
			for (const kind of KINDS) {
				const message = authMailMessage(
					{ to: 'person@example.com', kind, url: LINK },
					locale,
				);
				expect([locale, kind, message.subject]).toEqual([
					locale,
					kind,
					bundle[`mail.${kind}.subject`],
				]);
				expect(message.text).toContain(bundle[`mail.${kind}.intro`]);
				expect(message.text).toContain(bundle['mail.closing']);
				expect(message.html).toContain(`>${bundle[`mail.${kind}.action`]}<`);
				expect(message.html).toContain(bundle[`mail.${kind}.intro`]);
			}
		}
		expect(
			authMailMessage(
				{ to: 'person@example.com', kind: 'password-reset', url: LINK },
				'pl',
			).subject,
		).not.toBe(
			authMailMessage(
				{ to: 'person@example.com', kind: 'password-reset', url: LINK },
				'en',
			).subject,
		);
	});

	it('falls back to English for a locale it ships no bundle for', () => {
		const english = authMailMessage(
			{ to: 'person@example.com', kind: 'tenant-invitation', url: LINK },
			'en',
		);
		const unknown = authMailMessage(
			{ to: 'person@example.com', kind: 'tenant-invitation', url: LINK },
			'de',
		);
		expect(unknown).toEqual(english);
		expect(unknown.locale).toBe('en');
	});

	/* A message that does not say its language is rendered by the client in
	   whatever language it guesses from the account. */
	it('declares the language its wording is written in', async () => {
		const port = createMailPort(
			mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'development' }),
		);
		for (const kind of KINDS) {
			const message = authMailMessage(
				{ to: 'person@example.com', kind, url: LINK },
				'pl',
			);
			expect([kind, message.locale]).toEqual([kind, 'pl']);
			await port.send(message);
		}

		expect(port.outbox.map((sent) => sent.headers['content-language'])).toEqual(
			KINDS.map(() => 'pl'),
		);
	});
});
