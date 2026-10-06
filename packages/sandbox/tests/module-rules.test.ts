import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	runChecks,
	type CheckId,
	type CheckOutcome,
} from '../src/evals/checks.ts';
import { runGates } from '../src/server/gates.ts';
import { checkModuleRules } from '../src/server/module-rules.ts';
import type {
	SandboxSession,
	SessionModule,
	SessionPaths,
} from '../src/server/sessions.ts';

/* These rules existed only in the evaluation suite, so the defects they name
   were still reachable at eject. The gate is the same check, on the delivery
   path, before a module may land. */
const SPEC = `schemaVersion: 2
id: claims.core
specVersion: 0.1.0
status: approved
name: Claims Core
description: Test fixture.
profile: full
capabilities:
  - api
  - database
  - translations
dependencies: []
tenancy: required
locales:
  - en
  - pl
permissions:
  - id: claims.records.read
    description: Read claims.
`;

async function fixture(): Promise<{
	readonly modulePath: string;
	readonly paths: SessionPaths;
	readonly module: SessionModule;
	readonly session: SandboxSession;
}> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-module-rules-'));
	const workspace = join(root, 'workspace');
	const modulePath = join(workspace, 'modules', 'claims');
	await mkdir(join(modulePath, 'spec'), { recursive: true });
	await mkdir(join(modulePath, 'src'), { recursive: true });
	await writeFile(join(modulePath, 'spec', 'module.yaml'), SPEC);
	const module = { id: 'claims.core', directory: 'claims' } as SessionModule;
	const paths = { workspace, root } as SessionPaths;
	return {
		modulePath,
		paths,
		module,
		session: { modules: [module] } as unknown as SandboxSession,
	};
}

async function runGateFor(
	modulePath: string,
): Promise<{ passed: boolean; output: string }> {
	return checkModuleRules({
		modulePath,
		spec: await readFile(join(modulePath, 'spec', 'module.yaml'), 'utf8'),
	});
}

