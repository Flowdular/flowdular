import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@coreloom/contracts';
import { moduleLayoutIssues } from '../src/module-validate.ts';

const manifest: ModuleManifest & {
	platform: { server: boolean; client: boolean };
} = {
	schemaVersion: 1,
	id: 'billing.core',
	package: '@coreloom/module-billing',
	version: '0.1.0',
	profile: 'full',
	capabilities: ['api', 'client', 'translations'],
	platform: { server: true, client: true },
	dependencies: [],
	tenancy: 'required',
	locales: ['en', 'pl'],
	stability: 'experimental',
};

async function moduleRoot(
	files: Record<string, string>,
): Promise<{ root: string; dispose: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), 'oerp-validate-'));
	for (const [path, source] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), source);
	}
	return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

const complete = {
	'package.json': JSON.stringify({
		name: '@coreloom/module-billing',
		exports: {
			'.': './src/index.ts',
			'./client': './src/client/index.ts',
			'./platform': './src/platform.ts',
		},
	}),
	'src/platform.ts': '',
	'src/client/index.ts': '',
	'spec/module.yaml': 'id: billing.core\nspecVersion: 0.1.0\n',
	'translations/en.json': '{"module.name":"Billing","a":"1"}',
	'translations/pl.json': '{"module.name":"Rozliczenia","a":"1"}',
};

function codes(issues: readonly { code: string; severity: string }[]) {
	return issues.map((issue) => `${issue.severity}:${issue.code}`).sort();
}

describe('module layout validation', () => {
	it('accepts a module that matches its manifest', async () => {
		const { root, dispose } = await moduleRoot(complete);
		try {
			expect(
				await moduleLayoutIssues(root, manifest, {
					projectLocales: ['en', 'pl'],
				}),
			).toEqual([]);
		} finally {
			await dispose();
		}
	});

	it('reports missing composition entries and exports as errors', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'package.json': JSON.stringify({
				name: '@coreloom/module-billing',
				exports: { '.': './src/index.ts' },
			}),
		});
		await rm(join(root, 'src/platform.ts'));
		await rm(join(root, 'src/client/index.ts'));
		try {
			expect(codes(await moduleLayoutIssues(root, manifest))).toEqual([
				'error:PLATFORM_CLIENT_ENTRY_MISSING',
				'error:PLATFORM_CLIENT_EXPORT_MISSING',
				'error:PLATFORM_EXPORT_MISSING',
				'error:PLATFORM_SERVER_ENTRY_MISSING',
			]);
		} finally {
			await dispose();
		}
	});

	it('warns on version drift and unknown locales, errors on translation parity', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'spec/module.yaml': 'id: billing.core\nspecVersion: 0.2.0\n',
			'translations/pl.json': '{"module.name":"Rozliczenia","b":"2"}',
		});
		try {
			const issues = await moduleLayoutIssues(root, manifest, {
				projectLocales: ['en'],
			});
			expect(codes(issues)).toEqual([
				'error:TRANSLATION_KEYS_MISMATCH',
				'warning:LOCALE_NOT_IN_PROJECT',
				'warning:SPEC_VERSION_DRIFT',
			]);
			expect(
				issues.find((issue) => issue.code === 'TRANSLATION_KEYS_MISMATCH')
					?.message,
			).toContain('missing a; extra b');
		} finally {
			await dispose();
		}
	});

	it('errors when a declared locale has no translation file', async () => {
		const { root, dispose } = await moduleRoot(complete);
		await rm(join(root, 'translations/pl.json'));
		try {
			expect(codes(await moduleLayoutIssues(root, manifest))).toEqual([
				'error:TRANSLATION_FILE_MISSING',
			]);
		} finally {
			await dispose();
		}
	});
});
