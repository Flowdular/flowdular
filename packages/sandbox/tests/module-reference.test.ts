import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { materializeReference } from '../src/server/reference.ts';

it('prepares the offline catalog example without a bundled catalog module', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-reference-'));
	try {
		await mkdir(join(root, '.ai/references/catalog/src'), { recursive: true });
		await writeFile(
			join(root, '.ai/references/catalog/src/index.ts'),
			'export const reference = true;',
		);
		const session = join(root, 'session');
		await mkdir(session);
		await materializeReference(root, session);
		expect(
			await readFile(
				join(session, 'reference/example-module/src/index.ts'),
				'utf8',
			),
		).toBe('export const reference = true;');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('loads SDK reference files and skills when the consumer has no core sources', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-sdk-reference-'));
	try {
		const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
		await mkdir(join(sdk, 'packages/server/src'), { recursive: true });
		await mkdir(join(sdk, '.ai/skills/auto-review'), { recursive: true });
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				exports: { './package.json': './package.json' },
			}),
		);
		await writeFile(
			join(sdk, 'packages/server/src/index.ts'),
			'export const sdkReference = true;',
		);
		await writeFile(
			join(sdk, '.ai/skills/auto-review/SKILL.md'),
			'# Review the final source',
		);
		const session = join(root, 'session');
		await mkdir(session);
		expect(await materializeReference(root, session)).toEqual(['auto-review']);
		expect(
			await readFile(
				join(session, 'reference/packages/server/src/index.ts'),
				'utf8',
			),
		).toContain('sdkReference');
		expect(
			await readFile(
				join(session, 'reference/skills/auto-review/SKILL.md'),
				'utf8',
			),
		).toContain('final source');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