describe('module rules gate', () => {
	it('fails an endpoint that declares no permission', async () => {
		const { modulePath } = await fixture();
		await writeFile(
			join(modulePath, 'src', 'api.ts'),
			'export const list = defineEndpoint({\n method: "GET",\n handler: read,\n});',
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain('endpoints-declare-permission');
	});

	it('fails tenant identity taken from request input', async () => {
		const { modulePath } = await fixture();
		await mkdir(join(modulePath, 'src', 'api'), { recursive: true });
		await writeFile(
			join(modulePath, 'src', 'api', 'endpoints.ts'),
			[
				'export const list = defineEndpoint({',
				' access: { kind: "permission", permission: "claims.records.read" },',
				' handler: async ({ octane }) => {',
				'  const input = await readJsonObject(octane.request);',
				'  const tenantId = input.tenantId;',
				' },',
				'});',
			].join('\n'),
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain(
			'FAIL tenant-not-from-request: Tenant identity read from request input at src/api/endpoints.ts:5.',
		);
	});

	it('fails a migration without forced row-level security', async () => {
		const { modulePath } = await fixture();
		await writeFile(
			join(modulePath, 'src', 'api.ts'),
			'export const list = defineEndpoint({\n permission: "claims.records.read",\n});',
		);
		await mkdir(join(modulePath, 'migrations'), { recursive: true });
		await writeFile(
			join(modulePath, 'migrations', '0001_claims.up.sql'),
			'CREATE TABLE claims_records (id bigint);',
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain('rls-forced');
		expect(report.output).toContain('ENABLE ROW LEVEL SECURITY');
	});

	/* A session that copies a policy on another tenant setting must fail here,
	   before a preview applies it to an empty database where every policy would
	   see no tenant. */
	it('fails a migration whose policy reads another tenant setting', async () => {
		const { modulePath } = await fixture();
		await mkdir(join(modulePath, 'migrations'), { recursive: true });
		await writeFile(
			join(modulePath, 'migrations', '0001_claims.up.sql'),
			[
				'CREATE POLICY claims_records_tenant_policy ON claims_records',
				"  USING (tenant_id = current_setting('legacy.tenant_id', true))",
				"  WITH CHECK (tenant_id = current_setting('legacy.tenant_id', true));",
				'',
			].join('\n'),
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain(
			'FAIL migration-identifiers: migrations/0001_claims.up.sql',
		);
	});

	it('fails a statement that interpolates a value', async () => {
		const { modulePath } = await fixture();
		await writeFile(
			join(modulePath, 'src', 'repository.ts'),
			'const sql = `SELECT * FROM claims WHERE id = ${id}`;',
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain('no-sql-interpolation');
	});

	it('passes a module that satisfies every rule', async () => {
		const { modulePath } = await fixture();
		await writeFile(
			join(modulePath, 'src', 'api.ts'),
			[
				'export const list = defineEndpoint({',
				' access: { kind: "permission", permission: "claims.records.read" },',
				'});',
				'export const claimsRead = "claims.records.read";',
			].join('\n'),
		);
		await mkdir(join(modulePath, 'migrations'), { recursive: true });
		await writeFile(
			join(modulePath, 'migrations', '0001_claims.up.sql'),
			[
				'ALTER TABLE claims_records ENABLE ROW LEVEL SECURITY;',
				'ALTER TABLE claims_records FORCE ROW LEVEL SECURITY;',
				'CREATE POLICY claims_tenant ON claims_records',
				" USING (tenant_id = current_setting('flowdular.tenant_id', true))",
				" WITH CHECK (tenant_id = current_setting('flowdular.tenant_id', true));",
			].join('\n'),
		);
		const migration = await readFile(
			join(modulePath, 'migrations', '0001_claims.up.sql'),
			'utf8',
		);
		await writeFile(
			join(modulePath, 'src', 'migration.ts'),
			`export const databaseMigrations = [\n\`${migration}\`\n];\n`,
		);
		await mkdir(join(modulePath, 'translations'), { recursive: true });
		for (const locale of ['en', 'pl'])
			await writeFile(
				join(modulePath, 'translations', `${locale}.ts`),
				'export default { "claims.title": "Claims" };',
			);
		const report = await runGateFor(modulePath);
		expect(report.output).toContain('pass locales-complete');
		expect(report.passed).toBe(true);
	});

	/* A headless module has no endpoint and no table by design; the gate must
	   not push it toward growing one. */
	it('does not require an endpoint or a table from a headless module', async () => {
		const { modulePath } = await fixture();
		await writeFile(
			join(modulePath, 'spec', 'module.yaml'),
			SPEC.replace('  - api\n', '')
				.replace('  - database\n', '')
				.replace('  - translations\n', ''),
		);
		/* The declared permission still has to reach the module: the
		   specification is not itself evidence that it was built. */
		await writeFile(
			join(modulePath, 'src', 'permissions.ts'),
			"export const read = 'claims.records.read';",
		);
		const report = await runGateFor(modulePath);
		expect(report.output).toContain('Not applicable');
		expect(report.passed).toBe(true);
	});

	it('runs as a real gate and reports a failure to the turn', async () => {
		const { modulePath, paths, module, session } = await fixture();
		await writeFile(
			join(modulePath, 'src', 'api.ts'),
			'export const list = defineEndpoint({\n method: "GET",\n});',
		);
		expect(modulePath).toContain('claims');
		const results = await runGates({
			workspaceRoot: join(dirname(modulePath), '..', '..'),
			paths,
			session,
			gates: ['module-rules'],
		});
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe('module-rules');
		expect(results[0]!.status).toBe('failed');
		expect(results[0]!.output).toContain('endpoints-declare-permission');
	});
});

/* The reported session added a business rule the operator never approved and
   asked about it in prose afterwards. A permission is the part of that drift a
   static read can prove: its id is a string constant that has to equal one the
   specification lists. */
describe('permissions the specification does not list', () => {
	it('fails a permission constant the specification does not list', async () => {
		const { modulePath } = await fixture();
		await mkdir(join(modulePath, 'src', 'acl'), { recursive: true });
		await writeFile(
			join(modulePath, 'src', 'acl', 'permissions.ts'),
			[
				'export const CLAIMS_PERMISSIONS = {',
				"\tread: 'claims.records.read',",
				"\tapprove: 'claims.records.approve',",
				'} as const;',
			].join('\n'),
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain(
			'FAIL permissions-specified: The module defines claims.records.approve, which the approved specification does not list.',
		);
	});

	it('fails an endpoint that names an unlisted permission inline', async () => {
		const { modulePath } = await fixture();
		await writeFile(
			join(modulePath, 'src', 'api.ts'),
			[
				'export const read = "claims.records.read";',
				'export const exportAll = defineEndpoint({',
				' access: { kind: "permission", permission: "claims.records.export" },',
				'});',
			].join('\n'),
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain(
			'FAIL permissions-specified: The module defines claims.records.export',
		);
	});

	it('does not read a translation key or a data class id as a permission', async () => {
		const { modulePath } = await fixture();
		await mkdir(join(modulePath, 'src', 'acl'), { recursive: true });
		await writeFile(
			join(modulePath, 'src', 'acl', 'permissions.ts'),
			"export const CLAIMS_PERMISSIONS = { read: 'claims.records.read' } as const;",
		);
		await writeFile(
			join(modulePath, 'src', 'view.ts'),
			[
				"export const title = t('claims.records.title');",
				"export const dataClass = 'claims.core.records';",
			].join('\n'),
		);
		const report = await runGateFor(modulePath);
		expect(report.output).toContain(
			'pass permissions-specified: Every permission the module defines is in the specification.',
		);
	});
});

function outcome(
	id: CheckId,
	files: Readonly<Record<string, string>>,
	spec = SPEC,
): CheckOutcome {
	return runChecks([id], { files: new Map(Object.entries(files)), spec })[0]!;
}

/* The shipped modules and the reference module failed these rules on code
   that is correct. Each rule is narrowed to the shape that misled it, and the
   violation it exists for still fails next to it. */
describe('tenant identity from request input', () => {
	it('accepts a repository or service reading the tenant of its own argument', () => {
		const result = outcome('tenant-not-from-request', {
			'src/services/database-repository.ts': [
				'async history(query: HistoryQuery) {',
				"\treturn this.database.transaction(read, { access: 'read', tenantId: query.tenantId });",
				'}',
				'async decide(request: ApprovalRequest, input: DecideInput) {',
				'\treturn this.#member(request.tenantId, input.tenantId);',
				'}',
			].join('\n'),
			'tests/support/fakes.ts': 'const tenantId = body.tenantId;',
		});
		expect(result.passed).toBe(true);
	});

	it('fails an endpoint reading the tenant from the body, the query or the parameters', () => {
		const result = outcome('tenant-not-from-request', {
			'src/api/endpoints.ts': [
				'export const create = defineEndpoint({',
				'\thandler: async ({ octane }) => {',
				'\t\tconst input = await readJsonObject(octane.request);',
				'\t\treturn service.create(input.tenantId);',
				'\t},',
				'});',
				'export const list = defineEndpoint({',
				'\thandler: async ({ octane }) => {',
				'\t\tconst query = listQuery(new URL(octane.request.url));',
				'\t\treturn service.list(query.tenantId);',
				'\t},',
				'});',
			].join('\n'),
			'src/server/routes.ts': [
				"const route = new ServerRoute({ path: '/api/claims/:tenantId' });",
				"const read = (request: Request) => request['tenantId'];",
			].join('\n'),
			'src/services/claims-service.ts': [
				'export function create(octane: Context, body: Body) {',
				'\treturn [octane.params.tenantId, body.tenantId];',
				'}',
			].join('\n'),
		});
		expect(result.passed).toBe(false);
		expect(result.detail).toBe(
			'Tenant identity read from request input at src/api/endpoints.ts:4, src/api/endpoints.ts:10, src/server/routes.ts:2, src/services/claims-service.ts:2.',
		);
	});

	it('fails the bad example the repository ships, and a query string read', async () => {
		const result = outcome('tenant-not-from-request', {
			'src/api/endpoints.ts': await readFile(
				fileURLToPath(
					new URL(
						'../../../.ai/examples/bad/tenant-from-body/endpoints.ts',
						import.meta.url,
					),
				),
				'utf8',
			),
			'src/api/list.ts': [
				'export function listQuery(url: URL) {',
				"\treturn { tenant: url.searchParams.get('tenantId'), sort: url.searchParams.get('sort') };",
				'}',
				'export async function owner(octane: Context) {',
				"\treturn optionalString(await readJsonObject(octane.request), 'tenantId', 128);",
				'}',
			].join('\n'),
		});
		expect(result.passed).toBe(false);
		expect(result.detail).toBe(
			'Tenant identity read from request input at src/api/endpoints.ts:21, src/api/list.ts:2, src/api/list.ts:5.',
		);
	});
});

describe('migrations mirrored in databaseMigrations', () => {
	const UP = [
		'-- PostgreSQL checks column privileges in WHERE too, so `status` is granted.',
		'GRANT SELECT (tenant_id, id, status) ON claims_records TO flowdular_background;',
		'',
	].join('\n');
	const mirror = (sql: string) =>
		`export const CLAIMS_MIGRATION_001 = \`${sql}\`;\nexport const databaseMigrations = [CLAIMS_MIGRATION_001];\n`;

	it('accepts the up script mirrored with its template escapes, and no down script', () => {
		const result = outcome('migrations-mirrored', {
			'migrations/0001_claims.up.sql': UP,
			'migrations/0001_claims.down.sql': 'DROP TABLE claims_records;\n',
			'src/services/migration.ts': mirror(UP.replace(/`/g, '\\`')),
		});
		expect(result.detail).toBe(
			'All 1 migrations are mirrored in databaseMigrations.',
		);
		expect(result.passed).toBe(true);
	});

	it('fails an up script that is not mirrored, or mirrored with other bytes', () => {
		const result = outcome('migrations-mirrored', {
			'migrations/0001_claims.up.sql': UP,
			'migrations/0002_claims_index.up.sql':
				'CREATE INDEX claims_records_status_idx ON claims_records (status);\n',
			'migrations/0002_claims_index.down.sql':
				'DROP INDEX claims_records_status_idx;\n',
			'src/services/migration.ts': mirror(UP.replace(/`/g, '')),
		});
		expect(result.passed).toBe(false);
		expect(result.detail).toBe(
			'Not mirrored byte for byte: migrations/0001_claims.up.sql, migrations/0002_claims_index.up.sql.',
		);
	});
});

describe('locale bundles', () => {
	const bundle = (keys: readonly string[]) =>
		JSON.stringify(Object.fromEntries(keys.map((key) => [key, key])));

	it('compares a plural family by its base key', () => {
		const result = outcome('locales-complete', {
			'translations/en.json': bundle([
				'title',
				'table.count.one',
				'table.count.other',
			]),
			'translations/pl.json': bundle([
				'title',
				'table.count.one',
				'table.count.few',
				'table.count.many',
				'table.count.other',
			]),
		});
		expect(result.passed).toBe(true);
	});

	/* As translationKeys in @flowdular/contracts: `other` alone is an enum
	   value, not a family. */
	it('fails a missing key, a missing family, and an enum value that only ends in other', () => {
		const family = ['title', 'table.count.one', 'table.count.other'];
		for (const [en, pl] of [
			[family, ['table.count.one', 'table.count.few', 'table.count.other']],
			[family, ['title']],
			[
				['title', 'category.travel', 'category.other'],
				['title', 'category.other'],
			],
		] as const) {
			const result = outcome('locales-complete', {
				'translations/en.json': bundle(en),
				'translations/pl.json': bundle(pl),
			});
			expect(result.passed).toBe(false);
			expect(result.detail).toBe('Key set differs from en in pl.');
		}
	});
});

/* A value has to be bound. A fragment in a clause position (columns, a table,
   a keyset predicate, a sort expression) is how the shipped repositories
   compose a statement, and its own values are bound where it is built. */
describe('values interpolated into SQL', () => {
	it('accepts clause fragments, literal constants and messages that are not SQL', () => {
		const result = outcome('no-sql-interpolation', {
			'src/services/database-repository.ts': [
				"const HISTORY_TABLE = 'claims_history' as const;",
				'const PAGE_SIZE = 50;',
				'const COLUMNS = `id, tenant_id, name`;',
				'export const SELECT_ALL = `SELECT ${COLUMNS} FROM ${HISTORY_TABLE} LIMIT ${PAGE_SIZE}`;',
				'export function list(sort: Sort, filters: string[], keyset: string) {',
				'\tquery(`SELECT ${COLUMNS}, ${sort.expression} AS sort_value FROM ${table}`);',
				"\tquery(`SELECT * FROM (${select} WHERE ${filters.join(' AND ')}) AS page${keyset}`);",
				'\tquery(` WHERE ${predicate.text} ORDER BY ${sort.column} ${order}`);',
				'}',
				'export const segment = (from: number, to: number) => `${prefix}${pad(from)}-${pad(to)}.jsonl`;',
				'throw new Error(`The ${side} margin is a whole number from ${min} to ${max}.`);',
			].join('\n'),
		});
		expect(result.detail).toBe(
			'No statement interpolates a value instead of binding it.',
		);
		expect(result.passed).toBe(true);
	});

	it('fails a value in every value position, in either case', () => {
		const lines = [
			'query(`SELECT * FROM claims_records WHERE id = ${id}`);',
			"query(`SELECT * FROM claims_records WHERE name = '${name}'`);",
			"query(`SELECT * FROM claims_records WHERE name LIKE '%${term}%'`);",
			'query(`SELECT * FROM claims_records WHERE name ILIKE ${pattern}`);',
			'query(`SELECT * FROM claims_records WHERE amount <> ${amount}`);',
			'query(`SELECT * FROM claims_records WHERE amount >= ${amount}`);',
			'query(`SELECT * FROM claims_records WHERE day BETWEEN $1 AND ${last}`);',
			'query(`SELECT * FROM claims_records WHERE id IN ($1, ${second})`);',
			'query(`SELECT * FROM claims_records WHERE id = ANY(${ids})`);',
			'query(`SELECT * FROM claims_records LIMIT ${limit}`);',
			'query(`INSERT INTO claims_records (id, name) VALUES ($1, ${name})`);',
			'query(`UPDATE claims_records SET status = ${status} WHERE id = $1`);',
			'query(`SELECT name || ${suffix} FROM claims_records`);',
			'query(`SELECT * FROM claims_records WHERE id = ${COMPUTED}`);',
			'query(`select * from claims_records where id = ${id}`);',
			'query(`id = ${id} where tenant_id = $1`);',
			'log(`claims`, `DELETE FROM claims_records WHERE id = ${id}`);',
		];
		const result = outcome('no-sql-interpolation', {
			'src/services/database-repository.ts': [
				"const COMPUTED = FIELDS.join(', ');",
				...lines,
			].join('\n'),
		});
		expect(result.passed).toBe(false);
		expect(result.detail).toBe(
			`Interpolated statements at ${lines
				.map((_, index) => `src/services/database-repository.ts:${index + 2}`)
				.join(', ')}.`,
		);
	});
});

describe('endpoints that declare their access', () => {
	it('accepts a shorthand permission, a declared access object, a public endpoint and a scoped ServerRoute', () => {
		const result = outcome('endpoints-declare-permission', {
			'src/api/endpoints.ts': [
				'const $read = {',
				"\tkind: 'permission',",
				'\tpermission: CLAIMS_PERMISSIONS.read,',
				'} as const;',
				'export const list = defineEndpoint({ id, access: $read, handler });',
				'export const make = (permission: string) =>',
				"\tdefineEndpoint({ id, access: { kind: 'permission', permission }, handler });",
				"export const hook = defineEndpoint({ id, access: { kind: 'public' }, handler });",
			].join('\n'),
			'src/server/routes.ts': [
				'export const roles = new ServerRoute({',
				"\tpath: '/api/claims/roles',",
				'\thandler: async (context) => {',
				'\t\trequireScope(requireSession(context), CLAIMS_SCOPES.read);',
				'\t},',
				'});',
			].join('\n'),
		});
		expect(result.detail).toBe('All 4 endpoints declare their access.');
		expect(result.passed).toBe(true);
	});

	it('fails an endpoint that declares nothing, or an access object without a permission', () => {
		const result = outcome('endpoints-declare-permission', {
			'src/api/endpoints.ts': [
				"export const a = defineEndpoint({ id, path: '/api/claims', handler });",
				"export const b = defineEndpoint({ access: { kind: 'permission' }, handler });",
				'export const c = defineEndpoint({ access: imported, handler });',
				"const open = { kind: 'permission' };",
				'export const d = defineEndpoint({ access: open, handler });',
			].join('\n'),
		});
		expect(result.passed).toBe(false);
		expect(result.detail).toBe(
			'Endpoints without a permission: src/api/endpoints.ts:1, src/api/endpoints.ts:2, src/api/endpoints.ts:3, src/api/endpoints.ts:5.',
		);
	});

	it('fails a module whose only routes check no scope', () => {
		const result = outcome('endpoints-declare-permission', {
			'src/server/routes.ts': [
				'export const list = new ServerRoute({',
				"\tpath: '/api/claims',",
				'\thandler: async (context) => list(requireSession(context)),',
				'});',
			].join('\n'),
		});
		expect(result.passed).toBe(false);
		expect(result.detail).toBe(
			'The module defines no endpoint through defineEndpoint.',
		);
	});
});

/* A rule that fails the platform's own modules teaches every reader to ignore
   it. The values still interpolated below are fixed after 0.6.2 with a patch
   bump; a new failure anywhere, or one of these fixed, changes this list. */
describe('the shipped modules and the reference module', () => {
	const KNOWN = [
		"modules/auth no-sql-interpolation src/services/migration.ts: text: `SELECT CASE WHEN to_regclass('${table}') IS NOT NULL THEN",
		"modules/automations no-sql-interpolation src/services/migration.ts: text: `SELECT CASE WHEN to_regclass('${table}') IS NOT NULL THEN",
		'modules/exports no-sql-interpolation src/services/database-repository.ts: text: `DELETE FROM exports_jobs WHERE tenant_id = $1 AND id IN (${placeholders})`,',
		"modules/workflows no-sql-interpolation src/services/database-repository.ts: expireRunInputEvidence: `UPDATE workflow_runs SET input_evidence_json = ${expire('input_evidence_json')}",
		"modules/workflows no-sql-interpolation src/services/database-repository.ts: expireEdgeEvidence: `UPDATE workflow_edge_transfers SET evidence_json = ${expire('evidence_json')}",
	];

	it('hold every module rule but the known interpolated values', async () => {
		const repository = fileURLToPath(new URL('../../../', import.meta.url));
		const modules = [
			...(await readdir(join(repository, 'modules'), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => `modules/${entry.name}`)
				.sort(),
			'.ai/references/catalog',
		];
		expect(modules.length).toBeGreaterThanOrEqual(23);
		const findings: string[] = [];
		for (const module of modules) {
			const modulePath = join(repository, module);
			const report = await checkModuleRules({
				modulePath,
				spec: await readFile(join(modulePath, 'spec', 'module.yaml'), 'utf8'),
			});
			for (const line of report.output.split('\n')) {
				const failure = /^FAIL ([\w-]+): (.*)$/.exec(line);
				if (!failure) continue;
				const locations = [...failure[2]!.matchAll(/([\w./-]+\.tsx?):(\d+)/g)];
				if (locations.length === 0)
					findings.push(`${module} ${failure[1]}: ${failure[2]}`);
				for (const [, file, number] of locations) {
					const text = (await readFile(join(modulePath, file!), 'utf8')).split(
						'\n',
					)[Number(number) - 1]!;
					findings.push(`${module} ${failure[1]} ${file}: ${text.trim()}`);
				}
			}
		}
		expect(findings).toEqual(KNOWN);
	});
});
