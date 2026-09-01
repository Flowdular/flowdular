import type { ModuleSpec } from '@coreloom/contracts';

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
		packageName: `@coreloom/module-${suffix}`,
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

function jsxString(value: string): string {
	return JSON.stringify(value);
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
	const { spec, names, hasApi, hasClient, hasCli } = model;
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
			...(hasCli ? { '@coreloom/cli-protocol': 'workspace:*' } : {}),
			...(hasClient ? { '@coreloom/client': 'workspace:*' } : {}),
			'@coreloom/contracts': 'workspace:*',
			...(hasApi
				? {
						'@coreloom/module-auth': 'workspace:*',
						'@coreloom/server': 'workspace:*',
					}
				: {}),
			...(hasClient
				? {
						'@coreloom/ui': 'workspace:*',
						octane: '0.1.50',
						'segment-state': '0.2.0',
					}
				: {}),
		},
		devDependencies: {
			...(hasClient ? { '@tsrx/typescript-plugin': '0.3.120' } : {}),
			'@types/node': '24.13.3',
			typescript: '5.9.3',
			vitest: '4.1.10',
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
	return `import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
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
	list(tenantId: string): readonly ${entity.type}[];
	create(record: ${entity.type}): ${entity.type};
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

	list(tenantId: string): readonly ${entity.type}[] {
		return this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	create(tenantId: string, input: Create${entity.type}Input): ${entity.type} {
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
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ${entity.table}_tenant_name_idx
  ON ${entity.table} (tenant_id, name, id);
`;
}

function migrationFile(model: ScaffoldModel): string {
	return `export const ${model.names.constant}_MIGRATION_001 = \`
${migrationSql(model)}\`;
`;
}

function sqliteRepositoryFile(model: ScaffoldModel): string {
	const { names, entity } = model;
	return `import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ${entity.type} } from '../domain/types.ts';
import { ${names.constant}_MIGRATION_001 } from './migration.ts';
import type { ${names.pascal}Repository } from './repository.ts';

interface ${entity.type}Row {
	id: string;
	tenant_id: string;
	name: string;
	status: ${entity.type}['status'];
	created_at: number;
}

function fromRow(row: ${entity.type}Row): ${entity.type} {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		name: row.name,
		status: row.status,
		createdAt: row.created_at,
	};
}

export class Sqlite${names.pascal}Repository implements ${names.pascal}Repository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		this.#database.exec(${names.constant}_MIGRATION_001);
	}

	list(tenantId: string): readonly ${entity.type}[] {
		return (
			this.#database
				.prepare(
					\`SELECT id, tenant_id, name, status, created_at
					 FROM ${entity.table} WHERE tenant_id = ?
					 ORDER BY lower(name), id\`,
				)
				.all(tenantId) as unknown as ${entity.type}Row[]
		).map(fromRow);
	}

	create(record: ${entity.type}): ${entity.type} {
		this.#database
			.prepare(
				\`INSERT INTO ${entity.table} (id, tenant_id, name, status, created_at)
				 VALUES (?, ?, ?, ?, ?)\`,
			)
			.run(
				record.id,
				record.tenantId,
				record.name,
				record.status,
				record.createdAt,
			);
		return record;
	}
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

	list(tenantId: string): readonly ${entity.type}[] {
		return [...(this.#records.get(tenantId) ?? [])].sort(
			(left, right) =>
				left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
		);
	}

	create(record: ${entity.type}): ${entity.type} {
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
		? `export { Sqlite${names.pascal}Repository } from './sqlite-repository.ts';`
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
	service(): ${names.pascal}Service;
}

export function create${names.pascal}Runtime(): ${names.pascal}Runtime {
	let service: ${names.pascal}Service | undefined;
	return {
		service: () => {
			service ??= new ${names.pascal}Service(new Memory${names.pascal}Repository());
			return service;
		},
	};
}
`;
	}
	return `import { resolve } from 'node:path';
import { ${names.pascal}Service } from '../services/${names.suffix}-service.ts';
import { Sqlite${names.pascal}Repository } from '../services/sqlite-repository.ts';

export interface ${names.pascal}RuntimeOptions {
	readonly databasePath: string;
}

export interface ${names.pascal}Runtime {
	service(): ${names.pascal}Service;
}

export function ${names.camel}RuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): ${names.pascal}RuntimeOptions {
	return {
		databasePath:
			environment.OERP_${names.constant}_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/${names.suffix}.db'
				: resolve(workspaceRoot, '.octane-erp/${names.suffix}.db')),
	};
}

export function create${names.pascal}Runtime(
	options: ${names.pascal}RuntimeOptions = ${names.camel}RuntimeOptionsFromEnvironment(),
): ${names.pascal}Runtime {
	let service: ${names.pascal}Service | undefined;
	return {
		service: () => {
			service ??= new ${names.pascal}Service(
				new Sqlite${names.pascal}Repository(options.databasePath),
			);
			return service;
		},
	};
}
`;
}

function serverIndex(model: ScaffoldModel): string {
	const { names, hasDatabase } = model;
	const runtimeExports = hasDatabase
		? `export {
	create${names.pascal}Runtime,
	${names.camel}RuntimeOptionsFromEnvironment,
} from './runtime.ts';
export type { ${names.pascal}Runtime, ${names.pascal}RuntimeOptions } from './runtime.ts';`
		: `export { create${names.pascal}Runtime } from './runtime.ts';
export type { ${names.pascal}Runtime } from './runtime.ts';`;
	return `export { create${names.pascal}Routes } from '../api/endpoints.ts';
${runtimeExports}
`;
}

