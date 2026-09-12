import { describe, expect, it } from 'vitest';
import {
	acceptMailMessage,
	MailError,
	MAIL_LIMITS,
	type MailMessage,
} from '../src/mail/contracts.ts';
import { mailConfigFromEnvironment } from '../src/mail/config.ts';
import { createMailPort, DEVELOPMENT_OUTBOX_LIMIT } from '../src/mail/port.ts';
import { renderMailTemplate } from '../src/mail/template.ts';
import type { SmtpMessage, SmtpTransportOptions } from '../src/mail/smtp.ts';

const SMTP_URL = 'smtps://relay%40example:s3cr3t@smtp.example.com:2525';
const FROM = 'Flowdular <no-reply@example.com>';

const MESSAGE: MailMessage = {
	to: 'person@example.com',
	subject: 'A subject',
	text: 'A body.',
};

interface FakeRelay {
	readonly created: SmtpTransportOptions[];
	readonly sent: SmtpMessage[];
	createTransport(options: SmtpTransportOptions): {
		sendMail(message: SmtpMessage): Promise<unknown>;
	};
}

/* The transport seam is what keeps these cases off a socket. */
function relay(failure?: Error): FakeRelay {
	const created: SmtpTransportOptions[] = [];
	const sent: SmtpMessage[] = [];
	return {
		created,
		sent,
		createTransport(options) {
			created.push(options);
			return {
				async sendMail(message) {
					if (failure) throw failure;
					sent.push(message);
					return { accepted: [message.to] };
				},
			};
		},
	};
}

function smtpPort(transport: FakeRelay, environment: NodeJS.ProcessEnv = {}) {
	return createMailPort(
		mailConfigFromEnvironment({
			FD_MAIL_TRANSPORT: 'smtp',
			FD_MAIL_SMTP_URL: SMTP_URL,
			FD_MAIL_FROM: FROM,
			...environment,
		}),
		{ createSmtpTransport: transport.createTransport },
	);
}

function developmentPort() {
	return createMailPort(
		mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'development' }),
	);
}

async function refusal(message: MailMessage): Promise<MailError> {
	const port = developmentPort();
	try {
		await port.send(message);
	} catch (error) {
		return error as MailError;
	}
	throw new Error('The message was accepted.');
}

describe('message bounds', () => {
	it('refuses a message that breaks a bound', async () => {
		const cases: readonly (readonly [string, MailMessage])[] = [
			['recipient', { ...MESSAGE, to: [] }],
			[
				'recipients',
				{
					...MESSAGE,
					to: Array.from(
						{ length: MAIL_LIMITS.recipients + 1 },
						(_entry, index) => `person${index}@example.com`,
					),
				},
			],
			['not deliverable', { ...MESSAGE, to: 'person(at)example.com' }],
			['not deliverable', { ...MESSAGE, to: `${'a'.repeat(320)}@example.com` }],
			['subject', { ...MESSAGE, subject: '' }],
			['subject', { ...MESSAGE, subject: 'a'.repeat(MAIL_LIMITS.subject + 1) }],
			['text body', { ...MESSAGE, text: '' }],
			['text body', { ...MESSAGE, text: 'a'.repeat(MAIL_LIMITS.text + 1) }],
			['HTML body', { ...MESSAGE, html: 'a'.repeat(MAIL_LIMITS.html + 1) }],
			['locale', { ...MESSAGE, locale: 'not a tag' }],
		];
		for (const [expected, message] of cases) {
			const error = await refusal(message);
			expect(error).toBeInstanceOf(MailError);
			expect(error.code).toBe('MAIL_MESSAGE_REJECTED');
			expect(error.message).toContain(expected);
		}
	});

	/* The whole point of one gate: a value that carries CR or LF would append
	   its own headers to the message the transport builds. */
	it('refuses every field that could carry a second header', async () => {
		const injections: readonly MailMessage[] = [
			{ ...MESSAGE, subject: 'Hello\nBcc: everyone@example.com' },
			{ ...MESSAGE, to: 'person@example.com\nBcc: everyone@example.com' },
			{
				...MESSAGE,
				headers: { 'x-source': 'agents.core\r\nBcc: everyone@example.com' },
			},
		];
		for (const message of injections) {
			expect((await refusal(message)).code).toBe('MAIL_MESSAGE_REJECTED');
		}
	});

	it('refuses a header the envelope owns and one the syntax forbids', async () => {
		for (const headers of [
			{ bcc: 'everyone@example.com' },
			{ To: 'someone@example.com' },
			{ 'content-language': 'de' },
			{ 'x invalid': 'value' },
		]) {
			expect((await refusal({ ...MESSAGE, headers })).code).toBe(
				'MAIL_MESSAGE_REJECTED',
			);
		}
		expect(
			(
				await refusal({
					...MESSAGE,
					headers: Object.fromEntries(
						Array.from({ length: MAIL_LIMITS.headers + 1 }, (_e, index) => [
							`x-header-${index}`,
							'value',
						]),
					),
				})
			).message,
		).toContain('headers');
	});

	it('deduplicates recipients and carries the locale as a header', () => {
		const accepted = acceptMailMessage({
			...MESSAGE,
			to: ['person@example.com', 'person@example.com', 'other@example.com'],
			locale: 'pl',
			headers: { 'X-Source': 'notifications.core' },
		});

		expect(accepted.to).toEqual(['person@example.com', 'other@example.com']);
		expect(accepted.headers).toEqual({
			'x-source': 'notifications.core',
			'content-language': 'pl',
		});
	});
});

