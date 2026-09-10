import {
	assertDatabaseId,
	assertDatabaseRequirements,
	assertNamespace,
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapter,
	type DatabaseAdapterId,
	type DatabaseCapabilityId,
	type DatabaseDialectId,
	type DatabaseIsolationLevel,
	type DatabaseRequirements,
} from './contracts.ts';

export type DatabaseConfigurationValue = boolean | number | string;
export type DatabaseSafeConfiguration = Readonly<
	Record<string, DatabaseConfigurationValue>
>;
export type DatabaseSecretConfiguration = Readonly<Record<string, string>>;

export interface DatabaseConfigurationField {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly kind: 'boolean' | 'integer' | 'select' | 'text';
	readonly required: boolean;
	readonly secret: boolean;
	readonly options?: readonly {
		readonly label: string;
		readonly value: string;
	}[];
}

export interface DatabaseAdapterCapabilityProfile {
	readonly features: readonly DatabaseCapabilityId[];
	readonly isolationLevels: readonly DatabaseIsolationLevel[];
}

export interface DatabaseAdapterPublicDescriptor {
	readonly adapterId: DatabaseAdapterId;
	readonly dialectId: DatabaseDialectId;
	readonly label: string;
	readonly description: string;
	readonly capabilities: DatabaseAdapterCapabilityProfile;
	readonly configurationSchema: {
		readonly version: 1;
		readonly fields: readonly DatabaseConfigurationField[];
	};
}

export interface DatabaseAdapterConnectionInput {
	readonly config: DatabaseSafeConfiguration;
	readonly secrets: DatabaseSecretConfiguration;
}

export interface DatabaseAdapterValidationIssue {
	readonly field: string;
	readonly code: string;
	readonly message: string;
}

export interface DatabaseAdapterProbeResult {
	readonly status: 'ready' | 'unavailable';
	readonly latencyMs: number;
	readonly message?: string;
}

export interface DatabaseAdapterDescriptor
	extends DatabaseAdapterPublicDescriptor {
	validate(
		input: DatabaseAdapterConnectionInput,
	): readonly DatabaseAdapterValidationIssue[];
	probe(
		input: DatabaseAdapterConnectionInput,
	): Promise<DatabaseAdapterProbeResult>;
	provision(
		input: DatabaseAdapterConnectionInput,
		authorization: { readonly intent: 'confirmed-first-run' },
	): Promise<void>;
	connect(input: DatabaseAdapterConnectionInput): Promise<DatabaseAdapter>;
}

export interface DatabaseAdapterRegistry {
	register(descriptor: DatabaseAdapterDescriptor): void;
	get(adapterId: DatabaseAdapterId): DatabaseAdapterDescriptor | undefined;
	list(): readonly DatabaseAdapterPublicDescriptor[];
	seal(): void;
	readonly sealed: boolean;
}

export interface ModuleDatabaseRequirements extends DatabaseRequirements {
	readonly moduleId: string;
	readonly tenantOwned: boolean;
}

/** Persistable first-run state. It intentionally cannot contain credentials. */
export interface DatabaseSelection {
	readonly version: 1;
	readonly defaultAdapterId: DatabaseAdapterId;
	readonly moduleOverrides?: Readonly<Record<string, DatabaseAdapterId>>;
	readonly configurations?: Readonly<
		Record<DatabaseAdapterId, DatabaseSafeConfiguration>
	>;
}

export interface DatabaseSelectionIssue {
	readonly moduleId: string | null;
	readonly code:
		| 'ADAPTER_NOT_REGISTERED'
		| 'CAPABILITY_MISMATCH'
		| 'POSTGRESQL_RLS_REQUIRED';
	readonly message: string;
}

function assertField(field: DatabaseConfigurationField): void {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(field.key)) {
		throw new Error(`"${field.key}" is not a valid database config field key.`);
	}
	if (!field.label.trim() || !field.description.trim()) {
		throw new Error(`Database config field "${field.key}" needs UI copy.`);
	}
	if (field.kind === 'select' && !field.options?.length) {
		throw new Error(`Select field "${field.key}" needs at least one option.`);
	}
}

