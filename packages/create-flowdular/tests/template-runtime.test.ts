import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retirePlatformRuntimes } from '@flowdular/dev-console/shutdown';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.ts';

interface BootedRoute {
	readonly path: string;
	readonly handler: (context: {
		requestId: string;
		octane: { request: Request };
	}) => Promise<Response> | Response;
}

interface BootedConfig {
	readonly middlewares: {
		databases: { checked: boolean; disposed: boolean; root: string };
	}[];
	readonly router: { readonly routes: readonly BootedRoute[] };
}

const fixtures: Record<string, string> = {
	'@octanejs/vite-plugin': `
		export const defineConfig = value => value;
		export class RenderRoute { constructor(options) { Object.assign(this, options); } }
	`,
	'@flowdular/sdk/server': `export const validateApplicationPath = value => value; export const assertRouteConflicts = () => {}; export const createModuleWebRoutes = () => []; export const createApplicationRoutes = () => []; export const defineEndpoint = definition => ({ ...definition, serverRoute: { path: definition.path, methods: definition.methods, handler: definition.handler } }); export const jsonResponse = (body, status) => Response.json(body, { status }); export class HttpProblem extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } } export const problemResponse = error => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }); export const serverLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} }); export const serverMetrics = () => ({ setBuildVersion() {}, expose: () => 'flowdular_build_info 1\\n' }); export const createModuleMetrics = () => ({ counter() {}, histogram() {} }); export const serverTracer = () => ({ sampleRatio: 1, startSpan: () => ({ context: {}, setAttribute() {}, end() {} }), drain: () => [], stats: () => ({ buffered: 0, dropped: 0, recorded: 0 }), onSpanRecorded: () => () => {} }); export const traceConfigFromEnvironment = () => ({ exporter: 'none', url: null, headers: {}, sampleRatio: 1 }); export const createOtlpSpanExporter = () => ({ async flush() {}, stats: () => ({ exported: 0, dropped: 0, failures: 0, retries: 0 }), async dispose() {} }); export const errorSinkConfigFromEnvironment = () => ({ kind: 'none', url: null, token: null }); export const serverErrorSink = () => ({ stats: () => ({ queued: 0 }), async flush() {} }); export const createMailPort = () => ({ adapter: 'none', configured: false, async send() {}, outbox: [] }); export const mailConfigFromEnvironment = () => ({ adapter: 'none', deprecated: [] }); export const createCorsMiddleware = () => (context, next) => next(); export const createOpenApiRoutes = () => [{ path: '/api/openapi.json', methods: ['GET'], handler: () => new Response(null) }]; export const trackResponseBody = (response, release) => { release(); return response; };`,
	'@flowdular/sdk/modules/auth/server': `
        export const principalFromContext = () => null;
		export const isTokenPrincipal = () => false;
		export const mfaEnrolmentSatisfied = async () => true;
		export const authRuntimeOptionsFromEnvironment = () => ({ secureCookies: false });
		export const endpointIdentityFromContext = () => null;
		export function createAuthRuntime(options) {
			if (!options.databases) throw new Error('AUTH_DATABASE_PROVIDER_REQUIRED');
			return { moduleSettings: { declare() {}, async prime() {} }, middleware: { databases: options.databases }, publicBaseUrl: null, apiOriginAllowed: async () => false, async dispose() {} };
		}
		export const createAuthRoutes = () => [];
		export const createPlatformAgentRegistry = () => ({ seal() {} });
		export const createPlatformCapabilityRegistry = () => ({});
		export const createPlatformToolRegistry = () => ({});
	 export const nodemailerSmtpTransport = () => ({ async send() {} });`,
	'@flowdular/sdk/kernel': `export const createDataClassRegistry = () => ({ seal() {} }); export const PLATFORM_SETTINGS_TENANT = '';`,
	'@flowdular/sdk/storage': `
		export class StorageError extends Error {}
		export const STORAGE_READ_ROUTE_PREFIX = '/api/storage/objects/';
		export const storageConfigFromEnvironment = () => ({ adapter: 'local' });
		export const createStorageKeyring = () => ({ keyId: 'fixture' });
		export const createStoragePort = () => ({ async get() { return null; }, async dispose() {} });
		export const openStorageReadToken = () => null;
	`,
	'./src/server/database.ts': `
		export const databaseProviderConfigFromEnvironment = (_environment, root) => ({ root });
		export const loadPlatformEnvironmentFile = () => {};
		export const platformDatabaseConfigured = environment => environment.FD_TEST_DATABASE_CONFIGURED !== 'false';
		export const createPlatformDatabaseProvider = config => ({ checked: false, disposed: false, root: config.root, async check() { this.checked = true; }, async dispose() { this.disposed = true; } });
	`,
	'./src/server/setup/index.ts': `
		export const clearSetupToken = () => {};
		export const configuredDatabaseNeedsFirstRun = async environment => environment.FD_TEST_EMPTY === 'true';
		export const createFirstRunSetup = options => ({ routes: [{ path: '/setup', methods: ['GET'], handler: () => new Response(options.databasePreconfigured ? 'database ready' : 'database needed') }] });
		export const createInPlaceFirstRun = options => ({ middleware: { gate: options.passThrough }, routes: [{ path: '/setup', methods: ['GET'], handler: () => new Response('in place') }] });
	`,
	'./src/generated/modules.server.ts': `
        export const moduleWebMounts = []; export const applicationBasePath = '/app';
		export function composeModuleServer(context) {
			if (context.auth.middleware.databases !== context.databases) throw new Error('AUTH_DATABASE_PROVIDER_MISMATCH');
			return globalThis.__fixtureCompositions ?? [];
		}
	`,
};

