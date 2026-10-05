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

/** What a write hands its store, so the store records the change beside the value. */
export interface ModuleSettingChangeContext {
	/** The declaration the value was validated against. */
	readonly definition: ModuleSettingDefinition;
	/** The set() caller and the workspace the change was made from. */
	readonly actor: {
		readonly accountId: string;
		readonly tenantId: string;
	};
}

/** A committed write of a store that keeps a change log. */
export interface ModuleSettingCommit {
	readonly revision: number;
}

/** One change log row: which setting changed and when, never its value. */
export interface ModuleSettingLogEntry {
	readonly revision: number;
	/** Storage tenant: PLATFORM_SETTINGS_TENANT for a platform-scoped setting. */
	readonly tenantId: string;
	readonly moduleId: string;
	readonly key: string;
	readonly cleared: boolean;
	/** Database time of the change, in epoch milliseconds. */
	readonly changedAt: number;
}

export interface ModuleSettingsLogPosition {
	readonly revision: number;
	/** Reads after `revision`; opaque to its holder. */
	readonly cursor: string;
}

export interface ModuleSettingChangesRequest {
	/** A cursor a previous read answered; null reads from the start of the log. */
	readonly after: string | null;
	/** 1 to MODULE_SETTINGS_CHANGES_PAGE_MAX. */
	readonly limit: number;
	readonly moduleId?: string;
	/** Narrows to one key of `moduleId`. */
	readonly key?: string;
}

export type ModuleSettingChangesPage =
	| {
			readonly expired: false;
			/** Ordered by revision. */
			readonly changes: readonly ModuleSettingLogEntry[];
			/** Continues after this page, an empty one included. */
			readonly cursor: string;
			/** Whether further changes were committed when this page was read. */
			readonly more: boolean;
	  }
	| {
			/* The cursor predates the retained log. Its holder reads from the start,
			   which always holds the newest change of every setting. */
			readonly expired: true;
	  };

export const MODULE_SETTINGS_CHANGES_PAGE_MAX = 500;

/** How long a process serves settings from its snapshot without reading the log. */
export const MODULE_SETTINGS_STALENESS_MS = 5_000;

/* Storage may be a database or a network, so every operation is asynchronous;
   the runtime serves reads from a snapshot it primes per tenant. A store that
   keeps a change log answers `newestRevision` and `changesAfter`, and the
   runtime then revalidates its snapshot against it; one without (an in-memory
   store) is served from the snapshot alone. */
export interface ModuleSettingsStore {
	load(
		tenantId: string,
		moduleId: string,
	): Promise<Readonly<Record<string, ModuleSettingValue>>>;
	save(
		record: ModuleSettingRecord,
		change?: ModuleSettingChangeContext,
	): Promise<ModuleSettingCommit | void>;
	clear(
		tenantId: string,
		moduleId: string,
		key: string,
		change?: ModuleSettingChangeContext,
	): Promise<ModuleSettingCommit | void>;
	newestRevision?(): Promise<ModuleSettingsLogPosition>;
	changesAfter?(
		request: ModuleSettingChangesRequest,
	): Promise<ModuleSettingChangesPage>;
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
	/** The change log revision, when the store keeps a log. */
	readonly revision?: number;
}

export interface ModuleSettingsPrimeOptions {
	/** A revision the caller read from the log; the prime reflects at least it. */
	readonly revision?: number;
}

