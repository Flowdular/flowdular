import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { validateModuleSpec } from '../src/validation.ts';

const version1 = {
	schemaVersion: 1,
	id: 'inventory.core',
	specVersion: '0.1.0',
	status: 'approved',
	name: 'Inventory Core',
	description: 'Tracks tenant-owned stock for tests.',
	profile: 'full',
	capabilities: ['api', 'database', 'client', 'translations'],
	dependencies: [{ id: 'auth.core', range: '^0.10.0' }],
	tenancy: 'required',
	locales: ['en', 'pl'],
	permissions: [
		{ id: 'inventory.records.read', description: 'Read inventory records.' },
		{
			id: 'inventory.records.manage',
			description: 'Manage inventory records.',
		},
	],
};

const version2 = {
	...version1,
	schemaVersion: 2,
	entities: [
		{
			id: 'records',
			name: 'Stock record',
			fields: [
				{
					id: 'sku',
					type: 'string',
					required: true,
					unique: 'tenant',
					maxLength: 64,
				},
				{ id: 'quantity', type: 'integer', required: true },
				{
					id: 'status',
					type: 'enum',
					required: true,
					values: ['active', 'archived'],
				},
				{ id: 'ownerId', type: 'reference', reference: 'auth.core.users' },
			],
			states: { field: 'status', values: ['active', 'archived'] },
		},
	],
	screens: [
		{
			id: 'records',
			kind: 'list',
			entity: 'records',
			columns: ['sku', 'quantity', 'status'],
			filters: ['status'],
		},
	],
	actions: [
		{
			id: 'create-record',
			entity: 'records',
			permission: 'inventory.records.manage',
			kind: 'create',
			risk: 'workspace-write',
			idempotent: false,
			description: 'Create a stock record.',
		},
	],
	widgets: [
		{
			id: 'stock-total',
			slot: 'dashboard.metrics',
			entity: 'records',
			description: 'Total stock held by the tenant.',
		},
	],
	settings: [
		{
			key: 'lowStockThreshold',
			type: 'integer',
			scope: 'tenant',
			default: 5,
			description: 'Quantity below which a record counts as low stock.',
		},
	],
	agentTools: [
		{
			id: 'inventory.record.list',
			permission: 'inventory.records.read',
			description: 'List stock records of the active tenant.',
			risk: 'read',
		},
	],
	outOfScope: ['file attachments'],
	decisions: [
		{
			id: 'INV-ARCHIVE',
			question: 'Who may archive a record?',
			answer: 'Only a principal with the manage permission.',
			decidedBy: 'user',
		},
	],
};

const root = await mkdtemp(join(tmpdir(), 'flowdular-spec-'));
let counter = 0;

afterAll(() => rm(root, { recursive: true, force: true }));

async function report(spec: unknown) {
	const path = join(root, `module-${counter++}.yaml`);
	await writeFile(path, stringifyYaml(spec));
	return validateModuleSpec(path);
}

function codes(issues: readonly { code: string; severity: string }[]) {
	return issues.map((issue) => `${issue.severity}:${issue.code}`).sort();
}

/* A deep clone the cases mutate; structuredClone keeps every case independent. */
function draft(): Record<string, unknown> {
	return structuredClone(version2) as Record<string, unknown>;
}

