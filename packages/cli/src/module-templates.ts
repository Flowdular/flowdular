import type { ModuleSpec } from '@flowdular/contracts';

export interface ScaffoldNames {
	readonly id: string;
	readonly suffix: string;
	readonly packageName: string;
	readonly namespace: string;
	readonly constant: string;
	readonly pascal: string;
	readonly camel: string;
	readonly snake: string;
}

interface ScaffoldEntity {
	readonly plural: string;
	readonly type: string;
	readonly table: string;
}

interface ScaffoldPermission {
	readonly id: string;
	readonly key: string;
	readonly primary: boolean;
	readonly action: string;
}

interface ScaffoldModel {
	readonly spec: ModuleSpec;
	readonly names: ScaffoldNames;
	readonly entity: ScaffoldEntity;
	readonly permissions: readonly ScaffoldPermission[];
	/* Primary read permission: guards navigation and, with api, the list route. */
	readonly readPermission: ScaffoldPermission | undefined;
	readonly listPermission: ScaffoldPermission | undefined;
	readonly createPermission: ScaffoldPermission | undefined;
	readonly hasApi: boolean;
	readonly hasClient: boolean;
	readonly hasDatabase: boolean;
	readonly hasCli: boolean;
}

export function packageSuffix(id: string): string {
	const parts = id.split('.');
	return (parts.at(-1) === 'core' ? parts.slice(0, -1) : parts).join('-');
}

function pascalCase(value: string): string {
	return value
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join('');
}

function camelCase(value: string): string {
	const pascal = pascalCase(value);
	return pascal[0]!.toLowerCase() + pascal.slice(1);
}

function singular(word: string): string {
	if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
	if (/(ss|us|is)$/.test(word)) return word;
	if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
	if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
	return word;
}

export function scaffoldNames(id: string): ScaffoldNames {
	const suffix = packageSuffix(id);
	return {
		id,
		suffix,
		packageName: `@flowdular/module-${suffix}`,
		namespace: id.split('.')[0]!,
		constant: suffix.replace(/-/g, '_').toUpperCase(),
		pascal: pascalCase(suffix),
		camel: camelCase(suffix),
		snake: suffix.replace(/-/g, '_'),
	};
}

