import type {
	MeterKind,
	MeterLimit,
	MeterLimitEvent,
	MeterThreshold,
	MeterUsage,
	UsageBucket,
} from '../domain/types.ts';

/** The declaration a fact is recorded under, as the registry resolved it. */
export interface RecordedMeter {
	/** The full key, `<moduleId>.<key>`. */
	readonly key: string;
	readonly moduleId: string;
	readonly label: string;
	readonly unit: string;
	readonly kind: MeterKind;
}

/** Everything one fact needs, already validated and resolved by the service. */
export interface RecordFactInput {
	readonly tenantId: string;
	readonly meter: RecordedMeter;
	readonly day: string;
	readonly month: string;
	readonly amount: number;
	readonly sourceRef: string | null;
	readonly at: number;
}

export interface RecordFactResult {
	/** False when this source reference had already been counted. */
	readonly recorded: boolean;
	/** This month's usage after the fact landed; zero when nothing was. */
	readonly used: number;
	readonly limit: number | null;
}

export interface BucketQuery {
	readonly meter: string;
	readonly from: string;
	readonly to: string;
}

export interface SetLimitInput {
	readonly tenantId: string;
	readonly meter: string;
	readonly monthlyLimit: number;
	readonly setBy: string;
	readonly at: number;
}

export interface SetLimitResult {
	readonly limit: MeterLimit;
	readonly previousLimit: number | null;
	readonly event: MeterLimitEvent;
}

export interface UsageAgainstLimit {
	readonly used: number;
	readonly limit: number | null;
}

/** The database-agnostic business port. No driver type crosses it. */
export interface MeteringRepository {
	/**
	 * The whole fact in one tenant-scoped write transaction: the meter as this
	 * workspace recorded it, the idempotency claim, the day bucket, and the
	 * threshold rows this fact is the first to reach.
	 */
	recordFact(input: RecordFactInput): Promise<RecordFactResult>;
	/**
	 * Claims the thresholds of one meter and month that have not been claimed
	 * yet and answers the ones this call won. A claim that never reaches a
	 * published notification is the price of publishing at most once; a claim
	 * lost to a crash before the insert is re-evaluated by the next fact.
	 */
	claimThresholds(
		tenantId: string,
		meter: string,
		month: string,
		thresholds: readonly MeterThreshold[],
		at: number,
	): Promise<readonly MeterThreshold[]>;
	/** This month's usage and the limit of one meter, in one read. */
	usageAgainstLimit(
		tenantId: string,
		meter: string,
		month: string,
	): Promise<UsageAgainstLimit>;
	/** Every meter this workspace recorded, with the month's usage and limit. */
	listMeterUsage(
		tenantId: string,
		month: string,
	): Promise<readonly MeterUsage[]>;
	listBuckets(
		tenantId: string,
		query: BucketQuery,
	): Promise<readonly UsageBucket[]>;
	listLimits(tenantId: string): Promise<readonly MeterLimit[]>;
	setLimit(input: SetLimitInput): Promise<SetLimitResult>;
	listLimitEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly MeterLimitEvent[]>;
	/**
	 * Removes at most `limit` buckets older than the UTC day `beforeDay`, and
	 * the idempotency claims of the same days with them: a claim outliving its
	 * bucket would suppress a fact whose usage is already gone.
	 */
	sweepBuckets(
		tenantId: string,
		beforeDay: string,
		limit: number,
	): Promise<{ readonly removed: number }>;
	/** One keyset page of buckets, ordered by id, for the export walk. */
	exportBucketsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly UsageBucket[]>;
}
