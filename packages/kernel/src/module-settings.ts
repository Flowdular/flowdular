export type ModuleSettingValue = string | number | boolean;
export type ModuleSettingType = 'string' | 'number' | 'boolean';
/* Tenant settings are stored per workspace. Platform settings have one value
   shared by every tenant; auth uses them for knobs that apply before a tenant
   is known, such as sign-up availability. */
export type ModuleSettingScope = 'platform' | 'tenant';

export interface ModuleSettingDefinition {
	readonly type: ModuleSettingType;
	readonly defaultValue: ModuleSettingValue;
	readonly visibility: 'private' | 'shared';
	readonly client: boolean;
	/** Write-only: the API never returns the value, only whether one is set. */
	readonly secret?: boolean;
	readonly scope?: ModuleSettingScope;
	/** Fully qualified client translation key; `label` remains the fallback. */
	readonly labelKey?: string;
	readonly label?: string;
	/** Fully qualified client translation key; `description` remains the fallback. */
	readonly descriptionKey?: string;
	readonly description?: string;
	/** Allowed values of a string setting. */
	readonly enum?: readonly string[];
	/** Bounds of a number, or the length bounds of a string. */
	readonly min?: number;
	readonly max?: number;
	/** Regular expression source a string value must match in full. */
	readonly pattern?: string;
	readonly multiline?: boolean;
}

export interface ModuleSettingsDeclaration {
	readonly moduleId: string;
	readonly settings: Readonly<Record<string, ModuleSettingDefinition>>;
}

export const PLATFORM_SETTINGS_TENANT = '';

export interface ModuleSettingRecord {
	readonly tenantId: string;
	readonly moduleId: string;
	readonly key: string;
	readonly value: ModuleSettingValue;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface ModuleSettingsStore {
	load(
		tenantId: string,
		moduleId: string,
	): Readonly<Record<string, ModuleSettingValue>>;
	save(record: ModuleSettingRecord): void;
	clear(tenantId: string, moduleId: string, key: string): void;
}

export interface ModuleSettingEntry {
	readonly moduleId: string;
	readonly key: string;
	readonly definition: ModuleSettingDefinition;
	/** Effective value; null for a secret. */
	readonly value: ModuleSettingValue | null;
	/** Whether a stored value overrides the declared default. */
	readonly hasValue: boolean;
}

export interface ModuleSettingChange {
	/** Storage tenant: PLATFORM_SETTINGS_TENANT for a platform-scoped setting. */
	readonly tenantId: string;
	readonly moduleId: string;
	readonly key: string;
	/** True when the stored value was removed and the default applies again. */
	readonly cleared: boolean;
	/** The set() caller and the workspace the change was made from. */
	readonly actor: {
		readonly accountId: string;
		readonly tenantId: string;
	};
}

export interface ModuleSettingsRuntime {
	declare(declaration: ModuleSettingsDeclaration): void;
	declarations(): readonly ModuleSettingsDeclaration[];
	/** Live read: the stored value, else the declared default. */
	get<T extends ModuleSettingValue>(
		tenantId: string,
		moduleId: string,
		key: string,
	): T;
	list(tenantId: string): readonly ModuleSettingEntry[];
	/** Validates against the declaration; null clears the stored value. */
	set(
		tenantId: string,
		moduleId: string,
		key: string,
		value: ModuleSettingValue | null,
		actor: string,
	): void;
	onChange(listener: (change: ModuleSettingChange) => void): () => void;
}

export interface ModuleSettingsRuntimeOptions {
	readonly now?: () => number;
	/** Bound on cached (tenant, module) value sets; least recently read is evicted. */
	readonly cacheLimit?: number;
}

export class ModuleSettingsError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = 'ModuleSettingsError';
		this.code = code;
		this.status = status;
	}
}

function invalid(name: string, detail: string): ModuleSettingsError {
	return new ModuleSettingsError(
		'INVALID_SETTING_VALUE',
		`Setting ${name} ${detail}`,
	);
}

