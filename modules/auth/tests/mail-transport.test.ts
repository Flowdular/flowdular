import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
	createMailPort,
	mailConfigFromEnvironment,
	MailError,
	NO_MAIL,
	type MailPort,
} from '@flowdular/server';
import { authRuntimeOptionsFromEnvironment } from '../src/server/runtime.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { DevelopmentMailDelivery } from '../src/services/mail-delivery.ts';
import { createMailPortDelivery } from '../src/services/mail-port.ts';
import {
	SmtpMailDelivery,
	type SmtpMessage,
	type SmtpTransportOptions,
} from '../src/services/mail-smtp.ts';
import { closeAuthTestDatabases, fastHash } from './helpers.ts';
import { createAuthTestDatabase } from './support/database.ts';

const ROOT = process.cwd();
const SMTP_URL = 'smtps://relay%40example:s3cr3t@smtp.example.com:2525';
const FROM = 'Flowdular <no-reply@example.com>';
const RESET_URL = 'https://erp.example/auth/reset-password?token=abc&next=1';

function options(environment: NodeJS.ProcessEnv) {
	return authRuntimeOptionsFromEnvironment(environment, ROOT);
}

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

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(closeAuthTestDatabases);

describe('auth mail transport configuration', () => {
	it('composes no transport by default and honours the legacy development flag', () => {
		expect(options({}).mailTransport).toBe(false);
		expect(options({}).mailDelivery).toBeUndefined();
		expect(
			options({ FD_AUTH_MAIL_TRANSPORT: 'none' }).mailDelivery,
		).toBeUndefined();
		for (const environment of [
			{ FD_AUTH_DEVELOPMENT_MAIL: 'true' },
			{ FD_AUTH_MAIL_TRANSPORT: 'development' },
		]) {
			const composed = options(environment);
			expect(composed.mailTransport).toBe(true);
			expect(composed.mailDelivery).toBeInstanceOf(DevelopmentMailDelivery);
		}
	});

	it('refuses development mail in production and rejects an unknown transport', () => {
		expect(() =>
			options({ NODE_ENV: 'production', FD_AUTH_DEVELOPMENT_MAIL: 'true' }),
		).toThrow(/FD_AUTH_DEVELOPMENT_MAIL is only allowed outside production/);
		expect(() =>
			options({
				NODE_ENV: 'production',
				FD_AUTH_MAIL_TRANSPORT: 'development',
			}),
		).toThrow(/FD_AUTH_MAIL_TRANSPORT=development/);
		expect(() => options({ FD_AUTH_MAIL_TRANSPORT: 'sendgrid' })).toThrow(
			/FD_AUTH_MAIL_TRANSPORT must be one of none, development, smtp/,
		);
		expect(() =>
			options({
				FD_AUTH_MAIL_TRANSPORT: 'smtp',
				FD_AUTH_DEVELOPMENT_MAIL: 'true',
			}),
		).toThrow(/FD_AUTH_DEVELOPMENT_MAIL cannot be combined/);
	});

	it('names the variable an smtp deployment is missing or got wrong', () => {
		expect(() => options({ FD_AUTH_MAIL_TRANSPORT: 'smtp' })).toThrow(
			/FD_AUTH_SMTP_URL is required/,
		);
		expect(() =>
			options({ FD_AUTH_MAIL_TRANSPORT: 'smtp', FD_AUTH_SMTP_URL: SMTP_URL }),
		).toThrow(/FD_AUTH_MAIL_FROM is required/);
		expect(() =>
			options({
				FD_AUTH_MAIL_TRANSPORT: 'smtp',
				FD_AUTH_SMTP_URL: 'https://smtp.example.com',
				FD_AUTH_MAIL_FROM: FROM,
			}),
		).toThrow(/FD_AUTH_SMTP_URL must use smtp:\/\/ or smtps:\/\//);
		expect(() =>
			options({
				FD_AUTH_MAIL_TRANSPORT: 'smtp',
				FD_AUTH_SMTP_URL: SMTP_URL,
				FD_AUTH_MAIL_FROM: 'no-reply',
			}),
		).toThrow(/FD_AUTH_MAIL_FROM must be an address/);
		expect(() =>
			options({
				FD_AUTH_MAIL_TRANSPORT: 'smtp',
				FD_AUTH_SMTP_URL: SMTP_URL,
				FD_AUTH_MAIL_FROM: FROM,
				FD_AUTH_SMTP_REQUIRE_TLS: 'insecure',
			}),
		).toThrow(/FD_AUTH_SMTP_REQUIRE_TLS must be true or false/);
	});

	it('serves email confirmation in production once smtp is configured', () => {
		const production = {
			NODE_ENV: 'production',
			FD_AUTH_MAIL_TRANSPORT: 'smtp',
			FD_AUTH_SMTP_URL: SMTP_URL,
			FD_AUTH_MAIL_FROM: FROM,
			FD_AUTH_EMAIL_CONFIRMATION: 'true',
		};
		const composed = options(production);
		expect(composed.mailDelivery).toBeInstanceOf(SmtpMailDelivery);
		expect(composed.mailTransport).toBe(true);
		expect(composed.emailConfirmation).toBe(true);
		expect(() =>
			options({ NODE_ENV: 'production', FD_AUTH_EMAIL_CONFIRMATION: 'true' }),
		).toThrow(/FD_AUTH_EMAIL_CONFIRMATION requires a composed mail transport/);
	});
});

describe('SmtpMailDelivery', () => {
	it('derives one bounded connection from the URL and reuses it', async () => {
		const transport = relay();
		const delivery = new SmtpMailDelivery({
			url: SMTP_URL,
			from: FROM,
			createTransport: transport.createTransport,
		});
		await delivery.send({
			to: 'invited@example.com',
			kind: 'tenant-invitation',
			url: RESET_URL,
		});
		await delivery.send({
			to: 'invited@example.com',
			kind: 'password-reset',
			url: RESET_URL,
		});

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
		await delivery.send({
			to: 'invited@example.com',
			kind: 'email-confirmation',
			url: RESET_URL,
		});
		expect(transport.created).toHaveLength(1);
	});

	it('takes the port, the TLS mode and the anonymous relay from the URL', async () => {
		const transport = relay();
		await new SmtpMailDelivery({
			url: 'smtp://smtp.example.com',
			from: 'no-reply@example.com',
			rejectUnauthorized: false,
			createTransport: transport.createTransport,
		}).send({
			to: 'person@example.com',
			kind: 'password-reset',
			url: RESET_URL,
		});

		expect(transport.created[0]).toEqual({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			requireTLS: true,
			tls: { rejectUnauthorized: false },
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
		});
		expect(transport.sent[0]?.from).toBe('no-reply@example.com');
	});

	/* Port 587 starts in the clear. Without requireTLS nodemailer keeps the
	   plain socket when the relay offers no STARTTLS or a downgrade strips it,
	   and the relay credentials and the single-use link go over it. */
	it('demands STARTTLS on the cleartext scheme unless the deployment opts out', async () => {
		const enforced = relay();
		const relaxed = relay();
		for (const [transport, requireTLS] of [
			[enforced, undefined],
			[relaxed, false],
		] as const) {
			await new SmtpMailDelivery({
				url: 'smtp://relay%40example:s3cr3t@smtp.example.com',
				from: FROM,
				...(requireTLS === undefined ? {} : { requireTLS }),
				createTransport: transport.createTransport,
			}).send({
				to: 'person@example.com',
				kind: 'password-reset',
				url: RESET_URL,
			});
		}

		expect(enforced.created[0]?.requireTLS).toBe(true);
		expect(relaxed.created[0]?.requireTLS).toBe(false);
	});

	/* The implicit TLS scheme is already encrypted end to end; a STARTTLS
	   demand on it would only be noise in the transport options. */
	it('leaves the implicit TLS scheme without a STARTTLS demand', async () => {
		const transport = relay();
		await new SmtpMailDelivery({
			url: SMTP_URL,
			from: FROM,
			createTransport: transport.createTransport,
		}).send({
			to: 'person@example.com',
			kind: 'password-reset',
			url: RESET_URL,
		});

		expect(transport.created[0]).not.toHaveProperty('requireTLS');
	});

	it('names the variable when the relay credentials are not percent-encoded', () => {
		expect(
			() =>
				new SmtpMailDelivery({
					url: 'smtp://relay%40example:pa%ss@smtp.example.com',
					from: FROM,
				}),
		).toThrow(/^FD_AUTH_SMTP_URL credentials must be percent-encoded\.$/);
	});

	it('renders a subject, a link and no relay credentials per kind', async () => {
		const transport = relay();
		const delivery = new SmtpMailDelivery({
			url: SMTP_URL,
			from: FROM,
			createTransport: transport.createTransport,
		});
		for (const kind of [
			'password-reset',
			'tenant-invitation',
			'email-confirmation',
		] as const) {
			await delivery.send({ to: 'person@example.com', kind, url: RESET_URL });
		}

		expect(transport.sent.map((message) => message.subject)).toEqual([
			'Reset your password',
			'You have been invited to a workspace',
			'Confirm your email address',
		]);
		for (const message of transport.sent) {
			expect(message.to).toBe('person@example.com');
			expect(message.from).toBe(FROM);
			expect(message.text).toContain(RESET_URL);
			expect(message.html).toContain(
				'href="https://erp.example/auth/reset-password?token=abc&amp;next=1"',
			);
		}
		const serialized = JSON.stringify(transport.sent);
		expect(serialized).not.toContain('s3cr3t');
		expect(serialized).not.toContain('smtp.example.com');
	});

	it('refuses an implausible or oversized recipient before it connects', async () => {
		const transport = relay();
		const delivery = new SmtpMailDelivery({
			url: SMTP_URL,
			from: FROM,
			createTransport: transport.createTransport,
		});
		for (const to of [
			'not-an-address',
			`${'a'.repeat(320)}@example.com`,
			'person@example.com, other@example.com',
		]) {
			await expect(
				delivery.send({ to, kind: 'password-reset', url: RESET_URL }),
			).rejects.toThrow(/not deliverable/);
		}
		expect(transport.created).toHaveLength(0);
	});

	it('reports a failed delivery without the SMTP exchange', async () => {
		const error = new Error(
			'535 5.7.8 Authentication failed for relay@example with password s3cr3t',
		);
		const transport = relay(error);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const delivery = new SmtpMailDelivery({
			url: SMTP_URL,
			from: FROM,
			createTransport: transport.createTransport,
		});

		await expect(
			delivery.send({
				to: 'invited@example.com',
				kind: 'tenant-invitation',
				url: RESET_URL,
			}),
		).rejects.toThrow(/^Mail delivery failed for tenant-invitation\.$/);
		expect(logged).toHaveBeenCalledWith(
			'[auth.core] smtp delivery failed (tenant-invitation)',
		);
		expect(JSON.stringify(logged.mock.calls)).not.toContain('s3cr3t');
	});

	it('refuses a sender that could carry its own headers', () => {
		for (const from of [
			'no-reply@example.com\nBcc: everyone@example.com',
			'no-reply',
			`${'a'.repeat(320)}@example.com`,
		]) {
			expect(() => new SmtpMailDelivery({ url: SMTP_URL, from })).toThrow(
				/FD_AUTH_MAIL_FROM/,
			);
		}
	});
});

describe('auth as a sender on the platform mail port', () => {
	function developmentPort(): MailPort {
		return createMailPort(
			mailConfigFromEnvironment({ FD_MAIL_TRANSPORT: 'development' }),
		);
	}

	it('renders every kind into the port', async () => {
		const mail = developmentPort();
		const delivery = createMailPortDelivery(mail);
		for (const kind of [
			'password-reset',
			'tenant-invitation',
			'email-confirmation',
		] as const) {
			await delivery.send({ to: 'person@example.com', kind, url: RESET_URL });
		}

		expect(mail.outbox.map((message) => message.subject)).toEqual([
			'Reset your password',
			'You have been invited to a workspace',
			'Confirm your email address',
		]);
		for (const message of mail.outbox) {
			expect(message.to).toEqual(['person@example.com']);
			expect(message.text).toContain(RESET_URL);
			expect(message.html).toContain(
				'href="https://erp.example/auth/reset-password?token=abc&amp;next=1"',
			);
		}
	});

	/* The port's refusal names the transport; what auth.core hands back names
	   only the kind that failed. */
	it('answers a refusal with the kind and nothing about the transport', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const delivery = createMailPortDelivery({
			adapter: 'smtp',
			configured: true,
			outbox: NO_MAIL,
			send: async () => {
				throw new MailError(
					'MAIL_DELIVERY_FAILED',
					'535 5.7.8 Authentication failed for relay@example with s3cr3t',
				);
			},
		});

		await expect(
			delivery.send({
				to: 'invited@example.com',
				kind: 'tenant-invitation',
				url: RESET_URL,
			}),
		).rejects.toThrow(/^Mail delivery failed for tenant-invitation\.$/);
		expect(JSON.stringify(logged.mock.calls)).not.toContain('s3cr3t');
	});

	it('delivers a password reset through the port', async () => {
		const database = await createAuthTestDatabase();
		const mail = developmentPort();
		try {
			const service = new AuthService(database.repository, {
				passwordHash: fastHash,
				mailDelivery: createMailPortDelivery(mail),
			});
			await service.signUp({
				email: 'owner@example.com',
				password: 'correct horse battery staple',
				displayName: 'Ada Owner',
				organizationName: 'Example Operations',
				organizationSlug: 'example-operations',
			});

			await service.requestPasswordReset('Owner@Example.com');

			expect(mail.outbox).toHaveLength(1);
			expect(mail.outbox[0]).toMatchObject({
				to: ['owner@example.com'],
				subject: 'Reset your password',
			});
		} finally {
			await database.dispose();
		}
	});
});

describe('password reset without a mail transport', () => {
	it('answers generically and records the undelivered reset once', async () => {
		const database = await createAuthTestDatabase();
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const service = new AuthService(database.repository, {
				passwordHash: fastHash,
			});
			await service.signUp({
				email: 'owner@example.com',
				password: 'correct horse battery staple',
				displayName: 'Ada Owner',
				organizationName: 'Example Operations',
				organizationSlug: 'example-operations',
			});

			await expect(
				service.requestPasswordReset('Owner@Example.com'),
			).resolves.toBeUndefined();
			expect(warned).toHaveBeenCalledTimes(1);
			expect(warned).toHaveBeenCalledWith(
				'[auth.core] mail transport is none; password reset for an existing account was not delivered',
			);

			await service.requestPasswordReset('stranger@example.com');
			expect(warned).toHaveBeenCalledTimes(1);
		} finally {
			await database.dispose();
		}
	});
});
