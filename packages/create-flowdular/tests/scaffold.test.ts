import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffold, ScaffoldError } from '../src/scaffold.ts';
import { SECRET_KEYS } from '../src/secrets.ts';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'create-flowdular-'));
	roots.push(root);
	return root;
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

describe('scaffold', () => {
	it('writes a runnable app tree and rewrites the package name', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		expect(result.name).toBe('my-app');
		expect(result.directory).toBe(join(cwd, 'my-app'));
		const manifest = JSON.parse(
			await readFile(join(result.directory, 'package.json'), 'utf8'),
		) as { name: string; scripts: Record<string, string> };
		expect(manifest.name).toBe('my-app');
		const project = JSON.parse(
			await readFile(join(result.directory, 'flowdular.json'), 'utf8'),
		);
		const platform = JSON.parse(
			await readFile(
				new URL('../../../flowdular.json', import.meta.url),
				'utf8',
			),
		);
		expect([...project.modules.enabled].sort()).toEqual(
			[...platform.modules.enabled, 'example.core'].sort(),
		);
		expect(project.agent).toEqual({
			policy:
				'platform/node_modules/@flowdular/sdk/.ai/policies/capabilities.yaml',
			modelRouting:
				'platform/node_modules/@flowdular/sdk/.ai/policies/model-routing.yaml',
			blueprints: 'platform/node_modules/@flowdular/sdk/.ai/blueprints',
		});
		expect(manifest.scripts.dev).toContain('platform/scripts/dev.mjs');
		expect(
			await readFile(join(result.directory, 'platform/index.html'), 'utf8'),
		).toBe(
			await readFile(
				new URL('../../../platform/index.html', import.meta.url),
				'utf8',
			),
		);

		for (const path of [
			'pnpm-workspace.yaml',
			'flowdular.json',
			'tsconfig.base.json',
			'README.md',
			'platform/package.json',
			'platform/octane.config.ts',
			'platform/src/App.tsrx',
			'platform/src/server/database.ts',
			'platform/src/generated/modules.server.ts',
			'platform/src/generated/modules.client.ts',
			'modules/example/module.json',
			'modules/example/spec/module.yaml',
			'modules/example/src/platform.ts',
			'modules/example/src/api/endpoints.ts',
			'modules/example/src/services/database-repository.ts',
			'modules/example/migrations/0001_example_core.up.sql',
			'modules/example/translations/en.json',
			'modules/example/translations/pl.json',
			'modules/example/tests/module.test.ts',
		]) {
			expect(await exists(join(result.directory, path)), path).toBe(true);
		}
	});

	it('restores the ignore file npm cannot ship under its real name', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		expect(await exists(join(result.directory, '.gitignore'))).toBe(true);
		expect(await exists(join(result.directory, '_gitignore'))).toBe(false);
		expect(
			await readFile(join(result.directory, '.gitignore'), 'utf8'),
		).toContain('.env');
	});

	it('writes an .env whose keys differ between two scaffolds', async () => {
		const cwd = await workspace();

		const first = await scaffold({
			cwd,
			target: 'first',
			template: 'default',
			force: false,
		});
		const second = await scaffold({
			cwd,
			target: 'second',
			template: 'default',
			force: false,
		});

		const read = async (directory: string) => {
			const contents = await readFile(join(directory, '.env'), 'utf8');
			return SECRET_KEYS.map(
				(key) =>
					contents
						.split('\n')
						.find((line) => line.startsWith(`${key}=`))
						?.slice(key.length + 1) ?? '',
			);
		};
		const firstKeys = await read(first.directory);
		const secondKeys = await read(second.directory);

		expect(firstKeys.every((value) => value.length > 0)).toBe(true);
		for (const [index, value] of firstKeys.entries()) {
			expect(secondKeys[index]).not.toBe(value);
		}
	});

	it('refuses a directory that is not empty', async () => {
		const cwd = await workspace();
		await scaffold({ cwd, target: 'taken', template: 'default', force: false });

		await expect(
			scaffold({ cwd, target: 'taken', template: 'default', force: false }),
		).rejects.toBeInstanceOf(ScaffoldError);
		await expect(
			scaffold({ cwd, target: 'taken', template: 'default', force: false }),
		).rejects.toThrow(/not empty/);
	});

	it('scaffolds into a directory that is not empty with force', async () => {
		const cwd = await workspace();
		const target = join(cwd, 'occupied');
		await scaffold({
			cwd,
			target: 'occupied',
			template: 'default',
			force: false,
		});
		await writeFile(join(target, 'NOTES.md'), 'keep me');

		const result = await scaffold({
			cwd,
			target: 'occupied',
			template: 'default',
			force: true,
		});

		expect(result.name).toBe('occupied');
		expect(await readFile(join(target, 'NOTES.md'), 'utf8')).toBe('keep me');
	});

	it('refuses a directory name npm would reject as a package name', async () => {
		const cwd = await workspace();

		await expect(
			scaffold({ cwd, target: 'My App', template: 'default', force: false }),
		).rejects.toThrow(/not a valid npm package name/);
	});

	it('refuses a template it does not ship', async () => {
		const cwd = await workspace();

		await expect(
			scaffold({ cwd, target: 'my-app', template: 'missing', force: false }),
		).rejects.toThrow(/not a template/);
		expect(await exists(join(cwd, 'my-app'))).toBe(false);
	});
});
