import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	CliExtensionContext,
	CliExtensionResult,
	ModuleCliCatalog,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseProvider,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { cliExtension } from '../src/cli/index.ts';
import { createMeteringRuntime } from '../src/server/runtime.ts';
import { RUN_TOKENS_KEY } from './support/harness.ts';

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODULE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SLUG = 'acme-metering';
const METER = RUN_TOKENS_KEY;

const catalog = JSON.parse(
	readFileSync(new URL('../src/cli/commands.json', import.meta.url), 'utf8'),
) as ModuleCliCatalog;

let databases: DatabaseProvider;
let tenantId: string;

beforeAll(async () => {
	databases = createPgliteTestProvider();
	/* The command resolves a workspace through auth.core, so the workspace has
	   to exist the way a deployment made it: through auth.core's own service. */
	const auth = createAuthRuntime({
		databases,
		...authRuntimeOptionsFromEnvironment(process.env, WORKSPACE_ROOT),
	});
	try {
		const issued = await (
			await auth.service()
		).signUp({
			email: 'operator@example.com',
			password: 'correct horse battery staple',
			displayName: 'Operator',
			organizationName: 'Acme Metering',
			organizationSlug: SLUG,
		});
		tenantId = issued.principal.tenantId;
	} finally {
		await auth.dispose();
	}
}, 60_000);

afterAll(async () => {
	await databases?.dispose();
});

function command(path: string) {
	const found = cliExtension.commands.find(
		(candidate) => candidate.path.join(' ') === path,
	);
	if (!found) throw new Error(`The CLI command "${path}" is missing.`);
	return found;
}

function context(
	flags: Readonly<Record<string, string>>,
	apply: boolean,
): CliExtensionContext {
	return {
		workspaceRoot: WORKSPACE_ROOT,
		moduleRoot: MODULE_ROOT,
		apply,
		flags: new Map<string, string | boolean>(Object.entries(flags)),
		arguments: [],
		databases,
	};
}

const forWorkspace = { workspace: SLUG, meter: METER } as const;

function run(
	path: string,
	flags: Readonly<Record<string, string>>,
	apply = false,
): Promise<CliExtensionResult> {
	return Promise.resolve(command(path).execute(context(flags, apply)));
}

/** Whether the deployment database carries this module's schema at all. */
async function schemaPresent(): Promise<boolean> {
	const lease = await databases.acquire({
		namespace: 'metering.core',
		purpose: 'migration',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION],
		},
	});
	try {
		return await lease.database.schema.hasTable('metering_limits');
	} finally {
		await lease.release();
	}
}

async function storedLimits() {
	const runtime = createMeteringRuntime({
		databases,
		warningPercent: () => 80,
	});
	try {
		return await (await runtime.service()).limits(tenantId);
	} finally {
		await runtime.dispose();
	}
}

describe('metering CLI catalog', () => {
	/* The loader refuses a command whose implementation and catalog differ, so
	   the two files are compared here the way it compares them. */
	it('declares the same path and capability in both files', () => {
		expect(catalog.moduleId).toBe(cliExtension.moduleId);
		expect(
			catalog.commands.map((entry) => JSON.stringify(entry)).sort(),
		).toEqual(
			cliExtension.commands
				.map((entry) =>
					JSON.stringify({ path: entry.path, capability: entry.capability }),
				)
				.sort(),
		);
	});

	it('reads without --apply and treats setting a limit as a write', () => {
		expect(command('metering limits list').capability).toMatchObject({
			id: 'metering.limits.list',
			risk: 'read',
		});
		expect(command('metering limits set').capability).toMatchObject({
			id: 'metering.limits.set',
			risk: 'process',
			supportsDryRun: true,
		});
	});
});

/* A read command and a dry run reach the database before anything has
   migrated this module, and creating its tables is a write the operator did
   not ask for: they verify the ledger and stop. This suite runs first, while
   the deployment database still carries no metering schema. */
describe('metering CLI schema', () => {
	it('applies no DDL for a read command or a dry run', async () => {
		expect(await schemaPresent()).toBe(false);

		await expect(
			run('metering limits list', { workspace: SLUG }),
		).rejects.toMatchObject({ code: 'SCHEMA_NOT_MIGRATED' });
		expect(await schemaPresent()).toBe(false);

		await expect(
			run('metering limits set', { ...forWorkspace, 'monthly-limit': '10' }),
		).rejects.toMatchObject({ code: 'SCHEMA_NOT_MIGRATED' });
		expect(await schemaPresent()).toBe(false);
	});
});

describe('METERING-LIMIT-SET', () => {
	beforeAll(async () => {
		/* The platform migrates at rollout; these cases are about the command,
		   so the schema is put in place the way a deployment would. */
		await storedLimits();
	});

	it('writes nothing on a dry run, then persists the limit with the operator label and an audit event', async () => {
		const planned = await run('metering limits set', {
			...forWorkspace,
			'monthly-limit': '1000',
		});

		expect(planned.data).toMatchObject({
			applied: false,
			workspace: SLUG,
			meter: METER,
			previousLimit: null,
			monthlyLimit: 1_000,
		});
		expect(await storedLimits()).toEqual([]);

		const applied = await run(
			'metering limits set',
			{ ...forWorkspace, 'monthly-limit': '1000' },
			true,
		);

		const data = applied.data as {
			applied: boolean;
			setBy: string;
			auditEventId: string;
			previousLimit: number | null;
			monthlyLimit: number;
		};
		expect(data.applied).toBe(true);
		expect(data.monthlyLimit).toBe(1_000);
		expect(data.previousLimit).toBeNull();
		expect(data.setBy).toMatch(/^cli:/);
		expect(data.auditEventId).toMatch(/[0-9a-f-]{36}/);

		const stored = await storedLimits();
		expect(
			stored.map((limit) => [limit.meter, limit.monthlyLimit, limit.setBy]),
		).toEqual([[METER, 1_000, data.setBy]]);

		const listed = await run('metering limits list', { workspace: SLUG });
		expect(listed.data).toMatchObject({
			workspace: SLUG,
			limits: [
				{
					meter: METER,
					monthlyLimit: 1_000,
					usedThisMonth: 0,
					setBy: data.setBy,
				},
			],
		});
	});

	it('records the previous ceiling when the operator changes one', async () => {
		await run(
			'metering limits set',
			{ ...forWorkspace, 'monthly-limit': '2000' },
			true,
		);

		const raised = await run(
			'metering limits set',
			{ ...forWorkspace, 'monthly-limit': '3000' },
			true,
		);

		expect(raised.data).toMatchObject({
			previousLimit: 2_000,
			monthlyLimit: 3_000,
		});
		expect((await storedLimits()).map((limit) => limit.monthlyLimit)).toEqual([
			3_000,
		]);
	});

	it('warns that a meter this workspace has not recorded yet still takes a limit', async () => {
		const planned = await run('metering limits set', {
			workspace: SLUG,
			meter: 'workflows.core.runs',
			'monthly-limit': '10',
		});

		expect(planned.warnings?.join(' ')).toContain('workflows.core.runs');
	});

	it('refuses an unknown workspace and an unusable limit', async () => {
		await expect(
			run('metering limits set', {
				workspace: 'no-such-workspace',
				meter: METER,
				'monthly-limit': '10',
			}),
		).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

		for (const value of ['-1', '1.5', 'many']) {
			await expect(
				run('metering limits set', {
					...forWorkspace,
					'monthly-limit': value,
				}),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}
	});

	it('refuses a command that names no workspace', async () => {
		await expect(run('metering limits list', {})).rejects.toMatchObject({
			code: 'INPUT_REQUIRED',
		});
	});
});
