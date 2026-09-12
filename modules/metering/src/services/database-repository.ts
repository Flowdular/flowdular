import { randomUUID } from 'node:crypto';
import type {
	DatabaseHandle,
	DatabaseMigrationResult,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import type {
	Meter,
	MeterKind,
	MeterLimit,
	MeterLimitEvent,
	MeterThreshold,
	MeterUsage,
	UsageBucket,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	BucketQuery,
	MeteringRepository,
	RecordFactInput,
	RecordFactResult,
	SetLimitInput,
	SetLimitResult,
	UsageAgainstLimit,
} from './repository.ts';

interface MeterRow {
	id: string;
	tenant_id: string;
	meter_key: string;
	module_id: string;
	label: string;
	unit: string;
	kind: MeterKind;
	created_at: number | bigint | string;
}

interface BucketRow {
	id: string;
	tenant_id: string;
	meter_key: string;
	day: string;
	amount: number | bigint | string;
	events: number | bigint | string;
	updated_at: number | bigint | string;
}

interface LimitRow {
	id: string;
	tenant_id: string;
	meter_key: string;
	monthly_limit: number | bigint | string;
	set_by: string;
	updated_at: number | bigint | string;
}

interface LimitEventRow {
	id: string;
	tenant_id: string;
	meter_key: string;
	monthly_limit: number | bigint | string;
	previous_limit: number | bigint | string | null;
	set_by: string;
	occurred_at: number | bigint | string;
}

interface MeterUsageRow extends MeterRow {
	used: number | bigint | string | null;
	monthly_limit: number | bigint | string | null;
}

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const SQL = {
	upsertMeter: `INSERT INTO metering_meters
	 (id, tenant_id, meter_key, module_id, label, unit, kind, created_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	 ON CONFLICT (tenant_id, meter_key) DO NOTHING`,
	claimRecord: `INSERT INTO metering_records
	 (id, tenant_id, meter_key, source_ref, day, amount, recorded_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7)
	 ON CONFLICT (tenant_id, meter_key, source_ref) DO NOTHING
	 RETURNING id`,
	accumulateBucket: `INSERT INTO metering_buckets
	 (id, tenant_id, meter_key, day, amount, events, updated_at)
	 VALUES ($1, $2, $3, $4, $5, 1, $6)
	 ON CONFLICT (tenant_id, meter_key, day) DO UPDATE
	 SET amount = metering_buckets.amount + EXCLUDED.amount,
	     events = metering_buckets.events + 1,
	     updated_at = EXCLUDED.updated_at`,
	monthUsage: `SELECT COALESCE(SUM(amount), 0) AS used FROM metering_buckets
	 WHERE tenant_id = $1 AND meter_key = $2 AND day >= $3 AND day <= $4`,
	findLimit: `SELECT monthly_limit FROM metering_limits
	 WHERE tenant_id = $1 AND meter_key = $2`,
	/* A fact reads the month sum to decide whether it crossed a threshold. Two
	   facts of the same month on different days touch different bucket rows, so
	   nothing else makes them queue: the limit row is the one thing they share,
	   and locking it first means the later one sums after the earlier committed
	   instead of both reading a total below the threshold. */
	findLimitForUpdate: `SELECT monthly_limit FROM metering_limits
	 WHERE tenant_id = $1 AND meter_key = $2 FOR UPDATE`,
	claimThreshold: `INSERT INTO metering_threshold_notices
	 (id, tenant_id, meter_key, month, threshold, sent_at)
	 VALUES ($1, $2, $3, $4, $5, $6)
	 ON CONFLICT (tenant_id, meter_key, month, threshold) DO NOTHING
	 RETURNING threshold`,
	listMeterUsage: `SELECT meter.id, meter.tenant_id, meter.meter_key,
	        meter.module_id, meter.label, meter.unit, meter.kind,
	        meter.created_at,
	        (SELECT COALESCE(SUM(bucket.amount), 0) FROM metering_buckets AS bucket
	         WHERE bucket.tenant_id = meter.tenant_id
	           AND bucket.meter_key = meter.meter_key
	           AND bucket.day >= $2 AND bucket.day <= $3) AS used,
	        (SELECT ceiling.monthly_limit FROM metering_limits AS ceiling
	         WHERE ceiling.tenant_id = meter.tenant_id
	           AND ceiling.meter_key = meter.meter_key) AS monthly_limit
	 FROM metering_meters AS meter
	 WHERE meter.tenant_id = $1
	 ORDER BY meter.meter_key`,
	listBuckets: `SELECT id, tenant_id, meter_key, day, amount, events, updated_at
	 FROM metering_buckets
	 WHERE tenant_id = $1 AND meter_key = $2 AND day >= $3 AND day <= $4
	 ORDER BY day`,
	listLimits: `SELECT id, tenant_id, meter_key, monthly_limit, set_by, updated_at
	 FROM metering_limits WHERE tenant_id = $1 ORDER BY meter_key`,
	upsertLimit: `INSERT INTO metering_limits
	 (id, tenant_id, meter_key, monthly_limit, set_by, updated_at)
	 VALUES ($1, $2, $3, $4, $5, $6)
	 ON CONFLICT (tenant_id, meter_key) DO UPDATE
	 SET monthly_limit = EXCLUDED.monthly_limit,
	     set_by = EXCLUDED.set_by,
	     updated_at = EXCLUDED.updated_at
	 RETURNING id, tenant_id, meter_key, monthly_limit, set_by, updated_at`,
	insertLimitEvent: `INSERT INTO metering_limit_events
	 (id, tenant_id, meter_key, monthly_limit, previous_limit, set_by,
	  occurred_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
	/* One pass, one count: the claims go with the buckets they belong to, on
	   the day set this pass actually removed, so a claim never outlives its
	   bucket and `removed` stays the number of rows the class asked for rather
	   than that number plus however many claims those days carried. */
	sweepBuckets: `WITH swept AS (
	     DELETE FROM metering_buckets WHERE id IN (
	       SELECT id FROM metering_buckets
	       WHERE tenant_id = $1 AND day < $2 ORDER BY day, id LIMIT $3)
	     RETURNING meter_key, day
	   ), claims AS (
	     DELETE FROM metering_records AS record
	     USING swept
	     WHERE record.tenant_id = $1
	       AND record.meter_key = swept.meter_key
	       AND record.day = swept.day
	     RETURNING record.id
	   )
	   SELECT count(*) AS removed FROM swept`,
	exportBuckets: `SELECT id, tenant_id, meter_key, day, amount, events,
	        updated_at
	 FROM metering_buckets
	 WHERE tenant_id = $1 AND id > $2
	 ORDER BY id LIMIT $3`,
	listLimitEvents: `SELECT id, tenant_id, meter_key, monthly_limit,
	        previous_limit, set_by, occurred_at
	 FROM metering_limit_events WHERE tenant_id = $1
	 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
} as const;

/* PostgreSQL returns BIGINT as a string, so every counter crosses this. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The metering database returned an invalid ${field}.`);
	}
	return normalized;
}

/**
 * A month sum, over-approximated at the top of the safe integer range. The sum
 * is read inside the transaction that counts a fact, and refusing it there
 * would roll the counted fact back: a reporter without a source reference
 * would then retry and count it twice. Any ceiling is at most 1e12, so a sum
 * this large is over every limit, which is the answer the threshold and the
 * verdict need.
 */
function monthSum(value: number | bigint | string | null): number {
	const normalized = Number(value ?? 0);
	if (!Number.isFinite(normalized) || normalized < 0) {
		throw new Error('The metering database returned an invalid month usage.');
	}
	return Math.min(normalized, Number.MAX_SAFE_INTEGER);
}

function meterFromRow(row: MeterRow): Meter {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.meter_key,
		moduleId: row.module_id,
		label: row.label,
		unit: row.unit,
		kind: row.kind,
		createdAt: integer(row.created_at, 'meter timestamp'),
	};
}

