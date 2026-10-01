import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
	spec = 'id: eval.catalog\ncapabilities:\n  - api\n  - database\n  - translations\n',
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
	/* spec/module.yaml is collected as a module file. Reading it into the same
	   map as the sources made every declared id "appear in the module" by being
	   in the contract that asked for it, which voided the name checks. */
	it('does not read the specification as if it were part of the module', () => {
		const spec =
			'id: claims.core\ncapabilities:\n  - api\n  - database\n  - translations\nagentsPlaceholder:\nagentsToolsPlaceholder:\nsettings:\n  - key: autoAssign\n    type: boolean\nagentTools:\n  - id: triageClaim\n    permission: claims.records.manage\nentities:\n  - id: reserves\n    fields:\n      - id: amount\n        type: integer\n';
		const onlySpec = { 'spec/module.yaml': spec };
		for (const id of [
			'entities-are-built',
			'settings-declared',
			'agent-tools-registered',
		] as const) {
			const [outcome] = runChecks([id], context(onlySpec, spec));
			expect(outcome!.passed).toBe(false);
		}
		/* With the specification excluded, an id present only in the sources of
		   another locale still has to be there. */
		const [built] = runChecks(
			['settings-declared'],
			context(
				{ ...onlySpec, 'src/settings.ts': 'export const autoAssign = 1;' },
				spec,
			),
		);
		expect(built!.passed).toBe(true);
	});

	/* A headless module has no endpoint and no table by design. Failing it for
	   that would make the gate noise an author learns to ignore. */
	it('abstains on a capability the specification never declares', () => {
		const headless = 'id: eval.sync\ncapabilities:\n  - integration\n';
		const endpoint = runChecks(
			['endpoints-declare-permission'],
			context({}, headless),
		);
		expect(endpoint[0]!.passed).toBe(true);
		expect(endpoint[0]!.detail).toContain('Not applicable');
		const rls = runChecks(
			['rls-forced', 'migrations-mirrored'],
			context({}, headless),
		);
		for (const outcome of rls) {
			expect(outcome.passed).toBe(true);
			expect(outcome.detail).toContain('Not applicable');
		}
	});

	/* users.core and reports.core declare entities while owning no table, so a
	   declared entity is not treated as a declared database. */
	it('does not treat a declared entity as a declared database', () => {
		const spec =
			'id: eval.catalog\ncapabilities:\n  - api\nentities:\n  - id: parts\n    fields:\n      - id: sku\n        type: string\n';
		const rls = runChecks(['rls-forced'], context({}, spec));
		expect(rls[0]!.passed).toBe(true);
		expect(rls[0]!.detail).toContain('Not applicable');
	});

	/* Conformance: the specification is only a contract if the build is
	   measured against it. */
	/* The scaffold used to build entities[0] and ignore the rest, so the failure
	   this catches is the one a business user cannot see until delivery. */
	it('fails a declared entity the module never builds', () => {
		const spec =
			'id: claims.core\ncapabilities:\n  - api\n  - database\nentities:\n  - id: claims\n    fields:\n      - id: ref\n        type: string\n  - id: reserves\n    fields:\n      - id: amount\n        type: integer\n';
		const files = {
			'migrations/0001.up.sql': 'CREATE TABLE claims_claims (id bigint);',
		};
		const [outcome] = runChecks(['entities-are-built'], context(files, spec));
		expect(outcome!.passed).toBe(false);
		expect(outcome!.detail).toContain('reserves');
		/* A field id is not an entity: only the direct children count. */
		expect(outcome!.detail).not.toContain('ref');
		const [covered] = runChecks(
			['entities-are-built'],
			context(
				{
					...files,
					'migrations/0002.up.sql': 'CREATE TABLE claims_reserves (id bigint);',
				},
				spec,
			),
		);
		expect(covered!.passed).toBe(true);
	});

	it('accepts an entity named in camelCase rather than its specification form', () => {
		const spec =
			'id: claims.core\ncapabilities:\n  - api\n  - database\nentities:\n  - id: member-preference\n    fields:\n      - id: channel\n        type: string\n';
		const [outcome] = runChecks(
			['entities-are-built'],
			context(
				{
					'migrations/0001.up.sql':
						'CREATE TABLE notifications_preferences (channel text);',
					'src/domain/preferences.ts': 'export const memberPreference = 1;',
				},
				spec,
			),
		);
		expect(outcome!.passed).toBe(true);
	});
	/* Whether a transition is *guarded* is not statically checkable: audit,
	   documents, import and users each enforce theirs differently, and a rule
	   naming one shape fails the platform's own modules. What is checkable is
	   that the declared lifecycle exists. */
	it('fails a lifecycle the module never builds', () => {
		const spec =
			'id: claims.core\ncapabilities:\n  - api\n  - database\nentities:\n  - id: claims\n    fields:\n      - id: status\n        type: string\n    states:\n      field: status\n      values: [draft, investigation, paid]\n      transitions:\n        - from: draft\n          to: investigation\n        - from: investigation\n          to: paid\n';
		const [outcome] = runChecks(['transitions-guarded'], context({}, spec));
		expect(outcome!.passed).toBe(false);
		expect(outcome!.detail).toContain('investigation');
		const built = context(
			{
				'src/domain/claims.ts':
					"export type ClaimStatus = 'draft' | 'investigation' | 'paid';\nexport function claimTransitions(from: string) { return from === 'draft' ? ['investigation'] : ['paid']; }",
			},
			spec,
		);
		expect(runChecks(['transitions-guarded'], built)[0]!.passed).toBe(true);
	});
	it('fails a declared action and a declared screen the module omits', () => {
		const spec =
			'id: claims.core\ncapabilities:\n  - api\n  - client\nactions:\n  - id: create-claim\n    permission: claims.records.manage\nscreens:\n  - id: claims\n    kind: list\n';
		const [action] = runChecks(['actions-have-endpoints'], context({}, spec));
		expect(action!.passed).toBe(false);
		expect(action!.detail).toContain('create-claim');
		const [screen] = runChecks(['screens-have-views'], context({}, spec));
		expect(screen!.passed).toBe(false);
		const built = context(
			{
				'src/api/endpoints.ts': 'export const createClaim = 1;',
				'src/client/ClaimsView.tsrx': 'export const ClaimsView = 1;',
			},
			spec,
		);
		expect(runChecks(['actions-have-endpoints'], built)[0]!.passed).toBe(true);
		expect(runChecks(['screens-have-views'], built)[0]!.passed).toBe(true);
	});

	it('fails a declared agent tool and setting the module omits', () => {
		const spec =
			'id: claims.core\ncapabilities:\n  - api\nagentTools:\n  - id: triage-claim\n    permission: claims.records.manage\nsettings:\n  - key: autoAssign\n    type: boolean\n';
		const [tool] = runChecks(['agent-tools-registered'], context({}, spec));
		expect(tool!.passed).toBe(false);
		expect(tool!.detail).toContain('triage-claim');
		const [setting] = runChecks(['settings-declared'], context({}, spec));
		expect(setting!.passed).toBe(false);
		expect(setting!.detail).toContain('autoAssign');
	});

	it('abstains from every conformance check on a version 1 specification', () => {
		const spec = 'schemaVersion: 1\nid: legacy.core\n';
		for (const id of [
			'entities-are-built',
			'actions-have-endpoints',
			'transitions-guarded',
			'screens-have-views',
			'agent-tools-registered',
			'settings-declared',
		] as const) {
			const [outcome] = runChecks([id], context({}, spec));
			expect(outcome!.passed).toBe(true);
			expect(outcome!.detail).toContain('Not applicable');
		}
	});

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
		const spec =
			'id: eval.catalog\ncapabilities:\n  - translations\nlocales:\n  - en\n  - pl\n';
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
