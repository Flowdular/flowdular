import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
	createMailPort,
	mailConfigFromEnvironment,
	type SmtpMessage,
	type SmtpTransportOptions,
} from '@flowdular/server';
import { PLATFORM_SETTINGS_TENANT } from '@flowdular/kernel';
import {
	authed,
	call,
	closeAuthTestDatabases,
	jsonRequest,
	ORIGIN,
	signUpOwner,
	testRuntime,
	type SignedIn,
	type TestRuntime,
} from './helpers.ts';

/* The relay of an installation is auth.core platform settings. These cases run
   the same guards a served request runs and never open a socket: the transport
   seam is the factory the effective port is built with. */

const STORED_URL = 'smtps://relay%40example:s3cr3t@stored.example.com:2525';
const OTHER_URL = 'smtps://relay%40example:s3cr3t@other.example.com:2525';
const ENVIRONMENT_URL =
	'smtps://env%40example:env-pass@environment.example.com';
const FROM = 'Flowdular <no-reply@example.com>';
const PASSWORD = 's3cr3t';

interface FakeRelay {
	readonly created: SmtpTransportOptions[];
	readonly sent: SmtpMessage[];
	createTransport(options: SmtpTransportOptions): {
		sendMail(message: SmtpMessage): Promise<unknown>;
	};
}

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

/** The deployment port a composition builds from FD_MAIL_*. */
function environmentPort(environment: NodeJS.ProcessEnv, transport: FakeRelay) {
	return createMailPort(mailConfigFromEnvironment(environment), {
		createSmtpTransport: transport.createTransport,
	});
}

async function store(
	runtime: TestRuntime,
	key: string,
	value: string | boolean | null,
): Promise<void> {
	await runtime.moduleSettings.set(
		PLATFORM_SETTINGS_TENANT,
		'auth.core',
		key,
		value,
		'operator',
	);
}

