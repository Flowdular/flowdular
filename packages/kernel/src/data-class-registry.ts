import { RegistryError } from './errors.ts';

/* The platform-wide catalogue of the data a deployment holds. A module that
   owns rows declares its classes while the platform composes; the registry is
   sealed before start hooks run, so every reader sees the same declarations
   for the life of the process. The owner keeps its own operations: a sweep, an
   export and an erasure run inside the declaring module, on its own leases,
   under its own tenant transaction, so the reader of the registry opens no
   foreign table. */

/** Where one exported row goes. The caller owns the ordering and the shape. */
export interface DataClassExportSink {
	write(row: Record<string, unknown>): Promise<void>;
}

export interface DataClassSweepInput {
	readonly tenantId: string;
	/** Rows whose retention timestamp is strictly older than this may go. */
	readonly cutoff: Date;
	/** Upper bound on rows this call may remove. */
	readonly limit: number;
}

export interface DataClassExportInput {
	readonly tenantId: string;
	readonly sink: DataClassExportSink;
}

export interface DataClassExportSummary {
	readonly rows: number;
	/** Oldest and newest record time in the exported set, or null when empty. */
	readonly from: Date | null;
	readonly to: Date | null;
}

/** The person an erasure or a count is about. */
export interface DataClassSubject {
	readonly accountId: string;
}

export interface DataClassErasureInput {
	readonly tenantId: string;
	readonly subject: DataClassSubject;
	/** Upper bound on rows this call may remove. */
	readonly limit: number;
}

export interface DataClassErasureResult {
	readonly removed: number;
	/**
	 * True when rows of the subject are left that this call did not reach. The
	 * caller repeats the call up to its own batch cap and records the class as
	 * incomplete when the flag still stands.
	 */
	readonly truncated?: boolean;
}

export interface DataClassCountInput {
	readonly tenantId: string;
	readonly subject: DataClassSubject;
}

export interface DataClassDeclaration {
	/** `^[a-z][a-z0-9-]*$`; the class id is `${moduleId}.${key}`. */
	readonly key: string;
	readonly label: string;
	/** Days, or null for kept until a person deletes. Zero is refused. */
	readonly defaultRetentionDays: number | null;
	readonly exportable: boolean;
	/** Required when `exportable` is false; it reaches the export manifest. */
	readonly excludedReason?: string;
	/**
	 * Removes at most `limit` rows older than `cutoff` and answers how many it
	 * removed. A class without this operation is never swept. The operation runs
	 * inside the owner module and must use its own tenant-scoped transaction.
	 */
	readonly sweep?: (
		input: DataClassSweepInput,
	) => Promise<{ readonly removed: number }>;
	/**
	 * Writes every row of the class for one workspace into the sink. A class
	 * without this operation is reported in the export manifest as excluded.
	 * The operation runs inside the owner module and must use its own
	 * tenant-scoped transaction.
	 */
	readonly export?: (
		input: DataClassExportInput,
	) => Promise<DataClassExportSummary>;
	/**
	 * Removes at most `limit` rows one subject owns and answers how many it
	 * removed. A class without this operation is never erased: the plan and the
	 * certificate name it as not erasable rather than pretending it was cleared.
	 * The operation runs inside the owner module and must use its own
	 * tenant-scoped transaction.
	 */
	readonly erase?: (
		input: DataClassErasureInput,
	) => Promise<DataClassErasureResult>;
	/**
	 * Rows the subject holds, without removing any. A class that cannot count
	 * cheaply leaves the operation out or answers null, and the plan says the
	 * count is unknown rather than guessing one.
	 */
	readonly count?: (input: DataClassCountInput) => Promise<number | null>;
}

export interface DataClassModuleEntry {
	readonly moduleId: string;
	readonly classes: readonly DataClassDeclaration[];
}

