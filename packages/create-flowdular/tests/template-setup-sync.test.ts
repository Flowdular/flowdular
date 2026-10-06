import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const setupFiles = [
	'access.ts',
	'adapters.ts',
	'environment.ts',
	'gate.ts',
	'index.ts',
	'modules.ts',
	'page.ts',
	'routes.ts',
	'sanitize.ts',
	'seed.ts',
	'token.ts',
] as const;

const dockerFiles = [
	'.env.example',
	'Dockerfile',
	'app-entrypoint.mjs',
	'compose.yaml',
	'database-urls.mjs',
	'pitr.sh',
	'postgres/10-roles.sh',
	'start.mjs',
] as const;

function sdkImports(source: string): string {
	return source
		.replaceAll('@flowdular/server', '@flowdular/sdk/server')
		.replaceAll(
			'@flowdular/module-auth/server',
			'@flowdular/sdk/modules/auth/server',
		)
		.replaceAll('@flowdular/module-auth', '@flowdular/sdk/modules/auth')
		.replaceAll(
			'@flowdular/module-system/server',
			'@flowdular/sdk/modules/system/server',
		)
		.replaceAll('@flowdular/database', '@flowdular/sdk/database')
		.replaceAll(
			'@flowdular/kernel/runtime-config',
			'@flowdular/sdk/kernel/runtime-config',
		)
		.replaceAll(
			'@flowdular/kernel/module-manifests',
			'@flowdular/sdk/kernel/module-manifests',
		);
}

it('keeps generated first-run setup in sync with the platform implementation', async () => {
	for (const file of setupFiles) {
		const platform = await readFile(
			new URL(`../../../platform/src/server/setup/${file}`, import.meta.url),
			'utf8',
		);
		const template = await readFile(
			new URL(
				`../template/default/platform/src/server/setup/${file}`,
				import.meta.url,
			),
			'utf8',
		);
		expect(template, file).toBe(sdkImports(platform));
	}
});

it('keeps generated workspace-root resolution in sync with the platform', async () => {
	const platform = await readFile(
		new URL('../../../platform/src/server/workspace-root.ts', import.meta.url),
		'utf8',
	);
	const template = await readFile(
		new URL(
			'../template/default/platform/src/server/workspace-root.ts',
			import.meta.url,
		),
		'utf8',
	);
	expect(template).toBe(platform);
});

it('ships the same isolated, clean production build script in generated projects', async () => {
	const platform = await readFile(
		new URL('../../../platform/scripts/build.mjs', import.meta.url),
		'utf8',
	);
	const template = await readFile(
		new URL('../template/default/platform/scripts/build.mjs', import.meta.url),
		'utf8',
	);
	expect(template).toBe(platform);
});

it('keeps generated Docker boot files in sync with the platform stack', async () => {
	for (const file of dockerFiles) {
		const platform = await readFile(
			new URL(`../../../infra/docker/${file}`, import.meta.url),
			'utf8',
		);
		const template = await readFile(
			new URL(`../template/default/infra/docker/${file}`, import.meta.url),
			'utf8',
		);
		expect(template, file).toBe(platform);
	}
});
