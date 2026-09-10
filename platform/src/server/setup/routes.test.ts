import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import { OWNER_SCOPES } from '@flowdular/module-auth';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { GREENFIELD_ACCOUNTS } from '@flowdular/module-auth/greenfield';
import type { ModuleDatabaseRequirements } from '@flowdular/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
import { createSetupAccess } from './access.ts';
import {
	createSetupAdapters,
	PGLITE_ADAPTER_ID,
	POSTGRESQL_ADAPTER_ID,
} from './adapters.ts';
import { enabledDatabaseModules } from './modules.ts';
import { createSetupRoutes } from './routes.ts';

const TOKEN = 'z'.repeat(43);
const ORIGIN = 'http://127.0.0.1:4310';
const SLOW = 180_000;

const roots: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-setup-routes-'));
	roots.push(root);
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({ modules: { enabled: ['auth.core', 'catalog.core'] } }),
	);
	for (const [directory, id] of [
		['auth', 'auth.core'],
		['catalog', 'catalog.core'],
	]) {
		mkdirSync(join(root, 'modules', directory!), { recursive: true });
		writeFileSync(
			join(root, 'modules', directory!, 'module.json'),
			JSON.stringify({
				id,
				capabilities: ['api', 'database'],
				tenancy: 'required',
			}),
		);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function harness(
	root: string,
	modules?: readonly ModuleDatabaseRequirements[],
	webMountPaths: readonly string[] = [],
) {
	const enabled = enabledDatabaseModules(root);
	const routes = createSetupRoutes({
		environment: { NODE_ENV: 'development' },
		webMountPaths,
		workspaceRoot: root,
		adapters: createSetupAdapters({ workspaceRoot: root, production: false }),
		access: createSetupAccess(TOKEN),
		modules: modules ?? enabled.modules,
		modulesApproximated: enabled.approximated,
		tokenFile: join(root, '.flowdular', 'setup-token'),
		secureCookies: false,
	});
	const route = (path: string): ServerRoute =>
		routes.find((entry) => entry.path === path)!;
	let cookie: string | null = null;
	const call = async (
		path: string,
		body?: Record<string, string>,
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		if (cookie) headers.cookie = cookie;
		const request = body
			? new Request(`${ORIGIN}${path}`, {
					method: 'POST',
					headers,
					body: new URLSearchParams(body),
				})
			: new Request(`${ORIGIN}${path}`, { headers });
		const response = await route(path).handler(createContext(request, {}));
		const issued = response.headers.get('set-cookie');
		if (issued) cookie = issued.split(';')[0] ?? null;
		return response;
	};
	return { routes, route, call, csrf: '' };
}

async function csrfOf(response: Response): Promise<string> {
	const html = await response.text();
	return /name="setupCsrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

describe('first-run routes', () => {
	it('rejects a backoffice prefix claimed by a public module before provisioning', async () => {
		const root = workspace();
		const app = harness(root, undefined, ['/backoffice/blog']);
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));
		const response = await app.call('/setup', {
			step: 'configure',
			setupCsrf: csrf,
			adapter: PGLITE_ADAPTER_ID,
			applicationPath: '/backoffice',
			[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
		});
		expect(await response.text()).toContain(
			'overlaps a configured public module',
		);
		expect(existsSync(join(root, '.env'))).toBe(false);
	});
	it.each(['/api', '/', '//example.test', '/back office', '/setup'])(
		'rejects invalid backoffice address %s before provisioning',
		async (applicationPath) => {
			const root = workspace();
			const app = harness(root);
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const setup = await (await app.call('/setup')).text();
			expect(setup).toContain('name="applicationPath" value="/app"');
			const csrf = /name="setupCsrf" value="([^"]+)"/.exec(setup)![1]!;
			const response = await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				applicationPath,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
			});
			expect(await response.text()).toContain('System addresses are reserved');
			expect(existsSync(join(root, '.env'))).toBe(false);
			expect(existsSync(join(root, 'data'))).toBe(false);
		},
	);
	it('serves the unlock step and nothing else before the token is presented', async () => {
		const app = harness(workspace());

		const page = await app.call('/setup');
		const html = await page.text();

		expect(page.status).toBe(200);
		expect(html).toContain('Unlock setup');
		expect(html).not.toContain('Choose a database');
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(page.headers.get('content-security-policy')).toContain(
			"default-src 'none'",
		);
	});

	it('composes only the installer paths', () => {
		const app = harness(workspace());

		expect(app.routes.map((route) => route.path)).toEqual([
			'/setup',
			'/',
			'/api/*path',
			'/*path',
		]);
	});

	it('answers every application API with a not-configured refusal', async () => {
		const app = harness(workspace());

		const response = await app.call('/api/*path');

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: 'PLATFORM_NOT_CONFIGURED' },
		});
	});

	it('refuses a wrong token and locks out after repeated attempts', async () => {
		const app = harness(workspace());

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const denied = await app.call('/setup', {
				step: 'unlock',
				token: 'wrong',
			});
			expect(denied.status).toBe(401);
			expect(await denied.text()).toContain('not the setup token');
		}
		const locked = await app.call('/setup', { step: 'unlock', token: 'wrong' });
		expect(locked.status).toBe(429);
		expect(locked.headers.get('retry-after')).toBeTruthy();

		const correct = await app.call('/setup', {
			step: 'unlock',
			token: TOKEN,
		});
		expect(correct.status).toBe(429);
		expect(correct.headers.get('set-cookie')).toBeNull();
	});

	it('refuses a step without the token and without a session', async () => {
		const app = harness(workspace());

		const response = await app.call('/setup', {
			step: 'configure',
			adapter: PGLITE_ADAPTER_ID,
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toContain('Unlock setup');
	});

	it('opens the database step for the right token', async () => {
		const app = harness(workspace());

		const unlocked = await app.call('/setup', {
			step: 'unlock',
			token: TOKEN,
		});
		expect(unlocked.status).toBe(303);
		expect(unlocked.headers.get('set-cookie')).toContain('HttpOnly');
		expect(unlocked.headers.get('set-cookie')).toContain('SameSite=Strict');

		const html = await (await app.call('/setup')).text();
		expect(html).toContain('Choose a database');
		expect(html).toContain('Embedded PostgreSQL');
		expect(html).toContain('PostgreSQL server');
	});

	it('refuses a form that does not carry this session CSRF token', async () => {
		const app = harness(workspace());
		await app.call('/setup', { step: 'unlock', token: TOKEN });

		const forged = await app.call('/setup', {
			step: 'configure',
			adapter: PGLITE_ADAPTER_ID,
			setupCsrf: 'forged',
		});

		expect(forged.status).toBe(403);
		/* The session is dropped, so the next step starts from the token again. */
		expect(await (await app.call('/setup')).text()).toContain('Unlock setup');
	});

	it('reports the fields that need attention before any connection is opened', async () => {
		const root = workspace();
		const app = harness(root);
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));

		const response = await app.call('/setup', {
			step: 'configure',
			setupCsrf: csrf,
			adapter: POSTGRESQL_ADAPTER_ID,
			[`field:${POSTGRESQL_ADAPTER_ID}:host`]: '',
			[`field:${POSTGRESQL_ADAPTER_ID}:port`]: '5432',
		});
		const html = await response.text();

		expect(html).toContain('Enter a host name or an address.');
		expect(html).toContain('Enter the password for this role.');
		expect(existsSync(join(root, '.env'))).toBe(false);
	});

	it('leaves no configuration behind when the probe fails', async () => {
		const root = workspace();
		const app = harness(root);
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));

		const review = await app.call('/setup', {
			step: 'configure',
			setupCsrf: csrf,
			adapter: POSTGRESQL_ADAPTER_ID,
			[`field:${POSTGRESQL_ADAPTER_ID}:host`]: '127.0.0.1',
			[`field:${POSTGRESQL_ADAPTER_ID}:port`]: '1',
			[`field:${POSTGRESQL_ADAPTER_ID}:database`]: 'flowdular',
			[`field:${POSTGRESQL_ADAPTER_ID}:migrator-user`]: 'coreloom_migrator',
			[`field:${POSTGRESQL_ADAPTER_ID}:migrator-password`]: 'migrator-secret',
			[`field:${POSTGRESQL_ADAPTER_ID}:runtime-user`]: 'coreloom_runtime',
			[`field:${POSTGRESQL_ADAPTER_ID}:runtime-password`]: 'runtime-secret',
			[`field:${POSTGRESQL_ADAPTER_ID}:background-user`]: 'coreloom_background',
			[`field:${POSTGRESQL_ADAPTER_ID}:background-password`]:
				'background-secret',
			[`field:${POSTGRESQL_ADAPTER_ID}:tls`]: 'disable',
		});
		const html = await review.text();

		expect(html).toContain('Review');
		expect(html).not.toContain('Migrate and create the workspace');
		expect(html).not.toContain('runtime-secret');
		expect(html).not.toContain('postgresql://');
		expect(existsSync(join(root, '.env'))).toBe(false);

		/* Applying anyway is refused, and still writes nothing. */
		const applied = await app.call('/setup', {
			step: 'apply',
			setupCsrf: csrf,
		});
		expect(await applied.text()).toContain('did not succeed');
		expect(existsSync(join(root, '.env'))).toBe(false);
	});

	it(
		'refuses a database an enabled module cannot run on, naming the module',
		async () => {
			const root = workspace();
			const app = harness(root, [
				{
					moduleId: 'legacy.core',
					tenantOwned: true,
					dialectIds: ['mysql'],
					capabilities: ['flowdular.database.transactions'],
				},
			]);
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));

			const review = await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
			});
			const html = await review.text();

			expect(html).toContain('legacy.core');
			expect(html).toContain('dialect');
			expect(html).not.toContain('Migrate and create the workspace');

			const applied = await app.call('/setup', {
				step: 'apply',
				setupCsrf: csrf,
			});
			expect(await applied.text()).toContain('cannot run on this database');
			expect(existsSync(join(root, '.env'))).toBe(false);
		},
		SLOW,
	);

	it(
		'migrates, seeds the demo accounts, and stores the connection settings',
		async () => {
			const root = workspace();
			const data = join(root, 'data');
			const app = harness(root);
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));

			const review = await app.call('/setup', {
				step: 'configure',
				applicationPath: '/backoffice',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: data,
			});
			const reviewHtml = await review.text();
			expect(reviewHtml).toContain('Migrate and create the workspace');
			expect(reviewHtml).toContain('auth.core');
			expect(reviewHtml).toContain('catalog.core');
			expect(reviewHtml).toContain('BYPASSRLS');
			expect(reviewHtml).toContain('/backoffice');

			const done = await app.call('/setup', {
				step: 'apply',
				setupCsrf: csrf,
			});
			const html = await done.text();

			expect(html).toContain('Flowdular is ready');
			expect(html).toContain(GREENFIELD_ACCOUNTS.admin.email);
			expect(html).toContain(GREENFIELD_ACCOUNTS.admin.password);
			expect(html).toContain(GREENFIELD_ACCOUNTS.user.email);
			expect(html).toContain(GREENFIELD_ACCOUNTS.user.password);
			expect(html).toContain('Administration, Users');

			const written = readFileSync(join(root, '.env'), 'utf8');
			expect(written).toContain('FD_DATABASE_ADAPTER=pglite');
			expect(written).toContain('FD_APPLICATION_PATH=/backoffice');
			expect(html).toContain('href="/backoffice"');
			expect(written).toContain(`FD_DATABASE_PGLITE_DIRECTORY=${data}`);

			const provider = createPlatformDatabaseProvider(
				databaseProviderConfigFromEnvironment(
					{
						NODE_ENV: 'development',
						FD_DATABASE_ADAPTER: 'pglite',
						FD_DATABASE_PGLITE_DIRECTORY: data,
					},
					root,
				),
			);
			const auth = createAuthRuntime({
				...authRuntimeOptionsFromEnvironment({ NODE_ENV: 'development' }, root),
				databases: provider,
			});
			try {
				const service = await auth.service();
				const [tenant] = await service.listTenants();
				expect(tenant?.slug).toBe('operations-demo');
				const members = await service.listTenantMembers(tenant!.tenantId);
				const owner = members.find(
					(member) => member.email === GREENFIELD_ACCOUNTS.admin.email,
				)!;
				const member = members.find(
					(entry) => entry.email === GREENFIELD_ACCOUNTS.user.email,
				)!;

				expect([...owner.scopes].sort()).toEqual([...OWNER_SCOPES].sort());
				expect(member.role).toBe('member');
				expect(member.scopes.length).toBeLessThan(owner.scopes.length);

				const audit = await service.queryAudit({
					tenantId: tenant!.tenantId,
					limit: 20,
				});
				const actions = audit.events.map((event) => event.action);
				expect(actions).toContain('auth.workspace.provisioned');
				expect(actions).toContain('users.member.created');
				const provisioned = audit.events.find(
					(event) => event.action === 'auth.workspace.provisioned',
				)!;
				expect(provisioned.actorLabel).toBe('setup:first-run');
				expect(provisioned.subjectId).toBe(tenant!.tenantId);
			} finally {
				await auth.dispose();
				await provider.dispose();
			}
		},
		SLOW,
	);

	it(
		'stops instead of touching a database that already holds a workspace',
		async () => {
			const root = workspace();
			const data = join(root, 'data');
			const first = harness(root);
			await first.call('/setup', { step: 'unlock', token: TOKEN });
			const firstCsrf = await csrfOf(await first.call('/setup'));
			await first.call('/setup', {
				step: 'configure',
				setupCsrf: firstCsrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: data,
			});
			expect(
				await (
					await first.call('/setup', { step: 'apply', setupCsrf: firstCsrf })
				).text(),
			).toContain('Flowdular is ready');

			/* A second deployment pointed at the same database is not a first run. */
			const second = harness(root);
			await second.call('/setup', { step: 'unlock', token: TOKEN });
			const secondCsrf = await csrfOf(await second.call('/setup'));
			await second.call('/setup', {
				step: 'configure',
				setupCsrf: secondCsrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: data,
			});
			const refused = await second.call('/setup', {
				step: 'apply',
				setupCsrf: secondCsrf,
			});
			const html = await refused.text();

			expect(html).toContain('does not reset an existing installation');
			expect(html).not.toContain('Flowdular is ready');
		},
		SLOW,
	);
});
