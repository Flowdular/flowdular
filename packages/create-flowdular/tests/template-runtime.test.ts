import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.ts';

/* Run the emitted config with boundary doubles. No package installation, real
   database, process signal listener or provider credential is needed. */
it('boots a generated platform with one shared database provider', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-template-runtime-'));
	try {
		const generated = await scaffold({
			cwd: root,
			target: 'app',
			template: 'default',
			force: false,
		});
		const directory = join(generated.directory, 'platform');
		const fixtures: Record<string, string> = {
			'@octanejs/vite-plugin': `
				export const defineConfig = value => value;
				export class RenderRoute { constructor(options) { Object.assign(this, options); } }
			`,
			'@flowdular/sdk/server': `export const validateApplicationPath = value => value; export const assertRouteConflicts = () => {}; export const createModuleWebRoutes = () => []; export const createApplicationRoutes = () => [];`,
			'@flowdular/sdk/modules/auth/server': `
                export const principalFromContext = () => null;
				export const authRuntimeOptionsFromEnvironment = () => ({ secureCookies: false });
				export function createAuthRuntime(options) {
					if (!options.databases) throw new Error('AUTH_DATABASE_PROVIDER_REQUIRED');
					return { moduleSettings: { declare() {} }, middleware: { databases: options.databases }, async dispose() {} };
				}
				export const createAuthRoutes = () => [];
				export const createPlatformAgentRegistry = () => ({ seal() {} });
				export const createPlatformCapabilityRegistry = () => ({});
				export const createPlatformToolRegistry = () => ({});
			`,
			'./src/server/database.ts': `
				export const databaseProviderConfigFromEnvironment = () => ({});
				export const createPlatformDatabaseProvider = () => ({ checked: false, async check() { this.checked = true; }, async dispose() {} });
			`,
			'./src/generated/modules.server.ts': `
                export const moduleWebMounts = []; export const applicationBasePath = '/app';
				export function composeModuleServer(context) {
					if (context.auth.middleware.databases !== context.databases) throw new Error('AUTH_DATABASE_PROVIDER_MISMATCH');
					return [];
				}
			`,
		};
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
				'import.meta.dirname': JSON.stringify(directory),
				process: '__fixtureProcess',
			},
			banner: { js: 'const __fixtureProcess = { env: {}, once() {} };' },
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
						'\n//# sourceURL=generated-platform-smoke.mjs',
				).toString('base64')
		);
		expect(imported.default.middlewares).toHaveLength(1);
		expect(imported.default.middlewares[0].databases.checked).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