let evaluations = 0;

/* Run the emitted config with boundary doubles. No package installation, real
   database, process signal listener or provider credential is needed. Each
   call is a fresh evaluation, as each Vite load is. */
async function boot(
	directory: string,
	environment: NodeJS.ProcessEnv = {},
	entryDirectory = directory,
): Promise<BootedConfig> {
	const bundled = await build({
		stdin: {
			contents: await readFile(join(directory, 'octane.config.ts'), 'utf8'),
			loader: 'ts',
			resolveDir: directory,
		},
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
		define: {
			'import.meta.dirname': JSON.stringify(entryDirectory),
			process: '__fixtureProcess',
		},
		banner: {
			js: `const __fixtureProcess = { env: ${JSON.stringify(environment)}, once() {}, off() {} };`,
		},
		plugins: [
			{
				name: 'runtime-boundaries',
				setup(context) {
					context.onResolve({ filter: /.*/ }, (args) =>
						fixtures[args.path] === undefined
							? undefined
							: { path: args.path, namespace: 'fixture' },
					);
					context.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
						contents: fixtures[args.path]!,
						loader: 'js',
					}));
				},
			},
		],
	});
	const imported = await import(
		'data:text/javascript;base64,' +
			Buffer.from(
				bundled.outputFiles[0]!.text +
					`\n//# sourceURL=generated-platform-smoke-${(evaluations += 1)}.mjs`,
			).toString('base64')
	);
	return imported.default as BootedConfig;
}