function stringLiteral(value: string): string {
	const json = JSON.stringify(value);
	if (value.includes("'") && !value.includes('"')) return json;
	return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

const PRINT_WIDTH = 80;
const TAB_WIDTH = 2;

/* Mirrors how Prettier prints JSON with tabs: objects always break, arrays of
   primitives stay on one line while they fit, so manifests pass the format
   gate even when no formatter is available. */
function jsonValue(value: unknown, depth: number, prefixWidth: number): string {
	const indent = '\t'.repeat(depth + 1);
	const closing = '\t'.repeat(depth);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const primitives = value.every(
			(item) => item === null || typeof item !== 'object',
		);
		if (primitives) {
			const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
			if (depth * TAB_WIDTH + prefixWidth + inline.length + 1 <= PRINT_WIDTH) {
				return inline;
			}
		}
		return `[\n${value
			.map((item) => `${indent}${jsonValue(item, depth + 1, 0)}`)
			.join(',\n')}\n${closing}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value).filter(
			([, item]) => item !== undefined,
		);
		if (entries.length === 0) return '{}';
		return `{\n${entries
			.map(([key, item]) => {
				const prefix = `${JSON.stringify(key)}: `;
				return `${indent}${prefix}${jsonValue(item, depth + 1, prefix.length)}`;
			})
			.join(',\n')}\n${closing}}`;
	}
	return JSON.stringify(value);
}

function json(value: unknown): string {
	return `${jsonValue(value, 0, 0)}\n`;
}

function clientLocales(spec: ModuleSpec): readonly string[] {
	return [...new Set(['en', ...spec.locales])];
}

function translationVariable(locale: string): string {
	return `translations${pascalCase(locale)}`;
}

function translationImports(spec: ModuleSpec): string {
	return clientLocales(spec)
		.map(
			(locale) =>
				`import ${translationVariable(locale)} from '../../translations/${locale}.json';`,
		)
		.join('\n');
}

function translationRegistry(spec: ModuleSpec): string {
	return `{ ${clientLocales(spec)
		.map(
			(locale) => `${JSON.stringify(locale)}: ${translationVariable(locale)}`,
		)
		.join(', ')} }`;
}

const DEFAULT_ENTITY = 'records';

function buildModel(spec: ModuleSpec): ScaffoldModel {
	const names = scaffoldNames(spec.id);
	const declared = spec.permissions ?? [];
	const entityOf = (id: string): string | null => {
		const segments = id.split('.');
		return segments.length >= 3 ? segments[segments.length - 2]! : null;
	};
	const plural =
		declared.map((permission) => entityOf(permission.id)).find(Boolean) ??
		DEFAULT_ENTITY;
	const entity: ScaffoldEntity = {
		plural,
		type: `${pascalCase(names.namespace)}${pascalCase(singular(plural))}`,
		table: `${names.snake}_${plural.replace(/-/g, '_')}`,
	};
	const keys = new Map<string, string>();
	const permissions = declared.map((permission): ScaffoldPermission => {
		const segments = permission.id.split('.');
		const action = segments[segments.length - 1]!;
		const owner = entityOf(permission.id);
		const primary = owner === null || owner === plural;
		const key = primary ? camelCase(action) : camelCase(`${owner}-${action}`);
		const previous = keys.get(key);
		if (previous) {
			throw new Error(
				`Permissions "${previous}" and "${permission.id}" both map to the constant key "${key}".`,
			);
		}
		keys.set(key, permission.id);
		return { id: permission.id, key, primary, action };
	});
	const hasApi = spec.capabilities.includes('api');
	const readPermission = permissions.find(
		(permission) => permission.primary && permission.action === 'read',
	);
	return {
		spec,
		names,
		entity,
		permissions,
		readPermission,
		listPermission: hasApi ? readPermission : undefined,
		createPermission: hasApi
			? permissions.find(
					(permission) => permission.primary && permission.action === 'manage',
				)
			: undefined,
		hasApi,
		hasClient: spec.capabilities.includes('client'),
		hasDatabase: spec.capabilities.includes('database'),
		hasCli: spec.capabilities.includes('cli'),
	};
}

function manifest(model: ScaffoldModel): string {
	const { spec, names, hasApi, hasClient, hasCli } = model;
	return json({
		$schema: '../../packages/contracts/schemas/module.schema.json',
		schemaVersion: 1,
		id: spec.id,
		package: names.packageName,
		version: spec.specVersion,
		profile: spec.profile,
		capabilities: spec.capabilities,
		...(hasApi || hasClient
			? {
					platform: {
						...(hasApi ? { server: true } : {}),
						...(hasClient ? { client: true } : {}),
					},
				}
			: {}),
		dependencies: spec.dependencies,
		tenancy: spec.tenancy,
		locales: spec.locales,
		stability: 'experimental',
		...(hasCli
			? {
					cli: {
						catalog: 'src/cli/commands.json',
						entry: 'src/cli/index.ts',
					},
				}
			: {}),
	});
}

function packageJson(model: ScaffoldModel): string {
	const { spec, names, hasApi, hasClient, hasDatabase, hasCli } = model;
	return json({
		name: names.packageName,
		version: spec.specVersion,
		private: true,
		type: 'module',
		exports: {
			'.': './src/index.ts',
			...(hasClient ? { './client': './src/client/index.ts' } : {}),
			...(hasApi
				? {
						'./server': './src/server/index.ts',
						'./platform': './src/platform.ts',
					}
				: {}),
		},
		scripts: {
			typecheck: hasClient
				? 'tsrx-tsc --noEmit -p tsconfig.json'
				: 'tsc --noEmit -p tsconfig.json',
			test: 'vitest run',
		},
		dependencies: {
			...(hasCli ? { '@flowdular/cli-protocol': 'workspace:*' } : {}),
			...(hasClient ? { '@flowdular/client': 'workspace:*' } : {}),
			'@flowdular/contracts': 'workspace:*',
			...(hasDatabase ? { '@flowdular/database': 'workspace:*' } : {}),
			...(hasApi
				? {
						'@flowdular/module-auth': 'workspace:*',
						'@flowdular/server': 'workspace:*',
					}
				: {}),
			...(hasClient
				? {
						'@flowdular/ui': 'workspace:*',
						octane: '0.1.51',
						'segment-state': '0.2.0',
					}
				: {}),
		},
		devDependencies: {
			...(hasDatabase ? { '@flowdular/database-testing': 'workspace:*' } : {}),
			...(hasClient ? { '@tsrx/typescript-plugin': '0.3.120' } : {}),
			'@types/node': '24.13.3',
			typescript: '5.9.3',
			vitest: '4.1.11',
		},
	});
}

function tsconfig(model: ScaffoldModel): string {
	return json({
		extends: '../../tsconfig.base.json',
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'Bundler',
			allowImportingTsExtensions: true,
			...(model.hasClient
				? {
						isolatedModules: true,
						jsx: 'react-jsx',
						jsxImportSource: 'octane',
					}
				: {}),
			types: ['node'],
			...(model.hasClient
				? { plugins: [{ name: '@tsrx/typescript-plugin' }] }
				: {}),
		},
		include: ['src/**/*', 'tests/**/*.ts'],
	});
}

function moduleIndex(model: ScaffoldModel): string {
	const { names, entity, spec, hasClient, readPermission } = model;
	const permissionsConstant = `${names.constant}_PERMISSIONS`;
	const navigation =
		hasClient && readPermission
			? `[
		{
			id: '${names.suffix}.navigation',
			label: ${stringLiteral(spec.name)},
			href: '/${names.suffix}',
			order: 50,
			permission: ${permissionsConstant}.${readPermission.key},
		},
	]`
			: '[]';
	return `import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { ${permissionsConstant} } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: ${navigation},
	permissions: Object.values(${permissionsConstant}),
} satisfies RegisteredModule;

export { ${permissionsConstant} } from './acl/permissions.ts';
export {
	${names.pascal}Service,
	${names.pascal}ServiceError,
} from './services/${names.suffix}-service.ts';
export type {
	Create${entity.type}Input,
	${entity.type},
} from './domain/types.ts';
`;
}

function permissionsFile(model: ScaffoldModel): string {
	const { names, permissions } = model;
	const constant = `${names.constant}_PERMISSIONS`;
	const entries = permissions
		.map((permission) => `\t${permission.key}: '${permission.id}',\n`)
		.join('');
	const object = entries.length === 0 ? '{}' : `{\n${entries}}`;
	return `export const ${constant} = ${object} as const;

export const permissions = Object.freeze(Object.values(${constant}));
`;
}

function domainTypes(model: ScaffoldModel): string {
	const { entity } = model;
	return `export interface ${entity.type} {
	readonly id: string;
	readonly tenantId: string;
	readonly name: string;
	readonly status: 'active' | 'archived';
	readonly createdAt: number;
}

export interface Create${entity.type}Input {
	readonly name: string;
}
`;
}

function repositoryFile(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import type { ${entity.type} } from '../domain/types.ts';

export interface ${names.pascal}Repository {
	list(tenantId: string): Promise<readonly ${entity.type}[]>;
	create(record: ${entity.type}): Promise<${entity.type}>;
}
`;
}

