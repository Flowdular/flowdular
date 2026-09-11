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
import { materializeSessionWorkspace } from '../src/server/workspace-install.ts';

it('makes a platform-installed SDK resolvable before scaffolding the first session module', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-sdk-session-'));
	try {
		const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
		const workspace = join(root, 'session');
		await mkdir(sdk, { recursive: true });
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
			join(root, 'pnpm-workspace.yaml'),
			`packages:
  - platform
  - modules/*
  - custom/*
allowBuilds:
  esbuild: true
  tldjs: false
minimumReleaseAgeExclude:
  - segment-state@0.2.1
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
		expect(pkg.dependencies).toEqual({ '@flowdular/sdk': '0.1.0' });
		const workspaceFile = await readFile(
			join(workspace, 'pnpm-workspace.yaml'),
			'utf8',
		);
		expect(parse(workspaceFile)).toEqual({
			packages: ['modules/*'],
			allowUnusedPatches: true,
			allowBuilds: { esbuild: true, tldjs: false },
			minimumReleaseAgeExclude: ['segment-state@0.2.1'],
			overrides: {
				'@flowdular/sdk': `link:${await realpath(sdk)}`,
				'some-library': '1.2.3',
			},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
