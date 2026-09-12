import {
	METER_LIMITS,
	type MeterCheckInput,
	type MeterCheckResult,
	type MeterRecordInput,
	type MeterRecordResult,
	type MeterVerdict,
} from '../domain/meters.ts';
import type {
	MeterLimit,
	MeterLimitEvent,
	MeterThreshold,
	MeterUsage,
	UsageBucket,
} from '../domain/types.ts';
import type {
	DeclaredMeter,
	MeterDeclarationRegistry,
} from './meter-registry.ts';
import {
	publishThresholdNotice,
	type NotificationPublisherResolver,
} from './notifications.ts';
import type { MeteringRepository } from './repository.ts';
import { bounded, MeteringServiceError, wholeNumber } from './service-error.ts';

/** Widest window a bucket read may cover, which is the default retention. */
export const MAX_BUCKET_WINDOW_DAYS = 400;

/** Rows one export page carries, so a walk never loads a whole table. */
export const EXPORT_PAGE = 500;

/** Rows one sweep pass may remove, whatever the registry asks for. */
export const MAX_SWEEP_BATCH = 100_000;

/** Bounds the platform setting: below 50 or at 100 it is not a warning. */
export const WARNING_PERCENT_RANGE = { minimum: 50, maximum: 99 } as const;

const DAY_MS = 86_400_000;

/** The widest instant a Date represents, and the edge of the four-digit year. */
export const MAX_INSTANT_MS = 8_640_000_000_000_000;

/* UTC so a workspace rollup does not move when a reader's clock does, and
   computed at write time so a month total stays an index range scan. The shape
   is asserted because the top of the Date range formats as an expanded year
   (`+275760-09-13`), which slices to ten characters that are not a day. */
export function utcDay(timestamp: number): string {
	const day =
		Number.isFinite(timestamp) && Math.abs(timestamp) <= MAX_INSTANT_MS
			? new Date(timestamp).toISOString().slice(0, 10)
			: '';
	if (!DAY.test(day)) {
		throw new MeteringServiceError(
			'INVALID_INPUT',
			'The instant is outside the range a UTC day covers.',
		);
	}
	return day;
}

export function utcMonth(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 7);
}

/** The usage at which a share of a limit counts as reached, in whole units. */
export function thresholdPoint(limit: number, percent: number): number {
	return Math.ceil((limit * percent) / 100);
}

export interface MeteringServiceOptions {
	readonly repository: MeteringRepository;
	readonly registry: MeterDeclarationRegistry;
	/** Live platform setting; read again for every fact. */
	readonly warningPercent: () => number;
	/** Account ids of the workspace owners, resolved through auth.core. */
	readonly owners?: (tenantId: string) => Promise<readonly string[]>;
	readonly notifications?: NotificationPublisherResolver;
	readonly now?: () => number;
}

/**
 * Everything metering.core does with a meter: the capability half a reporting
 * module uses, and the read model the screens and the operator CLI read.
 */
export class MeteringService {
	readonly #repository: MeteringRepository;
	readonly #registry: MeterDeclarationRegistry;
	readonly #warningPercent: () => number;
	readonly #owners:
		| ((tenantId: string) => Promise<readonly string[]>)
		| undefined;
	readonly #notifications: NotificationPublisherResolver | undefined;
	readonly #now: () => number;

