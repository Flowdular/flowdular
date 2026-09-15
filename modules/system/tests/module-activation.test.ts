import { createPgliteTestProvider } from '@flowdular/database-testing';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import {
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import type { AuthActor } from '@flowdular/module-auth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { composedModules, type ComposedModule } from '../src/domain/modules.ts';
import { createSystemRoutes } from '../src/server/endpoints.ts';
import { readModuleCatalog } from '../src/server/module-catalog.ts';
import {
	createSystemRuntime,
	type SystemRuntime,
} from '../src/server/runtime.ts';
import {
	ModuleActivationError,
	ModuleActivationService,
} from '../src/services/module-activation-service.ts';
import { memoryActivationRepository } from './support/activation.ts';

const ORIGIN = 'https://erp.example';

/* system and auth are required; agents needs metering through a capability;
   reports declares metering as a module dependency; sandbox stands alone. */
const MANIFESTS = [
	{
		id: 'system.core',
		version: '1.0.0',
		dependencies: [],
		provides: [],
		requires: [],
	},
	{
		id: 'auth.core',
		version: '1.0.0',
		dependencies: [],
		provides: [],
		requires: [],
	},
	{
		id: 'metering.core',
		version: '0.4.0',
		dependencies: [],
		provides: ['metering.meters.v1'],
		requires: ['notifications.publish.v1'],
	},
	{
		id: 'agents.core',
		version: '0.9.0',
		dependencies: [],
		provides: [],
		requires: ['metering.meters.v1'],
	},
	{
		id: 'reports.core',
		version: '0.2.0',
		dependencies: ['metering.core', 'system.core'],
		provides: [],
		requires: [],
	},
	{
		id: 'sandbox.core',
		version: '0.3.0',
		dependencies: [],
		provides: [],
		requires: [],
	},
] as const;

const MODULES: readonly ComposedModule[] = composedModules(MANIFESTS);

const actor = (tenantId: string): AuthActor => ({
	accountId: `owner-${tenantId}`,
	tenantId,
	email: `owner@${tenantId}.example`,
	role: 'owner',
	scopes: [],
});

function service(
	overrides: Partial<
		ConstructorParameters<typeof ModuleActivationService>[0]
	> = {},
) {
	const repository = memoryActivationRepository();
	const audit = vi.fn(async () => undefined);
	const activation = new ModuleActivationService({
		repository,
		modules: () => MODULES,
		audit,
		...overrides,
	});
	return { activation, repository, audit };
}

describe('composed module dependencies', () => {
	it('resolves declared dependencies and required capabilities to module ids', () => {
		expect(MODULES.find((module) => module.id === 'agents.core')).toEqual({
			id: 'agents.core',
			version: '0.9.0',
			dependencies: ['metering.core'],
		});
		expect(
			MODULES.find((module) => module.id === 'reports.core')?.dependencies,
		).toEqual(['metering.core', 'system.core']);
		expect(
			MODULES.find((module) => module.id === 'metering.core')?.dependencies,
		).toEqual([]);
	});
});

describe('module activation service', () => {
	it('SYSTEM-MODULE-ACTIVATE: every composed module is active by default and a change is audited once', async () => {
		const { activation, audit } = service();
		const owner = actor('tenant-a');

		expect(
			(await activation.list('tenant-a')).map((entry) => entry.active),
		).toEqual(MODULES.map(() => true));
		expect(await activation.list('tenant-a')).toContainEqual({
			id: 'metering.core',
			version: '0.4.0',
			active: true,
			optional: true,
			dependents: ['agents.core', 'reports.core'],
		});

		const deactivated = await activation.deactivate(owner, 'sandbox.core');
		expect(deactivated).toMatchObject({ id: 'sandbox.core', active: false });
		expect(await activation.isActive('tenant-a', 'sandbox.core')).toBe(false);
		expect(await activation.isActive('tenant-b', 'sandbox.core')).toBe(true);
		expect(await activation.activeIds('tenant-a')).toEqual([
			'agents.core',
			'auth.core',
			'metering.core',
			'reports.core',
			'system.core',
		]);
		expect(audit).toHaveBeenCalledTimes(1);
		expect(audit).toHaveBeenCalledWith(owner, {
			moduleId: 'sandbox.core',
			active: false,
		});

		await activation.deactivate(owner, 'sandbox.core');
		expect(audit).toHaveBeenCalledTimes(1);

		const activated = await activation.activate(owner, 'sandbox.core');
		expect(activated.active).toBe(true);
		expect(audit).toHaveBeenLastCalledWith(owner, {
			moduleId: 'sandbox.core',
			active: true,
		});
		expect(await activation.activeIds('tenant-a')).toHaveLength(MODULES.length);
	});

	it('refuses a required module and an unknown one', async () => {
		const { activation, audit } = service();
		await expect(
			activation.deactivate(actor('tenant-a'), 'auth.core'),
		).rejects.toMatchObject({ code: 'MODULE_REQUIRED', status: 409 });
		await expect(
			activation.deactivate(actor('tenant-a'), 'billing.core'),
		).rejects.toMatchObject({ code: 'MODULE_UNKNOWN', status: 404 });
		await expect(
			activation.activate(actor('tenant-a'), 'billing.core'),
		).rejects.toBeInstanceOf(ModuleActivationError);
		expect(audit).not.toHaveBeenCalled();
		expect(await activation.isActive('tenant-a', 'auth.core')).toBe(true);
	});

	it('SYSTEM-MODULE-DEACTIVATE-REFUSED-DEPENDENCY: names the active dependents and accepts once they are inactive', async () => {
		const { activation, audit } = service();
		const owner = actor('tenant-a');

		const refused = await activation
			.deactivate(owner, 'metering.core')
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(ModuleActivationError);
		expect(refused).toMatchObject({
			code: 'MODULE_HAS_ACTIVE_DEPENDENTS',
			status: 409,
			modules: ['agents.core', 'reports.core'],
		});
		expect((refused as Error).message).toContain('agents.core, reports.core');
		expect(audit).not.toHaveBeenCalled();
		expect(await activation.isActive('tenant-a', 'metering.core')).toBe(true);

		await activation.deactivate(owner, 'agents.core');
		await expect(
			activation.deactivate(owner, 'metering.core'),
		).rejects.toMatchObject({ modules: ['reports.core'] });
		await activation.deactivate(owner, 'reports.core');
		expect((await activation.deactivate(owner, 'metering.core')).active).toBe(
			false,
		);

		await expect(
			activation.activate(owner, 'agents.core'),
		).rejects.toMatchObject({
			code: 'MODULE_DEPENDENCY_INACTIVE',
			modules: ['metering.core'],
		});
		await activation.activate(owner, 'metering.core');
		expect((await activation.activate(owner, 'agents.core')).active).toBe(true);
	});

	it('answers from a per-tenant snapshot until it expires or a write invalidates it', async () => {
		let now = 1_000;
		const { activation, repository } = service({
			now: () => now,
			snapshotTtlMs: 100,
		});
		const list = vi.spyOn(repository, 'list');

		expect(await activation.isActive('tenant-a', 'sandbox.core')).toBe(true);
		expect(await activation.isActive('tenant-a', 'reports.core')).toBe(true);
		expect(list).toHaveBeenCalledTimes(1);

		/* A write behind this instance's back is seen once the snapshot expires. */
		await repository.set({
			tenantId: 'tenant-a',
			moduleId: 'sandbox.core',
			active: false,
			changedBy: 'elsewhere',
			changedAt: now,
		});
		expect(await activation.isActive('tenant-a', 'sandbox.core')).toBe(true);
		now += 101;
		expect(await activation.isActive('tenant-a', 'sandbox.core')).toBe(false);
		expect(list).toHaveBeenCalledTimes(2);

		await activation.activate(actor('tenant-a'), 'sandbox.core');
		expect(await activation.isActive('tenant-a', 'sandbox.core')).toBe(true);
		/* A row for a required or an uncomposed module never deactivates anything. */
		await repository.set({
			tenantId: 'tenant-a',
			moduleId: 'auth.core',
			active: false,
			changedBy: 'elsewhere',
			changedAt: now,
		});
		activation.invalidate('tenant-a');
		expect(await activation.isActive('tenant-a', 'auth.core')).toBe(true);
	});
});

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-system-activation-'));
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({
			modules: { enabled: MANIFESTS.map((manifest) => manifest.id) },
			locales: ['en', 'pl'],
		}),
	);
	for (const manifest of MANIFESTS) {
		const directory = join(root, 'modules', manifest.id.split('.')[0]!);
		mkdirSync(join(directory, 'spec'), { recursive: true });
		writeFileSync(
			join(directory, 'module.json'),
			JSON.stringify({
				id: manifest.id,
				version: manifest.version,
				capabilities: ['api'],
				platform: { server: true, client: true },
				dependencies: manifest.dependencies.map((id) => ({ id, range: '^1' })),
				provides: manifest.provides,
				requires: manifest.requires.map((id) => ({
					id,
					optional: id === 'notifications.publish.v1',
				})),
			}),
		);
		writeFileSync(
			join(directory, 'spec/module.yaml'),
			[
				`id: ${manifest.id}`,
				`specVersion: ${manifest.version}`,
				`name: ${manifest.id}`,
			].join('\n'),
		);
	}
	mkdirSync(join(root, 'modules/draft'), { recursive: true });
	writeFileSync(
		join(root, 'modules/draft/module.json'),
		JSON.stringify({ id: 'draft.core', version: '0.0.1', capabilities: [] }),
	);
	return root;
}