async function generatedPlatform(): Promise<{
	readonly directory: string;
	readonly dispose: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-template-runtime-'));
	const generated = await scaffold({
		cwd: root,
		target: 'app',
		template: 'default',
		force: false,
	});
	return {
		directory: join(generated.directory, 'platform'),
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}

it('finds the generated workspace from the production bundle directory', async () => {
	const platform = await generatedPlatform();
	try {
		const config = await boot(
			platform.directory,
			{},
			join(platform.directory, 'dist', 'server'),
		);
		expect(config.middlewares.at(-1)!.databases.root).toBe(
			join(platform.directory, '..'),
		);
	} finally {
		await platform.dispose();
	}
});

it('boots a generated platform with one shared database provider', async () => {
	const platform = await generatedPlatform();
	try {
		const config = await boot(platform.directory);

		/* Cross-origin admission runs ahead of authentication, because a
		   preflight carries no credential; the authentication middleware is the
		   one that holds the shared provider. */
		expect(config.middlewares).toHaveLength(3);
		expect(config.middlewares.at(-1)!.databases.checked).toBe(true);
		/* The container and orchestrator probes in infra/ poll the first two, and
		   an integration reads the third to learn what the application serves. */
		expect(config.router.routes.map((route) => route.path)).toEqual(
			expect.arrayContaining([
				'/api/health',
				'/api/ready',
				'/api/openapi.json',
				'/api/storage/objects/:token',
			]),
		);
		const health = config.router.routes.find(
			(route) => route.path === '/api/health',
		)!;
		expect(
			(
				await health.handler({
					requestId: 'probe',
					octane: { request: new Request('http://app/api/health') },
				})
			).status,
		).toBe(200);
	} finally {
		await platform.dispose();
	}
});

/* Vite evaluates octane.config.ts once while it resolves its own configuration
   and again to serve it, in one process. */
it('releases the runtime of an earlier evaluation and retires the serving one on a stop', async () => {
	const platform = await generatedPlatform();
	try {
		const first = await boot(platform.directory);
		const serving = await boot(platform.directory);
		expect(first.middlewares.at(-1)!.databases.disposed).toBe(true);
		expect(serving.middlewares.at(-1)!.databases.disposed).toBe(false);

		await retirePlatformRuntimes();
		expect(serving.middlewares.at(-1)!.databases.disposed).toBe(true);
	} finally {
		await platform.dispose();
	}
});

it('stops and disposes every composition when a worker fails to start, then rethrows', async () => {
	const platform = await generatedPlatform();
	const calls: string[] = [];
	const refused = new Error('worker start refused');
	const composition = (name: string, startWorker: () => Promise<void>) => ({
		routes: [],
		startWorker: async () => {
			calls.push(`${name}.startWorker`);
			await startWorker();
		},
		stop: async () => {
			calls.push(`${name}.stop`);
		},
		dispose: async () => {
			calls.push(`${name}.dispose`);
		},
	});
	/* The generated composition the fixture answers with; the bundled config
	   runs in its own module, so a global is the only shared channel. */
	Object.assign(globalThis, {
		__fixtureCompositions: [
			composition('started', async () => {}),
			composition('refused', async () => {
				throw refused;
			}),
		],
	});
	try {
		await expect(boot(platform.directory)).rejects.toBe(refused);
		for (const name of ['started', 'refused']) {
			expect(calls.filter((call) => call.startsWith(`${name}.`))).toEqual([
				`${name}.startWorker`,
				`${name}.stop`,
				`${name}.dispose`,
			]);
		}
	} finally {
		Reflect.deleteProperty(globalThis, '__fixtureCompositions');
		await platform.dispose();
	}
});

it('composes the metrics route only when FD_METRICS is on', async () => {
	const platform = await generatedPlatform();
	try {
		/* infra/kubernetes/deployment.yaml scrapes /api/metrics and .env.example
		   documents the two keys, so the generated app has to serve it. */
		const off = await boot(platform.directory);
		expect(off.router.routes.map((route) => route.path)).not.toContain(
			'/api/metrics',
		);

		const on = await boot(platform.directory, { FD_METRICS: 'true' });
		const metrics = on.router.routes.find(
			(route) => route.path === '/api/metrics',
		);
		expect(metrics).toBeDefined();
		const exposition = await metrics!.handler({
			requestId: 'scrape',
			octane: { request: new Request('http://app/api/metrics') },
		});
		expect(exposition.status).toBe(200);
		expect(exposition.headers.get('content-type')).toBe(
			'text/plain; version=0.0.4; charset=utf-8',
		);

		const guarded = await boot(platform.directory, {
			FD_METRICS: 'true',
			FD_METRICS_TOKEN: 'scrape-token',
		});
		const denied = await guarded.router.routes
			.find((route) => route.path === '/api/metrics')!
			.handler({
				requestId: 'scrape',
				octane: { request: new Request('http://app/api/metrics') },
			});
		expect(denied.status).toBe(401);
		expect(denied.headers.get('www-authenticate')).toBe('Bearer');
		const scraped = await guarded.router.routes
			.find((route) => route.path === '/api/metrics')!
			.handler({
				requestId: 'scrape',
				octane: {
					request: new Request('http://app/api/metrics', {
						headers: { authorization: 'Bearer scrape-token' },
					}),
				},
			});
		expect(scraped.status).toBe(200);
		expect(await scraped.text()).toContain('flowdular_build_info');
	} finally {
		await platform.dispose();
	}
});

it('serves the worker tick route only in the tick role and refuses it without a secret', async () => {
	const platform = await generatedPlatform();
	try {
		const combined = await boot(platform.directory);
		expect(combined.router.routes.map((route) => route.path)).not.toContain(
			'/api/internal/worker/tick',
		);
		await expect(
			boot(platform.directory, { FD_RUNTIME_ROLE: 'tick' }),
		).rejects.toThrow('FD_WORKER_TICK_SECRET');
		const secret = 's'.repeat(32);
		const tick = await boot(platform.directory, {
			FD_RUNTIME_ROLE: 'tick',
			FD_WORKER_TICK_SECRET: secret,
			FD_WORKER_TICK_WINDOW_MS: '1000',
		});
		const route = tick.router.routes.find(
			(candidate) => candidate.path === '/api/internal/worker/tick',
		);
		expect(route).toBeDefined();
		const denied = await route!.handler({
			requestId: 'tick',
			octane: { request: new Request('http://app/api/internal/worker/tick') },
		});
		expect(denied.status).toBe(401);
	} finally {
		await platform.dispose();
	}
});

it('serves setup before composing modules when a generated app has no workspace', async () => {
	const platform = await generatedPlatform();
	try {
		const config = await boot(platform.directory, { FD_TEST_EMPTY: 'true' });
		expect(config.router.routes.map((route) => route.path)).toEqual([
			'/api/health',
			'/setup',
		]);
		expect(config.middlewares).toBeUndefined();
		const setup = config.router.routes.find(
			(route) => route.path === '/setup',
		)!;
		expect(
			await (
				await setup.handler({
					requestId: 'setup',
					octane: { request: new Request('http://app/setup') },
				})
			).text(),
		).toBe('database ready');
	} finally {
		await platform.dispose();
	}
});

it('composes the application with setup in front of it when a Vercel app has no workspace', async () => {
	const platform = await generatedPlatform();
	try {
		const config = await boot(platform.directory, {
			FD_TEST_EMPTY: 'true',
			FD_DEPLOYMENT_TARGET: 'vercel',
		});
		expect(config.middlewares).toContainEqual({
			gate: ['/api/health', '/api/ready', '/api/internal/worker/tick'],
		});
		expect(config.router.routes.map((route) => route.path)).toEqual(
			expect.arrayContaining(['/api/health', '/api/ready', '/setup']),
		);
	} finally {
		await platform.dispose();
	}
});

it('serves setup before composing modules when a generated app has no database', async () => {
	const platform = await generatedPlatform();
	try {
		const config = await boot(platform.directory, {
			FD_TEST_DATABASE_CONFIGURED: 'false',
		});
		expect(config.router.routes.map((route) => route.path)).toEqual([
			'/api/health',
			'/setup',
		]);
		const setup = config.router.routes.find(
			(route) => route.path === '/setup',
		)!;
		expect(
			await (
				await setup.handler({
					requestId: 'setup',
					octane: { request: new Request('http://app/setup') },
				})
			).text(),
		).toBe('database needed');
	} finally {
		await platform.dispose();
	}
});

it('bundles the application routes without a database URL during an image build', async () => {
	const platform = await generatedPlatform();
	try {
		const config = await boot(platform.directory, {
			FD_INTERNAL_BUILD: 'true',
			FD_TEST_DATABASE_CONFIGURED: 'false',
		});
		const paths = config.router.routes.map((route) => route.path);
		expect(paths).toContain('/api/openapi.json');
		expect(paths).not.toContain('/setup');
	} finally {
		await platform.dispose();
	}
});