async function storeRelay(
	runtime: TestRuntime,
	url = STORED_URL,
): Promise<void> {
	await store(runtime, 'mailSmtpUrl', url);
	await store(runtime, 'mailFrom', FROM);
	await store(runtime, 'mailTransport', 'smtp');
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		throw new Error('The write was accepted.');
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function json(response: Response): Promise<{
	error?: { code?: string; message?: string };
	sent?: boolean;
	mail?: {
		source: string;
		transport: string;
		configured: boolean;
		from: string;
	};
}> {
	return (await response.json()) as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(closeAuthTestDatabases);

describe('AUTH-MAIL-SETTINGS-REFUSED', () => {
	it('refuses a mail configuration that could not send and stores nothing', async () => {
		const runtime = await testRuntime();
		try {
			expect(await refusal(store(runtime, 'mailTransport', 'smtp'))).toContain(
				'auth.core.mailSmtpUrl',
			);
			expect(
				await refusal(store(runtime, 'mailSmtpUrl', 'https://relay.example')),
			).toBe('auth.core.mailSmtpUrl must use smtp:// or smtps://.');
			expect(
				await refusal(store(runtime, 'mailSmtpUrl', 'not a url at all')),
			).toBe('auth.core.mailSmtpUrl must be a valid URL.');
			expect(
				await refusal(store(runtime, 'mailFrom', 'not-an-address')),
			).toContain('auth.core.mailFrom');

			await store(runtime, 'mailSmtpUrl', STORED_URL);
			expect(await refusal(store(runtime, 'mailTransport', 'smtp'))).toContain(
				'auth.core.mailFrom',
			);
			await store(runtime, 'mailFrom', FROM);
			await store(runtime, 'mailTransport', 'smtp');

			/* Whichever way the configuration would end up incomplete: clearing a
			   value of a live relay is refused exactly as naming smtp without it. */
			expect(await refusal(store(runtime, 'mailSmtpUrl', null))).toContain(
				'auth.core.mailSmtpUrl',
			);
			expect(await refusal(store(runtime, 'mailFrom', ''))).toContain(
				'auth.core.mailFrom',
			);
			expect(runtime.mail.summary()).toEqual({
				source: 'settings',
				transport: 'smtp',
				configured: true,
				from: FROM,
			});
		} finally {
			await runtime.dispose();
		}
	});

	it('names the field and never the value it refused', async () => {
		const runtime = await testRuntime();
		try {
			const message = await refusal(
				store(runtime, 'mailSmtpUrl', `https://user:${PASSWORD}@relay.example`),
			);
			expect(message).not.toContain(PASSWORD);
			expect(message).toContain('auth.core.mailSmtpUrl');
		} finally {
			await runtime.dispose();
		}
	});
});

describe('AUTH-MAIL-SETTINGS-PRECEDENCE', () => {
	it('lets a stored transport win over the environment and hands it back when cleared', async () => {
		const stored = relay();
		const environment = relay();
		const runtime = await testRuntime({
			mail: environmentPort(
				{
					FD_MAIL_TRANSPORT: 'smtp',
					FD_MAIL_SMTP_URL: ENVIRONMENT_URL,
					FD_MAIL_FROM: FROM,
				},
				environment,
			),
			createSmtpTransport: stored.createTransport,
		});
		try {
			expect(runtime.mail.summary().source).toBe('environment');
			await runtime.mail.send({
				to: 'reader@example.com',
				subject: 'One',
				text: 'from the environment',
			});
			expect(environment.created[0]?.host).toBe('environment.example.com');
			expect(stored.created).toHaveLength(0);

			await storeRelay(runtime);
			expect(runtime.mail.summary()).toEqual({
				source: 'settings',
				transport: 'smtp',
				configured: true,
				from: FROM,
			});
			await runtime.mail.send({
				to: 'reader@example.com',
				subject: 'Two',
				text: 'from the settings',
			});
			expect(stored.created.map((options) => options.host)).toEqual([
				'stored.example.com',
			]);
			expect(environment.sent).toHaveLength(1);

			await store(runtime, 'mailTransport', null);
			expect(runtime.mail.summary().source).toBe('environment');
			await runtime.mail.send({
				to: 'reader@example.com',
				subject: 'Three',
				text: 'back to the environment',
			});
			expect(environment.sent).toHaveLength(2);
			expect(stored.sent).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});

	it('turns mail off for every sender when the stored transport is none', async () => {
		const environment = relay();
		const runtime = await testRuntime({
			mail: environmentPort(
				{
					FD_MAIL_TRANSPORT: 'smtp',
					FD_MAIL_SMTP_URL: ENVIRONMENT_URL,
					FD_MAIL_FROM: FROM,
				},
				environment,
			),
		});
		try {
			expect(runtime.mailTransport).toBe(true);
			await store(runtime, 'mailTransport', 'none');
			expect(runtime.mailTransport).toBe(false);
			expect(runtime.mail.summary()).toEqual({
				source: 'settings',
				transport: 'none',
				configured: false,
				from: '',
			});
			await expect(
				runtime.mail.send({
					to: 'reader@example.com',
					subject: 'Held',
					text: 'nothing leaves',
				}),
			).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
			expect(environment.sent).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it('opens an unchanged relay once and rebuilds it when a setting changes', async () => {
		const transport = relay();
		const runtime = await testRuntime({
			createSmtpTransport: transport.createTransport,
		});
		try {
			await storeRelay(runtime);
			const message = { to: 'reader@example.com', subject: 'Ping', text: 'ok' };
			await runtime.mail.send(message);
			await runtime.mail.send(message);
			expect(transport.created).toHaveLength(1);
			expect(transport.sent).toHaveLength(2);

			await store(runtime, 'mailSmtpUrl', OTHER_URL);
			await runtime.mail.send(message);
			expect(transport.created.map((options) => options.host)).toEqual([
				'stored.example.com',
				'other.example.com',
			]);

			/* A switch that is not the URL is part of the digest too. */
			await store(runtime, 'mailRejectUnauthorized', false);
			await runtime.mail.send(message);
			expect(transport.created).toHaveLength(3);
			expect(transport.created[2]?.tls.rejectUnauthorized).toBe(false);
		} finally {
			await runtime.dispose();
		}
	});
});

async function memberSession(
	runtime: TestRuntime,
	owner: SignedIn,
): Promise<SignedIn> {
	const member = await runtime.authService.createTenantMember(
		{
			tenantId: owner.tenantId,
			email: 'member@example.com',
			password: 'steady tangerine harbor',
			displayName: 'Mem Ber',
			role: 'member',
		},
		{
			accountId: owner.accountId,
			tenantId: owner.tenantId,
			email: 'owner@example.com',
			role: 'owner',
			scopes: ['users.members.manage'],
		},
	);
	expect(member.scopes).not.toContain('system.settings.manage');
	const signedIn = await call(
		runtime,
		'/api/auth/sign-in',
		jsonRequest('/api/auth/sign-in', {
			email: 'member@example.com',
			password: 'steady tangerine harbor',
		}),
	);
	return {
		cookie: signedIn.headers.get('set-cookie')!.split(';')[0]!,
		csrfToken: ((await signedIn.json()) as { csrfToken: string }).csrfToken,
		accountId: member.accountId,
		tenantId: owner.tenantId,
	};
}

function testRequest(session: SignedIn, extra: Record<string, string> = {}) {
	return jsonRequest('/api/auth/mail/test', {}, authed(session, extra));
}

describe('AUTH-MAIL-TEST-MESSAGE', () => {
	it('sends one message to the signed-in address and records the attempt', async () => {
		const transport = relay();
		const runtime = await testRuntime({
			createSmtpTransport: transport.createTransport,
		});
		try {
			const owner = await signUpOwner(runtime);
			await storeRelay(runtime);
			const response = await call(
				runtime,
				'/api/auth/mail/test',
				testRequest(owner),
			);
			expect(response.status).toBe(200);
			expect((await json(response)).sent).toBe(true);
			expect(transport.sent).toHaveLength(1);
			expect(transport.sent[0]?.to).toBe('owner@example.com');

			const status = await call(
				runtime,
				'/api/auth/mail',
				new Request(`${ORIGIN}/api/auth/mail`, {
					headers: { cookie: owner.cookie },
				}),
			);
			expect((await json(status)).mail).toEqual({
				source: 'settings',
				transport: 'smtp',
				configured: true,
				from: FROM,
			});

			const trail = await runtime.authService.queryAudit({
				tenantId: owner.tenantId,
				limit: 50,
			});
			const row = trail.events.find(
				(event) => event.action === 'auth.mail.tested',
			);
			expect(row?.metadata).toEqual({
				source: 'settings',
				transport: 'smtp',
				outcome: 'sent',
			});
			expect(JSON.stringify(row)).not.toContain(PASSWORD);
			expect(JSON.stringify(row)).not.toContain('stored.example.com');
		} finally {
			await runtime.dispose();
		}
	});

	it('reports the transport refusal without the relay or its credentials', async () => {
		const transport = relay(
			new Error(`535 auth failed for relay@example with ${PASSWORD}`),
		);
		const errors: unknown[] = [];
		vi.spyOn(console, 'error').mockImplementation((...args) => {
			errors.push(args);
		});
		const runtime = await testRuntime({
			createSmtpTransport: transport.createTransport,
		});
		try {
			const owner = await signUpOwner(runtime);
			await storeRelay(runtime);
			const response = await call(
				runtime,
				'/api/auth/mail/test',
				testRequest(owner),
			);
			expect(response.status).toBe(502);
			const body = await json(response);
			expect(body.error?.code).toBe('MAIL_DELIVERY_FAILED');
			expect(JSON.stringify(body)).not.toContain(PASSWORD);
			expect(JSON.stringify(body)).not.toContain('stored.example.com');
			expect(JSON.stringify(errors)).not.toContain(PASSWORD);
			expect(JSON.stringify(errors)).not.toContain('stored.example.com');

			const trail = await runtime.authService.queryAudit({
				tenantId: owner.tenantId,
				limit: 50,
			});
			expect(
				trail.events.find((event) => event.action === 'auth.mail.tested')
					?.metadata,
			).toEqual({
				source: 'settings',
				transport: 'smtp',
				outcome: 'MAIL_DELIVERY_FAILED',
			});
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses without the permission, without a CSRF proof and past the rate limit', async () => {
		const transport = relay();
		const runtime = await testRuntime({
			createSmtpTransport: transport.createTransport,
		});
		try {
			const owner = await signUpOwner(runtime);
			await storeRelay(runtime);

			const anonymous = await call(
				runtime,
				'/api/auth/mail/test',
				jsonRequest('/api/auth/mail/test', {}),
			);
			expect(anonymous.status).toBe(401);

			const withoutCsrf = await call(
				runtime,
				'/api/auth/mail/test',
				jsonRequest('/api/auth/mail/test', {}, { cookie: owner.cookie }),
			);
			expect(withoutCsrf.status).toBe(403);
			expect((await json(withoutCsrf)).error?.code).toBe('CSRF_REJECTED');

			const member = await memberSession(runtime, owner);
			const denied = await call(
				runtime,
				'/api/auth/mail/test',
				testRequest(member),
			);
			expect(denied.status).toBe(403);
			expect((await json(denied)).error?.code).toBe('FORBIDDEN');
			const readDenied = await call(
				runtime,
				'/api/auth/mail',
				new Request(`${ORIGIN}/api/auth/mail`, {
					headers: { cookie: member.cookie },
				}),
			);
			expect(readDenied.status).toBe(403);
			expect(transport.sent).toHaveLength(0);

			/* Three per owner per quarter hour; the fourth press sends nothing. */
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const accepted = await call(
					runtime,
					'/api/auth/mail/test',
					testRequest(owner),
				);
				expect(accepted.status).toBe(200);
			}
			const limited = await call(
				runtime,
				'/api/auth/mail/test',
				testRequest(owner),
			);
			expect(limited.status).toBe(429);
			expect((await json(limited)).error?.code).toBe('RATE_LIMITED');
			expect(transport.sent).toHaveLength(3);
		} finally {
			await runtime.dispose();
		}
	});
});