function serviceFile(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import { randomUUID } from 'node:crypto';
import type { Create${entity.type}Input, ${entity.type} } from '../domain/types.ts';
import type { ${names.pascal}Repository } from './repository.ts';

export class ${names.pascal}ServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = '${names.pascal}ServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new ${names.pascal}ServiceError(
			'INVALID_INPUT',
			\`\${field} must contain between \${min} and \${max} characters.\`,
		);
	}
	return normalized;
}

export class ${names.pascal}Service {
	constructor(private readonly repository: ${names.pascal}Repository) {}

	list(tenantId: string): Promise<readonly ${entity.type}[]> {
		return this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	create(
		tenantId: string,
		input: Create${entity.type}Input,
	): Promise<${entity.type}> {
		return this.repository.create({
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			name: bounded(input.name, 'name', 2, 160),
			status: 'active',
			createdAt: Date.now(),
		});
	}
}
`;
}

function migrationSql(model: ScaffoldModel): string {
	const { entity } = model;
	return `CREATE TABLE IF NOT EXISTS ${entity.table} (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${entity.table}_tenant_name_idx
  ON ${entity.table} (tenant_id, name, id);
ALTER TABLE ${entity.table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${entity.table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${entity.table}_tenant_policy ON ${entity.table}
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;
}

function migrationFile(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Mirrors migrations/0001_${names.snake}_core.up.sql byte for byte. */
export const ${names.constant}_MIGRATION_001 = \`${migrationSql(model)}\`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_${names.snake}_core',
		sql: { postgresql: ${names.constant}_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'${entity.table}',
				'${entity.table}_tenant_policy',
				[() => database.schema.hasIndex('${entity.table}_tenant_name_idx')],
			),
	},
];
`;
}

function databaseRepositoryFile(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import type { DatabaseHandle } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import type { ${entity.type} } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type { ${names.pascal}Repository } from './repository.ts';

interface ${entity.type}Row {
	id: string;
	tenant_id: string;
	name: string;
	status: ${entity.type}['status'];
	created_at: number | bigint | string;
}

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const LIST = \`SELECT id, tenant_id, name, status, created_at
			 FROM ${entity.table}
			 WHERE tenant_id = $1
			 ORDER BY lower(name), id\`;

const CREATE = \`INSERT INTO ${entity.table}
			 (id, tenant_id, name, status, created_at)
			 VALUES ($1, $2, $3, $4, $5)\`;

/* PostgreSQL returns BIGINT as a string, so every numeric read is normalized
   before it reaches the domain. */
function integer(value: ${entity.type}Row['created_at']): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error('The ${names.suffix} database returned an invalid timestamp.');
	}
	return normalized;
}

function fromRow(row: ${entity.type}Row): ${entity.type} {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		name: row.name,
		status: row.status,
		createdAt: integer(row.created_at),
	};
}

/** A repository over a platform-owned PostgreSQL handle. */
export class Database${names.pascal}Repository implements ${names.pascal}Repository {
	constructor(private readonly database: DatabaseHandle) {}

	async list(tenantId: string): Promise<readonly ${entity.type}[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<${entity.type}Row>({
					text: LIST,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async create(record: ${entity.type}): Promise<${entity.type}> {
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: CREATE,
					parameters: [
						record.id,
						record.tenantId,
						record.name,
						record.status,
						record.createdAt,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
		return record;
	}
}

export async function migrate${names.pascal}Database(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, '${names.id}', databaseMigrations);
}
`;
}

