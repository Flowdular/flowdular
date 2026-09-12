import { spawnSync } from 'node:child_process';
import {
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
import { sqlStringLiteral } from '../src/module-templates.ts';
import { moduleLayoutIssues } from '../src/module-validate.ts';
import type { ModuleManifest } from '@flowdular/contracts';
import type { Workspace } from '../src/workspace.ts';

/* Every field type the version 2 schema knows, so the derived column types,
   row mapping and input guards are all exercised at once. */
const specification = `schemaVersion: 2
id: inventory.core
specVersion: 0.1.0
status: approved
name: Inventory Core
description: Tracks tenant-owned stock for tests.
profile: full
capabilities:
  - api
  - database
  - client
  - translations
dependencies:
  - id: auth.core
    range: ^0.10.0
tenancy: required
locales:
  - en
  - pl
permissions:
  - id: inventory.records.read
    description: Read inventory records.
  - id: inventory.records.manage
    description: Manage inventory records.
entities:
  - id: records
    name: Stock record
    fields:
      - id: sku
        type: string
        required: true
        unique: tenant
        maxLength: 64
      - id: quantity
        type: integer
        required: true
      - id: unitPrice
        type: decimal
        required: true
      - id: status
        type: enum
        required: true
        values:
          - active
          - archived
      - id: receivedAt
        type: datetime
        required: true
      - id: tracked
        type: boolean
        required: true
      - id: expiresOn
        type: date
      - id: ownerId
        type: reference
        reference: auth.core.users
      - id: attributes
        type: json
      - id: note
        type: text
    states:
      field: status
      values:
        - active
        - archived
screens:
  - id: records
    kind: list
    entity: records
    columns:
      - sku
      - quantity
      - status
`;

/* An entity with no text column at all: nothing to sort with lower(). */
const untypedOrder = `schemaVersion: 2
id: ledger.core
specVersion: 0.1.0
status: approved
name: Ledger Core
description: Records tenant-owned ledger entries for tests.
profile: headless
capabilities:
  - api
  - database
dependencies: []
tenancy: required
locales:
  - en
permissions:
  - id: ledger.entries.read
    description: Read ledger entries.
  - id: ledger.entries.manage
    description: Manage ledger entries.
entities:
  - id: entries
    name: Ledger entry
    fields:
      - id: postedOn
        type: date
        required: true
        unique: tenant
      - id: amountMinor
        type: integer
        required: true
`;

/* Exercises the scaffolded service and repository against embedded
   PostgreSQL: the service create path, and one record written straight through
   the repository so the nullable, date and JSON columns are covered too. */
const driver = `import { createPgliteTestProvider } from '@flowdular/database-testing';
import { InventoryService } from './src/services/inventory-service.ts';
import {
	DatabaseInventoryRepository,
	migrateInventoryDatabase,
} from './src/services/database-repository.ts';

const provider = createPgliteTestProvider();
const migration = await provider.acquire({
	namespace: 'inventory.core',
	purpose: 'migration',
});
try {
	await migrateInventoryDatabase(migration.database);
} finally {
	await migration.release();
}
const lease = await provider.acquire({
	namespace: 'inventory.core',
	purpose: 'test',
});
const repository = new DatabaseInventoryRepository(lease.database);
const service = new InventoryService(repository);
const input = {
	quantity: 1,
	unitPrice: '10.00',
	receivedAt: '2024-01-01T00:00:00.000Z',
	tracked: true,
};
await service.create('tenant-a', { sku: 'Alpha', ...input });
await service.create('tenant-b', { sku: 'Beta', ...input });
await repository.create({
	id: 'full-1',
	tenantId: 'tenant-a',
	sku: 'Full',
	quantity: 7,
	unitPrice: '3.50',
	status: 'archived',
	receivedAt: '2024-03-04T05:06:07.000Z',
	expiresOn: '2025-01-31',
	tracked: false,
	ownerId: 'user-1',
	attributes: { color: 'red', size: 2 },
	note: 'hello',
	createdAt: 1700000000000,
});
console.log(
	JSON.stringify({
		a: await service.list('tenant-a'),
		b: await service.list('tenant-b'),
	}),
);
await lease.release();
await provider.dispose();
`;

const specPath = 'modules/inventory/spec/module.yaml';

async function workspace(
	source = specification,
	directory = 'inventory',
): Promise<Workspace> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-scaffold-v2-'));
	await mkdir(join(root, `modules/${directory}/spec`), { recursive: true });
	await writeFile(join(root, `modules/${directory}/spec/module.yaml`), source);
	await writeFile(join(root, 'flowdular.json'), '{}\n');
	return { root, configPath: join(root, 'flowdular.json'), config: {} };
}

