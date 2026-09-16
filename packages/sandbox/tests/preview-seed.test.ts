import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseProvider } from '@flowdular/database';
import type { PreviewModuleSource } from '../src/server/preview-modules.ts';
import { seedPreviewDrafts } from '../src/server/preview-seed.ts';

const databases = {
	marker: 'preview-databases',
} as unknown as DatabaseProvider;

const SEED_SOURCE = `import { appendFileSync } from 'node:fs';
export async function seed(context) {
  appendFileSync(context.data.probe, JSON.stringify({
    tenantId: context.tenantId,
    accountId: context.accountId,
    rooms: context.data.rooms,
    databases: context.databases.marker,
  }) + '\\n');
}
`;

async function draft(
	files: Readonly<Record<string, string>>,
	id = 'booking.core',
): Promise<PreviewModuleSource & { probe: string; data: string }> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-preview-seed-'));
	const path = join(root, 'modules', 'booking');
	const probe = join(root, 'probe.jsonl');
	for (const [file, content] of Object.entries(files)) {
		await mkdir(join(path, file, '..'), { recursive: true });
		await writeFile(
			join(path, file),
			content.replaceAll('PROBE', JSON.stringify(probe)),
		);
	}
	return {
		id,
		directory: 'booking',
		path,
		support: false,
		probe,
		data: join(root, 'data'),
	};
}

async function seedOnce(module: PreviewModuleSource & { data: string }) {
	return seedPreviewDrafts({
		modules: [module],
		revision: String(Math.random()),
		dataPath: module.data,
		context: { tenantId: 'tenant-1', accountId: 'account-1', databases },
	});
}

async function probeLines(path: string): Promise<unknown[]> {
	return (await readFile(path, 'utf8').catch(() => ''))
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

describe('preview seed', () => {
	it('hands seed() the preview identity, the parsed seed and the database, once per content', async () => {
		const module = await draft({
			'preview/seed.json': '{"probe": PROBE, "rooms": [{"name": "Atlas"}]}',
			'src/preview.ts': SEED_SOURCE,
		});
		expect(await seedOnce(module)).toEqual([]);
		expect(await probeLines(module.probe)).toEqual([
			{
				tenantId: 'tenant-1',
				accountId: 'account-1',
				rooms: [{ name: 'Atlas' }],
				databases: 'preview-databases',
			},
		]);

		expect(await seedOnce(module)).toEqual([]);
		expect(await probeLines(module.probe)).toHaveLength(1);

		await writeFile(
			join(module.path, 'preview/seed.json'),
			JSON.stringify({
				probe: module.probe,
				rooms: [{ name: 'Atlas' }, { name: 'Borealis' }],
			}),
		);
		expect(await seedOnce(module)).toEqual([]);
		expect((await probeLines(module.probe)).at(-1)).toMatchObject({
			rooms: [{ name: 'Atlas' }, { name: 'Borealis' }],
		});
	});

	it('skips a module without both files and reports broken seeds per module', async () => {
		const withoutEntry = await draft({
			'preview/seed.json': '{"probe": PROBE}',
		});
		const support = {
			...(await draft({
				'preview/seed.json': '{"probe": PROBE}',
				'src/preview.ts': SEED_SOURCE,
			})),
			support: true,
		};
		expect(await seedOnce(withoutEntry)).toEqual([]);
		expect(await seedOnce(support)).toEqual([]);
		expect(await probeLines(support.probe)).toEqual([]);

		const invalid = await draft({
			'preview/seed.json': '{ nope',
			'src/preview.ts': SEED_SOURCE,
		});
		expect(await seedOnce(invalid)).toEqual([
			expect.stringMatching(
				/^booking\.core: the preview seed failed: preview\/seed\.json is not valid JSON/,
			),
		]);

		const noExport = await draft({
			'preview/seed.json': '{}',
			'src/preview.ts': 'export const rooms = [];\n',
		});
		expect(await seedOnce(noExport)).toEqual([
			'booking.core: the preview seed failed: src/preview.ts does not export a seed function, so preview/seed.json was not loaded.',
		]);

		const throwing = await draft({
			'preview/seed.json': '{}',
			'src/preview.ts':
				'export async function seed() { throw new Error("rooms table missing"); }\n',
		});
		expect(await seedOnce(throwing)).toEqual([
			'booking.core: the preview seed failed: rooms table missing',
		]);
		expect(await seedOnce(throwing)).toHaveLength(1);
	});
});