describe('module activation API', () => {
	let auth: AuthRuntime;
	let activation: SystemRuntime;
	let routes: readonly ServerRoute[];
	let owner: Session;
	let member: Session;
	let other: Session;

	const call = async (path: string, request: Request): Promise<Response> => {
		const route = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(request.method),
		);
		if (!route) throw new Error(`No route ${request.method} ${path}`);
		const context = createContext(request, {});
		return auth.middleware(context, () =>
			Promise.resolve(route.handler(context)),
		);
	};

	const read = (path: string, session?: Session): Request =>
		new Request(`${ORIGIN}${path}`, {
			headers: session ? { cookie: session.cookie } : {},
		});

	const change = (
		action: 'activate' | 'deactivate',
		moduleId: string,
		session: Session,
		headers: Record<string, string> = {
			cookie: session.cookie,
			'x-csrf-token': session.csrfToken,
		},
	): Request =>
		new Request(`${ORIGIN}/api/system/modules/${action}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				...headers,
			},
			body: JSON.stringify({ moduleId }),
		});

	const session = (issued: {
		token: string;
		csrfToken: string;
		principal: { accountId: string; tenantId: string };
	}): Session => ({
		cookie: `coreloom_session_dev=${issued.token}`,
		csrfToken: issued.csrfToken,
		accountId: issued.principal.accountId,
		tenantId: issued.principal.tenantId,
	});

	beforeAll(async () => {
		const workspaceRoot = workspace();
		const databases = createPgliteTestProvider();
		auth = createAuthRuntime({
			databases,
			secureCookies: false,
			sessionTtlMs: 12 * 60 * 60 * 1000,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
			workspaceRoot,
		});
		activation = createSystemRuntime({
			databases,
			purpose: 'test',
			modules: () =>
				composedModules(
					readModuleCatalog(workspaceRoot).filter((entry) => entry.enabled),
				),
			audit: async (who, entry) =>
				(await auth.service()).recordModuleActivation(who, entry),
		});
		routes = createSystemRoutes({
			workspaceRoot,
			auth,
			settings: auth.moduleSettings,
			activation,
		});
		const service = await auth.service();
		const issued = await service.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		owner = session(issued);
		await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.com',
				password: 'workspace passphrase long',
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
		member = session(
			await service.signIn({
				email: 'member@example.com',
				password: 'workspace passphrase long',
			}),
		);
		other = session(
			await service.signUp({
				email: 'owner@second.example',
				password: 'another workspace passphrase',
				displayName: 'Bo Owner',
				organizationName: 'Second Operations',
				organizationSlug: 'second-operations',
			}),
		);
	});

	afterAll(async () => {
		await activation.dispose();
		await auth.dispose();
	});

	it('denies a change without a session, without the manage scope or without CSRF', async () => {
		expect(
			(
				await call(
					'/api/system/modules/active',
					read('/api/system/modules/active'),
				)
			).status,
		).toBe(401);
		expect(
			(
				await call(
					'/api/system/modules/deactivate',
					change('deactivate', 'sandbox.core', member),
				)
			).status,
		).toBe(403);
		expect(
			(
				await call(
					'/api/system/modules/deactivate',
					change('deactivate', 'sandbox.core', owner, { cookie: owner.cookie }),
				)
			).status,
		).toBe(403);
		const active = await call(
			'/api/system/modules/active',
			read('/api/system/modules/active', member),
		);
		expect(active.status).toBe(200);
		expect((await active.json()).modules).toContain('sandbox.core');
	});

	it('SYSTEM-MODULE-ACTIVATE: an owner deactivates and activates an optional module for the workspace alone, with an audit event', async () => {
		const deactivated = await call(
			'/api/system/modules/deactivate',
			change('deactivate', 'sandbox.core', owner),
		);
		expect(deactivated.status).toBe(200);
		expect((await deactivated.json()).module).toMatchObject({
			id: 'sandbox.core',
			active: false,
			optional: true,
		});

		const catalog = await call(
			'/api/system/modules',
			read('/api/system/modules', owner),
		);
		expect(catalog.status).toBe(200);
		const listed = (await catalog.json()) as {
			modules: {
				id: string;
				active: boolean;
				optional: boolean;
				dependents: string[];
				enabled: boolean;
			}[];
		};
		expect(
			listed.modules.find((entry) => entry.id === 'sandbox.core'),
		).toMatchObject({
			active: false,
			optional: true,
			enabled: true,
		});
		expect(
			listed.modules.find((entry) => entry.id === 'metering.core'),
		).toMatchObject({
			active: true,
			dependents: ['agents.core', 'reports.core'],
		});
		expect(
			listed.modules.find((entry) => entry.id === 'auth.core'),
		).toMatchObject({
			active: true,
			optional: false,
		});
		expect(
			listed.modules.find((entry) => entry.id === 'draft.core'),
		).toMatchObject({
			active: false,
			enabled: false,
		});

		const memberView = (await (
			await call(
				'/api/system/modules/active',
				read('/api/system/modules/active', member),
			)
		).json()) as { modules: string[] };
		expect(memberView.modules).not.toContain('sandbox.core');
		expect(memberView.modules).toContain('reports.core');
		const otherView = (await (
			await call(
				'/api/system/modules/active',
				read('/api/system/modules/active', other),
			)
		).json()) as { modules: string[] };
		expect(otherView.modules).toContain('sandbox.core');

		const trail = await (
			await auth.service()
		).queryAudit({
			tenantId: owner.tenantId,
			limit: 10,
			cursor: null,
		});
		expect(trail.events[0]).toMatchObject({
			action: 'system.module.deactivated',
			subjectType: 'module',
			subjectId: 'sandbox.core',
			actorAccountId: owner.accountId,
			metadata: { active: false },
		});

		const activated = await call(
			'/api/system/modules/activate',
			change('activate', 'sandbox.core', owner),
		);
		expect(activated.status).toBe(200);
		expect((await activated.json()).module.active).toBe(true);
	});

	it('SYSTEM-MODULE-DEACTIVATE-REFUSED-DEPENDENCY: answers 409 naming the dependents and refuses a required module', async () => {
		const refused = await call(
			'/api/system/modules/deactivate',
			change('deactivate', 'metering.core', owner),
		);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({
			error: {
				code: 'MODULE_HAS_ACTIVE_DEPENDENTS',
				modules: ['agents.core', 'reports.core'],
			},
		});
		const required = await call(
			'/api/system/modules/deactivate',
			change('deactivate', 'auth.core', owner),
		);
		expect(required.status).toBe(409);
		expect(await required.json()).toMatchObject({
			error: { code: 'MODULE_REQUIRED' },
		});
		const unknown = await call(
			'/api/system/modules/activate',
			change('activate', 'draft.core', owner),
		);
		expect(unknown.status).toBe(404);
		const active = (await (
			await call(
				'/api/system/modules/active',
				read('/api/system/modules/active', owner),
			)
		).json()) as { modules: string[] };
		expect(active.modules).toContain('metering.core');
	});
});
