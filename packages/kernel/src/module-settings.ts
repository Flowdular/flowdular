export type ModuleSettingValue = string | number | boolean;
export type ModuleSettingType = 'string' | 'number' | 'boolean';
/* Tenant settings are stored per workspace. Platform settings have one value
   shared by every tenant; auth uses them for knobs that apply before a tenant
   is known, such as sign-up availability. */
export type ModuleSettingScope = 'platform' | 'tenant';
/* A feature flag is a boolean setting an operator turns on or off per
   workspace. It is stored, read and validated exactly like any other setting;
   the kind is what makes the change audited as a flag change and listed on the
   Flags screen. */
export type ModuleSettingKind = 'flag';

export interface ModuleSettingDefinition {
	readonly type: ModuleSettingType;
	readonly defaultValue: ModuleSettingValue;
	readonly visibility: 'private' | 'shared';
	readonly client: boolean;
	/** Write-only: the API never returns the value, only whether one is set. */
	readonly secret?: boolean;
	/** `flag` requires a tenant-scoped, non-secret boolean, labelled and described. */
	readonly kind?: ModuleSettingKind;
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

/* Storage may be a database or a network, so every operation is asynchronous;
   the runtime serves reads from a snapshot it primes per tenant. */
export interface ModuleSettingsStore {
	load(
		tenantId: string,
		moduleId: string,
	): Promise<Readonly<Record<string, ModuleSettingValue>>>;
	save(record: ModuleSettingRecord): Promise<void>;
	clear(tenantId: string, moduleId: string, key: string): Promise<void>;
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
	/** Declared kind, so a listener can audit a flag change as a flag change. */
	readonly kind?: ModuleSettingKind;
	/**
	 * Effective values around the write, default included, so an audit trail
	 * records what an operator actually changed. Both are null for a secret,
	 * whose value never leaves the store.
	 */
	readonly previous: ModuleSettingValue | null;
	readonly next: ModuleSettingValue | null;
	/** The set() caller and the workspace the change was made from. */
	readonly actor: {
		readonly accountId: string;
		readonly tenantId: string;
	};
}

export interface ModuleSettingsRuntime {
	declare(declaration: ModuleSettingsDeclaration): void;
	declarations(): readonly ModuleSettingsDeclaration[];
	/**
	 * Loads the stored values of every declared module for this tenant, and the
	 * platform-scoped ones, into memory. Idempotent and memoised: a primed
	 * tenant costs one lookup. `get` and `list` answer from that snapshot, so a
	 * request path primes the tenant before it reads.
	 */
	prime(tenantId: string): Promise<void>;
	/** The stored value, else the declared default; throws for an unprimed tenant. */
	get<T extends ModuleSettingValue>(
		tenantId: string,
		moduleId: string,
		key: string,
	): T;
	list(tenantId: string): readonly ModuleSettingEntry[];
	/** Validates against the declaration; null clears the stored value. Resolves once the store holds it and the snapshot is refreshed. */
	set(
		tenantId: string,
		moduleId: string,
		key: string,
		value: ModuleSettingValue | null,
		actor: string,
	): Promise<void>;
	onChange(listener: (change: ModuleSettingChange) => void): () => void;
}

export interface ModuleSettingsRuntimeOptions {
	readonly now?: () => number;
	/** Bound on tenants held in memory; the least recently primed is evicted, the platform tenant stays. */
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

/* One compiled pattern per declared setting. Every read validates the stored
   value against its declaration, so compiling here rather than per call keeps
   the regular expression off the request path; `defineModuleSettings` builds it
   while it checks the declared default. Keyed by the definition, so a
   declaration that goes away takes its pattern with it. */
const patterns = new WeakMap<ModuleSettingDefinition, RegExp>();

function patternOf(definition: ModuleSettingDefinition): RegExp {
	let compiled = patterns.get(definition);
	if (compiled === undefined) {
		compiled = new RegExp(`^(?:${definition.pattern})$`, 'u');
		patterns.set(definition, compiled);
	}
	return compiled;
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
			!patternOf(definition).test(value)
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
		/* A flag is offered to an operator as a bare switch on a screen that
		   shows no module documentation, so the declaration has to carry the
		   words that explain it; a secret one could be neither read back nor
		   audited with its values. A flag is on or off for one workspace, and
		   the screen that turns it on is that workspace's, so a platform-scoped
		   one would let an operator switch every other workspace from inside
		   their own. */
		if (definition.kind === 'flag') {
			if (definition.type !== 'boolean' || definition.secret) {
				throw new Error(
					`Flag ${declaration.moduleId}.${key} must be a non-secret boolean setting.`,
				);
			}
			if (definition.scope === 'platform') {
				throw new Error(
					`Flag ${declaration.moduleId}.${key} must be tenant-scoped; a platform setting carries one value for every workspace.`,
				);
			}
			if (!definition.label || !definition.description) {
				throw new Error(
					`Flag ${declaration.moduleId}.${key} must declare a label and a description.`,
				);
			}
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
	/* Tenant, then module, to the values the store holds. Filled by prime and
	   by set, never by a read: a read of a tenant that is not here fails. */
	const snapshots = new Map<
		string,
		Map<string, Readonly<Record<string, ModuleSettingValue>>>
	>();
	const loads = new Map<string, Promise<void>>();
	/* The declaration generation a tenant was primed at; a module declared
	   later makes the next prime load what is missing. */
	const primed = new Map<string, number>();
	let generation = 0;
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

	const tenantSnapshot = (
		tenantId: string,
	): Map<string, Readonly<Record<string, ModuleSettingValue>>> => {
		let snapshot = snapshots.get(tenantId);
		if (snapshot) return snapshot;
		if (snapshots.size >= cacheLimit) {
			for (const oldest of snapshots.keys()) {
				if (oldest === PLATFORM_SETTINGS_TENANT) continue;
				snapshots.delete(oldest);
				primed.delete(oldest);
				break;
			}
		}
		snapshot = new Map();
		snapshots.set(tenantId, snapshot);
		return snapshot;
	};

	const loadModule = (tenantId: string, moduleId: string): Promise<void> => {
		if (snapshots.get(tenantId)?.has(moduleId)) return Promise.resolve();
		const loadKey = `${tenantId} ${moduleId}`;
		const inflight = loads.get(loadKey);
		if (inflight) return inflight;
		const pending = store
			.load(tenantId, moduleId)
			.then((values) => {
				tenantSnapshot(tenantId).set(moduleId, values);
			})
			.finally(() => loads.delete(loadKey));
		loads.set(loadKey, pending);
		return pending;
	};

	const scopesOf = (
		declaration: ModuleSettingsDeclaration,
	): { readonly tenant: boolean; readonly platform: boolean } => {
		let tenant = false;
		let platform = false;
		for (const definition of Object.values(declaration.settings)) {
			if (definition.scope === 'platform') platform = true;
			else tenant = true;
		}
		return { tenant, platform };
	};

	const prime = async (tenantId: string): Promise<void> => {
		const at = generation;
		if (primed.get(tenantId) === at) {
			const snapshot = snapshots.get(tenantId);
			if (snapshot) {
				snapshots.delete(tenantId);
				snapshots.set(tenantId, snapshot);
			}
			return;
		}
		const pending: Promise<void>[] = [];
		for (const declaration of declarations.values()) {
			const scopes = scopesOf(declaration);
			if (scopes.platform) {
				pending.push(
					loadModule(PLATFORM_SETTINGS_TENANT, declaration.moduleId),
				);
			}
			if (scopes.tenant && tenantId !== PLATFORM_SETTINGS_TENANT) {
				pending.push(loadModule(tenantId, declaration.moduleId));
			}
		}
		await Promise.all(pending);
		tenantSnapshot(tenantId);
		primed.set(tenantId, at);
	};

	const stored = (
		tenantId: string,
		moduleId: string,
	): Readonly<Record<string, ModuleSettingValue>> => {
		const values = snapshots.get(tenantId)?.get(moduleId);
		if (!values) {
			throw new ModuleSettingsError(
				'SETTINGS_NOT_PRIMED',
				`Settings of ${moduleId} for ${
					tenantId === PLATFORM_SETTINGS_TENANT
						? 'the platform'
						: `tenant ${tenantId}`
				} are not loaded; await settings.prime(tenantId) before reading.`,
				500,
			);
		}
		return values;
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
			generation += 1;
		},
		declarations() {
			return [...declarations.values()];
		},
		prime,
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
		async set(tenantId, moduleId, key, value, actor) {
			const definition = definitionOf(moduleId, key);
			const target = storageTenant(definition, moduleId, key, tenantId);
			const next =
				value === null
					? definition.defaultValue
					: assertSettingValue(moduleId, key, definition, value);
			/* Read before the write, so the change carries the value that was
			   replaced. The snapshot keeps serving the old values until the
			   reload lands, so a concurrent read never finds a gap. */
			await loadModule(target, moduleId);
			const previous = definition.secret
				? null
				: resolve(tenantId, moduleId, key, definition).value;
			if (value === null) {
				await store.clear(target, moduleId, key);
			} else {
				await store.save({
					tenantId: target,
					moduleId,
					key,
					value: next,
					updatedBy: actor,
					updatedAt: now(),
				});
			}
			tenantSnapshot(target).set(moduleId, await store.load(target, moduleId));
			const change: ModuleSettingChange = {
				tenantId: target,
				moduleId,
				key,
				cleared: value === null,
				...(definition.kind ? { kind: definition.kind } : {}),
				previous,
				next: definition.secret ? null : next,
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