	constructor(options: MeteringServiceOptions) {
		this.#repository = options.repository;
		this.#registry = options.registry;
		this.#warningPercent = options.warningPercent;
		this.#owners = options.owners;
		this.#notifications = options.notifications;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Counts one fact in this module's own tenant-scoped write transaction. A
	 * repeat of a source reference changes nothing and publishes nothing.
	 */
	async record(input: MeterRecordInput): Promise<MeterRecordResult> {
		const tenantId = bounded(
			input.tenantId,
			'tenantId',
			1,
			METER_LIMITS.tenantId,
		);
		const meter = this.#declared(input.meter);
		const amount = wholeNumber(input.amount, 'amount', METER_LIMITS.amount);
		const at = this.#instant(input.at);
		const sourceRef =
			input.sourceRef === undefined
				? null
				: bounded(input.sourceRef, 'sourceRef', 1, METER_LIMITS.sourceRef);
		const day = utcDay(at);
		const month = day.slice(0, 7);

		const outcome = await this.#repository.recordFact({
			tenantId,
			meter,
			day,
			month,
			amount,
			sourceRef,
			at,
		});
		/* Everything after the fact committed is advisory: the claim write, the
		   owner lookup that reaches auth.core and the publisher are all allowed
		   to fail without turning a counted fact into a rejected call, which a
		   caller reporting without a source reference would retry into a second
		   count. An unclaimed threshold is re-evaluated by the next fact. */
		if (outcome.recorded && outcome.limit !== null) {
			try {
				await this.#notifyThresholds(
					tenantId,
					meter,
					month,
					outcome.used,
					outcome.limit,
					at,
				);
			} catch (error) {
				console.warn(
					`[metering] threshold notice for ${meter.key} in ${month} failed:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
		return { recorded: outcome.recorded, day };
	}

	/** Reads this month's usage against the limit. Writes nothing. */
	async check(input: MeterCheckInput): Promise<MeterCheckResult> {
		const tenantId = bounded(
			input.tenantId,
			'tenantId',
			1,
			METER_LIMITS.tenantId,
		);
		const meter = this.#declared(input.meter);
		const amount = wholeNumber(input.amount, 'amount', METER_LIMITS.amount);
		const { used, limit } = await this.#repository.usageAgainstLimit(
			tenantId,
			meter.key,
			utcMonth(this.#now()),
		);
		return { verdict: this.#verdict(used, amount, limit), used, limit };
	}

	/**
	 * The share of a limit the owners are notified at. A screen reads it with
	 * the meters so its colours and the inbox agree on what has been reached.
	 */
	warningPercent(): number {
		return this.#percent();
	}

	/** Every meter this workspace recorded, with this month's usage and limit. */
	usage(tenantId: string): Promise<readonly MeterUsage[]> {
		return this.#repository.listMeterUsage(
			bounded(tenantId, 'tenantId', 1, METER_LIMITS.tenantId),
			utcMonth(this.#now()),
		);
	}

	/**
	 * The day buckets of one meter over a closed range of UTC days. The window
	 * is bounded so one read can never walk a workspace's whole history.
	 */
	buckets(
		tenantId: string,
		query: { meter: string; from?: string; to?: string },
	): Promise<readonly UsageBucket[]> {
		const now = this.#now();
		const to = query.to === undefined ? utcDay(now) : day(query.to, 'to');
		const from =
			query.from === undefined
				? utcDay(now - 29 * DAY_MS)
				: day(query.from, 'from');
		if (from > to) {
			throw new MeteringServiceError(
				'INVALID_INPUT',
				'from must not be later than to.',
			);
		}
		if (
			Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >
			(MAX_BUCKET_WINDOW_DAYS - 1) * DAY_MS
		) {
			throw new MeteringServiceError(
				'INVALID_INPUT',
				`The range must cover at most ${MAX_BUCKET_WINDOW_DAYS} days.`,
			);
		}
		return this.#repository.listBuckets(
			bounded(tenantId, 'tenantId', 1, METER_LIMITS.tenantId),
			{ meter: bounded(query.meter, 'meter', 1, METER_LIMITS.key), from, to },
		);
	}

	limits(tenantId: string): Promise<readonly MeterLimit[]> {
		return this.#repository.listLimits(
			bounded(tenantId, 'tenantId', 1, METER_LIMITS.tenantId),
		);
	}

	limitEvents(
		tenantId: string,
		limit = 50,
	): Promise<readonly MeterLimitEvent[]> {
		return this.#repository.listLimitEvents(
			bounded(tenantId, 'tenantId', 1, METER_LIMITS.tenantId),
			wholeNumber(limit, 'limit', 200),
		);
	}

	/**
	 * The operator path. No endpoint reaches it: a workspace cannot raise its
	 * own ceiling, and the label of whoever ran the command is recorded with
	 * the change.
	 */
	setLimit(input: {
		tenantId: string;
		meter: string;
		monthlyLimit: number;
		setBy: string;
	}): Promise<{
		limit: MeterLimit;
		previousLimit: number | null;
		event: MeterLimitEvent;
	}> {
		return this.#repository.setLimit({
			tenantId: bounded(input.tenantId, 'tenantId', 1, METER_LIMITS.tenantId),
			meter: bounded(input.meter, 'meter', 1, METER_LIMITS.key),
			monthlyLimit: wholeNumber(
				input.monthlyLimit,
				'monthlyLimit',
				METER_LIMITS.monthlyLimit,
			),
			setBy: bounded(input.setBy, 'setBy', 1, METER_LIMITS.setBy),
			at: this.#now(),
		});
	}

	/**
	 * The retention sweep of `metering.core.buckets`. Rows of days strictly
	 * older than the cutoff go, at most `limit` of them, so one pass is bounded
	 * however long a workspace has been running. The batch the registry asks
	 * for is clamped rather than refused: retention is the platform's pass over
	 * a workspace, and a batch this module would not have chosen is no reason to
	 * leave its rows unswept.
	 */
	sweepBuckets(
		tenantId: string,
		cutoff: Date,
		limit: number,
	): Promise<{ readonly removed: number }> {
		return this.#repository.sweepBuckets(
			bounded(tenantId, 'tenantId', 1, METER_LIMITS.tenantId),
			utcDay(cutoff.getTime()),
			Math.min(Math.max(Math.trunc(limit), 1), MAX_SWEEP_BATCH),
		);
	}

	/**
	 * Every bucket of one workspace, walked by keyset so no page holds more
	 * than `pageSize` rows whatever the history is.
	 */
	async exportBuckets(
		tenantId: string,
		sink: { write(row: Record<string, unknown>): Promise<void> },
		pageSize = EXPORT_PAGE,
	): Promise<{ rows: number; from: Date | null; to: Date | null }> {
		const owner = bounded(tenantId, 'tenantId', 1, METER_LIMITS.tenantId);
		let afterId = '';
		let rows = 0;
		let from: string | null = null;
		let to: string | null = null;
		for (;;) {
			const page = await this.#repository.exportBucketsPage(
				owner,
				afterId,
				pageSize,
			);
			for (const bucket of page) {
				await sink.write({
					id: bucket.id,
					meter: bucket.meter,
					day: bucket.day,
					amount: bucket.amount,
					events: bucket.events,
					updatedAt: new Date(bucket.updatedAt).toISOString(),
				});
				rows += 1;
				if (from === null || bucket.day < from) from = bucket.day;
				if (to === null || bucket.day > to) to = bucket.day;
			}
			if (page.length < pageSize) break;
			afterId = page[page.length - 1]!.id;
		}
		return {
			rows,
			from: from === null ? null : new Date(`${from}T00:00:00Z`),
			to: to === null ? null : new Date(`${to}T00:00:00Z`),
		};
	}

	#declared(key: string): DeclaredMeter {
		const meter = this.#registry.resolve(
			bounded(key, 'meter', 1, METER_LIMITS.key),
		);
		if (!meter) {
			throw new MeteringServiceError(
				'METER_NOT_DECLARED',
				`No composed module declared the meter "${key}".`,
				404,
			);
		}
		return meter;
	}

	#instant(value: number | undefined): number {
		if (value === undefined) return this.#now();
		if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INSTANT_MS) {
			throw new MeteringServiceError(
				'INVALID_INPUT',
				'at must be whole epoch milliseconds inside the Date range.',
			);
		}
		return value;
	}

	/* `warning` is what the amount itself carries the month past, not a state
	   it stays in: once the month is over the warning point every further
	   check answers allowed until the limit itself refuses. */
	#verdict(used: number, amount: number, limit: number | null): MeterVerdict {
		if (limit === null) return 'allowed';
		if (used + amount > limit) return 'refused';
		const point = thresholdPoint(limit, this.#percent());
		return used < point && used + amount >= point ? 'warning' : 'allowed';
	}

	#percent(): number {
		const value = this.#warningPercent();
		if (!Number.isFinite(value)) return WARNING_PERCENT_RANGE.minimum;
		return Math.min(
			Math.max(Math.trunc(value), WARNING_PERCENT_RANGE.minimum),
			WARNING_PERCENT_RANGE.maximum,
		);
	}

	async #notifyThresholds(
		tenantId: string,
		meter: DeclaredMeter,
		month: string,
		used: number,
		limit: number,
		at: number,
	): Promise<void> {
		const reached: MeterThreshold[] = [];
		if (used >= thresholdPoint(limit, this.#percent())) reached.push('warning');
		if (used >= limit) reached.push('exhausted');
		if (reached.length === 0) return;
		const claimed = await this.#repository.claimThresholds(
			tenantId,
			meter.key,
			month,
			reached,
			at,
		);
		if (claimed.length === 0 || !this.#owners) return;
		const owners = await this.#owners(tenantId);
		for (const threshold of claimed) {
			await publishThresholdNotice(this.#notifications, {
				tenantId,
				kind: 'meter-threshold',
				sourceModule: 'metering.core',
				sourceRef: `${meter.key}:${month}:${threshold}`,
				title:
					threshold === 'exhausted'
						? `${meter.label} reached its monthly limit`
						: `${meter.label} passed ${this.#percent()}% of its monthly limit`,
				body: `${used} of ${limit} ${meter.unit} used in ${month}.`,
				recipients: owners,
			});
		}
	}
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: string, field: string): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (
		!DAY.test(normalized) ||
		Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))
	) {
		throw new MeteringServiceError(
			'INVALID_INPUT',
			`${field} must be a UTC day in YYYY-MM-DD form.`,
		);
	}
	return normalized;
}
