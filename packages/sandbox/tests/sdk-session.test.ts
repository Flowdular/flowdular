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
import { materializeSessionWorkspace } from '../src/server/workspace-install.ts';

it('makes a platform-installed SDK resolvable before scaffolding the first session module', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-sdk-session-'));
	try {
		const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
		const workspace = join(root, 'session');
		await mkdir(sdk, { recursive: true });
		await mkdir(workspace);
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
		await materializeSessionWorkspace({
			workspaceRoot: root,
			sessionWorkspace: workspace,
			modules: [],
		});
		const pkg = JSON.parse(
			await readFile(join(workspace, 'package.json'), 'utf8'),
		);
		expect(pkg.dependencies).toEqual({ '@flowdular/sdk': '0.1.0' });
		const workspaceFile = await readFile(
			join(workspace, 'pnpm-workspace.yaml'),
			'utf8',
		);
		expect(workspaceFile).toContain(
			`'@flowdular/sdk': 'link:${await realpath(sdk)}'`,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