export function assertSettingValue(
	moduleId: string,
	key: string,
	definition: ModuleSettingDefinition,
	value: unknown,
): ModuleSettingValue {
	const name = `${moduleId}.${key}`;
	if (typeof value !== definition.type) {
		throw invalid(name, `must be ${definition.type}.`);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw invalid(name, 'must be finite.');
		if (definition.min !== undefined && value < definition.min) {
			throw invalid(name, `must be at least ${definition.min}.`);
		}
		if (definition.max !== undefined && value > definition.max) {
			throw invalid(name, `must be at most ${definition.max}.`);
		}
	}
	if (typeof value === 'string') {
		if (definition.enum && !definition.enum.includes(value)) {
			throw invalid(name, `must be one of: ${definition.enum.join(', ')}.`);
		}
		if (definition.min !== undefined && value.length < definition.min) {
			throw invalid(
				name,
				`must contain at least ${definition.min} characters.`,
			);
		}
		if (definition.max !== undefined && value.length > definition.max) {
			throw invalid(name, `must contain at most ${definition.max} characters.`);
		}
		if (
			definition.pattern !== undefined &&
			!new RegExp(`^(?:${definition.pattern})$`, 'u').test(value)
		) {
			throw invalid(name, 'has an unsupported format.');
		}
	}
	return value as ModuleSettingValue;
}

export function defineModuleSettings(
	declaration: ModuleSettingsDeclaration,
): ModuleSettingsDeclaration {
	for (const [key, definition] of Object.entries(declaration.settings)) {
		if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) {
			throw new Error(`Invalid module setting key: ${key}`);
		}
		const namespace = declaration.moduleId.split('.')[0] + '.';
		for (const [field, translationKey] of [
			['labelKey', definition.labelKey],
			['descriptionKey', definition.descriptionKey],
		] as const) {
			if (translationKey === undefined) continue;
			if (
				!/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(translationKey) ||
				!translationKey.startsWith(namespace)
			) {
				throw new Error(
					`Setting ${declaration.moduleId}.${key} has invalid ${field}: ${translationKey}`,
				);
			}
		}
		if (definition.enum !== undefined) {
			if (definition.type !== 'string' || definition.enum.length === 0) {
				throw new Error(
					`Enum setting ${declaration.moduleId}.${key} must be a string with options.`,
				);
			}
		}
		if (
			definition.min !== undefined &&
			definition.max !== undefined &&
			definition.min > definition.max
		) {
			throw new Error(
				`Setting ${declaration.moduleId}.${key} declares min above max.`,
			);
		}
		try {
			assertSettingValue(
				declaration.moduleId,
				key,
				definition,
				definition.defaultValue,
			);
		} catch (error) {
			throw new Error(
				`Default value for ${declaration.moduleId}.${key} does not match ${definition.type}.`,
				{ cause: error },
			);
		}
		if (
			definition.secret &&
			(definition.client || definition.visibility === 'shared')
		) {
			throw new Error(
				`Secret setting ${declaration.moduleId}.${key} cannot be shared or sent to clients.`,
			);
		}
	}
	return Object.freeze(declaration);
}

type ChangeListener = (change: ModuleSettingChange) => void;

