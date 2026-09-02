import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runDoctor } from '../src/doctor.ts';
import { runCommand } from '../src/runner.ts';
import type { Workspace } from '../src/workspace.ts';

const CLI_PACKAGE_PATH = fileURLToPath(
	new URL('../package.json', import.meta.url),
);
const ROOT_PACKAGE_PATH = fileURLToPath(
	new URL('../../../package.json', import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const LOCAL_STATE_CALLS = [
	['modules/agents/src/server/runtime.ts', 'agents.db'],
	['modules/auth/src/server/runtime.ts', 'auth.db'],
	['modules/automations/src/server/runtime.ts', 'automations.db'],
	['modules/catalog/src/server/runtime.ts', 'catalog.db'],
	['modules/expenses/src/server/runtime.ts', 'expenses.db'],
	['modules/parties/src/server/runtime.ts', 'parties.db'],
	['modules/profile/src/server/runtime.ts', 'profile.db'],
	['modules/sandbox/src/server/runtime.ts', 'sandbox.db'],
	['modules/agents/src/services/credential-vault.ts', 'agent-credential.key'],
	['modules/agents/src/services/run-grant.ts', 'agent-run-grant.key'],
	[
		'modules/automations/src/services/secret-vault.ts',
		'automations-credential.key',
	],
] as const;

async function staleWorkspace(): Promise<{
	readonly workspace: Workspace;
	readonly dispose: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), 'coreloom-doctor-'));
	const configPath = join(root, 'coreloom.json');
	const config = { modules: { enabled: [] } };
	await Promise.all([
		mkdir(join(root, '.ai/policies'), { recursive: true }),
		mkdir(join(root, '.ai/blueprints'), { recursive: true }),
		mkdir(join(root, 'modules'), { recursive: true }),
		mkdir(join(root, 'packages'), { recursive: true }),
		mkdir(join(root, 'platform'), { recursive: true }),
	]);
	await Promise.all([
		writeFile(configPath, `${JSON.stringify(config)}\n`),
		writeFile(
			join(root, 'package.json'),
			'{"packageManager":"pnpm@11.17.0"}\n',
		),
		writeFile(join(root, '.ai/policies/capabilities.yaml'), '{}\n'),
		writeFile(join(root, '.ai/policies/model-routing.yaml'), '{}\n'),
	]);
	return {
		workspace: { root, configPath, config },
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}

describe('CLI identity', () => {
	it('makes coreloom primary and exposes cl as the short alias', async () => {
		const [cliPackage, rootPackage] = await Promise.all(
			[CLI_PACKAGE_PATH, ROOT_PACKAGE_PATH].map(async (path) =>
				JSON.parse(await readFile(path, 'utf8')),
			),
		);

		expect(cliPackage.bin).toEqual({
			coreloom: './dist/index.js',
			cl: './dist/index.js',
		});
		expect(rootPackage.name).toBe('coreloom');
		expect(rootPackage.scripts.coreloom).toBe(
			'pnpm --filter @coreloom/cli dev',
		);
		expect(rootPackage.scripts.cl).toBe('pnpm coreloom');
		expect(rootPackage.scripts).not.toHaveProperty('oerp');

		const help = await runCommand(parseArguments(['help']));
		expect(help.ok).toBe(true);
		expect((help.data as { usage: string }).usage).toMatch(/^coreloom /);
		expect((help.data as { usage: string }).usage).not.toContain('oerp');
	});

	it('tells operators to repair generated composition with coreloom', async () => {
		const { workspace, dispose } = await staleWorkspace();
		try {
			const composition = (await runDoctor(workspace)).find(
				(check) => check.id === 'composition.generated',
			);
			expect(composition).toMatchObject({ status: 'warn' });
			expect(composition?.message).toContain(
				'pnpm coreloom module sync --apply',
			);
			expect(composition?.message).not.toContain('oerp');
		} finally {
			await dispose();
		}
	});

	it('guards every default database and vault key against silent replacement', async () => {
		for (const [path, fileName] of LOCAL_STATE_CALLS) {
			const source = await readFile(join(REPOSITORY_ROOT, path), 'utf8');
			expect(source, path).toContain(
				`coreloomLocalDataPath(workspaceRoot, '${fileName}')`,
			);
		}
	});
});
