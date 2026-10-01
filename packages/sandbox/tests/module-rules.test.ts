import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
		await writeFile(
			join(modulePath, 'src', 'api.ts'),
			'const tenantId = input.tenantId;',
		);
		const report = await runGateFor(modulePath);
		expect(report.passed).toBe(false);
		expect(report.output).toContain('tenant-not-from-request');
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
				" USING (tenant_id = current_setting('coreloom.tenant_id', true))",
				" WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));",
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
