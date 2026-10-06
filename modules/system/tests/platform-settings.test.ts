import { createPgliteTestProvider } from '@flowdular/database-testing';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import {
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { DEFAULT_APPLICATION_BRANDING } from '@flowdular/contracts';
import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
} from '@flowdular/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	createSystemRoutes,
	type SettingsEntryPayload,
} from '../src/server/endpoints.ts';
import { SYSTEM_MODULE_SETTINGS } from '../src/settings.ts';
import { memoryActivationRuntime } from './support/activation.ts';

const ORIGIN = 'https://erp.example';
const DEFAULT_PORTAL = 'https://portal.example';
const SESSION_COOKIE = 'flowdular_session_dev';

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly tenantId: string;
}

interface SettingsBody {
	readonly modules: readonly {
		readonly moduleId: string;
		readonly settings: readonly SettingsEntryPayload[];
	}[];
}

/* Another module's platform setting: one address every workspace renders. */
const DEMO_SETTINGS = defineModuleSettings({
	moduleId: 'demo.core',
	settings: {
		portalUrl: {
			type: 'string',
			defaultValue: DEFAULT_PORTAL,
			visibility: 'shared',
			client: true,
			scope: 'platform',
			max: 200,
			pattern: 'https://[a-z0-9./-]+',
			label: 'Portal address',
		},
		fastCheckout: {
			type: 'boolean',
			defaultValue: false,
			visibility: 'private',
			client: false,
			kind: 'flag',
			scope: 'tenant',
			label: 'Fast checkout',
			description: 'Skips the review step when the basket is small.',
		},
	},
});

