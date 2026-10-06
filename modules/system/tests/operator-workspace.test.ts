import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import { DEFAULT_APPLICATION_BRANDING } from '@flowdular/contracts';
import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
} from '@flowdular/kernel';
import {
	GREENFIELD_ACCOUNTS,
	GREENFIELD_TENANT_SLUGS,
	seedGreenfield,
} from '@flowdular/module-auth/greenfield';
import {
	createAuthRoutes,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { buildOpenApiDocument } from '@flowdular/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createSystemRoutes,
	type SettingsEntryPayload,
} from '../src/server/endpoints.ts';
import { SYSTEM_MODULE_SETTINGS } from '../src/settings.ts';
import { memoryActivationRuntime } from './support/activation.ts';

const ORIGIN = 'https://erp.example';
const SESSION_COOKIE = 'flowdular_session_dev';
const PASSWORD = 'correct horse battery staple';
const DEFAULT_PORTAL = 'https://portal.example';
const OPERATOR_ONLY = 'system.settings.platformOperatorOnly';
const OPERATOR_UNSET = 'system.settings.platformOperatorUnset';

/* Another module's platform setting, so the lock is shown to cover every
   module's platform rows and not only system.core's. */
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
	},
});

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly tenantId: string;
	readonly token: string;
}

type Row = SettingsEntryPayload & { readonly moduleId: string };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function session(issued: {
	readonly token: string;
	readonly csrfToken: string;
	readonly principal: { readonly tenantId: string };
}): Session {
	return {
		cookie: `${SESSION_COOKIE}=${issued.token}`,
		csrfToken: issued.csrfToken,
		tenantId: issued.principal.tenantId,
		token: issued.token,
	};
}

/* One deployment: an auth runtime over its own database, opened the way the
   platform opens it, and the system routes it serves. */