function publicDescriptor(
	descriptor: DatabaseAdapterDescriptor,
): DatabaseAdapterPublicDescriptor {
	return Object.freeze({
		adapterId: descriptor.adapterId,
		dialectId: descriptor.dialectId,
		label: descriptor.label,
		description: descriptor.description,
		capabilities: Object.freeze({
			features: Object.freeze([...descriptor.capabilities.features]),
			isolationLevels: Object.freeze([
				...descriptor.capabilities.isolationLevels,
			]),
		}),
		configurationSchema: Object.freeze({
			version: 1 as const,
			fields: Object.freeze(
				descriptor.configurationSchema.fields.map((field) =>
					Object.freeze({ ...field }),
				),
			),
		}),
	});
}

export function createDatabaseAdapterRegistry(): DatabaseAdapterRegistry {
	const descriptors = new Map<DatabaseAdapterId, DatabaseAdapterDescriptor>();
	let sealed = false;
	return {
		register(descriptor) {
			if (sealed) throw new Error('The database adapter registry is sealed.');
			assertDatabaseId(descriptor.adapterId, 'adapter');
			assertDatabaseId(descriptor.dialectId, 'dialect');
			for (const capability of descriptor.capabilities.features) {
				assertDatabaseId(capability, 'capability');
			}
			const fields = new Set<string>();
			for (const field of descriptor.configurationSchema.fields) {
				assertField(field);
				if (fields.has(field.key)) {
					throw new Error(
						`Database adapter "${descriptor.adapterId}" repeats config field "${field.key}".`,
					);
				}
				fields.add(field.key);
			}
			if (descriptors.has(descriptor.adapterId)) {
				throw new Error(
					`Database adapter "${descriptor.adapterId}" is already registered.`,
				);
			}
			descriptors.set(descriptor.adapterId, descriptor);
		},
		get: (adapterId) => descriptors.get(adapterId),
		list: () =>
			[...descriptors.values()]
				.sort((left, right) => left.adapterId.localeCompare(right.adapterId))
				.map(publicDescriptor),
		seal() {
			sealed = true;
		},
		get sealed() {
			return sealed;
		},
	};
}

function selectedAdapter(
	selection: DatabaseSelection,
	moduleId: string,
): DatabaseAdapterId {
	return selection.moduleOverrides?.[moduleId] ?? selection.defaultAdapterId;
}

function requirementView(descriptor: DatabaseAdapterDescriptor) {
	return {
		adapterId: descriptor.adapterId,
		dialectId: descriptor.dialectId,
		capabilities: {
			features: descriptor.capabilities.features,
			isolationLevels: descriptor.capabilities.isolationLevels,
		},
	};
}

export function validateDatabaseSelection(
	registry: DatabaseAdapterRegistry,
	selection: DatabaseSelection,
	modules: readonly ModuleDatabaseRequirements[],
): readonly DatabaseSelectionIssue[] {
	assertDatabaseId(selection.defaultAdapterId, 'adapter');
	const issues: DatabaseSelectionIssue[] = [];
	if (!registry.get(selection.defaultAdapterId)) {
		issues.push({
			moduleId: null,
			code: 'ADAPTER_NOT_REGISTERED',
			message: `Default database adapter "${selection.defaultAdapterId}" is not registered.`,
		});
	}
	for (const module of modules) {
		assertNamespace(module.moduleId);
		const adapterId = selectedAdapter(selection, module.moduleId);
		const descriptor = registry.get(adapterId);
		if (!descriptor) {
			issues.push({
				moduleId: module.moduleId,
				code: 'ADAPTER_NOT_REGISTERED',
				message: `Database adapter "${adapterId}" is not registered.`,
			});
			continue;
		}
		try {
			assertDatabaseRequirements(requirementView(descriptor), module);
		} catch (error) {
			issues.push({
				moduleId: module.moduleId,
				code: 'CAPABILITY_MISMATCH',
				message: error instanceof Error ? error.message : String(error),
			});
		}
		if (
			module.tenantOwned &&
			descriptor.dialectId === DATABASE_DIALECT_IDS.postgresql &&
			(!descriptor.capabilities.features.includes(
				DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
			) ||
				!descriptor.capabilities.features.includes(
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
				))
		) {
			issues.push({
				moduleId: module.moduleId,
				code: 'POSTGRESQL_RLS_REQUIRED',
				message: `Tenant-owned module "${module.moduleId}" requires transaction-local PostgreSQL RLS.`,
			});
		}
	}
	return issues;
}