function memoryRepositoryFile(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import type { ${entity.type} } from '../domain/types.ts';
import type { ${names.pascal}Repository } from './repository.ts';

/* Tenant-scoped in-process storage for a module without the database
   capability. State does not survive a restart. */
export class Memory${names.pascal}Repository implements ${names.pascal}Repository {
	readonly #records = new Map<string, ${entity.type}[]>();

	async list(tenantId: string): Promise<readonly ${entity.type}[]> {
		return [...(this.#records.get(tenantId) ?? [])].sort(
			(left, right) =>
				left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
		);
	}

	async create(record: ${entity.type}): Promise<${entity.type}> {
		const records = this.#records.get(record.tenantId) ?? [];
		records.push(record);
		this.#records.set(record.tenantId, records);
		return record;
	}
}
`;
}

function servicesIndex(model: ScaffoldModel): string {
	const { names, hasDatabase } = model;
	const implementation = hasDatabase
		? `export {
	Database${names.pascal}Repository,
	migrate${names.pascal}Database,
} from './database-repository.ts';`
		: `export { Memory${names.pascal}Repository } from './memory-repository.ts';`;
	return `export {
	${names.pascal}Service,
	${names.pascal}ServiceError,
} from './${names.suffix}-service.ts';
export type { ${names.pascal}Repository } from './repository.ts';
${implementation}
`;
}

function runtimeFile(model: ScaffoldModel): string {
	const { names, hasDatabase } = model;
	if (!hasDatabase) {
		return `import { ${names.pascal}Service } from '../services/${names.suffix}-service.ts';
import { Memory${names.pascal}Repository } from '../services/memory-repository.ts';

export interface ${names.pascal}Runtime {
	service(): Promise<${names.pascal}Service>;
	dispose(): Promise<void>;
}

export function create${names.pascal}Runtime(): ${names.pascal}Runtime {
	let service: ${names.pascal}Service | undefined;
	let disposed = false;
	return {
		async service() {
			if (disposed) throw new Error('${names.pascal} runtime is disposed.');
			service ??= new ${names.pascal}Service(new Memory${names.pascal}Repository());
			return service;
		},
		async dispose() {
			disposed = true;
			service = undefined;
		},
	};
}
`;
	}
	return `import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { ${names.pascal}Service } from '../services/${names.suffix}-service.ts';
import {
	Database${names.pascal}Repository,
	migrate${names.pascal}Database,
} from '../services/database-repository.ts';

export interface ${names.pascal}RuntimeOptions {
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
}

export interface ${names.pascal}Runtime {
	service(): Promise<${names.pascal}Service>;
	dispose(): Promise<void>;
}

export function create${names.pascal}Runtime(
	options: ${names.pascal}RuntimeOptions,
): ${names.pascal}Runtime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<${names.pascal}Service> | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const initialize = async (): Promise<${names.pascal}Service> => {
		const migrationLease = await options.databases.acquire({
			namespace: '${names.id}',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		try {
			await migrate${names.pascal}Database(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: '${names.id}',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		const lease = await runtimeLeasePromise;
		return new ${names.pascal}Service(
			new Database${names.pascal}Repository(lease.database),
		);
	};

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('${names.pascal} runtime is disposed.'));
			}
			servicePromise ??= initialize();
			return servicePromise;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (!runtimeLeasePromise) {
				await servicePromise?.catch(() => undefined);
			}
			if (!runtimeLeasePromise) return;
			const lease = await runtimeLeasePromise;
			await lease.release();
			runtimeLeasePromise = undefined;
			servicePromise = undefined;
		},
	};
}
`;
}

function serverIndex(model: ScaffoldModel): string {
	const { names, hasDatabase } = model;
	const runtimeExports = hasDatabase
		? `export {
	Database${names.pascal}Repository,
	migrate${names.pascal}Database,
} from '../services/database-repository.ts';
export { create${names.pascal}Runtime } from './runtime.ts';
export type { ${names.pascal}Runtime, ${names.pascal}RuntimeOptions } from './runtime.ts';`
		: `export { create${names.pascal}Runtime } from './runtime.ts';
export type { ${names.pascal}Runtime } from './runtime.ts';`;
	return `export { create${names.pascal}Routes } from '../api/endpoints.ts';
${runtimeExports}
`;
}

function platformFile(model: ScaffoldModel): string {
	const { names, hasDatabase } = model;
	const runtime = hasDatabase
		? `const runtime = create${names.pascal}Runtime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});`
		: `const runtime = create${names.pascal}Runtime();`;
	return `import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { create${names.pascal}Routes, create${names.pascal}Runtime } from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	${runtime}
	return {
		routes: create${names.pascal}Routes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
`;
}

function endpointsFile(model: ScaffoldModel): string {
	const { names, entity, listPermission, createPermission, hasApi } = model;
	if (!hasApi) return `export const endpoints = [] as const;\n`;
	const constant = `${names.constant}_PERMISSIONS`;
	const path = `/api/${names.suffix}/${entity.plural}`;
	const listId = `${names.namespace}.${entity.plural}.list`;
	const createId = `${names.namespace}.${entity.plural}.create`;
	const serverImports = [
		'defineEndpoint',
		'jsonResponse',
		...(createPermission
			? ['problemResponse', 'readJsonObject', 'requiredString']
			: []),
	];
	const authImports = [
		...(listPermission || createPermission
			? ['endpointIdentityFromContext', 'principalFromContext']
			: []),
		...(createPermission ? ['sessionMutationDenial'] : []),
	];
	const importList = (names_: readonly string[]) =>
		names_.map((name) => `\t${name},\n`).join('');
	const header = `import {
${importList(serverImports)}} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
${
	authImports.length > 0
		? `import {
${importList(authImports)}} from '@flowdular/module-auth/server';
`
		: ''
}${
		listPermission || createPermission
			? `import { ${constant} } from '../acl/permissions.ts';
`
			: ''
	}import type { ${names.pascal}Runtime } from '../server/runtime.ts';
${
	createPermission
		? `import { ${names.pascal}ServiceError } from '../services/${names.suffix}-service.ts';

function failure(error: unknown): Response {
	if (error instanceof ${names.pascal}ServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The ${names.suffix} operation failed.');
}
`
		: ''
}`;
	const list = listPermission
		? `	const list = defineEndpoint({
		id: '${listId}',
		path: '${path}',
		methods: ['GET'],
		access: { kind: 'permission', permission: ${constant}.${listPermission.key} },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const service = await runtime.service();
			return jsonResponse({
				${entity.plural}: await service.list(
					principalFromContext(octane)!.tenantId,
				),
			});
		},
	});
