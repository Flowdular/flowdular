import type { MeterKind } from './types.ts';

/**
 * The public cross-module surface. A metering module resolves it through
 * `context.capabilities.get<MeterRegistry>(METERING_METERS_CAPABILITY)` during
 * its own composition, declares what it counts, and reports facts at run time.
 */
export const METERING_METERS_CAPABILITY = 'metering.meters.v1';

/** The stable code a caller records when `check` refuses. */
export const METER_LIMIT_EXCEEDED = 'METER_LIMIT_EXCEEDED';

export interface MeterDeclaration {
	/** `^[a-z][a-z0-9-]*$`; the meter key is `${moduleId}.${key}`. */
	readonly key: string;
	readonly label: string;
	readonly unit: string;
	readonly kind: MeterKind;
}

export interface MeterRecordInput {
	readonly tenantId: string;
	/** The full key, `<moduleId>.<key>`, as `declare` composed it. */
	readonly meter: string;
	/** Whole units of the meter. Never negative. */
	readonly amount: number;
	/** Epoch milliseconds the fact happened at; the caller's clock by default. */
	readonly at?: number;
	/** Makes the fact idempotent. Without it every call counts again. */
	readonly sourceRef?: string;
}

export interface MeterRecordResult {
	/** False when this source reference was already counted. */
	readonly recorded: boolean;
	/** The UTC day bucket the fact landed in, `YYYY-MM-DD`. */
	readonly day: string;
}

export interface MeterCheckInput {
	readonly tenantId: string;
	readonly meter: string;
	readonly amount: number;
}

/**
 * `refused` once this month's usage plus the amount would pass the limit,
 * `warning` when the amount is what carries the month past the warning share
 * of the limit, `allowed` otherwise. A workspace with no limit is always
 * allowed.
 */
export type MeterVerdict = 'allowed' | 'warning' | 'refused';

export interface MeterCheckResult {
	readonly verdict: MeterVerdict;
	/** This calendar month's usage in UTC, before the amount asked about. */
	readonly used: number;
	/** The operator's ceiling, or null when this workspace is unlimited. */
	readonly limit: number | null;
}

export interface MeterRegistry {
	/**
	 * Accepted only while the platform composes. Declaring after the platform
	 * started throws, so the meters a request reads are the ones every module
	 * agreed on at boot.
	 */
	declare(moduleId: string, meters: readonly MeterDeclaration[]): void;
	/**
	 * Counts one fact in metering.core's own tenant-scoped write transaction,
	 * not in the caller's: no database handle crosses this boundary. The fact
	 * therefore commits independently of whatever the caller is doing, and a
	 * caller that wants exactly-once semantics names a `sourceRef`, which makes
	 * a repeat a no-op.
	 */
	record(input: MeterRecordInput): Promise<MeterRecordResult>;
	/** Reads this month's usage against the limit. Writes nothing. */
	check(input: MeterCheckInput): Promise<MeterCheckResult>;
}

/** Longest values and largest amounts the capability accepts. */
export const METER_LIMITS = {
	moduleId: 64,
	/** The declared key, before the module id is prefixed. */
	key: 96,
	label: 120,
	unit: 32,
	sourceRef: 200,
	tenantId: 128,
	metersPerModule: 64,
	/**
	 * One fact. The month sum is a BIGINT sum of these, so it leaves the safe
	 * integer range after roughly 9007 facts at this amount; past that the sum
	 * is read as `Number.MAX_SAFE_INTEGER` rather than failing the fact that
	 * crossed the line (`DatabaseMeteringRepository`).
	 */
	amount: 1_000_000_000_000,
	monthlyLimit: 1_000_000_000_000,
	setBy: 128,
} as const;
