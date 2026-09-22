import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSpec } from '../src/server/spec.ts';
import { approvalState, loadCase, loadCases } from '../src/evals/cases.ts';
import { runChecks, type CheckContext } from '../src/evals/checks.ts';
import { collectModuleFiles, runEvalCase } from '../src/evals/run.ts';

const suiteRoot = fileURLToPath(new URL('../../../evals', import.meta.url));

function context(
	files: Record<string, string>,
	spec = 'id: eval.catalog\n',
): CheckContext {
	return { files: new Map(Object.entries(files)), spec };
}

describe('cases', () => {
	it('loads every shipped case', async () => {
		const cases = await loadCases(suiteRoot);
		expect(cases.map((entry) => entry.id)).toEqual([
			'permission-boundary',
			'record-crud',
			'tenant-isolation',
		]);
		for (const entry of cases) expect(entry.spec).toContain('schemaVersion: 2');
	});

	it('treats a case as approved only while the hash matches the text', async () => {
		const [first] = await loadCases(suiteRoot);
		const frozen = { ...first!, approval: { ...first!.approval } };
		expect(
			approvalState({
				...frozen,
				approval: { ...frozen.approval, specHash: null },
			}),
		).toBe('unapproved');
		expect(
			approvalState({
				...frozen,
				approval: { ...frozen.approval, specHash: hashSpec(frozen.spec) },
			}),
		).toBe('approved');
		expect(
			approvalState({
				...frozen,
				spec: `${frozen.spec}\n# edited after approval\n`,
				approval: { ...frozen.approval, specHash: hashSpec(frozen.spec) },
			}),
		).toBe('stale');
	});

	it('refuses a case whose manifest names an unknown check', async () => {
		const root = await mkdtemp(join(tmpdir(), 'eval-case-'));
		try {
			await mkdir(join(root, 'spec'), { recursive: true });
			await writeFile(join(root, 'spec', 'module.yaml'), 'id: eval.x\n');
			await writeFile(
				join(root, 'case.json'),
				JSON.stringify({ checks: ['does-not-exist'], maxTurns: 1 }),
			);
			await expect(loadCase(root)).rejects.toThrow(/not a check this suite/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe('the approval gate', () => {
	it('refuses to run an unapproved case and never opens a session', async () => {
		const [first] = await loadCases(suiteRoot);
		const result = await runEvalCase(
			{
				/* A context that would throw if the run got as far as using it. */
				context: null as never,
				driver: 'stub',
			},
			{
				...first!,
				approval: { specHash: null, approvedBy: null, approvedAt: null },
			},
		);
		expect(result.status).toBe('refused');
		expect(result.sessionId).toBeNull();
		expect(result.refusal).toMatch(/carries no approval/);
	});

	it('refuses a case edited after it was approved', async () => {
		const [first] = await loadCases(suiteRoot);
		const result = await runEvalCase(
			{ context: null as never, driver: 'stub' },
			{
				...first!,
				spec: `${first!.spec}\n# edited\n`,
				approval: {
					specHash: hashSpec(first!.spec),
					approvedBy: 'owner',
					approvedAt: '2026-09-22',
				},
			},
		);
		expect(result.status).toBe('refused');
		expect(result.refusal).toMatch(/edited after it was approved/);
	});
});

describe('checks', () => {
	it('fails an endpoint that names no permission and passes one that does', () => {
		const bad = runChecks(
			['endpoints-declare-permission'],
			context({
				'src/api.ts':
					'export const list = defineEndpoint({\n method: "GET",\n handler: read,\n});',
			}),
		);
		expect(bad[0]!.passed).toBe(false);
		expect(bad[0]!.detail).toContain('src/api.ts');
		const good = runChecks(
			['endpoints-declare-permission'],
			context({
				'src/api.ts':
					'export const list = defineEndpoint({\n method: "GET",\n permission: "catalog.parts.read",\n handler: read,\n});',
			}),
		);
		expect(good[0]!.passed).toBe(true);
	});

	it('is not fooled by a nested object before the permission', () => {
		const outcome = runChecks(
			['endpoints-declare-permission'],
			context({
				'src/api.ts':
					'defineEndpoint({\n input: { shape: { code: string } },\n permission: "catalog.parts.read",\n});',
			}),
		);
		expect(outcome[0]!.passed).toBe(true);
	});

	it('catches tenant identity read from request input', () => {
		const outcome = runChecks(
			['tenant-not-from-request'],
			context({
				'src/api.ts': 'const tenantId = request.body.tenantId;',
			}),
		);
		expect(outcome[0]!.passed).toBe(false);
		expect(outcome[0]!.detail).toContain('src/api.ts:1');
	});

	it('accepts tenant identity taken from the principal', () => {
		const outcome = runChecks(
			['tenant-not-from-request'],
			context({
				'src/api.ts': 'const tenantId = principal.tenantId;',
			}),
		);
		expect(outcome[0]!.passed).toBe(true);
	});

	it('requires row-level security to be enabled, forced and both-sided', () => {
		const partial = runChecks(
			['rls-forced'],
			context({
				'migrations/0001_init.sql':
					'ALTER TABLE parts ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON parts USING (tenant_id = current_tenant());',
			}),
		);
		expect(partial[0]!.passed).toBe(false);
		expect(partial[0]!.detail).toContain('FORCE ROW LEVEL SECURITY');
		expect(partial[0]!.detail).toContain('WITH CHECK');
		const complete = runChecks(
			['rls-forced'],
			context({
				'migrations/0001_init.sql': [
					'ALTER TABLE parts ENABLE ROW LEVEL SECURITY;',
					'ALTER TABLE parts FORCE ROW LEVEL SECURITY;',
					'CREATE POLICY p ON parts USING (tenant_id = current_tenant())',
					'  WITH CHECK (tenant_id = current_tenant());',
				].join('\n'),
			}),
		);
		expect(complete[0]!.passed).toBe(true);
	});

	it('fails when a migration is not mirrored in databaseMigrations', () => {
		const sql = 'CREATE TABLE parts (id uuid primary key);';
		const missing = runChecks(
			['migrations-mirrored'],
			context({
				'migrations/0001_init.sql': sql,
				'src/module.ts': 'export const databaseMigrations = [];',
			}),
		);
		expect(missing[0]!.passed).toBe(false);
		const mirrored = runChecks(
			['migrations-mirrored'],
			context({
				'migrations/0001_init.sql': sql,
				'src/module.ts': `export const databaseMigrations = [{ sql: \`\n  ${sql}\n\` }];`,
			}),
		);
		expect(mirrored[0]!.passed).toBe(true);
	});

	it('catches a value interpolated into a statement', () => {
		const outcome = runChecks(
			['no-sql-interpolation'],
			context({
				'src/repository.ts':
					'const rows = await sql(`SELECT * FROM parts WHERE code = ${code}`);',
			}),
		);
		expect(outcome[0]!.passed).toBe(false);
	});

	it('accepts a bound statement', () => {
		const outcome = runChecks(
			['no-sql-interpolation'],
			context({
				'src/repository.ts':
					'const rows = await sql(`SELECT * FROM parts WHERE code = $1`, [code]);',
			}),
		);
		expect(outcome[0]!.passed).toBe(true);
	});

	it('requires a bundle per locale with the same keys', () => {
		const spec = 'locales:\n  - en\n  - pl\n';
		const absent = runChecks(
			['locales-complete'],
			context(
				{
					'src/translations/en.ts':
						'export default { "parts.title": "Parts" };',
				},
				spec,
			),
		);
		expect(absent[0]!.passed).toBe(false);
		expect(absent[0]!.detail).toContain('pl');
		const drifted = runChecks(
			['locales-complete'],
			context(
				{
					'src/translations/en.ts':
						'export default { "parts.title": "Parts", "parts.new": "New" };',
					'src/translations/pl.ts':
						'export default { "parts.title": "Czesci" };',
				},
				spec,
			),
		);
		expect(drifted[0]!.passed).toBe(false);
		const complete = runChecks(
			['locales-complete'],
			context(
				{
					'src/translations/en.ts':
						'export default { "parts.title": "Parts" };',
					'src/translations/pl.ts':
						'export default { "parts.title": "Czesci" };',
				},
				spec,
			),
		);
		expect(complete[0]!.passed).toBe(true);
	});

	it('reads the permissions a specification declares', () => {
		const spec = [
			'id: eval.catalog',
			'permissions:',
			'  - id: catalog.parts.read',
			'    description: Read parts.',
			'  - id: catalog.parts.manage',
			'    description: Manage parts.',
			'tenancy: required',
		].join('\n');
		const missing = runChecks(
			['permissions-declared'],
			context(
				{
					'src/module.ts': 'export const permissions = ["catalog.parts.read"];',
				},
				spec,
			),
		);
		expect(missing[0]!.passed).toBe(false);
		expect(missing[0]!.detail).toContain('catalog.parts.manage');
	});

	it('fails a module that was never scaffolded', () => {
		const outcome = runChecks(['module-manifest'], context({}));
		expect(outcome[0]!.passed).toBe(false);
		expect(outcome[0]!.detail).toContain('never written');
	});
});

describe('collectModuleFiles', () => {
	it('reads the module tree and skips dependencies', async () => {
		const root = await mkdtemp(join(tmpdir(), 'eval-module-'));
		try {
			await mkdir(join(root, 'src'), { recursive: true });
			await mkdir(join(root, 'node_modules', 'left'), { recursive: true });
			await writeFile(join(root, 'module.json'), '{}');
			await writeFile(join(root, 'src', 'api.ts'), 'export const a = 1;');
			await writeFile(join(root, 'src', 'logo.png'), 'binary');
			await writeFile(join(root, 'node_modules', 'left', 'index.ts'), 'x');
			const files = await collectModuleFiles(root);
			expect([...files.keys()].sort()).toEqual(['module.json', 'src/api.ts']);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
