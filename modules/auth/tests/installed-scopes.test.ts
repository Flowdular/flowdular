import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { declaredScopes } from '../src/cli/index.ts';

it('discovers permission declarations from modules beside installed SDK auth', async () => {
	const root = await mkdtemp(join(tmpdir(), 'installed-scopes-'));
	try {
		await mkdir(join(root, 'modules'));
		const sdk = join(root, 'node_modules/@flowdular/sdk/modules');
		await mkdir(join(sdk, 'sandbox/spec'), { recursive: true });
		await writeFile(
			join(sdk, 'sandbox/spec/module.yaml'),
			'id: sandbox.core\npermissions:\n  - id: sandbox.access.use\n',
		);
		expect(
			await declaredScopes(root, 'sandbox.core', join(sdk, 'auth')),
		).toEqual({ directory: 'sandbox', scopes: ['sandbox.access.use'] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