describe('platform-scoped settings and the operator workspace', () => {
	let runtime: AuthRuntime;
	/** Owner of the workspace FD_OPERATOR_TENANT names. */
	let operator: Session;
	/** Owner of a customer workspace. */
	let customer: Session;

	const routesFor = (operatorTenantId?: string): readonly ServerRoute[] =>
		createSystemRoutes({
			workspaceRoot: runtime.workspaceRoot!,
			auth: runtime,
			settings: runtime.moduleSettings,
			activation: memoryActivationRuntime(),
			...(operatorTenantId ? { operatorTenantId } : {}),
		});

	const call = async (
		routes: readonly ServerRoute[],
		path: string,
		request: Request,
	): Promise<Response> => {
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

	const update = (
		routes: readonly ServerRoute[],
		session: Session,
		moduleId: string,
		key: string,
		value: unknown,
	): Promise<Response> =>
		call(
			routes,
			'/api/settings/update',
			new Request(`${ORIGIN}/api/settings/update`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					cookie: session.cookie,
					'x-csrf-token': session.csrfToken,
				},
				body: JSON.stringify({ moduleId, key, value }),
			}),
		);

	const list = async (
		routes: readonly ServerRoute[],
		session: Session,
	): Promise<readonly (SettingsEntryPayload & { moduleId: string })[]> => {
		const response = await call(
			routes,
			'/api/settings',
			new Request(`${ORIGIN}/api/settings`, {
				headers: { cookie: session.cookie },
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as SettingsBody;
		return body.modules.flatMap((module) =>
			module.settings.map((setting) => ({
				...setting,
				moduleId: module.moduleId,
			})),
		);
	};

	const settingsEvents = async (tenantId: string): Promise<number> =>
		(
			await (await runtime.service()).queryAudit({ tenantId, limit: 50 })
		).events.filter((event) => event.action === 'settings.updated').length;

	const platformValue = (moduleId: string, key: string) =>
		runtime.moduleSettings.get(PLATFORM_SETTINGS_TENANT, moduleId, key);

	const signUp = async (
		email: string,
		displayName: string,
		organizationName: string,
		organizationSlug: string,
	): Promise<Session> => {
		const issued = await (
			await runtime.service()
		).signUp({
			email,
			password: 'correct horse battery staple',
			displayName,
			organizationName,
			organizationSlug,
		});
		return {
			cookie: `${SESSION_COOKIE}=${issued.token}`,
			csrfToken: issued.csrfToken,
			tenantId: issued.principal.tenantId,
		};
	};

	beforeAll(async () => {
		const root = mkdtempSync(join(tmpdir(), 'flowdular-platform-settings-'));
		writeFileSync(
			join(root, 'flowdular.json'),
			JSON.stringify({ modules: { enabled: [] }, locales: ['en', 'pl'] }),
		);
		runtime = createAuthRuntime({
			databases: createPgliteTestProvider(),
			secureCookies: false,
			cookieName: SESSION_COOKIE,
			sessionTtlMs: 12 * 60 * 60 * 1000,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
			workspaceRoot: root,
		});
		runtime.moduleSettings.declare(SYSTEM_MODULE_SETTINGS);
		runtime.moduleSettings.declare(DEMO_SETTINGS);
		operator = await signUp(
			'ops@operator.example',
			'Ada Operator',
			'Operator Workspace',
			'operator-workspace',
		);
		customer = await signUp(
			'owner@customer.example',
			'Bo Customer',
			'Customer Workspace',
			'customer-workspace',
		);
		/* The record names the customer, so every case below shows that a set
		   FD_OPERATOR_TENANT decides and the record is not consulted. */
		await (await runtime.service()).setOperator(customer.tenantId, 'cli:ops');
		await runtime.moduleSettings.prime(PLATFORM_SETTINGS_TENANT);
	});

	it('SYSTEM-SETTINGS-PLATFORM-OPERATOR refuses a customer owner every platform-scoped write', async () => {
		const routes = routesFor(operator.tenantId);
		for (const [moduleId, key, value] of [
			['system.core', 'appName', 'Customer Brand'],
			['system.core', 'logoUrl', 'https://customer.example/logo.svg'],
			['demo.core', 'portalUrl', 'https://customer.example'],
			['auth.core', 'allowSignUp', false],
			['auth.core', 'mailTransport', 'none'],
			['auth.core', 'mailSmtpUrl', 'smtp://relay.customer.example'],
			['system.core', 'logoUrl', null],
			/* Refused before validation, so the answer says nothing about the value. */
			['system.core', 'appName', '<b>Customer</b>'],
		] as const) {
			const refused = await update(routes, customer, moduleId, key, value);
			expect(refused.status, `${moduleId}.${key}`).toBe(403);
			expect(await refused.json()).toMatchObject({
				error: { code: 'PLATFORM_SETTING_OPERATOR_ONLY' },
			});
		}
		expect(platformValue('system.core', 'appName')).toBe(
			DEFAULT_APPLICATION_BRANDING.appName,
		);
		expect(platformValue('demo.core', 'portalUrl')).toBe(DEFAULT_PORTAL);
		expect(platformValue('auth.core', 'allowSignUp')).toBe(true);
		expect(platformValue('auth.core', 'mailTransport')).toBe('environment');
		expect(platformValue('auth.core', 'mailSmtpUrl')).toBe('');
		const seenByOperator = await list(routes, operator);
		expect(
			seenByOperator.find((setting) => setting.key === 'portalUrl')?.value,
		).toBe(DEFAULT_PORTAL);
		expect(await settingsEvents(customer.tenantId)).toBe(0);
		expect(await (await runtime.service()).operatorWorkspace()).toMatchObject({
			workspace: { tenantId: customer.tenantId },
		});
	});

	it('SYSTEM-SETTINGS-PLATFORM-OPERATOR stores an operator write for every workspace', async () => {
		const routes = routesFor(operator.tenantId);
		const brand = await update(
			routes,
			operator,
			'system.core',
			'appName',
			'Operator Brand',
		);
		expect(brand.status).toBe(200);
		const portal = await update(
			routes,
			operator,
			'demo.core',
			'portalUrl',
			'https://portal.operator.example',
		);
		expect(portal.status).toBe(200);
		expect(await portal.json()).toMatchObject({
			setting: { value: 'https://portal.operator.example', hasValue: true },
		});

		const seenByCustomer = await list(routes, customer);
		expect(
			seenByCustomer.find(
				(setting) =>
					setting.moduleId === 'system.core' && setting.key === 'appName',
			)?.value,
		).toBe('Operator Brand');
		expect(
			seenByCustomer.find((setting) => setting.key === 'portalUrl')?.value,
		).toBe('https://portal.operator.example');
		await expect
			.poll(() => settingsEvents(operator.tenantId), { timeout: 5_000 })
			.toBe(2);
		expect(await settingsEvents(customer.tenantId)).toBe(0);
	});

	it('SYSTEM-SETTINGS-PLATFORM-OPERATOR keeps tenant settings and flags with the customer owner', async () => {
		const routes = routesFor(operator.tenantId);
		const zone = await update(
			routes,
			customer,
			'system.core',
			'timeZone',
			'Europe/Warsaw',
		);
		expect(zone.status).toBe(200);
		const flag = await update(
			routes,
			customer,
			'demo.core',
			'fastCheckout',
			true,
		);
		expect(flag.status).toBe(200);

		expect(
			runtime.moduleSettings.get(customer.tenantId, 'system.core', 'timeZone'),
		).toBe('Europe/Warsaw');
		expect(
			runtime.moduleSettings.get(
				customer.tenantId,
				'demo.core',
				'fastCheckout',
			),
		).toBe(true);
		await runtime.moduleSettings.prime(operator.tenantId);
		expect(
			runtime.moduleSettings.get(operator.tenantId, 'system.core', 'timeZone'),
		).toBe('UTC');
		expect(
			runtime.moduleSettings.get(
				operator.tenantId,
				'demo.core',
				'fastCheckout',
			),
		).toBe(false);
	});

	it('SYSTEM-SETTINGS-READ locks platform rows outside the operator workspace only', async () => {
		const routes = routesFor(operator.tenantId);
		const customerRows = await list(routes, customer);
		const platformRows = customerRows.filter(
			(setting) => setting.scope === 'platform',
		);
		expect(platformRows.length).toBeGreaterThan(0);
		for (const row of platformRows) {
			expect(row.lockedKey, `${row.moduleId}.${row.key}`).toBe(
				'system.settings.platformOperatorOnly',
			);
		}
		const tenantRows = customerRows.filter(
			(setting) => setting.scope === 'tenant',
		);
		expect(
			tenantRows.find((setting) => setting.key === 'timeZone')?.locked,
		).toBeUndefined();
		expect(
			tenantRows.find((setting) => setting.key === 'fastCheckout')?.locked,
		).toBeUndefined();

		const operatorRows = await list(routes, operator);
		for (const key of ['appName', 'logoUrl', 'portalUrl', 'allowSignUp']) {
			expect(
				operatorRows.find((setting) => setting.key === key)?.locked,
				key,
			).toBeUndefined();
		}
	});
});