function bucketFromRow(row: BucketRow): UsageBucket {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		meter: row.meter_key,
		day: row.day,
		amount: integer(row.amount, 'bucket amount'),
		events: integer(row.events, 'bucket event count'),
		updatedAt: integer(row.updated_at, 'bucket timestamp'),
	};
}

function limitFromRow(row: LimitRow): MeterLimit {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		meter: row.meter_key,
		monthlyLimit: integer(row.monthly_limit, 'monthly limit'),
		setBy: row.set_by,
		updatedAt: integer(row.updated_at, 'limit timestamp'),
	};
}

function limitEventFromRow(row: LimitEventRow): MeterLimitEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		meter: row.meter_key,
		monthlyLimit: integer(row.monthly_limit, 'monthly limit'),
		previousLimit:
			row.previous_limit === null
				? null
				: integer(row.previous_limit, 'previous monthly limit'),
		setBy: row.set_by,
		occurredAt: integer(row.occurred_at, 'limit event timestamp'),
	};
}

/** The first and last day of a `YYYY-MM` month as sortable `YYYY-MM-DD` text. */
export function monthRange(month: string): { from: string; to: string } {
	return { from: `${month}-01`, to: `${month}-31` };
}

export class DatabaseMeteringRepository implements MeteringRepository {
	constructor(private readonly runtime: DatabaseHandle) {}