export interface PlatformDataClassRegistry {
	/**
	 * The platform form, for a module composed outside the module composition
	 * and for a module naming the classes it owns. A bound view accepts only
	 * its own id. Accepted while the platform composes; after `seal()` it
	 * throws, so the catalogue a request reads is the one every module agreed
	 * on at boot. A module that owns no class declares an empty list, so the
	 * workspace can see it holds none.
	 */
	declare(moduleId: string, classes: readonly DataClassDeclaration[]): void;
	/** The module form, available on a view bound by `forModule`. */
	declare(classes: readonly DataClassDeclaration[]): void;
	/** Returns a view that declares classes owned by one module only. */
	forModule(moduleId: string): PlatformDataClassRegistry;
	/**
	 * Every module that declared, in composition order, including the ones that
	 * declared nothing. A bound view answers the whole catalogue: the binding
	 * limits what a module may declare, never what it may read.
	 */
	list(): readonly DataClassModuleEntry[];
}

export interface MutablePlatformDataClassRegistry
	extends PlatformDataClassRegistry {
	seal(): void;
}

/** Longest values the registry accepts; over any of them is a rejection. */
export const DATA_CLASS_LIMITS = {
	moduleId: 64,
	key: 48,
	classId: 96,
	label: 120,
	excludedReason: 200,
	classesPerModule: 64,
	/** 100 years. A longer period is a mistake, not a policy. */
	retentionDays: 36_500,
} as const;

const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const CLASS_KEY = /^[a-z][a-z0-9-]*$/;

function refuse(message: string): never {
	throw new RegistryError('DATA_CLASS_DECLARATION_INVALID', message);
}

export function createDataClassRegistry(): MutablePlatformDataClassRegistry {
	/** Declaration order, so the registry reads the way composition ran. */
	const modules = new Map<string, readonly DataClassDeclaration[]>();
	/** Class id to owner, so a duplicate is refused in O(1). */
	const owners = new Map<string, string>();
	let sealed: readonly DataClassModuleEntry[] | null = null;

	const snapshot = (): readonly DataClassModuleEntry[] =>
		Object.freeze(
			[...modules].map(([moduleId, classes]) => ({ moduleId, classes })),
		);

	const view = (boundModuleId?: string): PlatformDataClassRegistry => {
		const self: PlatformDataClassRegistry = {
			declare(
				first: string | readonly DataClassDeclaration[],
				second?: readonly DataClassDeclaration[],
			): void {
				const named = typeof first === 'string';
				const moduleId = named ? first : boundModuleId;
				const classes = named ? second : first;
				if (moduleId === undefined) {
					refuse(
						'The platform data class registry needs a module id: call declare(moduleId, classes) or bind it with forModule(moduleId).',
					);
				}
				if (boundModuleId !== undefined && moduleId !== boundModuleId) {
					refuse(
						`Module ${boundModuleId} cannot declare data classes owned by ${moduleId}.`,
					);
				}
				declareClasses(moduleId, classes as readonly DataClassDeclaration[]);
			},
			forModule(moduleId: string): PlatformDataClassRegistry {
				const normalized = moduleId.trim();
				if (!normalized)
					refuse('A module-bound data class registry needs an id.');
				if (boundModuleId !== undefined && normalized !== boundModuleId) {
					refuse(
						`Module ${boundModuleId} cannot obtain the data class registrar for ${normalized}.`,
					);
				}
				return boundModuleId === normalized ? self : view(normalized);
			},
			list(): readonly DataClassModuleEntry[] {
				return sealed ?? snapshot();
			},
		};
		return self;
	};

	function declareClasses(
		moduleId: string,
		classes: readonly DataClassDeclaration[],
	): void {
		if (sealed !== null) {
			refuse(
				`${moduleId} declared data classes after the platform started; declarations are accepted during composition only.`,
			);
		}
		if (
			typeof moduleId !== 'string' ||
			moduleId.length > DATA_CLASS_LIMITS.moduleId ||
			!MODULE_ID.test(moduleId)
		) {
			refuse(`"${String(moduleId)}" is not a module id.`);
		}
		if (modules.has(moduleId)) {
			refuse(`${moduleId} declared its data classes twice.`);
		}
		if (!Array.isArray(classes)) {
			refuse(`${moduleId} declared something other than a list of classes.`);
		}
		if (classes.length > DATA_CLASS_LIMITS.classesPerModule) {
			refuse(
				`${moduleId} declared ${classes.length} data classes; at most ${DATA_CLASS_LIMITS.classesPerModule} are accepted.`,
			);
		}
		/* Nothing is recorded until every class of the module validated, so a
		   refused declaration leaves the registry exactly as it was. */
		const accepted = new Set<string>();
		for (const declaration of classes) {
			const classId = validated(moduleId, declaration);
			const taken = owners.get(classId);
			if (taken || accepted.has(classId)) {
				refuse(
					`${moduleId} declared ${classId}, which ${taken ?? moduleId} already owns.`,
				);
			}
			accepted.add(classId);
		}
		modules.set(moduleId, Object.freeze([...classes]));
		for (const classId of accepted) owners.set(classId, moduleId);
	}

	return {
		...view(),
		seal(): void {
			if (sealed !== null) return;
			sealed = snapshot();
		},
	};
}

