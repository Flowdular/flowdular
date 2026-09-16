import { spawnSync } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceFormatter } from '../src/format.ts';
import { scaffoldModule } from '../src/module-scaffold.ts';
import type { Workspace } from '../src/workspace.ts';

const base = `schemaVersion: 2
id: vendors.core
specVersion: 0.1.0
status: approved
name: Vendors
description: Screens vendors against public sources for tests.
profile: full
capabilities:
  - api
  - database
  - client
  - translations
dependencies:
  - id: auth.core
    range: ^0.13.0
tenancy: required
locales:
  - en
  - pl
permissions:
  - id: vendors.companies.read
    description: Read vendors.
  - id: vendors.companies.manage
    description: Manage vendors.
entities:
  - id: companies
    name: Vendor
    fields:
      - id: name
        type: string
        required: true
        unique: tenant
        maxLength: 120
      - id: taxId
        type: string
screens:
  - id: companies
    kind: list
    entity: companies
    columns:
      - name
`;

const sections = `${base}research:
  adapter: model-native
  allowDomains:
    - registry.example.gov
  monthlyQueryBudget: 200
  evidenceOwner: companies
adapters:
  - id: vendors.core.erp-vendors
    direction: source
    connector: http-json
    operation: list-vendors
    port: vendors.core.companies
    schedule: 0 6 * * mon-fri
    mapping:
      - from: vendor_name
        to: name
        transform: rename
        value: null
      - to: country
        transform: constant
        value: PL
    recorded: adapters/erp-vendors.recorded.json
  - id: vendors.core.erp.flags
    direction: sink
    connector: http-json
    operation: push-flags
    port: vendors.core.flags
    mapping:
      - from: name
        to: vendor
        transform: rename
templates:
  - id: screening-report
    title: Vendor screening report
    inputEntity: companies
    format: pdf
    body: templates/screening-report.md
  - id: screening-letter
    title: Vendor screening letter
    inputEntity: companies
    format: docx
    body: templates/screening-report.md
`;

async function workspace(source: string): Promise<Workspace> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-scaffold-sections-'));
	await mkdir(join(root, 'modules/vendors/spec'), { recursive: true });
	await writeFile(join(root, 'modules/vendors/spec/module.yaml'), source);
	await writeFile(join(root, 'flowdular.json'), '{}\n');
	return { root, configPath: join(root, 'flowdular.json'), config: {} };
}

const request = {
	id: 'vendors.core',
	specPath: 'modules/vendors/spec/module.yaml',
	apply: true,
};