async function deployment(databases?: DatabaseProvider) {
	const provider = databases ?? createPgliteTestProvider();
	const root = mkdtempSync(join(tmpdir(), 'flowdular-operator-workspace-'));
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({ modules: { enabled: [] }, locales: ['en', 'pl'] }),
	);
	const runtime: AuthRuntime = createAuthRuntime({
		databases: provider,
		secureCookies: false,
		cookieName: SESSION_COOKIE,
		sessionTtlMs: 12 * 60 * 60 * 1000,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
		workspaceRoot: root,
	});
	cleanups.push(async () => {
		await runtime.dispose();
		if (!databases) await provider.dispose();
	});
	runtime.moduleSettings.declare(SYSTEM_MODULE_SETTINGS);
	runtime.moduleSettings.declare(DEMO_SETTINGS);
	const service = await runtime.service();
	await runtime.moduleSettings.prime(PLATFORM_SETTINGS_TENANT);

	const routes = (operatorTenantId?: string): readonly ServerRoute[] =>
		createSystemRoutes({
			workspaceRoot: root,
			auth: runtime,
			settings: runtime.moduleSettings,
			activation: memoryActivationRuntime(),
			...(operatorTenantId ? { operatorTenantId } : {}),
		});

	const call = async (
		served: readonly ServerRoute[],
		request: Request,
	): Promise<Response> => {
		const path = new URL(request.url).pathname;
		const route = served.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(request.method),
		);
		if (!route) throw new Error(`No route ${request.method} ${path}`);
		const context = createContext(request, {});
		return runtime.middleware(context, () =>
			Promise.resolve(route.handler(context)),
		);
	};

	const updateRequest = (
		owner: Session,
		moduleId: string,
		key: string,
		value: unknown,
		extra: {
			readonly query?: string;
			readonly headers?: Record<string, string>;
			readonly body?: Record<string, unknown>;
		} = {},
	): Request =>
		new Request(`${ORIGIN}/api/settings/update${extra.query ?? ''}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: owner.cookie,
				'x-csrf-token': owner.csrfToken,
				...extra.headers,
			},
			body: JSON.stringify({ ...extra.body, moduleId, key, value }),
		});

	const update = (
		served: readonly ServerRoute[],
		owner: Session,
		moduleId: string,
		key: string,
		value: unknown,
	): Promise<Response> =>
		call(served, updateRequest(owner, moduleId, key, value));

	const listResponse = (served: readonly ServerRoute[], owner: Session) =>
		call(
			served,
			new Request(`${ORIGIN}/api/settings`, {
				headers: { cookie: owner.cookie },
			}),
		);

	const list = async (
		served: readonly ServerRoute[],
		owner: Session,
	): Promise<readonly Row[]> => {
		const response = await listResponse(served, owner);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			modules: readonly {
				moduleId: string;
				settings: readonly SettingsEntryPayload[];
			}[];
		};
		return body.modules.flatMap((module) =>
			module.settings.map((setting) => ({
				...setting,
				moduleId: module.moduleId,
			})),
		);
	};

	const platformRows = async (
		served: readonly ServerRoute[],
		owner: Session,
	): Promise<readonly Row[]> => {
		const rows = (await list(served, owner)).filter(
			(row) => row.scope === 'platform',
		);
		expect(rows.length).toBeGreaterThan(0);
		return rows;
	};

	const settingsEvents = async (tenantId: string): Promise<number> =>
		(await service.queryAudit({ tenantId, limit: 50 })).events.filter(
			(event) => event.action === 'settings.updated',
		).length;

	const platformValue = (moduleId: string, key: string) =>
		runtime.moduleSettings.get(PLATFORM_SETTINGS_TENANT, moduleId, key);

	const signUp = async (slug: string): Promise<Session> =>
		session(
			await service.signUp({
				email: `owner@${slug}.example`,
				password: PASSWORD,
				displayName: 'Bo Owner',
				organizationName: `Workspace ${slug}`,
				organizationSlug: slug,
			}),
		);

	/* What first-run setup does: auth.core provisions the workspace and its
	   owner signs in with the password chosen on the setup page. */
	const firstRun = async (slug: string): Promise<Session> => {
		await service.provisionWorkspace({
			name: `Workspace ${slug}`,
			slug,
			ownerEmail: `owner@${slug}.example`,
			ownerDisplayName: 'Ada Owner',
			password: PASSWORD,
			operator: 'setup:first-run',
		});
		return session(
			await service.signIn({
				email: `owner@${slug}.example`,
				password: PASSWORD,
			}),
		);
	};

	return {
		runtime,
		service,
		routes,
		call,
		updateRequest,
		update,
		listResponse,
		list,
		platformRows,
		settingsEvents,
		platformValue,
		signUp,
		firstRun,
	};
}

type Deployment = Awaited<ReturnType<typeof deployment>>;

async function expectRefused(response: Response): Promise<unknown> {
	expect(response.status).toBe(403);
	const body = (await response.json()) as { error: { code: string } };
	expect(body.error.code).toBe('PLATFORM_SETTING_OPERATOR_ONLY');
	return body;
}

async function expectLocked(
	at: Deployment,
	served: readonly ServerRoute[],
	owner: Session,
	lockedKey: string,
): Promise<void> {
	for (const row of await at.platformRows(served, owner)) {
		expect(row.lockedKey, `${row.moduleId}.${row.key}`).toBe(lockedKey);
	}
}

async function expectUnlocked(
	at: Deployment,
	served: readonly ServerRoute[],
	owner: Session,
): Promise<void> {
	const rows = await at.platformRows(served, owner);
	for (const row of rows) {
		expect(row.lockedKey, `${row.moduleId}.${row.key}`).not.toBe(OPERATOR_ONLY);
		expect(row.lockedKey, `${row.moduleId}.${row.key}`).not.toBe(
			OPERATOR_UNSET,
		);
	}
	for (const key of ['appName', 'logoUrl', 'portalUrl', 'allowSignUp']) {
		expect(rows.find((row) => row.key === key)?.locked, key).toBeUndefined();
	}
}

describe('SYSTEM-SETTINGS-PLATFORM-FIRST-RUN', () => {
	it('lets the workspace first-run setup created change platform settings without FD_OPERATOR_TENANT', async () => {
		const at = await deployment();
		const a = await at.firstRun('workspace-a');
		const b = await at.signUp('workspace-b');
		const served = at.routes();

		await expectUnlocked(at, served, a);
		expect(
			(await at.update(served, a, 'system.core', 'appName', 'Acme')).status,
		).toBe(200);
		expect(
			(
				await at.update(
					served,
					a,
					'demo.core',
					'portalUrl',
					'https://portal.acme.example',
				)
			).status,
		).toBe(200);
		expect(at.platformValue('system.core', 'appName')).toBe('Acme');
		expect(at.platformValue('demo.core', 'portalUrl')).toBe(
			'https://portal.acme.example',
		);
		await expect
			.poll(() => at.settingsEvents(a.tenantId), { timeout: 5_000 })
			.toBe(2);

		await expectLocked(at, served, b, OPERATOR_ONLY);
		await expectRefused(
			await at.update(served, b, 'system.core', 'appName', 'Other'),
		);
		await expectRefused(
			await at.update(
				served,
				b,
				'demo.core',
				'portalUrl',
				'https://portal.other.example',
			),
		);
		expect(at.platformValue('system.core', 'appName')).toBe('Acme');
		expect(at.platformValue('demo.core', 'portalUrl')).toBe(
			'https://portal.acme.example',
		);
		expect(await at.settingsEvents(b.tenantId)).toBe(0);
	});
});

describe('SYSTEM-SETTINGS-PLATFORM-OVERRIDE-UNKNOWN', () => {
	it('knows no operator when FD_OPERATOR_TENANT names no workspace id, whatever the record says', async () => {
		const at = await deployment();
		const a = await at.firstRun('workspace-a');
		const b = await at.signUp('workspace-b');
		const recorded = await at.service.operatorWorkspace();
		expect(recorded?.workspace.tenantId).toBe(a.tenantId);

		for (const configured of ['not-a-workspace', 'workspace-a']) {
			const served = at.routes(configured);
			for (const owner of [a, b]) {
				await expectLocked(at, served, owner, OPERATOR_UNSET);
				await expectRefused(
					await at.update(
						served,
						owner,
						'demo.core',
						'portalUrl',
						'https://portal.override.example',
					),
				);
			}
		}
		expect(at.platformValue('demo.core', 'portalUrl')).toBe(DEFAULT_PORTAL);
		expect(await at.service.operatorWorkspace()).toEqual(recorded);
	});
});

describe('SYSTEM-SETTINGS-PLATFORM-UPGRADE', () => {
	it('makes the only workspace of an upgraded deployment its operator when the platform starts', async () => {
		const databases = createPgliteTestProvider();
		cleanups.push(() => databases.dispose());
		/* The release before the record: its only workspace was signed up and
		   nothing recorded it. */
		const before = await deployment(databases);
		const a = await before.signUp('workspace-a');
		expect(await before.service.operatorWorkspace()).toBeNull();
		await before.runtime.dispose();

		const at = await deployment(databases);
		const served = at.routes();

		await expectUnlocked(at, served, a);
		expect(
			(await at.update(served, a, 'system.core', 'appName', 'Acme')).status,
		).toBe(200);
		await expect
			.poll(() => at.settingsEvents(a.tenantId), { timeout: 5_000 })
			.toBe(1);
		const b = await at.signUp('workspace-b');
		await expectLocked(at, served, b, OPERATOR_ONLY);
		await expectRefused(
			await at.update(served, b, 'system.core', 'appName', 'Other'),
		);
		expect(at.platformValue('system.core', 'appName')).toBe('Acme');
	});
});

describe('SYSTEM-SETTINGS-PLATFORM-UNCONFIGURED', () => {
	it('locks platform settings for every workspace until the operator command records one, then applies it without a restart', async () => {
		const at = await deployment();
		const a = await at.signUp('workspace-a');
		const b = await at.signUp('workspace-b');
		const served = at.routes();

		for (const owner of [a, b]) {
			const rows = await at.platformRows(served, owner);
			for (const row of rows) {
				expect(row.lockedKey, `${row.moduleId}.${row.key}`).toBe(
					OPERATOR_UNSET,
				);
				expect(row.locked).toContain('pnpm flowdular auth operator-set');
			}
			const refused = (await expectRefused(
				await at.update(served, owner, 'system.core', 'appName', 'Early'),
			)) as { error: { message: string } };
			expect(refused.error.message).toContain(
				'pnpm flowdular auth operator-set',
			);
		}
		expect(at.platformValue('system.core', 'appName')).toBe(
			DEFAULT_APPLICATION_BRANDING.appName,
		);
		expect(await at.settingsEvents(a.tenantId)).toBe(0);

		await at.service.setOperator(a.tenantId, 'cli:ops');

		await expectUnlocked(at, served, a);
		expect(
			(await at.update(served, a, 'system.core', 'appName', 'Acme')).status,
		).toBe(200);
		await expect
			.poll(() => at.settingsEvents(a.tenantId), { timeout: 5_000 })
			.toBe(1);
		await expectLocked(at, served, b, OPERATOR_ONLY);
		await expectRefused(
			await at.update(served, b, 'system.core', 'appName', 'Other'),
		);
		expect(at.platformValue('system.core', 'appName')).toBe('Acme');
		expect(await at.settingsEvents(b.tenantId)).toBe(0);
	});
});

describe('SYSTEM-SETTINGS-READ', () => {
	it('names no other workspace in a settings response, whichever lock applies', async () => {
		const at = await deployment();
		const a = await at.firstRun('workspace-a');
		const b = await at.signUp('workspace-b');
		const workspaceA = (await at.service.findTenant(a.tenantId))!;

		for (const served of [at.routes(), at.routes('not-a-workspace')]) {
			const read = await (await at.listResponse(served, b)).text();
			const refused = await (
				await at.update(served, b, 'system.core', 'appName', 'Other')
			).text();
			for (const text of [read, refused]) {
				expect(text).not.toContain(workspaceA.tenantId);
				expect(text).not.toContain(workspaceA.slug);
				expect(text).not.toContain(workspaceA.name);
			}
		}
	});
});

describe('SYSTEM-SETTINGS-PLATFORM-REQUEST-INPUT', () => {
	it('decides from the principal alone and documents no operation on the operator workspace', async () => {
		const at = await deployment();
		const a = await at.firstRun('workspace-a');
		const b = await at.signUp('workspace-b');
		const served = at.routes();
		createAuthRoutes(at.runtime);

		const plain = await at.call(
			served,
			at.updateRequest(b, 'demo.core', 'portalUrl', 'https://b.example'),
		);
		const forged = await at.call(
			served,
			at.updateRequest(b, 'demo.core', 'portalUrl', 'https://b.example', {
				query: `?tenantId=${a.tenantId}&operatorTenant=${a.tenantId}`,
				headers: {
					'x-tenant-id': a.tenantId,
					'x-operator-tenant': a.tenantId,
				},
				body: {
					tenantId: a.tenantId,
					operatorTenant: a.tenantId,
					operatorTenantId: a.tenantId,
				},
			}),
		);

		expect(await expectRefused(forged)).toEqual(await expectRefused(plain));
		expect(at.platformValue('demo.core', 'portalUrl')).toBe(DEFAULT_PORTAL);
		expect(await at.settingsEvents(b.tenantId)).toBe(0);

		const document = await buildOpenApiDocument();
		const operations = Object.entries(document.paths).flatMap(
			([path, methods]) =>
				Object.values(
					methods as Record<string, { readonly operationId?: string }>,
				).map((operation) => `${path} ${operation.operationId}`),
		);
		expect(
			operations.some((operation) =>
				operation.startsWith('/api/settings/update'),
			),
		).toBe(true);
		expect(
			operations.filter((operation) => /operator/i.test(operation)),
		).toEqual([]);
	});
});

describe('SYSTEM-BRANDING-READ and SYSTEM-BRANDING-DENY', () => {
	it('shows every branding row the unset reason and refuses the owner while no operator workspace is known', async () => {
		const at = await deployment();
		const owner = await at.signUp('workspace-a');
		const served = at.routes();

		const branding = (await at.list(served, owner)).filter(
			(row) => row.moduleId === 'system.core' && row.scope === 'platform',
		);
		expect(branding.map((row) => row.key)).toEqual(
			expect.arrayContaining(['appName', 'logoUrl', 'themeColor']),
		);
		for (const row of branding) {
			expect(row.lockedKey, row.key).toBe(OPERATOR_UNSET);
		}
		await expectRefused(
			await at.update(served, owner, 'system.core', 'appName', 'Acme'),
		);
		expect(at.platformValue('system.core', 'appName')).toBe(
			DEFAULT_APPLICATION_BRANDING.appName,
		);
		expect(await at.settingsEvents(owner.tenantId)).toBe(0);
	});
});

/* AUTH-OPERATOR-GREENFIELD: the reset leaves Operations Demo the operator. */
describe('AUTH-OPERATOR-GREENFIELD', () => {
	it('lets the administrator change branding from Operations Demo and refuses it from Finance Demo', async () => {
		const databases = createPgliteTestProvider();
		cleanups.push(() => databases.dispose());
		await seedGreenfield(databases);
		const at = await deployment(databases);
		const served = at.routes();
		const operations = (await at.service.findTenant(
			GREENFIELD_TENANT_SLUGS.operations,
		))!;
		const finance = (await at.service.findTenant(
			GREENFIELD_TENANT_SLUGS.finance,
		))!;
		/* Switching replaces the session, so each workspace gets its own sign-in. */
		const signedInto = async (tenantId: string): Promise<Session> => {
			const issued = await at.service.signIn({
				email: GREENFIELD_ACCOUNTS.admin.email,
				password: GREENFIELD_ACCOUNTS.admin.password,
			});
			return session(
				issued.principal.tenantId === tenantId
					? issued
					: await at.service.switchTenant(issued.token, tenantId),
			);
		};
		const inOperations = await signedInto(operations.tenantId);
		const inFinance = await signedInto(finance.tenantId);

		expect(
			(await at.update(served, inOperations, 'system.core', 'appName', 'Demo'))
				.status,
		).toBe(200);
		await expectRefused(
			await at.update(served, inFinance, 'system.core', 'appName', 'Finance'),
		);
		expect(at.platformValue('system.core', 'appName')).toBe('Demo');
	});
});
