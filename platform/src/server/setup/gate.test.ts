import { randomBytes } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createContext } from '@octanejs/app-core';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
import { setupTokenDigest } from './access.ts';
import {
	configuredDatabaseNeedsFirstRun,
	createInPlaceFirstRun,
} from './index.ts';

const TOKEN = 'in-place-setup-token-K7v2Qm9xR4tW8zL3nB6pY1s';
const ORIGIN = 'https://flowdular.example';
const SLOW = 180_000;
const OWNER = {
	workspaceName: 'Acme Finance',
	workspaceSlug: 'acme-finance',
	ownerName: 'Ada Owner',
	ownerEmail: 'ada@example.test',
	ownerPassword: 'SetupOwner987!',
	ownerPasswordConfirm: 'SetupOwner987!',
	applicationPath: '/app',
};

const roots: string[] = [];

function temporary(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function workspace(): string {
	const root = temporary('flowdular-in-place-setup-');
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({ modules: { enabled: ['auth.core'] } }),
	);
	mkdirSync(join(root, 'modules', 'auth'), { recursive: true });
	writeFileSync(
		join(root, 'modules', 'auth', 'module.json'),
		JSON.stringify({
			id: 'auth.core',
			capabilities: ['api', 'database'],
			tenancy: 'required',
		}),
	);
	return root;
}

/* Every path under the root with its size and modification time, so a write
   anywhere in the workspace shows up as a difference. */
function files(root: string): Record<string, string> {
	const listed: Record<string, string> = {};
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const stat = statSync(path);
			listed[relative(root, path)] = `${stat.size}:${stat.mtimeMs}`;
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(root);
	return listed;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/* One Function instance: the gate in front of a stand-in application, the way
   octane.config.ts composes it. */
function instance(root: string, environment: NodeJS.ProcessEnv) {
	const gate = createInPlaceFirstRun({
		environment,
		workspaceRoot: root,
		applicationPath: '/app',
		webMountPaths: [],
		passThrough: ['/api/ready'],
		workspaceExists: async () =>
			!(await configuredDatabaseNeedsFirstRun(environment, root)),
		log: () => undefined,
	});
	let cookie: string | null = null;
	const call = async (
		path: string,
		body?: Record<string, string>,
		method = body ? 'POST' : 'GET',
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		if (cookie) headers.cookie = cookie;
		const request = new Request(`${ORIGIN}${path}`, {
			method,
			headers,
			...(body ? { body: new URLSearchParams(body) } : {}),
		});
		const context = createContext(request, {});
		const response = await gate.middleware(context, async () => {
			const route = gate.routes.find((entry) => entry.path === path);
			return route
				? route.handler(context)
				: new Response('application', { status: 200 });
		});
		const issued = response.headers.get('set-cookie');
		if (issued) cookie = issued.split(';')[0] ?? null;
		return response;
	};
	const csrf = async (): Promise<string> =>
		/name="setupCsrf" value="([^"]+)"/.exec(
			await (await call('/setup')).text(),
		)?.[1] ?? '';
	return { call, csrf };
}

async function tenantSlugs(
	environment: NodeJS.ProcessEnv,
	root: string,
): Promise<string[]> {
	const databases = createPlatformDatabaseProvider(
		databaseProviderConfigFromEnvironment(environment, root),
	);
	const auth = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(environment, root),
		databases,
	});
	try {
		return (await (await auth.service()).listTenants()).map(
			(tenant) => tenant.slug,
		);
	} finally {
		await auth.dispose();
		await databases.dispose();
	}
}