describe('module scaffolding of research, adapters and templates', () => {
	it('writes no stub for a specification without the sections', async () => {
		const ws = await workspace(base);
		try {
			const result = await scaffoldModule(ws, request);
			expect(
				result.files.filter(
					(file) =>
						file.endsWith('src/research.ts') ||
						file.endsWith('research-fixtures.json') ||
						file.includes('/src/adapters/') ||
						file.includes('/adapters/') ||
						file.includes('/templates/'),
				),
			).toEqual([]);
			const pkg = JSON.parse(
				await readFile(join(ws.root, 'modules/vendors/package.json'), 'utf8'),
			) as { files: string[] };
			expect(pkg.files).not.toContain('templates');
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('writes one stub per section entry, formatted and compiling', async () => {
		const ws = await workspace(sections);
		try {
			const result = await scaffoldModule(ws, request);
			const module = await realpath(join(ws.root, 'modules/vendors'));
			const read = (path: string) => readFile(join(module, path), 'utf8');
			expect(result.files).toEqual(
				expect.arrayContaining([
					'modules/vendors/src/research.ts',
					'modules/vendors/research-fixtures.json',
					'modules/vendors/src/adapters/erp-vendors.ts',
					'modules/vendors/adapters/erp-vendors.recorded.json',
					'modules/vendors/src/adapters/erp-flags.ts',
					'modules/vendors/adapters/erp-flags.recorded.json',
					'modules/vendors/templates/screening-report.md',
				]),
			);
			/* Two templates rendering one body share the file. */
			expect(
				result.files.filter((file) => file.includes('/templates/')),
			).toHaveLength(1);

			const research = await read('src/research.ts');
			expect(research).toContain("evidence: 'research.evidence.v1'");
			expect(research).toContain('export const VENDORS_RESEARCH = {');
			expect(research).toContain("evidenceOwner: 'companies'");
			expect(research).toContain('monthlyQueryBudget: 200');

			const source = await read('src/adapters/erp-vendors.ts');
			expect(source).toContain('export const ERP_VENDORS_ADAPTER = {');
			expect(source).toContain("schedule: '0 6 * * mon-fri'");
			expect(source).toContain(
				"recorded: 'adapters/erp-vendors.recorded.json'",
			);
			expect(source).toContain('value: null');
			expect(await read('src/adapters/erp-flags.ts')).toContain(
				"port: 'vendors.core.flags'",
			);

			/* The shape research.core's recorded adapter reads, on an allowed host. */
			expect(JSON.parse(await read('research-fixtures.json'))).toEqual({
				queries: {
					example: [
						{
							url: 'https://registry.example.gov/example',
							title: 'Example result',
							snippet: 'Replace with a recorded search result.',
							source: 'registry.example.gov',
						},
					],
				},
				pages: {
					'https://registry.example.gov/example': {
						title: 'Example result',
						text: 'Replace with the text of the recorded page.',
					},
				},
			});
			/* The declared fixture path, or the local id when none is declared. */
			expect(
				JSON.parse(await read('adapters/erp-vendors.recorded.json')),
			).toEqual({
				adapter: 'vendors.core.erp-vendors',
				operation: 'list-vendors',
				calls: [{ input: {}, body: {} }],
			});
			expect(
				JSON.parse(await read('adapters/erp-flags.recorded.json')),
			).toMatchObject({ adapter: 'vendors.core.erp.flags' });

			const template = await read('templates/screening-report.md');
			expect(template).toContain('# Vendor screening report');
			expect(template).toContain('companies record. Fields: name, taxId.');

			const pkg = JSON.parse(await read('package.json')) as {
				files: string[];
			};
			expect(pkg.files).toContain('templates');

			expect(result.formatted).toBe(true);
			const formatter = await loadWorkspaceFormatter(ws.root);
			for (const path of [
				'src/research.ts',
				'research-fixtures.json',
				'src/adapters/erp-vendors.ts',
				'adapters/erp-vendors.recorded.json',
				'src/adapters/erp-flags.ts',
				'adapters/erp-flags.recorded.json',
				'templates/screening-report.md',
			]) {
				const absolute = join(module, path);
				const text = await readFile(absolute, 'utf8');
				expect(await formatter!.format(absolute, text), path).toBe(text);
			}

			await writeFile(
				join(module, 'tsconfig.check.json'),
				JSON.stringify({
					compilerOptions: {
						target: 'ES2022',
						module: 'ESNext',
						moduleResolution: 'Bundler',
						allowImportingTsExtensions: true,
						strict: true,
						noEmit: true,
						skipLibCheck: true,
						exactOptionalPropertyTypes: true,
						verbatimModuleSyntax: true,
						types: [],
						baseUrl: '.',
						paths: {
							'@flowdular/contracts': [resolve('../contracts/src/index.ts')],
						},
					},
					include: ['src/research.ts', 'src/adapters/*.ts'],
				}),
			);
			const compiled = spawnSync(
				process.execPath,
				[
					resolve('node_modules/typescript/bin/tsc'),
					'-p',
					join(module, 'tsconfig.check.json'),
				],
				{ encoding: 'utf8', cwd: module },
			);
			expect(compiled.error, 'tsc did not run').toBeUndefined();
			expect(compiled.status, compiled.stdout).toBe(0);
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	}, 60_000);

	it('refuses two adapters that declare one recorded fixture', async () => {
		const ws = await workspace(
			sections.replace(
				'    operation: push-flags\n',
				'    operation: push-flags\n    recorded: adapters/erp-vendors.recorded.json\n',
			),
		);
		try {
			await expect(scaffoldModule(ws, request)).rejects.toThrow(
				'both map to adapters/erp-vendors.recorded.json',
			);
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('refuses two adapters whose ids map to one stub file', async () => {
		/* The ids differ only in a dot, so both validate and the paths collide. */
		const ws = await workspace(
			sections.replace('vendors.core.erp.flags', 'vendors.core.erp.vendors'),
		);
		try {
			await expect(scaffoldModule(ws, request)).rejects.toThrow(
				'both map to src/adapters/erp-vendors.ts',
			);
			await expect(
				access(join(ws.root, 'modules/vendors/module.json')),
			).rejects.toThrow();
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});
});