`
		: '';
	const create = createPermission
		? `	const create = defineEndpoint({
		id: '${createId}',
		path: '${path}',
		methods: ['POST'],
		access: { kind: 'permission', permission: ${constant}.${createPermission.key} },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				const record = await service.create(
					principalFromContext(octane)!.tenantId,
					{ name: requiredString(value, 'name', { min: 2, max: 160 }) },
				);
				return jsonResponse({ record }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});
`
		: '';
	const routes = [
		...(listPermission ? ['list.serverRoute'] : []),
		...(createPermission ? ['create.serverRoute'] : []),
	];
	const ids = [
		...(listPermission ? [listId] : []),
		...(createPermission ? [createId] : []),
	];
	const runtimeParameter = routes.length > 0 ? 'runtime' : '_runtime';
	const authParameter = createPermission ? 'auth' : '_auth';
	const routesLiteral =
		routes.length === 0 ? '[] as const' : `[${routes.join(', ')}] as const`;
	const idsLiteral =
		ids.length === 0
			? '[] as const'
			: `[\n${ids.map((id) => `\t'${id}',\n`).join('')}] as const`;
	return `${header}
export function create${names.pascal}Routes(
	${authParameter}: AuthRuntime,
	${runtimeParameter}: ${names.pascal}Runtime,
) {
${list}${create}	return ${routesLiteral};
}

export const endpoints = ${idsLiteral};
`;
}

function clientIndex(model: ScaffoldModel): string {
	const { names, hasClient } = model;
	if (!hasClient) return `export const clientContributions = [] as const;\n`;
	return `import type {
	ModuleClientContext,
	ModuleClientContribution,
} from '@flowdular/client';
import { create${names.pascal}ClientContribution as canonicalContribution } from './contribution.tsrx';

export { create${names.pascal}ClientContribution } from './contribution.tsrx';
export type { ${names.pascal}ClientContributionOptions } from './contribution.tsrx';
export { ${names.pascal}View } from './${names.pascal}View.tsrx';

/* Canonical entry used by the generated platform composition. */
export function createClientContribution(
	context: ModuleClientContext,
): ModuleClientContribution {
	return canonicalContribution({ csrfToken: context.csrfToken });
}
`;
}

function contributionFile(model: ScaffoldModel): string {
	const { names, spec, readPermission, listPermission } = model;
	const constant = `${names.constant}_PERMISSIONS`;
	const navigation = readPermission
		? `		navigation: [
			{
				id: '${names.suffix}.navigation',
				viewId: '${names.suffix}',
				group: 'Operations',
				get label() {
					return t('${names.namespace}.navigation.label');
				},
				glyph: 'modules',
				get description() {
					return t('${names.namespace}.navigation.description');
				},
				scope: ${constant}.${readPermission.key},
				order: 50,
			},
		],
`
		: '';
	const view = listPermission
		? `<${names.pascal}View csrfToken={options.csrfToken} />`
		: `<${names.pascal}View />`;
	return `import { t, type ModuleClientContribution } from '@flowdular/client';
${translationImports(spec)}
${readPermission ? `import { ${constant} } from '../acl/permissions.ts';\n` : ''}import { ${names.pascal}View } from './${names.pascal}View.tsrx';

export interface ${names.pascal}ClientContributionOptions {
	readonly csrfToken: string;
}

export function create${names.pascal}ClientContribution(
	${listPermission ? 'options' : '_options'}: ${names.pascal}ClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: '${names.id}',
		translations: ${translationRegistry(spec)},
${navigation}		views: [
			{
				id: '${names.suffix}',
				render: () => ${view},
			},
		],
	};
}
`;
}

function clientApi(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import { t } from '@flowdular/client/i18n';
import type { ${entity.type} } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(
			value.error?.message ?? t('${names.namespace}.error.request'),
		);
	}
	return value;
}

export async function load${entity.type}s(): Promise<readonly ${entity.type}[]> {
	const response = await fetch('/api/${names.suffix}/${entity.plural}', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly ${entity.plural}: readonly ${entity.type}[] }>(
			response,
		)
	).${entity.plural};
}
`;
}