/** Answers the class id, so a caller can index the declarations it accepted. */
function validated(
	moduleId: string,
	declaration: DataClassDeclaration,
): string {
	if (typeof declaration !== 'object' || declaration === null) {
		refuse(`${moduleId} declared something other than a data class.`);
	}
	const key = declaration.key;
	if (
		typeof key !== 'string' ||
		key.length > DATA_CLASS_LIMITS.key ||
		!CLASS_KEY.test(key)
	) {
		refuse(`${moduleId} declared "${String(key)}", which is not a class key.`);
	}
	const classId = `${moduleId}.${key}`;
	if (classId.length > DATA_CLASS_LIMITS.classId) {
		refuse(
			`${classId} is longer than ${DATA_CLASS_LIMITS.classId} characters.`,
		);
	}
	const label = declaration.label;
	if (
		typeof label !== 'string' ||
		label.trim().length < 1 ||
		label.length > DATA_CLASS_LIMITS.label
	) {
		refuse(
			`${classId} needs a label of 1 to ${DATA_CLASS_LIMITS.label} characters.`,
		);
	}
	const days = declaration.defaultRetentionDays;
	if (
		days !== null &&
		(!Number.isSafeInteger(days) ||
			days < 1 ||
			days > DATA_CLASS_LIMITS.retentionDays)
	) {
		refuse(
			`${classId} declared a default retention of ${String(days)}; it must be null or 1 to ${DATA_CLASS_LIMITS.retentionDays} days.`,
		);
	}
	if (typeof declaration.exportable !== 'boolean') {
		refuse(`${classId} must say whether it is exportable.`);
	}
	const reason = declaration.excludedReason;
	if (!declaration.exportable) {
		if (
			typeof reason !== 'string' ||
			reason.trim().length < 1 ||
			reason.length > DATA_CLASS_LIMITS.excludedReason
		) {
			refuse(
				`${classId} is not exportable and must state why in excludedReason.`,
			);
		}
	}
	if (
		declaration.sweep !== undefined &&
		typeof declaration.sweep !== 'function'
	) {
		refuse(`${classId} declared a sweep operation that is not a function.`);
	}
	if (
		declaration.export !== undefined &&
		typeof declaration.export !== 'function'
	) {
		refuse(`${classId} declared an export operation that is not a function.`);
	}
	if (
		declaration.erase !== undefined &&
		typeof declaration.erase !== 'function'
	) {
		refuse(`${classId} declared an erase operation that is not a function.`);
	}
	if (
		declaration.count !== undefined &&
		typeof declaration.count !== 'function'
	) {
		refuse(`${classId} declared a count operation that is not a function.`);
	}
	return classId;
}
