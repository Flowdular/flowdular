import type {
	DataClassCountInput,
	DataClassErasureInput,
	DataClassErasureResult,
} from '@flowdular/kernel';
import { DATA_CLASS_LIMITS } from '../domain/data-classes.ts';
import { AuditServiceError } from './service-error.ts';

/**
 * An adapter, not the port. The erase operation belongs to the platform data
 * class declaration (`DataClassDeclaration.erase` in packages/kernel), which the
 * run resolves first: a module declares its classes and their erase operation in
 * one place and needs no composition order at all.
 *
 * This capability stays for a module that composes after audit.core and prefers
 * to register an operation for a class it declared elsewhere. It carries the
 * kernel input and result types unchanged, so a class resolved through either
 * route behaves identically, and a registration for a class the sealed registry
 * does not carry is ignored by the run rather than inventing a class id.
 */
export const AUDIT_ERASURE_CAPABILITY = 'audit.erasure.v1';

export type { DataClassErasureInput };

export interface DataClassErasureEntry {
	readonly moduleId: string;
	/** `${moduleId}.${key}`, the same id the data class registry carries. */
	readonly classId: string;
	/**
	 * Rows the subject holds, without removing any. A class that cannot count
	 * cheaply leaves it out and the plan says the count is unknown rather than
	 * guessing one.
	 */
	readonly count?: (input: DataClassCountInput) => Promise<number | null>;
	/** Removes at most `limit` rows of the subject and answers how many it removed. */
	readonly erase: (
		input: DataClassErasureInput,
	) => Promise<DataClassErasureResult>;
}

export interface AuditErasureRegistry {
	register(entry: DataClassErasureEntry): void;
	/** The operation registered for one class, or null. */
	get(classId: string): DataClassErasureEntry | null;
	/** Every registration, in composition order. */
	list(): readonly DataClassErasureEntry[];
}

export interface MutableAuditErasureRegistry extends AuditErasureRegistry {
	seal(): void;
}

/** Classes the adapter accepts. A deployment past this has a registration bug. */
export const ERASURE_LIMITS = {
	classes: 256,
	batch: 500,
	batches: 200,
} as const;

const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

function refuse(message: string): never {
	throw new AuditServiceError('ERASURE_REGISTRATION_INVALID', message, 500);
}

/**
 * Registrations are accepted while the platform composes and the registry is
 * sealed in audit.core's start hook, which the platform runs after every module
 * composed, so a run walks the set every module agreed on at boot.
 */
export function createErasureRegistry(): MutableAuditErasureRegistry {
	const entries = new Map<string, DataClassErasureEntry>();
	let sealed: readonly DataClassErasureEntry[] | null = null;
	return {
		register(entry) {
			if (sealed !== null) {
				refuse(
					`${entry?.moduleId ?? 'a module'} registered an erasure operation after the platform started; registrations are accepted during composition only.`,
				);
			}
			if (typeof entry !== 'object' || entry === null) {
				refuse('An erasure registration must be an object.');
			}
			if (
				typeof entry.moduleId !== 'string' ||
				entry.moduleId.length > DATA_CLASS_LIMITS.moduleId ||
				!MODULE_ID.test(entry.moduleId)
			) {
				refuse(`"${String(entry.moduleId)}" is not a module id.`);
			}
			if (
				typeof entry.classId !== 'string' ||
				entry.classId.length > DATA_CLASS_LIMITS.classId ||
				!entry.classId.startsWith(`${entry.moduleId}.`)
			) {
				refuse(
					`${entry.moduleId} registered "${String(entry.classId)}", which is not one of its class ids.`,
				);
			}
			if (typeof entry.erase !== 'function') {
				refuse(`${entry.classId} registered an erase that is not a function.`);
			}
			if (entry.count !== undefined && typeof entry.count !== 'function') {
				refuse(`${entry.classId} registered a count that is not a function.`);
			}
			if (entries.has(entry.classId)) {
				refuse(`${entry.classId} registered an erase operation twice.`);
			}
			if (entries.size >= ERASURE_LIMITS.classes) {
				refuse(
					`At most ${ERASURE_LIMITS.classes} classes may register an erase operation.`,
				);
			}
			entries.set(entry.classId, entry);
		},
		get(classId) {
			return entries.get(classId) ?? null;
		},
		list() {
			return sealed ?? [...entries.values()];
		},
		seal() {
			sealed ??= Object.freeze([...entries.values()]);
		},
	};
}
