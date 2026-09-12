import { PLATFORM_API_VERSION } from '@flowdular/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@flowdular/contracts';
import { moduleLayoutIssues, validateModules } from '../src/module-validate.ts';

const manifest: ModuleManifest & {
	platform: { server: boolean; client: boolean };
} = {
	schemaVersion: 1,
	id: 'billing.core',
	package: '@flowdular/module-billing',
	version: '0.1.0',
	platformApi: '^0.1.0',
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
	const root = await mkdtemp(join(tmpdir(), 'flowdular-validate-'));
	for (const [path, source] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), source);
	}
	return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

const complete = {
	'package.json': JSON.stringify({
		name: '@flowdular/module-billing',
		version: '0.1.0',
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
				name: '@flowdular/module-billing',
				version: '0.1.0',
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

	it('rejects a package version that differs from the module manifest', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'package.json': JSON.stringify({
				name: '@flowdular/module-billing',
				version: '0.2.0',
				exports: {
					'.': './src/index.ts',
					'./client': './src/client/index.ts',
					'./platform': './src/platform.ts',
				},
			}),
		});
		try {
			const issues = await moduleLayoutIssues(root, manifest);
			expect(codes(issues)).toContain('error:PACKAGE_VERSION_MISMATCH');
			expect(
				issues.find((issue) => issue.code === 'PACKAGE_VERSION_MISMATCH')
					?.message,
			).toContain('0.2.0');
		} finally {
			await dispose();
		}
	});

	it('does not require package metadata from unselected sandbox stubs', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-validate-workspace-'));
		try {
			for (const [path, source] of Object.entries(complete)) {
				await mkdir(join(root, 'modules/billing', path, '..'), {
					recursive: true,
				});
				await writeFile(join(root, 'modules/billing', path), source);
			}
			await mkdir(join(root, 'modules/catalog'), { recursive: true });
			await writeFile(
				join(root, 'modules/billing/module.json'),
				JSON.stringify(manifest),
			);
			await writeFile(
				join(root, 'modules/catalog/module.json'),
				JSON.stringify({
					...manifest,
					id: 'catalog.core',
					package: '@flowdular/module-catalog',
					platform: { server: false, client: false },
				}),
			);

			const result = await validateModules(
				{ root, configPath: join(root, 'flowdular.json'), config: {} },
				{ modules: ['billing.core'] },
			);

			expect(result.ok).toBe(true);
			expect(
				(result.data as { reports: readonly { file: string }[] }).reports.map(
					(report) => report.file,
				),
			).toEqual(['modules/billing/module.json']);
		} finally {
			await rm(root, { recursive: true, force: true });
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

	it('errors when client code references a missing static translation key', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'src/client/index.ts': "t('billing.missing');\n",
		});
		try {
			const issues = await moduleLayoutIssues(root, manifest);
			expect(codes(issues)).toContain('error:TRANSLATION_KEY_MISSING');
			expect(
				issues.find((entry) => entry.code === 'TRANSLATION_KEY_MISSING'),
			).toMatchObject({ path: 'src/client/index.ts' });
		} finally {
			await dispose();
		}
	});

	it('rejects raw tables and direct TanStack imports in a module', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'src/client/index.ts': [
				"import { useTable } from '@octanejs/tanstack-table';",
				'export function View() @{ <table><tbody></tbody></table> }',
			].join('\n'),
		});
		try {
			expect(codes(await moduleLayoutIssues(root, manifest))).toEqual([
				'error:RAW_TABLE_FORBIDDEN',
				'error:TANSTACK_TABLE_DIRECT_IMPORT',
			]);
		} finally {
			await dispose();
		}
	});

	it('accepts the shared Table component', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'src/client/index.ts': [
				"import { Table } from '@flowdular/ui';",
				'export function View() @{ <Table /> }',
			].join('\n'),
		});
		try {
			expect(codes(await moduleLayoutIssues(root, manifest))).not.toContain(
				'error:RAW_TABLE_FORBIDDEN',
			);
		} finally {
			await dispose();
		}
	});
});

describe('module contract drift', () => {
	it('requires platformApi on an authored module', async () => {
		const { root, dispose } = await moduleRoot(complete);
		try {
			const { platformApi: _omitted, ...withoutPlatformApi } = manifest;
			const issues = await moduleLayoutIssues(root, withoutPlatformApi);
			expect(codes(issues)).toContain('error:PLATFORM_API_MISSING');
			expect(
				issues.find((issue) => issue.code === 'PLATFORM_API_MISSING')?.message,
			).toContain(`"platformApi": "^${PLATFORM_API_VERSION}"`);
		} finally {
			await dispose();
		}
	});

	it('warns when the specification dependencies drift from module.json', async () => {
		const { root, dispose } = await moduleRoot({
			...complete,
			'spec/module.yaml':
				'id: billing.core\nspecVersion: 0.1.0\ndependencies:\n  - id: auth.core\n    range: 0.11.0\n',
		});
		try {
			const issues = await moduleLayoutIssues(root, {
				...manifest,
				dependencies: [{ id: 'auth.core', range: '^0.11.0' }],
			});
			expect(codes(issues)).toContain('warning:SPEC_DEPENDENCY_DRIFT');
			expect(
				issues.find((issue) => issue.code === 'SPEC_DEPENDENCY_DRIFT')?.message,
			).toContain('auth.core@0.11.0, auth.core@^0.11.0');
			expect(
				codes(
					await moduleLayoutIssues(root, {
						...manifest,
						dependencies: [{ id: 'auth.core', range: '0.11.0' }],
					}),
				),
			).not.toContain('warning:SPEC_DEPENDENCY_DRIFT');
		} finally {
			await dispose();
		}
	});
});