	async #read<Row extends object>(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<readonly Row[]> {
		const result = await this.runtime.transaction(
			(transaction) => transaction.query<Row>(statement),
			{ access: 'read', tenantId },
		);
		return result.rows;
	}

	async #monthUsage(
		transaction: DatabaseTransaction,
		tenantId: string,
		meter: string,
		month: string,
	): Promise<number> {
		const range = monthRange(month);
		const result = await transaction.query<{
			used: number | bigint | string | null;
		}>({
			text: SQL.monthUsage,
			parameters: [tenantId, meter, range.from, range.to],
		});
		return monthSum(result.rows[0]?.used ?? 0);
	}

	/**
	 * One write transaction: the meter as this workspace recorded it, the
	 * idempotency claim, the day bucket, and the threshold rows this fact is the
	 * first to reach. A workspace without a limit never pays for the month sum.
	 */
	async recordFact(input: RecordFactInput): Promise<RecordFactResult> {
		return this.runtime.transaction<RecordFactResult>(
			async (transaction) => {
				await transaction.execute({
					text: SQL.upsertMeter,
					parameters: [
						randomUUID(),
						input.tenantId,
						input.meter.key,
						input.meter.moduleId,
						input.meter.label,
						input.meter.unit,
						input.meter.kind,
						input.at,
					],
				});
				if (input.sourceRef !== null) {
					const claimed = await transaction.query<{ id: string }>({
						text: SQL.claimRecord,
						parameters: [
							randomUUID(),
							input.tenantId,
							input.meter.key,
							input.sourceRef,
							input.day,
							input.amount,
							input.at,
						],
					});
					/* A repeat changed no bucket, so it can cross no threshold and
					   nothing downstream reads its usage. It pays for no further
					   statement: a retry storm is the case this path exists for. */
					if (claimed.rows.length === 0) {
						return { recorded: false, used: 0, limit: null, claimed: [] };
					}
				}
				await transaction.execute({
					text: SQL.accumulateBucket,
					parameters: [
						randomUUID(),
						input.tenantId,
						input.meter.key,
						input.day,
						input.amount,
						input.at,
					],
				});
				const limit = await transaction.query<{
					monthly_limit: number | bigint | string;
				}>({
					text: SQL.findLimitForUpdate,
					parameters: [input.tenantId, input.meter.key],
				});
				const ceiling = limit.rows[0];
				if (ceiling === undefined) {
					return { recorded: true, used: 0, limit: null, claimed: [] };
				}
				return {
					recorded: true,
					used: await this.#monthUsage(
						transaction,
						input.tenantId,
						input.meter.key,
						input.month,
					),
					limit: integer(ceiling.monthly_limit, 'monthly limit'),
				};
			},
			{ access: 'write', tenantId: input.tenantId },
		);
	}

	async claimThresholds(
		tenantId: string,
		meter: string,
		month: string,
		thresholds: readonly MeterThreshold[],
		at: number,
	): Promise<readonly MeterThreshold[]> {
		if (thresholds.length === 0) return [];
		return this.runtime.transaction<readonly MeterThreshold[]>(
			async (transaction) => {
				const claimed: MeterThreshold[] = [];
				for (const threshold of thresholds) {
					const inserted = await transaction.query<{
						threshold: MeterThreshold;
					}>({
						text: SQL.claimThreshold,
						parameters: [randomUUID(), tenantId, meter, month, threshold, at],
					});
					if (inserted.rows.length > 0) claimed.push(threshold);
				}
				return claimed;
			},
			{ access: 'write', tenantId },
		);
	}

	async usageAgainstLimit(
		tenantId: string,
		meter: string,
		month: string,
	): Promise<UsageAgainstLimit> {
		return this.runtime.transaction<UsageAgainstLimit>(
			async (transaction) => {
				const limit = await transaction.query<{
					monthly_limit: number | bigint | string;
				}>({ text: SQL.findLimit, parameters: [tenantId, meter] });
				const used = await this.#monthUsage(
					transaction,
					tenantId,
					meter,
					month,
				);
				const ceiling = limit.rows[0];
				return {
					used,
					limit:
						ceiling === undefined
							? null
							: integer(ceiling.monthly_limit, 'monthly limit'),
				};
			},
			{ access: 'read', tenantId },
		);
	}

	async listMeterUsage(
		tenantId: string,
		month: string,
	): Promise<readonly MeterUsage[]> {
		const range = monthRange(month);
		const rows = await this.#read<MeterUsageRow>(tenantId, {
			text: SQL.listMeterUsage,
			parameters: [tenantId, range.from, range.to],
		});
		return rows.map((row) => ({
			meter: meterFromRow(row),
			month,
			used: integer(row.used ?? 0, 'month usage'),
			limit:
				row.monthly_limit === null
					? null
					: integer(row.monthly_limit, 'monthly limit'),
		}));
	}

	async listBuckets(
		tenantId: string,
		query: BucketQuery,
	): Promise<readonly UsageBucket[]> {
		const rows = await this.#read<BucketRow>(tenantId, {
			text: SQL.listBuckets,
			parameters: [tenantId, query.meter, query.from, query.to],
		});
		return rows.map(bucketFromRow);
	}

	async listLimits(tenantId: string): Promise<readonly MeterLimit[]> {
		const rows = await this.#read<LimitRow>(tenantId, {
			text: SQL.listLimits,
			parameters: [tenantId],
		});
		return rows.map(limitFromRow);
	}

	/* The ceiling and the evidence of how it got there are written together: a
	   limit row without its event would leave the operator's label unexplained. */
	async setLimit(input: SetLimitInput): Promise<SetLimitResult> {
		return this.runtime.transaction<SetLimitResult>(
			async (transaction) => {
				const existing = await transaction.query<{
					monthly_limit: number | bigint | string;
				}>({
					text: SQL.findLimit,
					parameters: [input.tenantId, input.meter],
				});
				const previous = existing.rows[0];
				const previousLimit =
					previous === undefined
						? null
						: integer(previous.monthly_limit, 'monthly limit');
				const saved = await transaction.query<LimitRow>({
					text: SQL.upsertLimit,
					parameters: [
						randomUUID(),
						input.tenantId,
						input.meter,
						input.monthlyLimit,
						input.setBy,
						input.at,
					],
				});
				const row = saved.rows[0];
				if (!row) {
					throw new Error('The metering database did not return the limit.');
				}
				const event: MeterLimitEvent = {
					id: randomUUID(),
					tenantId: input.tenantId,
					meter: input.meter,
					monthlyLimit: input.monthlyLimit,
					previousLimit,
					setBy: input.setBy,
					occurredAt: input.at,
				};
				await transaction.execute({
					text: SQL.insertLimitEvent,
					parameters: [
						event.id,
						event.tenantId,
						event.meter,
						event.monthlyLimit,
						event.previousLimit,
						event.setBy,
						event.occurredAt,
					],
				});
				return { limit: limitFromRow(row), previousLimit, event };
			},
			{ access: 'write', tenantId: input.tenantId },
		);
	}

	async listLimitEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly MeterLimitEvent[]> {
		const rows = await this.#read<LimitEventRow>(tenantId, {
			text: SQL.listLimitEvents,
			parameters: [tenantId, limit],
		});
		return rows.map(limitEventFromRow);
	}

	async sweepBuckets(
		tenantId: string,
		beforeDay: string,
		limit: number,
	): Promise<{ readonly removed: number }> {
		return this.runtime.transaction<{ readonly removed: number }>(
			async (transaction) => {
				const swept = await transaction.query<{
					removed: number | bigint | string;
				}>({
					text: SQL.sweepBuckets,
					parameters: [tenantId, beforeDay, limit],
				});
				return {
					removed: integer(swept.rows[0]?.removed ?? 0, 'swept bucket count'),
				};
			},
			{ access: 'write', tenantId },
		);
	}

	async exportBucketsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly UsageBucket[]> {
		const rows = await this.#read<BucketRow>(tenantId, {
			text: SQL.exportBuckets,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(bucketFromRow);
	}
}

/**
 * Applies the module's schema, or with `dryRun` only reads the ledger and
 * answers what a run would do. A command that is not applying anything must
 * not create tables on the way to a read, so it asks for the dry run and gets
 * the same checksum and adoption refusals without the DDL.
 */
export async function migrateMeteringDatabase(
	database: DatabaseHandle,
	options: { readonly dryRun?: boolean } = {},
): Promise<readonly DatabaseMigrationResult[]> {
	return runDatabaseMigrations(
		database,
		'metering.core',
		databaseMigrations,
		options,
	);
}