describe('in-place first run', () => {
	it('refuses to compose without the token digest', () => {
		expect(() =>
			createInPlaceFirstRun({
				environment: { NODE_ENV: 'production' },
				workspaceRoot: workspace(),
				applicationPath: '/app',
				webMountPaths: [],
				passThrough: [],
				workspaceExists: async () => false,
				log: () => undefined,
			}),
		).toThrow(/FD_SETUP_TOKEN_SHA256/);
	});

	it('keeps the application closed while the workspace check fails', async () => {
		const gate = createInPlaceFirstRun({
			environment: { FD_SETUP_TOKEN_SHA256: setupTokenDigest(TOKEN) },
			workspaceRoot: workspace(),
			applicationPath: '/app',
			webMountPaths: [],
			passThrough: [],
			workspaceExists: () => Promise.reject(new Error('database down')),
			log: () => undefined,
		});
		const context = createContext(new Request(`${ORIGIN}/api/workspaces`), {});
		const response = await gate.middleware(
			context,
			async () => new Response('application'),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: 'PLATFORM_NOT_CONFIGURED' },
		});
	});

	it(
		'serves only setup until the first workspace exists, then the application on every instance, without writing a file',
		async () => {
			const root = workspace();
			const environment = {
				NODE_ENV: 'development',
				FD_DATABASE_ADAPTER: 'pglite',
				FD_DATABASE_PGLITE_DIRECTORY: join(
					temporary('flowdular-in-place-data-'),
					'pglite',
				),
				FD_SETUP_TOKEN_SHA256: setupTokenDigest(TOKEN),
			};
			const before = files(root);
			const first = instance(root, environment);
			const second = instance(root, environment);

			const page = await first.call('/app');
			expect(page.status).toBe(303);
			expect(page.headers.get('location')).toBe('/setup');
			const api = await first.call('/api/workspaces');
			expect(api.status).toBe(503);
			expect(await api.json()).toMatchObject({
				error: { code: 'PLATFORM_NOT_CONFIGURED' },
			});
			expect((await first.call('/api/x', {}, 'POST')).status).toBe(503);
			expect(await (await first.call('/api/ready')).text()).toBe('application');

			const unlock = await first.call('/setup');
			expect(unlock.headers.get('x-flowdular-setup')).toBe('first-run');
			expect(await unlock.text()).toContain(
				'printed by the command that deployed this app',
			);
			expect(
				(await first.call('/setup', { step: 'unlock', token: 'wrong-token' }))
					.status,
			).toBe(401);
			expect(
				(await first.call('/setup', { step: 'unlock', token: TOKEN })).status,
			).toBe(303);
			const workspaceHtml = await (await first.call('/setup')).text();
			expect(workspaceHtml).toContain('Create your workspace');
			expect(workspaceHtml).toContain('Database, configured by deployment');
			const csrf = /name="setupCsrf" value="([^"]+)"/.exec(workspaceHtml)![1]!;
			const review = await (
				await first.call('/setup', {
					step: 'workspace',
					setupCsrf: csrf,
					...OWNER,
				})
			).text();
			expect(review).toContain(
				'Applying creates your workspace and owner account.',
			);
			expect(review).not.toContain('restart');

			expect((await second.call('/app')).status).toBe(303);
			const done = await (
				await first.call('/setup', { step: 'apply', setupCsrf: csrf })
			).text();
			expect(done).toContain('Flowdular is ready');
			expect(done).toContain('Sign in to start using it.');
			expect(done).not.toContain("step:'restart'");

			for (const app of [first, second]) {
				const served = await app.call('/app');
				expect(served.status).toBe(200);
				expect(await served.text()).toBe('application');
				expect(await (await app.call('/api/workspaces')).text()).toBe(
					'application',
				);
				const setup = await app.call('/setup');
				expect(setup.status).toBe(303);
				expect(setup.headers.get('location')).toBe('/app');
			}
			const late = await second.call('/setup', {
				step: 'unlock',
				token: TOKEN,
			});
			expect(late.headers.get('location')).toBe('/app');
			expect(await tenantSlugs(environment, root)).toEqual([
				OWNER.workspaceSlug,
			]);
			expect(files(root)).toEqual(before);
		},
		SLOW,
	);
});

const migratorUrl = process.env.FD_TEST_POSTGRES_URL?.trim();

/* Two Function instances hold separate setup sessions, so only the database can
   stop both from creating a first workspace. */
describe.skipIf(!migratorUrl)('in-place first run on PostgreSQL', () => {
	const schema = `flowdular_setup_${randomBytes(6).toString('hex')}`;
	const scoped = (url: string): string => {
		const parsed = new URL(url);
		parsed.searchParams.set('options', `-c search_path=${schema}`);
		return parsed.toString();
	};
	const owner = async <T>(
		operation: (client: Client) => Promise<T>,
	): Promise<T> => {
		const client = new Client({ connectionString: migratorUrl });
		await client.connect();
		try {
			return await operation(client);
		} finally {
			await client.end();
		}
	};

	beforeAll(async () => {
		await owner(async (client) => {
			await client.query(`CREATE SCHEMA ${schema}`);
			await client.query(
				`GRANT USAGE ON SCHEMA ${schema} TO flowdular_runtime, flowdular_background`,
			);
			await client.query(
				`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowdular_runtime`,
			);
			await client.query(
				`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO flowdular_runtime`,
			);
		});
	});

	afterAll(async () => {
		await owner((client) =>
			client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
		);
	});

	it(
		'lets exactly one of two concurrent instances create the first workspace',
		async () => {
			const root = workspace();
			const environment = {
				NODE_ENV: 'development',
				FD_DATABASE_ADAPTER: 'postgresql',
				FD_DATABASE_TLS: 'disable',
				/* What infra/vercel/build.mjs gives each Function instance. */
				FD_DATABASE_POOL_MAX: '2',
				FD_DATABASE_MIGRATOR_URL: scoped(migratorUrl!),
				FD_DATABASE_URL: scoped(
					process.env.FD_TEST_POSTGRES_RUNTIME_URL?.trim() || migratorUrl!,
				),
				FD_DATABASE_BACKGROUND_URL: scoped(
					process.env.FD_TEST_POSTGRES_BACKGROUND_URL?.trim() || migratorUrl!,
				),
				FD_SETUP_TOKEN_SHA256: setupTokenDigest(TOKEN),
			};
			const instances = [0, 1].map(() => instance(root, environment));
			const forms = await Promise.all(
				instances.map(async (app, index) => {
					await app.call('/setup', { step: 'unlock', token: TOKEN });
					const setupCsrf = await app.csrf();
					await app.call('/setup', {
						step: 'workspace',
						setupCsrf,
						...OWNER,
						workspaceSlug: `acme-${index}`,
						ownerEmail: `owner-${index}@example.test`,
					});
					return setupCsrf;
				}),
			);
			const pages = await Promise.all(
				instances.map(async (app, index) =>
					(
						await app.call('/setup', {
							step: 'apply',
							setupCsrf: forms[index]!,
						})
					).text(),
				),
			);
			expect(
				pages.filter((page) => page.includes('Flowdular is ready')),
			).toHaveLength(1);
			expect(await tenantSlugs(environment, root)).toHaveLength(1);
			for (const app of instances) {
				expect((await app.call('/app')).status).toBe(200);
			}
		},
		SLOW,
	);
});