function platformFile(model: ScaffoldModel): string {
	const { names, hasDatabase } = model;
	const imports = hasDatabase
		? `import {
	create${names.pascal}Routes,
	create${names.pascal}Runtime,
	${names.camel}RuntimeOptionsFromEnvironment,
} from './server/index.ts';`
		: `import { create${names.pascal}Routes, create${names.pascal}Runtime } from './server/index.ts';`;
	const runtime = hasDatabase
		? `const runtime = create${names.pascal}Runtime(
		${names.camel}RuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
	);`
		: `const runtime = create${names.pascal}Runtime();`;
	return `import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
${imports}

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	${runtime}
	return { routes: create${names.pascal}Routes(context.auth, runtime) };
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
${importList(serverImports)}} from '@coreloom/server';
import type { AuthRuntime } from '@coreloom/module-auth/server';
${
	authImports.length > 0
		? `import {
${importList(authImports)}} from '@coreloom/module-auth/server';
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
		handler: ({ octane }) =>
			jsonResponse({
				${entity.plural}: runtime
					.service()
					.list(principalFromContext(octane)!.tenantId),
			}),
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
				const record = runtime
					.service()
					.create(principalFromContext(octane)!.tenantId, {
						name: requiredString(value, 'name', { min: 2, max: 160 }),
					});
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
} from '@coreloom/client';
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
				label: ${stringLiteral(spec.name)},
				glyph: 'modules',
				description: ${stringLiteral(spec.description)},
				scope: ${constant}.${readPermission.key},
				order: 50,
			},
		],
`
		: '';
	const view = listPermission
		? `<${names.pascal}View csrfToken={options.csrfToken} />`
		: `<${names.pascal}View />`;
	return `import type { ModuleClientContribution } from '@coreloom/client';
${readPermission ? `import { ${constant} } from '../acl/permissions.ts';\n` : ''}import { ${names.pascal}View } from './${names.pascal}View.tsrx';

export interface ${names.pascal}ClientContributionOptions {
	readonly csrfToken: string;
}

export function create${names.pascal}ClientContribution(
	${listPermission ? 'options' : '_options'}: ${names.pascal}ClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: '${names.id}',
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
	return `import type { ${entity.type} } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(
			value.error?.message ?? 'The ${names.suffix} operation failed.',
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
	const { names, entity, spec, listPermission } = model;
	const heading = pascalCase(entity.plural);
	if (!listPermission) {
		return `import { EmptyState, PageHeader } from '@coreloom/ui';

export function ${names.pascal}View() @{
	<div class="ui-view">
		<PageHeader
			eyebrow=${jsxString(spec.name)}
			title=${jsxString(heading)}
			description=${jsxString(spec.description)}
		/>
		<section class="ui-card">
			<EmptyState icon="modules" title="Nothing to show yet">
				This module exposes no list endpoint. Add one to the API layer
				and load it from this view.
			</EmptyState>
		</section>
	</div>
}
`;
	}
	return `import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, Icon, PageHeader } from '@coreloom/ui';
import { useValue } from 'segment-state';
import { load${entity.type}s } from './api.ts';
import { create${names.pascal}ClientState } from './state.ts';

export interface ${names.pascal}ViewProps {
	readonly csrfToken: string;
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
					: 'Could not load ${entity.plural}.',
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
			eyebrow=${jsxString(spec.name)}
			title=${jsxString(heading)}
			description=${jsxString(spec.description)}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					${heading}
					<small>{${entity.plural}.length + ' ${entity.plural}'}</small>
				</span>
			</div>
			@if (status === 'loading' && ${entity.plural}.length === 0) {
				<p class="ui-table__empty">Loading ${entity.plural}…</p>
			} @else if (${entity.plural}.length === 0) {
				<EmptyState icon="modules" title="No ${entity.plural} yet">
					${heading} created in this workspace appear here.
				</EmptyState>
			} @else {
				<div class="ui-table-wrap">
					<table class="ui-table" aria-label=${jsxString(heading)}>
						<thead>
							<tr>
								<th>Name</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							@for (const record of ${entity.plural}; key record.id) {
								<tr>
									<td>{record.name}</td>
									<td>{record.status}</td>
								</tr>
							}
						</tbody>
					</table>
				</div>
			}
		</section>
	</div>
}
`;
}

function testFile(model: ScaffoldModel): string {
	const { names, entity, hasDatabase } = model;
	const repositoryImport = hasDatabase
		? `import { Sqlite${names.pascal}Repository } from '../src/services/sqlite-repository.ts';`
		: `import { Memory${names.pascal}Repository } from '../src/services/memory-repository.ts';`;
	const repository = hasDatabase
		? `new Sqlite${names.pascal}Repository(':memory:')`
		: `new Memory${names.pascal}Repository()`;
	return `import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { ${names.pascal}Service } from '../src/services/${names.suffix}-service.ts';
${repositoryImport}

describe('${names.id}', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('${names.id}');
	});

	it('isolates ${entity.plural} by trusted tenant id', () => {
		const service = new ${names.pascal}Service(${repository});
		service.create('tenant-a', { name: 'Alpha' });
		service.create('tenant-b', { name: 'Beta' });

		expect(service.list('tenant-a').map((record) => record.name)).toEqual([
			'Alpha',
		]);
		expect(service.list('tenant-b').map((record) => record.name)).toEqual([
			'Beta',
		]);
	});
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
	return `import { defineCliExtension } from '@coreloom/cli-protocol';

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

/* The Polish label is a placeholder a translator replaces; it must not read as
   the English name so an untranslated bundle is visible at a glance. */
function translation(locale: string, name: string): string {
	return json({
		'module.name': locale === 'pl' ? `Moduł ${name}` : name,
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
		files.set('src/services/sqlite-repository.ts', sqliteRepositoryFile(model));
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
		files.set(`translations/${locale}.json`, translation(locale, spec.name));
	}
	return files;
}