describe('adapters', () => {
	it('refuses every message with a stable code when none is configured', async () => {
		const port = createMailPort(mailConfigFromEnvironment({}));

		expect(port.adapter).toBe('none');
		expect(port.configured).toBe(false);
		expect(port.outbox).toEqual([]);
		/* Stable whatever the message is: a sender learns that this deployment has
		   no transport, never that its message was the problem. */
		for (const message of [MESSAGE, { ...MESSAGE, subject: '' }]) {
			await expect(port.send(message)).rejects.toMatchObject({
				code: 'MAIL_NOT_CONFIGURED',
			});
		}
	});

	it('collects development mail in a bounded outbox', async () => {
		const port = createMailPort(
			mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'development' }),
			{ now: () => 1_700_000_000_000 },
		);
		await port.send({ ...MESSAGE, html: '<p>A body.</p>', locale: 'en' });

		expect(port.configured).toBe(true);
		expect(port.outbox).toEqual([
			{
				to: ['person@example.com'],
				subject: 'A subject',
				text: 'A body.',
				html: '<p>A body.</p>',
				locale: 'en',
				headers: { 'content-language': 'en' },
				sentAt: 1_700_000_000_000,
			},
		]);

		for (let index = 0; index < DEVELOPMENT_OUTBOX_LIMIT + 5; index += 1) {
			await port.send({ ...MESSAGE, subject: `Message ${index}` });
		}
		expect(port.outbox).toHaveLength(DEVELOPMENT_OUTBOX_LIMIT);
		/* The ring keeps the newest, so a long dev session still shows what it
		   just sent. */
		expect(port.outbox[DEVELOPMENT_OUTBOX_LIMIT - 1]?.subject).toBe(
			`Message ${DEVELOPMENT_OUTBOX_LIMIT + 4}`,
		);
	});

	it('opens one relay connection and reuses it', async () => {
		const transport = relay();
		const port = smtpPort(transport);
		await port.send(MESSAGE);
		await port.send({ ...MESSAGE, subject: 'Another subject' });

		expect(transport.created).toEqual([
			{
				host: 'smtp.example.com',
				port: 2525,
				secure: true,
				auth: { user: 'relay@example', pass: 's3cr3t' },
				tls: { rejectUnauthorized: true },
				connectionTimeout: 10_000,
				greetingTimeout: 10_000,
			},
		]);
		expect(transport.sent).toHaveLength(2);
		expect(transport.sent[0]).toMatchObject({
			from: FROM,
			to: 'person@example.com',
			subject: 'A subject',
			text: 'A body.',
		});
		expect(port.outbox).toEqual([]);
	});

	it('sends every accepted recipient in one envelope', async () => {
		const transport = relay();
		await smtpPort(transport).send({
			...MESSAGE,
			to: ['person@example.com', 'other@example.com'],
			headers: { 'x-source': 'notifications.core' },
		});

		expect(transport.sent[0]?.to).toBe('person@example.com, other@example.com');
		expect(transport.sent[0]?.headers).toEqual({
			'x-source': 'notifications.core',
		});
	});

	it('reports a failed delivery without the SMTP exchange', async () => {
		const transport = relay(
			new Error('535 5.7.8 Authentication failed for relay@example s3cr3t'),
		);

		const error = await smtpPort(transport)
			.send(MESSAGE)
			.catch((thrown: unknown) => thrown as MailError);
		expect(error).toBeInstanceOf(MailError);
		expect((error as MailError).code).toBe('MAIL_DELIVERY_FAILED');
		expect(JSON.stringify(error)).not.toContain('s3cr3t');
		expect((error as MailError).message).not.toContain('smtp.example.com');
	});

	/* Opening the connection is as much of the delivery as sending on it: a
	   factory rejection quotes the relay and the options it was handed. */
	it('reports a transport it could not open as a failed delivery', async () => {
		const handed: SmtpTransportOptions[] = [];
		const port = createMailPort(
			mailConfigFromEnvironment({
				FD_MAIL_TRANSPORT: 'smtp',
				FD_MAIL_SMTP_URL: SMTP_URL,
				FD_MAIL_FROM: FROM,
			}),
			{
				createSmtpTransport: (options) => {
					handed.push(options);
					return Promise.reject(
						new Error(`connect ECONNREFUSED ${JSON.stringify(options)}`),
					);
				},
			},
		);

		const error = await port
			.send(MESSAGE)
			.catch((thrown: unknown) => thrown as MailError);
		expect(error).toBeInstanceOf(MailError);
		expect((error as MailError).code).toBe('MAIL_DELIVERY_FAILED');
		expect(JSON.stringify(error)).not.toContain('s3cr3t');
		expect((error as MailError).message).not.toContain('smtp.example.com');
		/* A relay that was down for one message must not be down for every later
		   one: the failed connection is not the cached one. */
		await expect(port.send(MESSAGE)).rejects.toMatchObject({
			code: 'MAIL_DELIVERY_FAILED',
		});
		expect(handed).toHaveLength(2);
	});

	it('validates the message before it opens a connection', async () => {
		const transport = relay();
		await expect(
			smtpPort(transport).send({ ...MESSAGE, to: 'not-an-address' }),
		).rejects.toMatchObject({ code: 'MAIL_MESSAGE_REJECTED' });

		expect(transport.created).toHaveLength(0);
	});

	it('names the composition when smtp has no transport factory', () => {
		expect(() =>
			createMailPort(
				mailConfigFromEnvironment({
					FD_MAIL_TRANSPORT: 'smtp',
					FD_MAIL_SMTP_URL: SMTP_URL,
					FD_MAIL_FROM: FROM,
				}),
			),
		).toThrow(/FD_MAIL_TRANSPORT=smtp needs an SMTP transport factory/);
	});
});

