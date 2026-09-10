import { createPgliteTestProvider } from '@flowdular/database-testing';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import {
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
} from '@flowdular/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSystemRoutes } from '../src/server/endpoints.ts';
import type { SettingsEntryPayload } from '../src/server/endpoints.ts';

const ORIGIN = 'https://erp.example';

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
}

interface SettingsBody {
	readonly modules: readonly {
		readonly moduleId: string;
		readonly name: string;
		readonly settings: readonly SettingsEntryPayload[];
	}[];
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-system-settings-'));
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({
			modules: { enabled: ['auth.core'] },
			locales: ['en', 'pl'],
		}),
	);
	mkdirSync(join(root, 'modules/auth/spec'), { recursive: true });
	writeFileSync(
		join(root, 'modules/auth/module.json'),
		JSON.stringify({ id: 'auth.core', version: '0.5.0', capabilities: [] }),
	);
	writeFileSync(
		join(root, 'modules/auth/spec/module.yaml'),
		['id: auth.core', 'specVersion: 0.5.0', 'name: Authentication Core'].join(
			'\n',
		),
	);
	return root;
}

describe('settings API', () => {
	let runtime: AuthRuntime;
	let routes: readonly ServerRoute[];
	let owner: Session;
	let member: Session;

	const call = async (path: string, request: Request): Promise<Response> => {
		const route = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(request.method),
		);
		if (!route) throw new Error(`No route ${request.method} ${path}`);
		const context = createContext(request, {});
		return runtime.middleware(context, () =>
			Promise.resolve(route.handler(context)),
		);
	};

	const read = (session?: Session): Request =>
		new Request(`${ORIGIN}/api/settings`, {
			headers: session ? { cookie: session.cookie } : {},
		});

	const update = (
		body: unknown,
		session: Session,
		headers: Record<string, string> = {
			cookie: session.cookie,
			'x-csrf-token': session.csrfToken,
		},
	): Request =>
		new Request(`${ORIGIN}/api/settings/update`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				...headers,
			},
			body: JSON.stringify(body),
		});

	beforeAll(async () => {
		runtime = createAuthRuntime({
			databases: createPgliteTestProvider(),
			secureCookies: false,
			sessionTtlMs: 12 * 60 * 60 * 1000,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
			workspaceRoot: workspace(),
		});
		runtime.moduleSettings.declare(
			defineModuleSettings({
				moduleId: 'demo.core',
				settings: {
					apiKey: {
						type: 'string',
						defaultValue: '',
						visibility: 'private',
						client: false,
						secret: true,
						label: 'API key',
					},
				},
			}),
		);
		const issued = await (
			await runtime.service()
		).signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		owner = {
			cookie: `coreloom_session_dev=${issued.token}`,
			csrfToken: issued.csrfToken,
			accountId: issued.principal.accountId,
			tenantId: issued.principal.tenantId,
		};
		await (
			await runtime.service()
		).createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.com',
				password: 'member password long',
				displayName: 'Mem Ber',
				role: 'member',
			},
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: issued.principal.email,
				role: 'owner',
				scopes: issued.principal.scopes,
			},
		);
		const memberSession = await (
			await runtime.service()
		).signIn({
			email: 'member@example.com',
			password: 'member password long',
		});
		member = {
			cookie: `coreloom_session_dev=${memberSession.token}`,
			csrfToken: memberSession.csrfToken,
			accountId: memberSession.principal.accountId,
			tenantId: memberSession.principal.tenantId,
		};
		routes = createSystemRoutes({
			workspaceRoot: runtime.workspaceRoot!,
			auth: runtime,
			settings: runtime.moduleSettings,
		});
	});

	it('denies reads without a session or the read scope', async () => {
		expect((await call('/api/settings', read())).status).toBe(401);
		expect((await call('/api/settings', read(member))).status).toBe(403);
		const denied = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'allowSignUp', value: false },
				member,
			),
		);
		expect(denied.status).toBe(403);
		expect(
			runtime.moduleSettings.get(
				PLATFORM_SETTINGS_TENANT,
				'auth.core',
				'allowSignUp',
			),
		).toBe(true);
	});

	it('lists declared settings with catalog names and lock reasons', async () => {
		const response = await call('/api/settings', read(owner));
		expect(response.status).toBe(200);
		const body = (await response.json()) as SettingsBody;
		const auth = body.modules.find(
			(module) => module.moduleId === 'auth.core',
		)!;
		expect(auth.name).toBe('Authentication Core');
		expect(
			auth.settings.find((setting) => setting.key === 'allowSignUp')?.value,
		).toBe(true);
		expect(
			auth.settings.find((setting) => setting.key === 'allowSignUp'),
		).toMatchObject({
			label: 'Allow sign-up',
			labelKey: 'auth.moduleSettings.allowSignUp.label',
			descriptionKey: 'auth.moduleSettings.allowSignUp.description',
		});
		expect(
			auth.settings.find((setting) => setting.key === 'defaultLocale')?.enum,
		).toEqual(['en', 'pl']);
		expect(
			auth.settings.find((setting) => setting.key === 'emailConfirmation')
				?.locked,
		).toMatch(/mail transport/);
		expect(
			auth.settings.find((setting) => setting.key === 'emailConfirmation')
				?.lockedKey,
		).toBe('system.settings.mailTransportRequired');
		expect(body.modules.some((module) => module.moduleId === 'demo.core')).toBe(
			true,
		);
	});

	it('stores and clears validated values and audits both through onChange', async () => {
		const stored = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'sessionIdleMinutes', value: 90 },
				owner,
			),
		);
		expect(stored.status).toBe(200);
		const storedBody = (await stored.json()) as {
			setting: SettingsEntryPayload;
		};
		expect(storedBody.setting).toMatchObject({ value: 90, hasValue: true });
		expect(
			runtime.moduleSettings.get(
				PLATFORM_SETTINGS_TENANT,
				'auth.core',
				'sessionIdleMinutes',
			),
		).toBe(90);

		const cleared = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'sessionIdleMinutes', value: null },
				owner,
			),
		);
		expect(cleared.status).toBe(200);
		expect(
			runtime.moduleSettings.get(
				PLATFORM_SETTINGS_TENANT,
				'auth.core',
				'sessionIdleMinutes',
			),
		).toBe(120);

		/* The kernel change listener is synchronous, so the audit rows land after
		   the response. Wait for them rather than racing the write. */
		await runtime.settingsAuditSettled();
		const events = (
			await (
				await runtime.service()
			).queryAudit({ tenantId: owner.tenantId, limit: 10 })
		).events.filter((event) => event.action === 'settings.updated');
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			actorLabel: 'owner@example.com',
			subjectId: 'auth.core.sessionIdleMinutes',
			metadata: { cleared: true },
		});
		expect(events[1]?.metadata).toEqual({ cleared: false });
	});

	it('rejects invalid values, unknown keys, and locked settings', async () => {
		const invalid = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'sessionTtlHours', value: 999 },
				owner,
			),
		);
		expect(invalid.status).toBe(400);
		const unknown = await call(
			'/api/settings/update',
			update({ moduleId: 'auth.core', key: 'nope', value: 1 }, owner),
		);
		expect(unknown.status).toBe(404);
		const wrongShape = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'allowSignUp', value: { on: true } },
				owner,
			),
		);
		expect(wrongShape.status).toBe(400);
		const mail = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'emailConfirmation', value: true },
				owner,
			),
		);
		expect(mail.status).toBe(409);
		expect(await mail.json()).toMatchObject({
			error: { code: 'MAIL_TRANSPORT_REQUIRED' },
		});
	});

	it('keeps secret values write-only', async () => {
		const set = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'demo.core', key: 'apiKey', value: 'sk-secret-value' },
				owner,
			),
		);
		expect(set.status).toBe(200);
		const setBody = (await set.json()) as { setting: SettingsEntryPayload };
		expect(setBody.setting).toMatchObject({
			value: null,
			hasValue: true,
			secret: true,
			defaultValue: null,
		});
		const listed = await call('/api/settings', read(owner));
		expect(JSON.stringify(await listed.json())).not.toContain(
			'sk-secret-value',
		);
	});

	it('refuses mutations without CSRF and from API tokens', async () => {
		const noCsrf = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'allowSignUp', value: false },
				owner,
				{
					cookie: owner.cookie,
				},
			),
		);
		expect(noCsrf.status).toBe(403);
		const token = await (
			await runtime.service()
		).issueApiToken({
			tenantId: owner.tenantId,
			accountId: owner.accountId,
			label: 'Automation',
			scopes: ['system.settings.manage'],
			expiresAt: null,
			createdBy: owner.accountId,
		});
		const viaToken = await call(
			'/api/settings/update',
			update(
				{ moduleId: 'auth.core', key: 'allowSignUp', value: false },
				owner,
				{
					authorization: `Bearer ${token.token}`,
				},
			),
		);
		expect(viaToken.status).toBe(403);
		expect(await viaToken.json()).toMatchObject({
			error: { code: 'TOKEN_MUTATION_DENIED' },
		});
		expect(
			runtime.moduleSettings.get(
				PLATFORM_SETTINGS_TENANT,
				'auth.core',
				'allowSignUp',
			),
		).toBe(true);
	});
});
