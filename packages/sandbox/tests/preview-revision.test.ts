import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { previewRevision } from '../src/server/preview-revision.ts';

it('moves to a new revision when only a translation bundle changes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-preview-revision-'));
	try {
		await mkdir(join(root, 'src/client'), { recursive: true });
		await mkdir(join(root, 'translations'));
		await writeFile(join(root, 'src/client/contribution.tsrx'), 'export {};\n');
		await writeFile(join(root, 'translations/en.json'), '{"page.title":"x"}\n');
		const sources = [
			{
				id: 'equipment.core',
				directory: 'equipment',
				path: root,
				support: false,
			},
		];
		const before = await previewRevision(sources);
		await writeFile(
			join(root, 'translations/en.json'),
			'{"page.title":"Equipment register"}\n',
		);
		expect(await previewRevision(sources)).not.toBe(before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
