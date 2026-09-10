import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('loads an installed TypeScript CLI extension and its SDK dependency in plain Node', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-installed-types-'));
	try {
		const sdk = join(root, 'node_modules/@flowdular/sdk');
		await mkdir(join(sdk, 'modules/demo'), { recursive: true });
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				type: 'module',
				exports: {
					'./package.json': './package.json',
					'./value': './value.ts',
					'./lazy': './lazy.ts',
				},
			}),
		);
		await writeFile(join(sdk, 'value.ts'), 'export const answer: number = 42;');
		await writeFile(join(sdk, 'lazy.ts'), 'export const answer: number = 42;');
		const unrelated = join(root, 'node_modules/unrelated/index.ts');
		await mkdir(join(root, 'node_modules/unrelated'), { recursive: true });
		await writeFile(unrelated, 'export const value: number = 1;');
		const entry = join(sdk, 'modules/demo/index.ts');
		await writeFile(
			entry,
			`import {answer} from '@flowdular/sdk/value';
export default {protocolVersion:1,moduleId:'demo.core',commands:[{path:['demo','read'],capability:{id:'demo.read'},run:async()=>{const {answer:again}=await import('@flowdular/sdk/lazy');return answer+again;}}]};`,
		);
		const loader = pathToFileURL(resolve('src/extensions.ts')).href;
		const result = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import {loadCliCommand} from ${JSON.stringify(loader)}; const command=await loadCliCommand(${JSON.stringify({ moduleId: 'demo.core', moduleRoot: join(sdk, 'modules/demo'), entry, command: { path: ['demo', 'read'], capability: { id: 'demo.read' } } })}); console.log(await command.run()); const assert=await import('node:assert/strict'); await assert.rejects(import(${JSON.stringify(pathToFileURL(unrelated).href)}),{code:'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'});`,
			],
			{ encoding: 'utf8' },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe('84');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('discovers installed SDK migrations and propagates broken imports', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-installed-migrations-'));
	try {
		const sdk = join(root, 'node_modules/@flowdular/sdk');
		const moduleRoot = join(sdk, 'modules/demo');
		await mkdir(join(moduleRoot, 'src/services'), { recursive: true });
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				type: 'module',
				exports: {
					'./package.json': './package.json',
					'./modules.json': './modules.json',
				},
			}),
		);
		await writeFile(
			join(sdk, 'modules.json'),
			JSON.stringify({
				schemaVersion: 1,
				modules: [
					{
						manifest: 'modules/demo/module.json',
						import: '@flowdular/sdk/modules/demo',
					},
				],
			}),
		);
		await writeFile(
			join(moduleRoot, 'module.json'),
			JSON.stringify({ id: 'demo.core', package: '@flowdular/module-demo' }),
		);
		const entry = join(moduleRoot, 'src/services/migration.ts');
		await writeFile(
			entry,
			"export const databaseMigrations: readonly {id:string}[] = [{id:'installed'}];",
		);
		const loader = pathToFileURL(resolve('src/migration.ts')).href;
		const script = `import {loadMigrationModules} from ${JSON.stringify(loader)}; const result=await loadMigrationModules(${JSON.stringify({ root, configPath: join(root, 'flowdular.json'), config: { modules: { enabled: ['demo.core'] } } })}); console.log(JSON.stringify(result));`;
		const run = () =>
			spawnSync(
				process.execPath,
				['--experimental-transform-types', '--input-type=module', '-e', script],
				{
					encoding: 'utf8',
				},
			);
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).managed[0].databaseMigrations).toEqual([
			{ id: 'installed' },
		]);
		await writeFile(
			entry,
			"throw new Error('Broken migration import'); export const databaseMigrations = [];",
		);
		const broken = run();
		expect(broken.status).not.toBe(0);
		expect(broken.stderr).toContain('Broken migration import');
		await rm(entry);
		const absent = run();
		expect(absent.status, absent.stderr).toBe(0);
		expect(JSON.parse(absent.stdout).managed).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