function clientState(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import { cell, createStore } from 'segment-state';
import type { ${entity.type} } from '../domain/types.ts';

export function create${names.pascal}ClientState() {
	const store = createStore({
		${entity.plural}: cell<readonly ${entity.type}[]>([]),
		status: cell<'idle' | 'loading'>('idle'),
		error: '',
	});
	return { store, state: store.state };
}
`;
}

function viewFile(model: ScaffoldModel): string {
	const { names, entity, listPermission } = model;
	if (!listPermission) {
		return `import { t } from '@flowdular/client';
import { EmptyState, PageHeader } from '@flowdular/ui';

export function ${names.pascal}View() @{
	<div class="ui-view">
		<PageHeader
			eyebrow={t('${names.namespace}.page.eyebrow')}
			title={t('${names.namespace}.page.title')}
			description={t('${names.namespace}.page.description')}
		/>
		<section class="ui-card">
			<EmptyState
				icon="modules"
				title={t('${names.namespace}.table.emptyTitle')}
			>
				{t('${names.namespace}.table.emptyHint')}
			</EmptyState>
		</section>
	</div>
}
`;
	}
	return `import { useEffect, useMemo } from 'octane';
import { t } from '@flowdular/client';
import {
	Alert,
	Button,
	Icon,
	PageHeader,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import type { ${entity.type} } from '../domain/types.ts';
import { load${entity.type}s } from './api.ts';
import { create${names.pascal}ClientState } from './state.ts';

export interface ${names.pascal}ViewProps {
	readonly csrfToken: string;
}

function columns(): readonly TableColumn<${entity.type}>[] {
	return [
		{
			key: 'name',
			header: t('${names.namespace}.table.column.name'),
			width: '65%',
			cell: (record) => <b>{record.name}</b>,
		},
		{
			key: 'status',
			header: t('${names.namespace}.table.column.status'),
			width: '35%',
			cell: (record) => t('${names.namespace}.status.' + record.status),
		},
	];
}

export function ${names.pascal}View(_props: ${names.pascal}ViewProps) @{
	const viewState = useMemo(() => create${names.pascal}ClientState(), []);
	const [${entity.plural}] = useValue(viewState.state.${entity.plural});
	const [status, setStatus] = useValue(viewState.state.status);
	const [error, setError] = useValue(viewState.state.error);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await load${entity.type}s();
			viewState.store.act(
				(transaction) => transaction.set(viewState.state.${entity.plural}, loaded),
				'${names.suffix}/loaded',
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('${names.namespace}.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('${names.namespace}.page.eyebrow')}
			title={t('${names.namespace}.page.title')}
			description={t('${names.namespace}.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('${names.namespace}.action.refresh')}
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t('${names.namespace}.table.title')}
			count={t('${names.namespace}.table.count', {
				count: ${entity.plural}.length,
			})}
			caption={t('${names.namespace}.table.caption')}
			columns={columns()}
			rows={${entity.plural}}
			rowKey={(record) => record.id}
			status={status === 'loading' && ${entity.plural}.length === 0
				? 'loading'
				: 'idle'}
			loadingLabel={t('${names.namespace}.table.loading')}
			empty={{
				icon: 'modules',
				title: t('${names.namespace}.table.emptyTitle'),
				hint: t('${names.namespace}.table.emptyHint'),
			}}
		/>
	</div>
}
`;
}

function testFile(model: ScaffoldModel): string {
	const { names, entity, hasDatabase } = model;
	const isolation = `	it('isolates ${entity.plural} by trusted tenant id', async () => {
		const service = await ${names.camel}Service();
		await service.create('tenant-a', { name: 'Alpha' });
		await service.create('tenant-b', { name: 'Beta' });

		expect((await service.list('tenant-a')).map((record) => record.name)).toEqual(
			['Alpha'],
		);
		expect((await service.list('tenant-b')).map((record) => record.name)).toEqual(
			['Beta'],
		);
	});`;
	if (!hasDatabase) {
		return `import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { ${names.pascal}Service } from '../src/services/${names.suffix}-service.ts';
import { Memory${names.pascal}Repository } from '../src/services/memory-repository.ts';

async function ${names.camel}Service(): Promise<${names.pascal}Service> {
	return new ${names.pascal}Service(new Memory${names.pascal}Repository());
}

describe('${names.id}', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('${names.id}');
	});

${isolation}
});
`;
	}
	return `import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import { afterAll, describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { ${names.pascal}Service } from '../src/services/${names.suffix}-service.ts';
import {
	Database${names.pascal}Repository,
	migrate${names.pascal}Database,
} from '../src/services/database-repository.ts';

interface TestDatabase {
	readonly provider: DatabaseProvider;
	readonly service: ${names.pascal}Service;
	release(): Promise<void>;
}

let shared: Promise<TestDatabase> | undefined;

async function open(): Promise<TestDatabase> {
	const provider = createPgliteTestProvider();
	const migration = await provider.acquire({
		namespace: '${names.id}',
		purpose: 'migration',
	});
	try {
		await migrate${names.pascal}Database(migration.database);
	} finally {
		await migration.release();
	}
	const lease = await provider.acquire({
		namespace: '${names.id}',
		purpose: 'test',
	});
	return {
		provider,
		service: new ${names.pascal}Service(
			new Database${names.pascal}Repository(lease.database),
		),
		release: () => lease.release(),
	};
}

/* Booting an embedded PostgreSQL costs about two seconds, so the file shares one
   migrated database and every case starts from truncated tables. The runtime
   role holds no BYPASSRLS, so the isolation below is enforced by the database. */
async function ${names.camel}Service(): Promise<${names.pascal}Service> {
	shared ??= open();
	const database = await shared;
	const migration = await database.provider.acquire({
		namespace: '${names.id}',
		purpose: 'migration',
	});
	try {
		await migration.database.execute({
			text: 'TRUNCATE ${entity.table} RESTART IDENTITY CASCADE',
		});
	} finally {
		await migration.release();
	}
	return database.service;
}

afterAll(async () => {
	const pending = shared;
	shared = undefined;
	if (!pending) return;
	const database = await pending;
	await database.release();
	await database.provider.dispose();
});

describe('${names.id}', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('${names.id}');
	});

${isolation}
});
`;
}

function vitestConfig(): string {
	return `import { defineConfig } from 'vitest/config';