export interface ModuleSettingsRuntime {
	declare(declaration: ModuleSettingsDeclaration): void;
	declarations(): readonly ModuleSettingsDeclaration[];
	/**
	 * Loads the stored values of every declared module for this tenant, and the
	 * platform-scoped ones, into memory. Memoised: a primed tenant costs one
	 * lookup. `get` and `list` answer from that snapshot, so a request path
	 * primes the tenant before it reads. Over a store that keeps a change log, a
	 * prime begun at time p reflects every change committed before p minus
	 * MODULE_SETTINGS_STALENESS_MS, and fails rather than serve past that bound.
	 */
	prime(tenantId: string, options?: ModuleSettingsPrimeOptions): Promise<void>;
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
	/**
	 * Fires in this process only, after a set() commits. A change another
	 * process made is never announced; a consumer that must see every change,
	 * or must survive a crash, reads `changesAfter` instead.
	 */
	onChange(listener: (change: ModuleSettingChange) => void): () => void;
	/** The store's change log; refused with SETTINGS_LOG_UNAVAILABLE when it keeps none. */
	changesAfter(
		request: ModuleSettingChangesRequest,
	): Promise<ModuleSettingChangesPage>;
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

/* The values one load read, and the order in which that load began. */
interface LoadedModule {
	readonly values: Readonly<Record<string, ModuleSettingValue>>;
	readonly order: number;
}

interface PendingLoad {
	readonly tenantId: string;
	readonly moduleId: string;
	readonly pending: Promise<void>;
}

function invalidPage(detail: string): ModuleSettingsError {
	return new ModuleSettingsError('INVALID_SETTINGS_PAGE', detail);
}

function assertChangesRequest(request: ModuleSettingChangesRequest): void {
	if (
		!Number.isInteger(request.limit) ||
		request.limit < 1 ||
		request.limit > MODULE_SETTINGS_CHANGES_PAGE_MAX
	) {
		throw invalidPage(
			`A change log page holds 1 to ${MODULE_SETTINGS_CHANGES_PAGE_MAX} changes.`,
		);
	}
	if (request.key !== undefined && request.moduleId === undefined) {
		throw invalidPage('A change log read narrowed to a key names its module.');
	}
}

export function createModuleSettingsRuntime(
	store: ModuleSettingsStore,
	options: ModuleSettingsRuntimeOptions = {},
): ModuleSettingsRuntime {
	const now = options.now ?? Date.now;
	const cacheLimit = options.cacheLimit ?? 512;
	const declarations = new Map<string, ModuleSettingsDeclaration>();
	/* Tenant, then module, to the values the store holds. Filled by prime, by
	   set and by revalidation, never by a read: a read of a tenant that is not
	   here fails. */
	const snapshots = new Map<string, Map<string, LoadedModule>>();
	const loads = new Map<string, PendingLoad>();
	/* The declaration generation a tenant was primed at; a module declared
	   later makes the next prime load what is missing. */
	const primed = new Map<string, number>();
	let generation = 0;
	const listeners = new Set<ChangeListener>();
	/* Loads land out of order. A landing load replaces only a snapshot that an
	   earlier-begun load wrote, so no read goes back past a write this process
	   saw commit. */
	let loadOrder = 0;
	const log =
		store.newestRevision && store.changesAfter
			? {
					newest: () => store.newestRevision!(),
					after: (request: ModuleSettingChangesRequest) =>
						store.changesAfter!(request),
				}
			: null;
	/* Every held snapshot reflects each change up to `reflected`, and the log
	   was last read after `cursor` by a read begun at `validatedAt`. */
	let cursor: string | null = null;
	let reflected = 0;
	let validatedAt = Number.NEGATIVE_INFINITY;
	let revalidating: Promise<void> | null = null;

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

	const tenantSnapshot = (tenantId: string): Map<string, LoadedModule> => {
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

	const pairKey = (tenantId: string, moduleId: string): string =>
		`${tenantId} ${moduleId}`;

	const read = (tenantId: string, moduleId: string): Promise<void> => {
		loadOrder += 1;
		const order = loadOrder;
		return store.load(tenantId, moduleId).then((values) => {
			const snapshot = tenantSnapshot(tenantId);
			const current = snapshot.get(moduleId);
			if (current && current.order > order) return;
			snapshot.set(moduleId, { values, order });
		});
	};

	const loadModule = (tenantId: string, moduleId: string): Promise<void> => {
		if (snapshots.get(tenantId)?.has(moduleId)) return Promise.resolve();
		const key = pairKey(tenantId, moduleId);
		const inflight = loads.get(key);
		if (inflight) return inflight.pending;
		const pending = read(tenantId, moduleId).finally(() => loads.delete(key));
		loads.set(key, { tenantId, moduleId, pending });
		return pending;
	};

	const held = (tenantId: string, moduleId: string): boolean =>
		snapshots.get(tenantId)?.has(moduleId) === true ||
		loads.has(pairKey(tenantId, moduleId));

	const reloadHeld = async (): Promise<void> => {
		const pairs = new Map<string, readonly [string, string]>();
		for (const [tenantId, snapshot] of snapshots) {
			for (const moduleId of snapshot.keys()) {
				pairs.set(pairKey(tenantId, moduleId), [tenantId, moduleId]);
			}
		}
		for (const [key, load] of loads) {
			pairs.set(key, [load.tenantId, load.moduleId]);
		}
		await Promise.all(
			[...pairs.values()].map(([tenantId, moduleId]) =>
				read(tenantId, moduleId),
			),
		);
	};

	/* A held pair is read again only after the log read that named it, so the
	   reload reflects that change; a pair first loaded later reflects it too. */
	const revalidate = async (): Promise<void> => {
		if (!log) return;
		const startedAt = now();
		const page =
			cursor === null
				? null
				: await log.after({
						after: cursor,
						limit: MODULE_SETTINGS_CHANGES_PAGE_MAX,
					});
		if (page === null || page.expired || page.more) {
			const head = await log.newest();
			await reloadHeld();
			cursor = head.cursor;
			reflected = Math.max(reflected, head.revision);
		} else {
			const named = new Map<string, readonly [string, string]>();
			for (const change of page.changes) {
				if (held(change.tenantId, change.moduleId)) {
					named.set(pairKey(change.tenantId, change.moduleId), [
						change.tenantId,
						change.moduleId,
					]);
				}
			}
			await Promise.all(
				[...named.values()].map(([tenantId, moduleId]) =>
					read(tenantId, moduleId),
				),
			);
			cursor = page.cursor;
			reflected = Math.max(reflected, page.changes.at(-1)?.revision ?? 0);
		}
		validatedAt = startedAt;
	};

	const sharedRevalidation = (): Promise<void> =>
		(revalidating ??= revalidate().finally(() => {
			revalidating = null;
		}));

	/* A revalidation begun after `begunAt` covers any revision the caller read
	   before it asked, so a revision still above `reflected` then is no
	   committed change and is not waited for. One begun in the same
	   millisecond may have read before the caller did. */
	const covered = (begunAt: number, revision: number | undefined): boolean =>
		cursor !== null &&
		validatedAt >= begunAt - MODULE_SETTINGS_STALENESS_MS &&
		(revision === undefined || reflected >= revision || validatedAt > begunAt);

	const ensureFresh = async (revision: number | undefined): Promise<void> => {
		const begunAt = now();
		if (covered(begunAt, revision)) return;
		if (revalidating) {
			await revalidating;
			if (covered(begunAt, revision)) return;
		}
		await sharedRevalidation();
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

	const prime = async (
		tenantId: string,
		primeOptions: ModuleSettingsPrimeOptions = {},
	): Promise<void> => {
		const revision = primeOptions.revision;
		if (
			revision !== undefined &&
			!(Number.isSafeInteger(revision) && revision >= 0)
		) {
			throw new ModuleSettingsError(
				'INVALID_SETTINGS_REVISION',
				'A settings revision is a non-negative integer.',
			);
		}
		if (log) await ensureFresh(revision);
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
		const loaded = snapshots.get(tenantId)?.get(moduleId);
		if (!loaded) {
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
		return loaded.values;
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
			const context: ModuleSettingChangeContext = {
				definition,
				actor: { accountId: actor, tenantId },
			};
			const commit =
				value === null
					? await store.clear(target, moduleId, key, context)
					: await store.save(
							{
								tenantId: target,
								moduleId,
								key,
								value: next,
								updatedBy: actor,
								updatedAt: now(),
							},
							context,
						);
			await read(target, moduleId);
			const change: ModuleSettingChange = {
				tenantId: target,
				moduleId,
				key,
				cleared: value === null,
				...(definition.kind ? { kind: definition.kind } : {}),
				previous,
				next: definition.secret ? null : next,
				actor: { accountId: actor, tenantId },
				...(commit ? { revision: commit.revision } : {}),
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
		async changesAfter(request) {
			assertChangesRequest(request);
			if (!log) {
				throw new ModuleSettingsError(
					'SETTINGS_LOG_UNAVAILABLE',
					'This settings store keeps no change log.',
					503,
				);
			}
			return log.after(request);
		},
	};
}