export function createModuleSettingsRuntime(
	store: ModuleSettingsStore,
	options: ModuleSettingsRuntimeOptions = {},
): ModuleSettingsRuntime {
	const now = options.now ?? Date.now;
	const cacheLimit = options.cacheLimit ?? 512;
	const declarations = new Map<string, ModuleSettingsDeclaration>();
	const cache = new Map<string, Readonly<Record<string, ModuleSettingValue>>>();
	const listeners = new Set<ChangeListener>();

	const definitionOf = (
		moduleId: string,
		key: string,
	): ModuleSettingDefinition => {
		const declaration = declarations.get(moduleId);
		if (!declaration) {
			throw new ModuleSettingsError(
				'SETTINGS_NOT_DECLARED',
				`Module ${moduleId} declares no settings.`,
				404,
			);
		}
		const definition = declaration.settings[key];
		if (!definition) {
			throw new ModuleSettingsError(
				'UNKNOWN_SETTING',
				`Unknown setting ${moduleId}.${key}.`,
				404,
			);
		}
		return definition;
	};

	const storageTenant = (
		definition: ModuleSettingDefinition,
		moduleId: string,
		key: string,
		tenantId: string,
	): string => {
		if (definition.scope === 'platform') return PLATFORM_SETTINGS_TENANT;
		if (tenantId === PLATFORM_SETTINGS_TENANT) {
			throw new ModuleSettingsError(
				'TENANT_REQUIRED',
				`Setting ${moduleId}.${key} is tenant-scoped and needs a tenant.`,
			);
		}
		return tenantId;
	};

	const stored = (
		tenantId: string,
		moduleId: string,
	): Readonly<Record<string, ModuleSettingValue>> => {
		const cacheKey = `${tenantId} ${moduleId}`;
		const hit = cache.get(cacheKey);
		if (hit) {
			cache.delete(cacheKey);
			cache.set(cacheKey, hit);
			return hit;
		}
		const loaded = store.load(tenantId, moduleId);
		if (cache.size >= cacheLimit) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(cacheKey, loaded);
		return loaded;
	};

	const resolve = (
		tenantId: string,
		moduleId: string,
		key: string,
		definition: ModuleSettingDefinition,
	): { readonly value: ModuleSettingValue; readonly hasValue: boolean } => {
		const raw = stored(
			storageTenant(definition, moduleId, key, tenantId),
			moduleId,
		)[key];
		if (raw !== undefined) {
			try {
				return {
					value: assertSettingValue(moduleId, key, definition, raw),
					hasValue: true,
				};
			} catch {
				// A stored value that no longer fits the declaration falls back.
			}
		}
		return { value: definition.defaultValue, hasValue: false };
	};

	return {
		declare(declaration) {
			const existing = declarations.get(declaration.moduleId);
			if (existing && existing !== declaration) {
				throw new Error(
					`Settings for module ${declaration.moduleId} are already declared.`,
				);
			}
			declarations.set(declaration.moduleId, defineModuleSettings(declaration));
		},
		declarations() {
			return [...declarations.values()];
		},
		get(tenantId, moduleId, key) {
			return resolve(tenantId, moduleId, key, definitionOf(moduleId, key))
				.value as never;
		},
		list(tenantId) {
			const entries: ModuleSettingEntry[] = [];
			for (const declaration of declarations.values()) {
				for (const [key, definition] of Object.entries(declaration.settings)) {
					const resolved = resolve(
						tenantId,
						declaration.moduleId,
						key,
						definition,
					);
					entries.push({
						moduleId: declaration.moduleId,
						key,
						definition,
						value: definition.secret ? null : resolved.value,
						hasValue: resolved.hasValue,
					});
				}
			}
			return entries;
		},
		set(tenantId, moduleId, key, value, actor) {
			const definition = definitionOf(moduleId, key);
			const target = storageTenant(definition, moduleId, key, tenantId);
			if (value === null) {
				store.clear(target, moduleId, key);
			} else {
				store.save({
					tenantId: target,
					moduleId,
					key,
					value: assertSettingValue(moduleId, key, definition, value),
					updatedBy: actor,
					updatedAt: now(),
				});
			}
			cache.delete(`${target} ${moduleId}`);
			const change: ModuleSettingChange = {
				tenantId: target,
				moduleId,
				key,
				cleared: value === null,
				actor: { accountId: actor, tenantId },
			};
			for (const listener of listeners) {
				try {
					listener(change);
				} catch (error) {
					// A faulty listener must not undo a committed change.
					console.error('[kernel] settings listener failed', error);
				}
			}
		},
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
