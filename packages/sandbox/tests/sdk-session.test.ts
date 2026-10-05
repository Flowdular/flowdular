import {
	mkdtemp,
	realpath,
	mkdir,
	writeFile,
	readFile,
	rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import {
	materializeSessionWorkspace,
	runPnpm,
} from '../src/server/workspace-install.ts';

it('installs the platform SDK and CLI before the first agent turn', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-sdk-session-'));
	try {
		const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
		const cli = join(root, 'node_modules/flowdular');
		const workspace = join(root, 'session');
		await mkdir(sdk, { recursive: true });
		await mkdir(join(cli, 'dist'), { recursive: true });
		await mkdir(workspace);
		await mkdir(join(workspace, 'modules/draft'), { recursive: true });
		await writeFile(
			join(workspace, 'modules/draft/package.json'),
			JSON.stringify({ name: '@app/draft' }),
		);
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				version: '0.1.0',
				exports: { './modules.json': './modules.json' },
			}),
		);
		await writeFile(
			join(sdk, 'modules.json'),
			'{"schemaVersion":1,"modules":[]}',
		);
		await writeFile(
			join(cli, 'package.json'),
			JSON.stringify({
				name: 'flowdular',
				version: '0.1.0',
				type: 'module',
				bin: { flowdular: './dist/index.js' },
			}),
		);
		await writeFile(
			join(cli, 'dist/index.js'),
			`#!/usr/bin/env node\nconsole.log('CLI_READY', ...process.argv.slice(2));\n`,
		);
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			`packages:
  - platform
  - modules/*
  - custom/*
allowBuilds:
  esbuild: true
  tldjs: false
minimumReleaseAgeExclude:
  - segment-state@0.4.0
overrides:
  '@flowdular/sdk': file:old-sdk.tgz
  some-library: 1.2.3
  '@app/draft': file:host-draft
`,
		);
		await materializeSessionWorkspace({
			workspaceRoot: root,
			sessionWorkspace: workspace,
			modules: [{ id: 'draft.core', directory: 'draft', kind: 'edit' }],
		});
		const pkg = JSON.parse(
			await readFile(join(workspace, 'package.json'), 'utf8'),
		);
		expect(pkg.dependencies).toEqual({
			'@flowdular/sdk': '0.1.0',
			flowdular: '0.1.0',
		});
		const workspaceFile = await readFile(
			join(workspace, 'pnpm-workspace.yaml'),
			'utf8',
		);
		expect(parse(workspaceFile)).toEqual({
			packages: ['modules/*'],
			allowUnusedPatches: true,
			allowBuilds: { esbuild: true, tldjs: false },
			minimumReleaseAgeExclude: ['segment-state@0.4.0'],
			overrides: {
				'@flowdular/sdk': `link:${await realpath(sdk)}`,
				flowdular: `link:${await realpath(cli)}`,
				'some-library': '1.2.3',
			},
		});
		const install = await runPnpm(workspace, [
			'install',
			'--offline',
			'--no-frozen-lockfile',
		]);
		expect(install).toMatchObject({ code: 0 });
		const command = await runPnpm(workspace, [
			'flowdular',
			'spec',
			'validate',
			'--all',
			'--json',
		]);
		expect(command).toMatchObject({ code: 0 });
		expect(command.output).toContain('CLI_READY spec validate --all --json');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
