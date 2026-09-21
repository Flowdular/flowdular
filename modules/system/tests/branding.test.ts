import { createPgliteTestProvider } from '@flowdular/database-testing';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import {
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { DEFAULT_APPLICATION_BRANDING } from '@flowdular/contracts';
import { PLATFORM_SETTINGS_TENANT } from '@flowdular/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { brandingFromSettings } from '../src/domain/branding.ts';
import { createSystemRoutes } from '../src/server/endpoints.ts';
import { SYSTEM_MODULE_SETTINGS } from '../src/settings.ts';
import { memoryActivationRuntime } from './support/activation.ts';

const ORIGIN = 'https://erp.example';

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly tenantId: string;
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-system-branding-'));
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

describe('deployment branding', () => {
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

	const update = (key: string, value: unknown, session: Session): Request =>
		new Request(`${ORIGIN}/api/settings/update`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: session.cookie,
				'x-csrf-token': session.csrfToken,
			},
			body: JSON.stringify({ moduleId: 'system.core', key, value }),
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
		runtime.moduleSettings.declare(SYSTEM_MODULE_SETTINGS);
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
			tenantId: issued.principal.tenantId,
		};
		await (
			await runtime.service()
		).createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.com',
				password: 'workspace passphrase long',
				displayName: 'Mem Ber',
				role: 'member',
			},
			{
				accountId: issued.principal.accountId,
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
			password: 'workspace passphrase long',
		});
		member = {
			cookie: `coreloom_session_dev=${memberSession.token}`,
			csrfToken: memberSession.csrfToken,
			tenantId: memberSession.principal.tenantId,
		};
		routes = createSystemRoutes({
			workspaceRoot: runtime.workspaceRoot!,
			auth: runtime,
			settings: runtime.moduleSettings,
			activation: memoryActivationRuntime(),
		});
		await runtime.moduleSettings.prime(PLATFORM_SETTINGS_TENANT);
	});

	it('reads the product defaults until an owner changes something', () => {
		expect(brandingFromSettings(runtime.moduleSettings)).toEqual(
			DEFAULT_APPLICATION_BRANDING,
		);
	});

	/* SYSTEM-BRANDING-MANAGE: stored once for the deployment, and the resolver
	   the document reads answers with it on the next read, without a restart. */
	it('stores a change for every workspace and serves it to the next document', async () => {
		const stored = await call(
			'/api/settings/update',
			update('appName', 'Acme Operations', owner),
		);
		expect(stored.status).toBe(200);
		const logo = await call(
			'/api/settings/update',
			update('logoUrl', 'https://cdn.example.test/acme.svg', owner),
		);
		expect(logo.status).toBe(200);

		const branding = brandingFromSettings(runtime.moduleSettings);
		expect(branding.appName).toBe('Acme Operations');
		expect(branding.logoUrl).toBe('https://cdn.example.test/acme.svg');
		/* A platform setting has one value; the second workspace reads the same. */
		expect(
			runtime.moduleSettings.get(member.tenantId, 'system.core', 'appName'),
		).toBe('Acme Operations');
	});

	/* SYSTEM-BRANDING-CLEAR */
	it('returns to the product default when the value is cleared', async () => {
		const cleared = await call(
			'/api/settings/update',
			update('appName', null, owner),
		);
		expect(cleared.status).toBe(200);
		expect(brandingFromSettings(runtime.moduleSettings).appName).toBe(
			DEFAULT_APPLICATION_BRANDING.appName,
		);
	});

	/* SYSTEM-BRANDING-VALIDATE */
	it.each([
		['logoUrl', 'javascript:alert(1)'],
		['logoUrl', '//evil.test/logo.svg'],
		['faviconUrl', 'data:image/svg+xml,<svg/>'],
		['ogImageUrl', 'http://cdn.example.test/og.png'],
		['themeColor', '#fff'],
		['appName', '<b>Acme</b>'],
		['appName', 'a'.repeat(65)],
		['documentTitle', 42],
	])('refuses %s = %s and stores nothing', async (key, value) => {
		const before = runtime.moduleSettings.get(
			PLATFORM_SETTINGS_TENANT,
			'system.core',
			key as string,
		);
		const refused = await call(
			'/api/settings/update',
			update(key as string, value, owner),
		);
		expect(refused.status).toBe(400);
		expect(
			runtime.moduleSettings.get(
				PLATFORM_SETTINGS_TENANT,
				'system.core',
				key as string,
			),
		).toBe(before);
	});

	/* SYSTEM-BRANDING-DENY */
	it('refuses a member and an anonymous caller', async () => {
		const denied = await call(
			'/api/settings/update',
			update('appName', 'Member Brand', member),
		);
		expect(denied.status).toBe(403);
		const anonymous = await call(
			'/api/settings/update',
			new Request(`${ORIGIN}/api/settings/update`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({
					moduleId: 'system.core',
					key: 'appName',
					value: 'Anonymous Brand',
				}),
			}),
		);
		expect(anonymous.status).toBe(401);
		expect(brandingFromSettings(runtime.moduleSettings).appName).toBe(
			DEFAULT_APPLICATION_BRANDING.appName,
		);
	});
});