describe('configuration', () => {
	it('reads the platform variables and defaults to no transport', () => {
		expect(mailConfigFromEnvironment({}).adapter).toBe('none');
		const config = mailConfigFromEnvironment({
			FD_MAIL_TRANSPORT: 'smtp',
			FD_MAIL_SMTP_URL: SMTP_URL,
			FD_MAIL_FROM: FROM,
			FD_MAIL_SMTP_REQUIRE_TLS: 'false',
		});

		expect(config).toMatchObject({
			adapter: 'smtp',
			from: FROM,
			smtp: { url: SMTP_URL, rejectUnauthorized: true, requireTLS: false },
			deprecated: [],
		});
		expect(config.variables.url).toBe('FD_MAIL_SMTP_URL');
	});

	it('accepts the retired auth.core names and reports them', () => {
		const config = mailConfigFromEnvironment({
			FD_AUTH_MAIL_TRANSPORT: 'smtp',
			FD_AUTH_SMTP_URL: SMTP_URL,
			FD_AUTH_MAIL_FROM: FROM,
		});

		expect(config.adapter).toBe('smtp');
		expect(config.from).toBe(FROM);
		expect(config.deprecated).toEqual([
			'FD_AUTH_MAIL_TRANSPORT',
			'FD_AUTH_SMTP_URL',
			'FD_AUTH_MAIL_FROM',
		]);
		/* A refusal names what the operator set, not a spelling they never used. */
		expect(config.variables.transport).toBe('FD_AUTH_MAIL_TRANSPORT');
		expect(
			mailConfigFromEnvironment({
				FD_MAIL_TRANSPORT: 'smtp',
				FD_MAIL_SMTP_URL: SMTP_URL,
				FD_AUTH_MAIL_FROM: FROM,
			}).deprecated,
		).toEqual(['FD_AUTH_MAIL_FROM']);
		expect(
			mailConfigFromEnvironment({ FD_AUTH_DEVELOPMENT_MAIL: 'true' }),
		).toMatchObject({
			adapter: 'development',
			deprecated: ['FD_AUTH_DEVELOPMENT_MAIL'],
		});
	});

	it('prefers the platform name over the retired one', () => {
		const config = mailConfigFromEnvironment({
			FD_MAIL_TRANSPORT: 'none',
			FD_AUTH_MAIL_TRANSPORT: 'development',
		});

		expect(config.adapter).toBe('none');
		expect(config.deprecated).toEqual([]);
	});

	/* The in-memory adapter accepts every message and delivers none; in
	   production that is silent data loss. */
	it('refuses the development adapter in production', () => {
		for (const environment of [
			{ FD_MAIL_TRANSPORT: 'development' },
			{ FD_AUTH_MAIL_TRANSPORT: 'development' },
			{ FD_AUTH_DEVELOPMENT_MAIL: 'true' },
		]) {
			expect(() =>
				mailConfigFromEnvironment({ ...environment, NODE_ENV: 'production' }),
			).toThrow(/is only allowed outside production/);
		}
		expect(
			mailConfigFromEnvironment({
				NODE_ENV: 'production',
				FD_MAIL_TRANSPORT: 'none',
			}).production,
		).toBe(true);
	});

	it('names the variable a deployment is missing or got wrong', () => {
		expect(() =>
			mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'sendgrid' }),
		).toThrow(/FD_MAIL_TRANSPORT must be one of none, development, smtp/);
		expect(() =>
			mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'smtp' }),
		).toThrow(/FD_MAIL_SMTP_URL is required/);
		expect(() =>
			mailConfigFromEnvironment({
				FD_MAIL_TRANSPORT: 'smtp',
				FD_MAIL_SMTP_URL: SMTP_URL,
			}),
		).toThrow(/FD_MAIL_FROM is required/);
		/* A deployment still on the retired family is told about the key next to
		   the one it set. */
		expect(() =>
			mailConfigFromEnvironment({ FD_AUTH_MAIL_TRANSPORT: 'smtp' }),
		).toThrow(/FD_AUTH_SMTP_URL is required/);
		expect(() =>
			mailConfigFromEnvironment({
				FD_MAIL_TRANSPORT: 'smtp',
				FD_AUTH_DEVELOPMENT_MAIL: 'true',
			}),
		).toThrow(/FD_AUTH_DEVELOPMENT_MAIL cannot be combined/);
		expect(() =>
			mailConfigFromEnvironment({
				FD_MAIL_TRANSPORT: 'smtp',
				FD_MAIL_SMTP_URL: SMTP_URL,
				FD_MAIL_FROM: FROM,
				FD_MAIL_SMTP_REQUIRE_TLS: 'insecure',
			}),
		).toThrow(/FD_MAIL_SMTP_REQUIRE_TLS must be true or false/);
	});

	/* An unquoted display name carrying one of these makes a parser read a second
	   address, or an address nobody named, out of the name. The deployment learns
	   that at boot rather than from what a recipient sees. */
	it('refuses a sender whose display name carries an address separator', () => {
		const transport = relay();
		for (const from of [
			'Ops, Inc <no-reply@example.com>',
			'Ops; Inc <no-reply@example.com>',
			'Ops: Inc <no-reply@example.com>',
			'ops@example.com <no-reply@example.com>',
			'Reply <ops@example.com> <no-reply@example.com>',
		]) {
			expect(() => smtpPort(transport, { FD_MAIL_FROM: from })).toThrow(
				/FD_MAIL_FROM has an unsupported display name/,
			);
		}
		expect(
			smtpPort(transport, {
				FD_MAIL_FROM: 'Flowdular Ops <no-reply@example.com>',
			}).configured,
		).toBe(true);
	});

	it('refuses a sender or a relay URL the transport could not use', () => {
		const transport = relay();
		for (const environment of [
			{ FD_MAIL_FROM: 'no-reply' },
			{ FD_MAIL_FROM: 'no-reply@example.com\nBcc: everyone@example.com' },
			{ FD_MAIL_SMTP_URL: 'https://smtp.example.com' },
			{ FD_MAIL_SMTP_URL: 'smtp://relay%40example:pa%ss@smtp.example.com' },
		]) {
			expect(() => smtpPort(transport, environment)).toThrow(/^FD_MAIL_/);
		}
	});
});

