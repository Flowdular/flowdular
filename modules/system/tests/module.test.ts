import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '@octanejs/app-core';
import { createAuthRuntime } from '@coreloom/module-auth/server';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PERMISSIONS } from '../src/acl/permissions.ts';
import { systemModule } from '../src/index.ts';
import { createSystemRoutes } from '../src/server/endpoints.ts';

function systemRoutes(workspaceRoot: string) {
	const auth = createAuthRuntime({
		databasePath: ':memory:',
		secureCookies: false,
		sessionTtlMs: 3_600_000,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	return createSystemRoutes({
		workspaceRoot,
		auth,
		settings: auth.moduleSettings,
	});
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'coreloom-system-'));
	writeFileSync(
		join(root, 'coreloom.json'),
		JSON.stringify({ modules: { enabled: ['system.core'] } }),
	);
	mkdirSync(join(root, 'modules/system/spec'), { recursive: true });
	writeFileSync(
		join(root, 'modules/system/module.json'),
		JSON.stringify({
			id: 'system.core',
			version: '0.1.1',
			capabilities: ['api', 'client'],
			platform: { server: true, client: true },
		}),
	);
	writeFileSync(
		join(root, 'modules/system/spec/module.yaml'),
		[
			'id: system.core',
			'specVersion: 0.3.0',
			'name: System Core',
			'description: Shell and catalog.',
			'permissions:',
			'  - id: system.modules.read',
			'    description: Read modules.',
		].join('\n'),
	);
	mkdirSync(join(root, 'modules/draft'), { recursive: true });
	writeFileSync(
		join(root, 'modules/draft/module.json'),
		JSON.stringify({ id: 'draft.core', version: '0.0.1', capabilities: [] }),
	);
	return root;
}

describe('system.core', () => {
	it('declares its permissions without shell navigation stubs', () => {
		expect(systemModule.manifest.id).toBe('system.core');
		expect(systemModule.navigation).toEqual([]);
		expect(systemModule.permissions).toContain(
			SYSTEM_PERMISSIONS.settingsManage,
		);
	});

	it('lists workspace modules for readers and denies everyone else', async () => {
		const [route] = systemRoutes(workspace());
		const request = new Request('https://erp.example/api/system/modules');
		const denied = await route.handler(createContext(request, {}));
		expect(denied.status).toBe(401);

		const context = createContext(request, {});
		context.state.set('coreloom.auth.principal', {
			accountId: 'owner',
			tenantId: 'tenant',
			email: 'owner@example.com',
			displayName: 'Owner',
			role: 'owner',
			scopes: [SYSTEM_PERMISSIONS.modulesRead],
			tenants: [],
		});
		const allowed = await route.handler(context);
		expect(allowed.status).toBe(200);
		const body = (await allowed.json()) as {
			modules: {
				id: string;
				name: string;
				enabled: boolean;
				permissions: unknown[];
				platform: { server: boolean };
			}[];
			commands: Record<string, string>;
		};
		expect(body.modules.map((module) => module.id)).toEqual([
			'draft.core',
			'system.core',
		]);
		const system = body.modules.find((module) => module.id === 'system.core')!;
		expect(system).toMatchObject({
			name: 'System Core',
			enabled: true,
			platform: { server: true },
		});
		expect(system.permissions).toHaveLength(1);
		expect(body.modules[0]).toMatchObject({
			enabled: false,
			name: 'draft.core',
		});
		expect(body.commands.enable).toContain('module enable');

		const member = createContext(request, {});
		member.state.set('coreloom.auth.principal', {
			accountId: 'member',
			tenantId: 'tenant',
			email: 'member@example.com',
			displayName: 'Member',
			role: 'member',
			scopes: [SYSTEM_PERMISSIONS.workspaceAccess],
			tenants: [],
		});
		expect((await route.handler(member)).status).toBe(403);
	});
});
