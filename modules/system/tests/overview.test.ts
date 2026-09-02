import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '@octanejs/app-core';
import { createAuthRuntime } from '@coreloom/module-auth/server';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PERMISSIONS } from '../src/acl/permissions.ts';
import { createSystemRoutes } from '../src/server/endpoints.ts';

function harness(workspaceRoot: string) {
	const auth = createAuthRuntime({
		databasePath: ':memory:',
		secureCookies: false,
		sessionTtlMs: 3_600_000,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	const [, overview] = createSystemRoutes({
		workspaceRoot,
		auth,
		settings: auth.moduleSettings,
	});
	return { auth, overview };
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'coreloom-overview-'));
	writeFileSync(
		join(root, 'coreloom.json'),
		JSON.stringify({ modules: { enabled: ['system.core'] } }),
	);
	mkdirSync(join(root, 'modules/system/spec'), { recursive: true });
	writeFileSync(
		join(root, 'modules/system/module.json'),
		JSON.stringify({
			id: 'system.core',
			version: '0.5.0',
			capabilities: ['api', 'client'],
			platform: { server: true, client: true },
		}),
	);
	writeFileSync(
		join(root, 'modules/system/spec/module.yaml'),
		[
			'id: system.core',
			'specVersion: 0.5.0',
			'name: System Core',
			'description: Shell and catalog.',
			'permissions:',
			'  - id: system.workspace.access',
			'    description: Open the workspace.',
			'  - id: system.modules.read',
			'    description: Read modules.',
		].join('\n'),
	);
	return root;
}

function principalContext(scopes: readonly string[], tenantId = 'tenant') {
	const request = new Request('https://erp.example/api/system/overview');
	const context = createContext(request, {});
	context.state.set('coreloom.auth.principal', {
		accountId: 'account',
		tenantId,
		email: 'person@example.com',
		displayName: 'A Person',
		role: 'owner',
		scopes,
		tenants: [],
	});
	return context;
}

interface OverviewBody {
	readonly enabledModuleCount: number;
	readonly moduleCount: number;
	readonly activity: readonly { date: string; count: number }[];
	readonly modules: readonly {
		id: string;
		name: string;
		permissions: number;
	}[];
}

describe('system.core overview', () => {
	it('denies anonymous and unscoped principals', async () => {
		const { overview } = harness(workspace());
		const anonymous = await overview.handler(
			createContext(new Request('https://erp.example/api/system/overview'), {}),
		);
		expect(anonymous.status).toBe(401);

		const unscoped = await overview.handler(
			principalContext(['some.other.scope']),
		);
		expect(unscoped.status).toBe(403);
	});

	it('returns tenant module counts and a 14-day activity window', async () => {
		const { overview } = harness(workspace());
		const response = await overview.handler(
			principalContext([SYSTEM_PERMISSIONS.workspaceAccess]),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as OverviewBody;
		expect(body.moduleCount).toBe(1);
		expect(body.enabledModuleCount).toBe(1);
		expect(body.activity).toHaveLength(14);
		expect(body.activity.every((point) => point.count === 0)).toBe(true);
		const system = body.modules.find((module) => module.id === 'system.core');
		expect(system?.permissions).toBe(2);
	});

	it('counts real audit events into the tenant activity series', async () => {
		const { auth, overview } = harness(workspace());
		const issued = await auth.service().signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		const response = await overview.handler(
			principalContext(
				[SYSTEM_PERMISSIONS.workspaceAccess],
				issued.principal.tenantId,
			),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as OverviewBody;
		const total = body.activity.reduce((sum, point) => sum + point.count, 0);
		expect(total).toBeGreaterThanOrEqual(1);
		const today = new Date().toISOString().slice(0, 10);
		expect(body.activity[body.activity.length - 1]?.date).toBe(today);
	});
});