describe('module specification validation', () => {
	it('accepts a version 1 specification and rejects the version 2 sections in it', async () => {
		expect(await report(version1)).toMatchObject({ valid: true, issues: [] });

		const mixed = await report({ ...version1, entities: version2.entities });
		expect(mixed.valid).toBe(false);
		expect(mixed.issues).toContainEqual({
			code: 'SCHEMA_FALSE_SCHEMA',
			message: 'boolean schema is false',
			path: '/entities',
			severity: 'error',
		});
	});

	it('accepts a complete version 2 domain model', async () => {
		expect(await report(version2)).toMatchObject({ valid: true, issues: [] });
	});

	it('reports an action permission the specification does not declare', async () => {
		const spec = draft();
		(spec.actions as { permission: string }[])[0]!.permission =
			'inventory.records.approve';
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual([
			'error:SPEC_ACTION_PERMISSION_UNKNOWN',
		]);
		expect(result.issues[0]?.path).toBe('/actions/0/permission');
	});

	it('reports unknown entities on screens, actions and widgets', async () => {
		const spec = draft();
		(spec.screens as { entity: string }[])[0]!.entity = 'orders';
		(spec.actions as { entity: string }[])[0]!.entity = 'orders';
		(spec.widgets as { entity: string }[])[0]!.entity = 'orders';
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual([
			'error:SPEC_ENTITY_UNKNOWN',
			'error:SPEC_ENTITY_UNKNOWN',
			'error:SPEC_ENTITY_UNKNOWN',
		]);
		expect(result.issues.map((issue) => issue.path)).toEqual([
			'/screens/0/entity',
			'/actions/0/entity',
			'/widgets/0/entity',
		]);
	});

	it('reports screen columns and filters that are not fields of the entity', async () => {
		const spec = draft();
		(spec.screens as { columns: string[]; filters: string[] }[])[0]!.columns = [
			'sku',
			'price',
		];
		(spec.screens as { columns: string[]; filters: string[] }[])[0]!.filters = [
			'warehouse',
		];
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual([
			'error:SPEC_FIELD_UNKNOWN',
			'error:SPEC_FIELD_UNKNOWN',
		]);
		expect(result.issues.map((issue) => issue.path)).toEqual([
			'/screens/0/columns/1',
			'/screens/0/filters/0',
		]);
	});

	it('reports a reference that names no entity of this specification or a dependency', async () => {
		const local = draft();
		const fields = (
			local.entities as { fields: { reference?: string }[] }[]
		)[0]!.fields;
		fields[3]!.reference = 'records';
		expect(await report(local)).toMatchObject({ valid: true });

		const foreign = draft();
		(
			foreign.entities as { fields: { reference?: string }[] }[]
		)[0]!.fields[3]!.reference = 'billing.core.invoices';
		const result = await report(foreign);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_REFERENCE_UNKNOWN']);
		expect(result.issues[0]?.path).toBe('/entities/0/fields/3/reference');
	});

	it('reports an enum field without values', async () => {
		const spec = draft();
		const fields = (spec.entities as { fields: { values?: string[] }[] }[])[0]!
			.fields;
		delete fields[2]!.values;
		const result = await report(spec);
		expect(result.valid).toBe(false);
		/* The lifecycle values now describe members the field no longer has. */
		expect(codes(result.issues)).toEqual([
			'error:SPEC_ENUM_VALUES_REQUIRED',
			'error:SPEC_STATE_FIELD_INVALID',
		]);
		expect(
			result.issues.find((issue) => issue.code === 'SPEC_ENUM_VALUES_REQUIRED')
				?.path,
		).toBe('/entities/0/fields/2/values');
	});

	it('requires an entity when the database capability is declared', async () => {
		const spec = draft();
		delete spec.entities;
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toContain('error:SPEC_ENTITY_REQUIRED');

		const headless = draft();
		delete headless.entities;
		headless.capabilities = ['api', 'client', 'translations'];
		expect(codes((await report(headless)).issues)).not.toContain(
			'error:SPEC_ENTITY_REQUIRED',
		);
	});

	it('reports a field the scaffold owns and a lifecycle field that does not exist', async () => {
		const spec = draft();
		const entity = (
			spec.entities as {
				fields: { id: string }[];
				states: { field: string };
			}[]
		)[0]!;
		entity.fields[3]!.id = 'createdAt';
		entity.states.field = 'phase';
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual([
			'error:SPEC_FIELD_RESERVED',
			'error:SPEC_FIELD_UNKNOWN',
		]);
		expect(result.issues.map((issue) => issue.path)).toEqual([
			'/entities/0/states/field',
			'/entities/0/fields/3/id',
		]);
	});

	it('reports a field id PostgreSQL cannot use as a column', async () => {
		const spec = draft();
		/* Generated SQL quotes no identifier, so "order BIGINT NOT NULL" would
		   be a migration that does not parse. */
		(spec.entities as { fields: { id: string }[] }[])[0]!.fields[1]!.id =
			'order';
		(spec.screens as { columns: string[] }[])[0]!.columns = ['sku', 'status'];
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_FIELD_RESERVED']);
		expect(result.issues[0]?.message).toContain('reserved word');
	});

	it('reports a field id that snake-cases into a reserved word', async () => {
		const spec = draft();
		/* snakeCase turns "currentUser" into the reserved current_user, so the
		   column would be refused by PostgreSQL even though the id is one word. */
		(spec.entities as { fields: { id: string }[] }[])[0]!.fields[3]!.id =
			'currentUser';
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_FIELD_RESERVED']);
		expect(result.issues[0]?.path).toBe('/entities/0/fields/3/id');
		expect(result.issues[0]?.message).toContain('reserved word');
	});

	it('reports a field id that snake-cases into a reserved word added in PostgreSQL 16', async () => {
		const spec = draft();
		(spec.entities as { fields: { id: string }[] }[])[0]!.fields[3]!.id =
			'systemUser';
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_FIELD_RESERVED']);
	});

	it('refuses an enum value that would not survive a SQL string literal', async () => {
		const spec = draft();
		/* The value is interpolated into the CHECK constraint of an immutable
		   migration, so the schema keeps it to characters a literal can carry. */
		const entity = (
			spec.entities as {
				fields: { values?: string[] }[];
				states: { values: string[] };
			}[]
		)[0]!;
		entity.fields[2]!.values = ['active', "arch'ived"];
		entity.states.values = ['active', "arch'ived"];
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual([
			'error:SCHEMA_PATTERN',
			'error:SCHEMA_PATTERN',
		]);
		expect(result.issues.map((issue) => issue.path).sort()).toEqual([
			'/entities/0/fields/2/values/1',
			'/entities/0/states/values/1',
		]);
	});

	it('resolves a reference qualified with the module id of this specification', async () => {
		const local = draft();
		(
			local.entities as { fields: { reference?: string }[] }[]
		)[0]!.fields[3]!.reference = 'inventory.core.records';
		expect(await report(local)).toMatchObject({ valid: true });

		const missing = draft();
		(
			missing.entities as { fields: { reference?: string }[] }[]
		)[0]!.fields[3]!.reference = 'inventory.core.orders';
		const result = await report(missing);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_REFERENCE_UNKNOWN']);
		expect(result.issues[0]?.path).toBe('/entities/0/fields/3/reference');
	});

	it('keeps its own source readable as text', async () => {
		/* A literal NUL byte anywhere in the file makes git treat it as binary
		   and stops printing a diff for it. */
		const source = await readFile(
			new URL('../src/validation.ts', import.meta.url),
			'utf8',
		);
		expect(source.includes(String.fromCharCode(0))).toBe(false);
	});

	it('requires the lifecycle field to be the enum that declares its values', async () => {
		const integer = draft();
		const entity = (
			integer.entities as {
				fields: { id: string; type: string; values?: string[] }[];
				states: { field: string; values: string[] };
			}[]
		)[0]!;
		entity.states.field = 'quantity';
		const wrongType = await report(integer);
		expect(wrongType.valid).toBe(false);
		expect(codes(wrongType.issues)).toEqual(['error:SPEC_STATE_FIELD_INVALID']);
		expect(wrongType.issues[0]?.message).toContain('must be an enum');

		const drifted = draft();
		(drifted.entities as { states: { values: string[] } }[])[0]!.states.values =
			['draft', 'sent'];
		const result = await report(drifted);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_STATE_FIELD_INVALID']);
		expect(result.issues[0]?.path).toBe('/entities/0/states/values');
	});

	it('reports an enum setting without values', async () => {
		const spec = draft();
		const settings = (spec.settings as Record<string, unknown>[])[0]!;
		settings.type = 'enum';
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_ENUM_VALUES_REQUIRED']);
		expect(result.issues[0]?.path).toBe('/settings/0/values');
	});

	it('reports duplicate ids inside a section and inside an entity', async () => {
		const spec = draft();
		const screens = spec.screens as Record<string, unknown>[];
		screens.push({ ...screens[0]!, kind: 'form' });
		const result = await report(spec);
		expect(result.valid).toBe(false);
		expect(codes(result.issues)).toEqual(['error:SPEC_DUPLICATE_ID']);
		expect(result.issues[0]?.path).toBe('/screens/1/id');

		/* Two fields under one id would become two identical columns. */
		const twice = draft();
		const entity = (
			twice.entities as { fields: Record<string, unknown>[] }[]
		)[0]!;
		entity.fields.push({ ...entity.fields[1]!, type: 'text' });
		const duplicate = await report(twice);
		expect(duplicate.valid).toBe(false);
		expect(codes(duplicate.issues)).toEqual(['error:SPEC_DUPLICATE_ID']);
		expect(duplicate.issues[0]?.path).toBe('/entities/0/fields/4/id');
	});

	it('warns about a client without screens and an entity without a tenant-unique field', async () => {
		const spec = draft();
		delete spec.screens;
		const fields = (spec.entities as { fields: { unique?: string }[] }[])[0]!
			.fields;
		delete fields[0]!.unique;
		const result = await report(spec);
		/* Warnings describe an incomplete specification, not an invalid one. */
		expect(result.valid).toBe(true);
		expect(codes(result.issues)).toEqual([
			'warning:SPEC_ENTITY_UNIQUE_MISSING',
			'warning:SPEC_SCREENS_MISSING',
		]);
	});

	/* A workspace view is built from any screen the client renders on its own,
	   not from a list in particular, so a record or dashboard screen answers
	   the client capability the same way. */
	it('accepts a record or a dashboard as the screen a client renders', async () => {
		for (const kind of ['list', 'record', 'dashboard']) {
			const spec = draft();
			(spec.screens as Record<string, unknown>[])[0]!.kind = kind;
			expect([kind, codes((await report(spec)).issues)]).toEqual([kind, []]);
		}
	});

	/* A form is the drawer of another screen, so it is not one on its own. */
	it('still warns when a client declares only a form screen', async () => {
		const spec = draft();
		(spec.screens as Record<string, unknown>[])[0]!.kind = 'form';
		expect(codes((await report(spec)).issues)).toEqual([
			'warning:SPEC_SCREENS_MISSING',
		]);
	});
});