async function read(root: string, path: string): Promise<string> {
	return readFile(join(root, 'modules/inventory', path), 'utf8');
}

describe('module scaffolding from a version 2 specification', () => {
	/* The schema keeps a quote out of an enum value, so this is the second line
	   of defence for the CHECK constraint of an immutable migration. */
	it('doubles a single quote inside a SQL string literal', () => {
		expect(sqlStringLiteral('archived')).toBe("'archived'");
		expect(sqlStringLiteral("arch'ived")).toBe("'arch''ived'");
		expect(sqlStringLiteral("a','b'); DROP TABLE t; --")).toBe(
			"'a'',''b''); DROP TABLE t; --'",
		);
	});

	it('derives the domain, the table, the repository, the endpoint and the list', async () => {
		const ws = await workspace();
		try {
			await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});

			const types = await read(ws.root, 'src/domain/types.ts');
			expect(types).toContain('readonly sku: string;');
			expect(types).toContain('readonly quantity: number;');
			expect(types).toContain('readonly unitPrice: string;');
			expect(types).toContain("readonly status: 'active' | 'archived';");
			expect(types).toContain('readonly tracked: boolean;');
			expect(types).toContain('readonly expiresOn: string | null;');
			expect(types).toContain(
				'readonly attributes: Record<string, unknown> | null;',
			);
			/* The lifecycle field is service state, never create input. */
			expect(types).toContain(
				'export interface CreateInventoryRecordInput {\n\treadonly sku: string;',
			);
			expect(types.split('CreateInventoryRecordInput')[1]).not.toContain(
				'status',
			);

			const sql = await read(ws.root, 'migrations/0001_inventory_core.up.sql');
			expect(sql).toContain('sku TEXT NOT NULL,');
			expect(sql).toContain('quantity BIGINT NOT NULL,');
			expect(sql).toContain('unit_price NUMERIC NOT NULL,');
			expect(sql).toContain(
				"status TEXT NOT NULL CHECK (status IN ('active', 'archived')),",
			);
			expect(sql).toContain('received_at TIMESTAMPTZ NOT NULL,');
			expect(sql).toContain('tracked BOOLEAN NOT NULL,');
			expect(sql).toContain('expires_on DATE,');
			expect(sql).toContain('owner_id TEXT,');
			expect(sql).toContain('attributes JSONB,');
			expect(sql).toContain('note TEXT,');
			expect(sql).toContain('UNIQUE (tenant_id, sku)');
			expect(sql).toContain('inventory_records_tenant_sku_idx');
			/* Tenant isolation stays exactly as the version 1 scaffold writes it. */
			expect(sql).toContain(
				'ALTER TABLE inventory_records FORCE ROW LEVEL SECURITY;',
			);
			expect(await read(ws.root, 'src/services/migration.ts')).toContain(
				"'inventory_records_tenant_sku_idx'",
			);

			const repository = await read(
				ws.root,
				'src/services/database-repository.ts',
			);
			expect(repository).toContain('quantity: number | bigint | string;');
			expect(repository).toContain("status: InventoryRecord['status'];");
			expect(repository).toContain('received_at: Date | string;');
			/* A DATE is read as text: the drivers build different Dates from it. */
			expect(repository).toContain('expires_on: string | null;');
			expect(repository).toContain('expires_on::text AS expires_on');
			expect(repository).toContain('expiresOn: row.expires_on,');
			expect(repository).toContain('quantity: whole(row.quantity),');
			expect(repository).toContain('receivedAt: isoText(row.received_at),');
			expect(repository).toContain('ORDER BY lower(sku), id');
			/* A statement parameter is text, a number or null. */
			expect(repository).toContain('String(record.tracked),');
			expect(repository.replace(/\s+/g, ' ')).toContain(
				'record.attributes === null ? null : JSON.stringify(record.attributes)',
			);

			const endpoints = await read(ws.root, 'src/api/endpoints.ts');
			expect(endpoints).toContain(
				"sku: requiredString(value, 'sku', { min: 1, max: 64 })",
			);
			expect(endpoints).toContain(
				"quantity: requiredInteger(value, 'quantity')",
			);
			expect(endpoints).toContain("tracked: flag(value, 'tracked')");
			expect(endpoints).toContain('HttpProblem');
			/* The create input carries no optional field and no lifecycle field. */
			expect(endpoints).not.toContain("'status'");
			expect(endpoints).not.toContain("'note'");

			const view = await read(ws.root, 'src/client/InventoryView.tsrx');
			expect(view).toContain("key: 'sku'");
			expect(view).toContain("header: t('inventory.table.column.quantity')");
			expect(view).toContain('numeric: true');
			expect(view).toContain(
				"cell: (record) => t('inventory.status.' + record.status)",
			);
			expect(view).not.toContain('record.note');

			const en = JSON.parse(
				await read(ws.root, 'translations/en.json'),
			) as Record<string, string>;
			const pl = JSON.parse(
				await read(ws.root, 'translations/pl.json'),
			) as Record<string, string>;
			expect(en['table.column.sku']).toBe('Sku');
			expect(en['table.column.quantity']).toBe('Quantity');
			expect(en['status.archived']).toBe('Archived');
			/* Every locale keeps the same key set or module validate fails. */
			expect(Object.keys(pl)).toEqual(Object.keys(en));

			const test = await read(ws.root, 'tests/module.test.ts');
			expect(test).toContain("unitPrice: '10.00'");
			expect(test).toContain("receivedAt: '2024-01-01T00:00:00.000Z'");
			expect(test).toContain('quantity: 1');
			expect(test).toContain('(record) => record.sku');

			/* Derived column headers are translation keys, so the module layout
			   gate is what proves every one of them exists. */
			const manifest = JSON.parse(
				await read(ws.root, 'module.json'),
			) as ModuleManifest;
			expect(
				await moduleLayoutIssues(join(ws.root, 'modules/inventory'), manifest, {
					projectLocales: ['en', 'pl'],
				}),
			).toEqual([]);
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('orders by id when the entity has no column PostgreSQL can lower()', async () => {
		const ws = await workspace(untypedOrder, 'ledger');
		try {
			await scaffoldModule(ws, {
				id: 'ledger.core',
				specPath: 'modules/ledger/spec/module.yaml',
				apply: true,
			});
			const module = join(ws.root, 'modules/ledger');
			const repository = await readFile(
				join(module, 'src/services/database-repository.ts'),
				'utf8',
			);
			/* lower(date) and lower(numeric) do not exist in PostgreSQL. */
			expect(repository).not.toContain('lower(');
			expect(repository).toContain('ORDER BY id');
			const sql = await readFile(
				join(module, 'migrations/0001_ledger_core.up.sql'),
				'utf8',
			);
			expect(sql).toContain('posted_on DATE NOT NULL,');
			expect(sql).toContain('ledger_entries_tenant_id_idx');
			expect(sql).toContain('ON ledger_entries (tenant_id, id);');
			const test = await readFile(join(module, 'tests/module.test.ts'), 'utf8');
			expect(test).toContain("postedOn: '2024-01-01'");
			expect(test).toContain('.length).toEqual(1)');
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('reads and writes every derived column against PostgreSQL', async () => {
		/* The generated module imports @flowdular/database by name, so it is
		   scaffolded inside this package's dependency tree: that is the only
		   place where its imports resolve without an install. */
		const root = await mkdtemp(
			join(resolve('node_modules'), '.flowdular-roundtrip-'),
		);
		try {
			await mkdir(join(root, 'modules/inventory/spec'), { recursive: true });
			await writeFile(join(root, specPath), specification);
			await writeFile(join(root, 'flowdular.json'), '{}\n');
			await scaffoldModule(
				{ root, configPath: join(root, 'flowdular.json'), config: {} },
				{ id: 'inventory.core', specPath, apply: true },
			);
			const module = join(root, 'modules/inventory');
			await writeFile(join(module, 'roundtrip.mts'), driver);
			const run = spawnSync(
				resolve('node_modules/.bin/tsx'),
				[join(module, 'roundtrip.mts')],
				/* A timezone far from UTC: a date column must not shift a day. */
				{ encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } },
			);
			expect(run.status, run.stderr).toBe(0);
			const listed = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as {
				a: Record<string, unknown>[];
				b: Record<string, unknown>[];
			};

			expect(listed.b.map((record) => record.sku)).toEqual(['Beta']);
			expect(listed.a.map((record) => record.sku)).toEqual(['Alpha', 'Full']);
			expect(listed.a[1]).toMatchObject({
				sku: 'Full',
				quantity: 7,
				unitPrice: '3.50',
				status: 'archived',
				receivedAt: '2024-03-04T05:06:07.000Z',
				/* The day must survive both drivers and the local timezone. */
				expiresOn: '2025-01-31',
				tracked: false,
				ownerId: 'user-1',
				attributes: { color: 'red', size: 2 },
				note: 'hello',
			});
			expect(listed.a[0]).toMatchObject({ status: 'active', tracked: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);

	it('derives TypeScript that compiles under the module compiler options', async () => {
		const ws = await workspace();
		try {
			await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});
			/* The real path, or tsc reports its own diagnostics relative to a
			   symlinked temporary directory and the filter below misses them. */
			const moduleRoot = await realpath(join(ws.root, 'modules/inventory'));
			/* The scaffolded tsconfig extends a workspace file the temporary
			   directory has no copy of, and only the platform-free half of the
			   module is compiled here: it needs no module resolution beyond the
			   database contract. */
			await writeFile(
				join(moduleRoot, 'tsconfig.check.json'),
				JSON.stringify({
					compilerOptions: {
						target: 'ES2022',
						module: 'ESNext',
						moduleResolution: 'Bundler',
						allowImportingTsExtensions: true,
						strict: true,
						noEmit: true,
						skipLibCheck: true,
						noUncheckedIndexedAccess: true,
						exactOptionalPropertyTypes: true,
						verbatimModuleSyntax: true,
						types: ['node'],
						typeRoots: [resolve('node_modules/@types')],
						baseUrl: '.',
						paths: {
							'@flowdular/database': [resolve('../database/src/index.ts')],
						},
					},
					include: ['src/domain/**/*.ts', 'src/services/**/*.ts'],
				}),
			);
			const result = spawnSync(
				process.execPath,
				[
					resolve('node_modules/typescript/bin/tsc'),
					'--noEmit',
					'-p',
					join(moduleRoot, 'tsconfig.check.json'),
				],
				/* Run inside the module so its own diagnostics print as src/… */
				{ encoding: 'utf8', cwd: moduleRoot },
			);
			expect(result.error, 'tsc did not run').toBeUndefined();
			/* Only the generated files are this test's business: the database
			   contract is compiled from source and may carry its own errors. */
			const own = result.stdout
				.split('\n')
				.filter((line) => line.startsWith('src/'));
			expect(own, result.stdout).toEqual([]);
			expect(
				result.status === 0 || result.stdout.includes('error TS'),
				result.stderr,
			).toBe(true);
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	}, 60_000);

	it('writes files the workspace format gate accepts', async () => {
		const ws = await workspace();
		try {
			const result = await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});
			expect(result.formatted).toBe(true);
			const formatter = await loadWorkspaceFormatter(ws.root);
			for (const path of result.files) {
				const absolute = join(ws.root, path);
				const source = await readFile(absolute, 'utf8');
				expect(await formatter!.format(absolute, source), path).toBe(source);
			}
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});
});
