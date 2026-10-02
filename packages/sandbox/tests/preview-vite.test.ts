import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewSdkRoot } from '../src/server/preview-modules.ts';
import { createSession, sessionPaths } from '../src/server/sessions.ts';
import { previewModules } from '../vite.config.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

describe('Vite preview source resolver', () => {
	it('loads draft and declared support sources from a sealed session', async () => {
		const root = await temporaryRoot('flowdular-preview-vite-');
		await writeFile(
			join(root, 'flowdular.json'),
			JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		);
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'finance.core',
			title: 'Finance',
			brief: 'Track finances.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const stored = JSON.parse(await readFile(paths.record, 'utf8')) as {
			seal?: string;
			session?: { id: string };
		};
		expect(stored.seal).toBeTruthy();
		expect(stored.session?.id).toBe(session.id);

		const draftEntry = join(paths.modulePath, 'src/client/index.ts');
		await mkdir(join(paths.modulePath, 'src/client'), { recursive: true });
		await writeFile(draftEntry, 'export const draft = true;\n');
		await writeFile(
			join(paths.modulePath, 'module.json'),
			JSON.stringify({
				id: 'finance.core',
				dependencies: [{ id: 'system.core' }],
			}),
		);

		const supportPath = join(root, 'modules/system');
		const supportEntry = join(supportPath, 'src/client/index.ts');
		await mkdir(join(supportPath, 'src/client'), { recursive: true });
		await writeFile(
			join(supportPath, 'module.json'),
			JSON.stringify({ id: 'system.core' }),
		);
		await writeFile(supportEntry, 'export const support = true;\n');
		const outside = join(root, 'outside.ts');
		await writeFile(outside, 'export const outside = true;\n');
		await symlink(outside, join(paths.modulePath, 'src/outside.ts'));

		const resolver = previewModules(root).resolveId;
		if (typeof resolver !== 'function')
			throw new Error('Missing preview resolver.');
		const resolveSource = (source: string) =>
			resolver.call({} as never, source, undefined, { isEntry: true });

		expect(
			await resolveSource(
				`/preview-module/${session.id}/finance/src/client/index.ts`,
			),
		).toBe(draftEntry);
		expect(
			await resolveSource(
				`/preview-support/${session.id}/system/src/client/index.ts`,
			),
		).toBe(supportEntry);
		expect(
			await resolveSource(
				`/preview-module/${session.id}/other/src/client/index.ts`,
			),
		).toBeNull();
		expect(
			await resolveSource(
				`/preview-module/${session.id}/finance/src/../client/index.ts`,
			),
		).toBeNull();
		expect(
			await resolveSource(
				`/preview-module/${session.id}/finance/src/outside.ts`,
			),
		).toBeNull();
		expect(
			await resolveSource(
				`/preview-support/${session.id}/system/src/../client/index.ts`,
			),
		).toBeNull();
	});

	it('loads a core dependency from the SDK installed in a generated app', async () => {
		const root = await temporaryRoot('flowdular-preview-sdk-');
		await writeFile(
			join(root, 'flowdular.json'),
			JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		);
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'finance.core',
			title: 'Finance',
			brief: 'Track finances.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await writeFile(
			join(paths.modulePath, 'module.json'),
			JSON.stringify({
				id: 'finance.core',
				dependencies: [{ id: 'research.core' }],
			}),
		);

		const sdkRoot = join(root, 'platform/node_modules/@flowdular/sdk');
		const supportPath = join(sdkRoot, 'modules/research');
		const supportEntry = join(supportPath, 'src/client/index.ts');
		await mkdir(join(supportPath, 'src/client'), { recursive: true });
		await writeFile(join(root, 'platform/package.json'), '{}');
		await writeFile(
			join(sdkRoot, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				exports: { './package.json': './package.json' },
			}),
		);
		await writeFile(
			join(supportPath, 'module.json'),
			JSON.stringify({ id: 'research.core' }),
		);
		await writeFile(supportEntry, 'export const support = true;\n');

		expect(await previewSdkRoot(root)).toBe(await realpath(sdkRoot));
		const resolver = previewModules(root).resolveId;
		if (typeof resolver !== 'function')
			throw new Error('Missing preview resolver.');
		expect(
			await resolver.call(
				{} as never,
				`/preview-support/${session.id}/research/src/client/index.ts`,
				undefined,
				{ isEntry: true },
			),
		).toBe(await realpath(supportEntry));
	});
});
