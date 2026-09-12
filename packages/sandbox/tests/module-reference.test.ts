import {
	mkdtemp,
	mkdir,
	readFile,
	stat,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
	resolveReadableInsideWorkspace,
	resolveWritableInsideWorkspace,
} from '@flowdular/coding-agent';
import { materializeSdkReference } from '../src/server/sdk-reference.ts';
import { guardAgentPaths } from '../src/server/path-guard.ts';
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

it('copies the platform capability card the specification skills cite', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-capabilities-'));
	try {
		await mkdir(join(root, '.ai'), { recursive: true });
		await writeFile(
			join(root, '.ai/platform-capabilities.md'),
			'# Platform capabilities\n',
		);
		const session = join(root, 'session');
		await mkdir(session);
		await materializeReference(root, session);
		expect(
			await readFile(
				join(session, 'reference/platform-capabilities.md'),
				'utf8',
			),
		).toContain('Platform capabilities');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('names the capability card in the reference README and warns when it is missing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-capabilities-gap-'));
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...parts: readonly unknown[]) => {
		warnings.push(parts.map(String).join(' '));
	};
	try {
		const session = join(root, 'session');
		await mkdir(session);
		await materializeReference(root, session);
		expect(
			await readFile(join(session, 'reference/README.md'), 'utf8'),
		).toContain('platform-capabilities.md');
		expect(
			warnings.filter((line) => line.includes('.ai/platform-capabilities.md')),
		).toHaveLength(1);
	} finally {
		console.warn = warn;
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

it('makes the installed SDK readable without opening external symlinks or allowing writes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-sdk-snapshot-'));
	try {
		const sdk = join(root, 'store/sdk');
		const app = join(root, 'app');
		const session = join(app, 'session/workspace');
		await mkdir(join(sdk, 'packages/database/src'), { recursive: true });
		await mkdir(join(app, 'platform/node_modules/@flowdular'), {
			recursive: true,
		});
		await mkdir(session, { recursive: true });
		await symlink(sdk, join(app, 'platform/node_modules/@flowdular/sdk'));
		await symlink(sdk, join(session, 'sdk-link'));
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				version: '1.0.0',
				exports: { './package.json': './package.json' },
			}),
		);
		const source = join(sdk, 'packages/database/src/provider.ts');
		await writeFile(source, 'export const provider = "installed";');
		await mkdir(join(sdk, 'packages/database/node_modules'), {
			recursive: true,
		});
		await writeFile(join(sdk, 'packages/database/.env'), 'private');
		await writeFile(
			join(sdk, 'packages/database/node_modules/private.ts'),
			'private',
		);
		await symlink(source, join(sdk, 'packages/database/src/external.ts'));
		await materializeReference(app, session);
		const relative = 'reference/sdk/packages/database/src/provider.ts';
		const snapshot = await resolveReadableInsideWorkspace(session, relative);
		expect(await readFile(snapshot, 'utf8')).toBe(
			'export const provider = "installed";',
		);
		await expect(
			resolveReadableInsideWorkspace(
				session,
				'sdk-link/packages/database/src/provider.ts',
			),
		).rejects.toThrow();
		await expect(
			resolveWritableInsideWorkspace(session, relative, ['modules/example/**']),
		).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
		for (const excluded of [
			'.env',
			'node_modules/private.ts',
			'src/external.ts',
		]) {
			await expect(
				readFile(join(session, 'reference/sdk/packages/database', excluded)),
			).rejects.toMatchObject({ code: 'ENOENT' });
		}
		const copiedAt = (await stat(snapshot)).mtimeMs;
		await materializeSdkReference(app, session);
		expect((await stat(snapshot)).mtimeMs).toBe(copiedAt);
		const guard = await guardAgentPaths({
			workspace: session,
			sessionRoot: join(app, 'session'),
			allowedPaths: ['modules/example/**'],
		});
		await writeFile(snapshot, 'changed');
		expect(
			(await guard.verify()).violations.map((entry) => entry.path),
		).toContain(relative);
		expect(await readFile(snapshot, 'utf8')).toBe(
			'export const provider = "installed";',
		);
		expect(await readFile(source, 'utf8')).toBe(
			'export const provider = "installed";',
		);
		await rm(source);
		await writeFile(
			join(sdk, 'packages/database/src/new-api.ts'),
			'export const version = 2;',
		);
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				version: '2.0.0',
				exports: { './package.json': './package.json' },
			}),
		);
		await materializeSdkReference(app, session);
		await expect(readFile(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(
			await readFile(
				join(session, 'reference/sdk/packages/database/src/new-api.ts'),
				'utf8',
			),
		).toContain('version = 2');
		await rm(join(session, 'reference/sdk'), { recursive: true });
		await materializeSdkReference(app, session);
		expect(
			await readFile(
				join(session, 'reference/sdk/packages/database/src/new-api.ts'),
				'utf8',
			),
		).toContain('version = 2');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