/* Booting the embedded PostgreSQL a suite runs against takes seconds under
   parallel load, well past the 5s vitest default. */
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
`;
}

function cliCatalog(model: ScaffoldModel): string {
	const { names } = model;
	return json({
		protocolVersion: 1,
		moduleId: names.id,
		commands: [
			{
				path: [names.namespace, 'status'],
				capability: {
					id: `${names.namespace}.status`,
					version: 1,
					summary: `Inspect the ${names.id} module status.`,
					risk: 'read',
					requiresApprovedSpec: false,
					supportsDryRun: false,
				},
			},
		],
	});
}

function cliEntry(model: ScaffoldModel): string {
	const { names } = model;
	return `import { defineCliExtension } from '@flowdular/cli-protocol';

export default defineCliExtension({
	protocolVersion: 1,
	moduleId: '${names.id}',
	commands: [
		{
			path: ['${names.namespace}', 'status'],
			capability: {
				id: '${names.namespace}.status',
				version: 1,
				summary: 'Inspect the ${names.id} module status.',
				risk: 'read',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
			execute: () => ({ data: { moduleId: '${names.id}', status: 'ready' } }),
		},
	],
});
`;
}

/* The scaffold owns generic, complete runtime copy. A business-manager may
   replace it with domain-specific wording before the module gates run. */
function translation(
	locale: string,
	name: string,
	description: string,
): string {
	if (locale === 'pl') {
		return json({
			'module.name': `Moduł ${name}`,
			'navigation.label': name,
			'navigation.description': `Dane modułu ${name}`,
			'page.eyebrow': 'Dane operacyjne',
			'page.title': name,
			'page.description': `Obsługa danych modułu ${name}.`,
			'action.refresh': 'Odśwież',
			'table.title': 'Rekordy',
			'table.caption': `Rekordy modułu ${name}`,
			'table.count': 'Liczba rekordów: {count}',
			'table.column.name': 'Nazwa',
			'table.column.status': 'Status',
			'table.loading': 'Wczytywanie rekordów…',
			'table.emptyTitle': 'Brak rekordów',
			'table.emptyHint': 'Utworzone rekordy pojawią się w tym miejscu.',
			'status.active': 'Aktywny',
			'status.archived': 'Zarchiwizowany',
			'error.load': 'Nie udało się wczytać rekordów.',
			'error.request': 'Operacja na rekordach nie powiodła się.',
		});
	}
	return json({
		'module.name': name,
		'navigation.label': name,
		'navigation.description': description,
		'page.eyebrow': 'Operations',
		'page.title': name,
		'page.description': description,
		'action.refresh': 'Refresh',
		'table.title': 'Records',
		'table.caption': `${name} records`,
		'table.count': '{count} records',
		'table.column.name': 'Name',
		'table.column.status': 'Status',
		'table.loading': 'Loading records…',
		'table.emptyTitle': 'No records yet',
		'table.emptyHint': 'Records created in this workspace appear here.',
		'status.active': 'Active',
		'status.archived': 'Archived',
		'error.load': 'Could not load records.',
		'error.request': 'The records operation failed.',
	});
}

export function planScaffold(
	spec: ModuleSpec,
	specSource: string,
): ReadonlyMap<string, string> {
	const model = buildModel(spec);
	const { names, hasApi, hasClient, hasDatabase, hasCli, listPermission } =
		model;
	const files = new Map<string, string>([
		['module.json', manifest(model)],
		['package.json', packageJson(model)],
		['tsconfig.json', tsconfig(model)],
		['spec/module.yaml', specSource],
		['src/index.ts', moduleIndex(model)],
		['src/acl/permissions.ts', permissionsFile(model)],
		['src/api/endpoints.ts', endpointsFile(model)],
		['src/domain/types.ts', domainTypes(model)],
		['src/services/repository.ts', repositoryFile(model)],
		[`src/services/${names.suffix}-service.ts`, serviceFile(model)],
		['src/services/index.ts', servicesIndex(model)],
		['src/client/index.ts', clientIndex(model)],
	]);
	if (hasDatabase) {
		files.set('src/services/migration.ts', migrationFile(model));
		files.set(
			'src/services/database-repository.ts',
			databaseRepositoryFile(model),
		);
		files.set('vitest.config.ts', vitestConfig());
		files.set(
			`migrations/0001_${names.snake}_core.up.sql`,
			migrationSql(model),
		);
		files.set(
			`migrations/0001_${names.snake}_core.down.sql`,
			`DROP TABLE IF EXISTS ${model.entity.table};\n`,
		);
	} else {
		files.set('src/services/memory-repository.ts', memoryRepositoryFile(model));
	}
	files.set(
		'migrations/README.md',
		'# Migrations\n\nMigrations in this directory are append-only after release.\n',
	);
	if (hasApi) {
		files.set('src/server/runtime.ts', runtimeFile(model));
		files.set('src/server/index.ts', serverIndex(model));
		files.set('src/platform.ts', platformFile(model));
	}
	if (hasClient) {
		files.set('src/client/contribution.tsrx', contributionFile(model));
		files.set(`src/client/${names.pascal}View.tsrx`, viewFile(model));
		if (listPermission) {
			files.set('src/client/api.ts', clientApi(model));
			files.set('src/client/state.ts', clientState(model));
		}
	}
	if (hasCli) {
		files.set('src/cli/commands.json', cliCatalog(model));
		files.set('src/cli/index.ts', cliEntry(model));
	}
	files.set('tests/module.test.ts', testFile(model));
	for (const locale of new Set(['en', ...spec.locales])) {
		files.set(
			`translations/${locale}.json`,
			translation(locale, spec.name, spec.description),
		);
	}
	return files;
}