describe('template rendering', () => {
	it('fills the holes and escapes only the HTML part', () => {
		const rendered = renderMailTemplate(
			{
				subject: 'Reset for {{ workspace }}',
				text: 'Open {{url}} to continue.',
				html: '<p><a href="{{url}}">{{workspace}}</a></p>',
			},
			{
				url: 'https://erp.example/reset?token=abc&next=1',
				workspace: 'Ada & Co <ops>',
			},
		);

		expect(rendered.subject).toBe('Reset for Ada & Co <ops>');
		expect(rendered.text).toBe(
			'Open https://erp.example/reset?token=abc&next=1 to continue.',
		);
		expect(rendered.html).toBe(
			'<p><a href="https://erp.example/reset?token=abc&amp;next=1">Ada &amp; Co &lt;ops&gt;</a></p>',
		);
	});

	/* One pass: a value is written out, never rendered again, so nothing a
	   caller supplies can name another value. */
	it('never expands what a value contains', () => {
		expect(
			renderMailTemplate(
				{ subject: 'Hi', text: '{{ name }}' },
				{ name: '{{secret}}', secret: 'must not appear' },
			).text,
		).toBe('{{secret}}');
	});

	/* A hole is filled from what the caller supplied and from nothing else:
	   {{constructor}} would otherwise render Object's source into the message. */
	it('refuses a hole named after an inherited property', () => {
		for (const name of ['constructor', 'toString']) {
			expect(() =>
				renderMailTemplate({ subject: 'Hi', text: `{{${name}}}` }, {}),
			).toThrow(new RegExp(`unknown value ${name}`));
		}
		expect(
			renderMailTemplate(
				{ subject: 'Hi', text: '{{constructor}}' },
				{ constructor: 'Ada' },
			).text,
		).toBe('Ada');
	});

	/* The wording a template holds is written in one language, and the message it
	   becomes says which, so a client can render and read it as that language. */
	it('carries the template locale into the accepted message', async () => {
		const rendered = renderMailTemplate({
			subject: 'Hi',
			text: 'Body',
			locale: 'pl',
		});
		expect(rendered.locale).toBe('pl');
		expect(
			renderMailTemplate({ subject: 'Hi', text: 'Body' }).locale,
		).toBeUndefined();

		const port = developmentPort();
		await port.send({ to: 'person@example.com', ...rendered });
		expect(port.outbox[0]).toMatchObject({
			locale: 'pl',
			headers: { 'content-language': 'pl' },
		});
	});

	it('refuses an unknown value and a value past the bounds', () => {
		expect(() =>
			renderMailTemplate({ subject: 'Hi', text: '{{missing}}' }, {}),
		).toThrow(/unknown value missing/);
		expect(() =>
			renderMailTemplate(
				{ subject: 'Hi', text: '{{name}}' },
				{ name: 'a'.repeat(4_097) },
			),
		).toThrow(/at most 4096 characters/);
		expect(() =>
			renderMailTemplate(
				{ subject: 'Hi', text: 'Body' },
				Object.fromEntries(
					Array.from({ length: 33 }, (_entry, index) => [`value${index}`, 'x']),
				),
			),
		).toThrow(/at most 32 values/);
	});
});
