import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
	DatabaseHandle,
	DatabaseTransactionOptions,
} from '@flowdular/database';
import { REPORT_PROVIDER_LIMITS } from '@flowdular/module-reports';
import type { MeterDeclaration } from '../src/domain/meters.ts';
import { METERING_PERMISSIONS } from '../src/acl/permissions.ts';
import { DatabaseMeteringRepository } from '../src/services/database-repository.ts';
import {
	createUsageReportProvider,
	METERING_REPORT_PROVIDER_KEY,
	METERING_REPORT_PROVIDER_LABEL,
	METERING_REPORT_PROVIDER_LABEL_KEY,
	monthPeriod,
	unitWithLimit,
	usageTiles,
} from '../src/services/reports.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import { createHarness, REPORTER } from './support/harness.ts';

const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);
const RANGE = { from: '2026-08-13', to: '2026-09-11' } as const;

const TOKENS: MeterDeclaration = {
	key: 'run-tokens',
	label: 'Agent run tokens',
	unit: 'tokens',
	kind: 'cumulative',
};
const CALLS: MeterDeclaration = {
	key: 'tool-calls',
	label: 'Tool calls',
	unit: 'calls',
	kind: 'cumulative',
};

let shared: MeteringTestDatabase;

beforeAll(async () => {
	shared = await openMeteringTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function harness(meters: readonly MeterDeclaration[]) {
	return createHarness({
		repository: shared.repository,
		now: () => SEPTEMBER,
		meters,
	});
}

function provider(meters: readonly MeterDeclaration[]) {
	const { service } = harness(meters);
	return {
		service,
		read: createUsageReportProvider(async () => service),
	};
}

function reader(tenantId = ALPHA) {
	return {
		accountId: 'account-ada',
		tenantId,
		scopes: [METERING_PERMISSIONS.read],
	};
}

/**
 * The real handle, recording what the repository asked the database for and
 * firing the caller's budget once the transaction is open, so a case sees what
 * the statement in flight does with the signal it was handed.
 */
function abortingHandle(handle: DatabaseHandle, expireBudget: () => void) {
	const asked: (DatabaseTransactionOptions | undefined)[] = [];
	const recording = new Proxy(handle, {
		get(target, property) {
			if (property === 'transaction') {
				return (
					operation: (transaction: never) => Promise<unknown>,
					options?: DatabaseTransactionOptions,
				) => {
					asked.push(options);
					return target.transaction(async (transaction) => {
						expireBudget();
						return operation(transaction as never);
					}, options);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { asked, handle: recording };
}

describe('METERING-REPORT-USAGE', () => {
	it('answers one tile per meter with the limit as the unit context', async () => {
		const { service, read } = provider([TOKENS, CALLS]);
		await service.setLimit({
			tenantId: ALPHA,
			meter: `${REPORTER}.${TOKENS.key}`,
			monthlyLimit: 1_000,
			setBy: 'cli:test',
		});
		await service.record({
			tenantId: ALPHA,
			meter: `${REPORTER}.${TOKENS.key}`,
			amount: 412,
			at: SEPTEMBER,
			sourceRef: 'run-1',
		});
		await service.record({
			tenantId: ALPHA,
			meter: `${REPORTER}.${CALLS.key}`,
			amount: 9,
			at: SEPTEMBER,
			sourceRef: 'call-1',
		});

		const answer = await read.read({
			tenantId: ALPHA,
			principal: {
				accountId: 'account-ada',
				tenantId: ALPHA,
				scopes: [METERING_PERMISSIONS.read],
			},
			range: RANGE,
		});

		expect(answer.tiles).toEqual([
			{
				key: `${REPORTER}.${TOKENS.key}`,
				label: TOKENS.label,
				value: 412,
				unit: 'tokens of 1000',
			},
			{
				key: `${REPORTER}.${CALLS.key}`,
				label: CALLS.label,
				value: 9,
				unit: 'calls',
			},
		]);
		expect(answer.series).toBeUndefined();
	});

	it('counts only the workspace of the tenant it was handed', async () => {
		const { service, read } = provider([TOKENS]);
		for (const [tenantId, amount] of [
			[ALPHA, 100],
			[BETA, 250],
		] as const) {
			await service.record({
				tenantId,
				meter: `${REPORTER}.${TOKENS.key}`,
				amount,
				at: SEPTEMBER,
				sourceRef: `run-${tenantId}`,
			});
		}

		const principal = {
			accountId: 'account-ada',
			tenantId: ALPHA,
			scopes: [METERING_PERMISSIONS.read],
		};
		const inAlpha = await read.read({
			tenantId: ALPHA,
			principal,
			range: RANGE,
		});
		const inBeta = await read.read({
			tenantId: BETA,
			principal: { ...principal, tenantId: BETA },
			range: RANGE,
		});

		expect(inAlpha.tiles.map((tile) => tile.value)).toEqual([100]);
		expect(inBeta.tiles.map((tile) => tile.value)).toEqual([250]);
	});

	/* The workspace has usage to answer with, so a provider that ignored the
	   budget would answer a tile here instead of nothing. */
	it('answers nothing once the time budget has expired', async () => {
		const { service, read } = provider([TOKENS]);
		await service.record({
			tenantId: ALPHA,
			meter: `${REPORTER}.${TOKENS.key}`,
			amount: 77,
			at: SEPTEMBER,
			sourceRef: 'run-budget',
		});
		expect(
			(await read.read({ tenantId: ALPHA, principal: reader(), range: RANGE }))
				.tiles,
		).toHaveLength(1);
		const controller = new AbortController();
		controller.abort();

		const answer = await read.read({
			tenantId: ALPHA,
			principal: reader(),
			range: RANGE,
			signal: controller.signal,
		});

		expect(answer.tiles).toEqual([]);
	});

	/* The budget has to reach the statement, not only the provider: a read the
	   reader has already been given up on must stop, not run to completion on a
	   connection nobody is waiting for. */
	it('hands the budget to the transaction and stops the statement it expires under', async () => {
		const controller = new AbortController();
		const recorder = abortingHandle(shared.runtime, () => controller.abort());
		const { service } = createHarness({
			repository: new DatabaseMeteringRepository(recorder.handle),
			now: () => SEPTEMBER,
			meters: [TOKENS],
		});
		const read = createUsageReportProvider(async () => service);

		await expect(
			read.read({
				tenantId: ALPHA,
				principal: reader(),
				range: RANGE,
				signal: controller.signal,
			}),
		).rejects.toThrow(/abort/i);

		expect(recorder.asked).toHaveLength(1);
		expect(recorder.asked[0]?.signal).toBe(controller.signal);
		expect(recorder.asked[0]?.tenantId).toBe(ALPHA);
		expect(recorder.asked[0]?.access).toBe('read');
	});

	/* The tiles are this calendar month whatever range was asked for, so the
	   answer names the period the screen should caption the card with. */
	it('answers the calendar month it rolled up, not the range it was asked for', async () => {
		const { service, read } = provider([TOKENS]);
		const month = { from: '2026-09-01', to: '2026-09-30' };

		/* A workspace with no meter has no row to take the month from. */
		expect(
			(await read.read({ tenantId: ALPHA, principal: reader(), range: RANGE }))
				.period,
		).toEqual(month);

		await service.record({
			tenantId: ALPHA,
			meter: `${REPORTER}.${TOKENS.key}`,
			amount: 12,
			at: SEPTEMBER,
			sourceRef: 'run-period',
		});
		const answer = await read.read({
			tenantId: ALPHA,
			principal: reader(),
			range: RANGE,
		});

		expect(answer.period).toEqual(month);
		expect(answer.tiles).toHaveLength(1);
	});

	it('registers under a stable key and the usage read permission', () => {
		const read = createUsageReportProvider(async () => {
			throw new Error('not called');
		});
		expect(read.key).toBe(METERING_REPORT_PROVIDER_KEY);
		expect(read.permission).toBe(METERING_PERMISSIONS.read);
		expect(read.label).toBe(METERING_REPORT_PROVIDER_LABEL);
		expect(read.labelKey).toBe(METERING_REPORT_PROVIDER_LABEL_KEY);
	});

	/* reports.core resolves the key against this module's own bundle and falls
	   back to the English literal, so a locale that lacks the key shows copy
	   rather than a raw key. */
	it('names the period in every locale this module ships', () => {
		const key = METERING_REPORT_PROVIDER_LABEL_KEY.slice('metering.'.length);
		for (const bundle of [translationsEn, translationsPl]) {
			expect([key, key in bundle]).toEqual([key, true]);
		}
		expect(translationsEn[key as keyof typeof translationsEn]).toBe(
			METERING_REPORT_PROVIDER_LABEL,
		);
		expect(translationsPl[key as keyof typeof translationsPl]).not.toBe(
			translationsEn[key as keyof typeof translationsEn],
		);
	});
});

describe('metering report period', () => {
	/* A month is captioned with the day it actually ends on, so February and a
	   30 day month are not shown as ending on the 31st. */
	it('ends a month on its own last day', () => {
		expect(monthPeriod('2026-09')).toEqual({
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(monthPeriod('2026-02')).toEqual({
			from: '2026-02-01',
			to: '2026-02-28',
		});
		expect(monthPeriod('2028-02')).toEqual({
			from: '2028-02-01',
			to: '2028-02-29',
		});
		expect(monthPeriod('2026-12')).toEqual({
			from: '2026-12-01',
			to: '2026-12-31',
		});
	});
});

describe('metering report tiles', () => {
	const usage = (key: string, used: number, limit: number | null) => ({
		meter: {
			id: key,
			tenantId: ALPHA,
			key,
			moduleId: REPORTER,
			label: key,
			unit: 'tokens',
			kind: 'cumulative' as const,
			createdAt: 0,
		},
		month: '2026-09',
		used,
		limit,
	});

	/* More meters than a provider answer may carry would make the whole
	   provider unavailable, so the busiest are kept rather than the report
	   being lost. */
	it('keeps the busiest meters within the tile bound', () => {
		const tiles = usageTiles(
			Array.from(
				{ length: REPORT_PROVIDER_LIMITS.tiles + 4 },
				(_entry, index) =>
					usage(`meter-${String(index).padStart(2, '0')}`, index, null),
			),
		);
		expect(tiles).toHaveLength(REPORT_PROVIDER_LIMITS.tiles);
		expect(tiles[0]!.value).toBe(REPORT_PROVIDER_LIMITS.tiles + 3);
		expect(tiles.at(-1)!.value).toBe(4);
	});

	it('orders equal usage by meter key, so the tiles do not shuffle', () => {
		expect(
			usageTiles([usage('b', 5, null), usage('a', 5, null)]).map(
				(tile) => tile.key,
			),
		).toEqual(['a', 'b']);
	});

	/* A unit past the contract's bound would make the provider unavailable, so
	   the limit context is dropped rather than the report. */
	it('keeps the bare unit when the limit would push it past the bound', () => {
		const long = 'x'.repeat(REPORT_PROVIDER_LIMITS.unit);
		expect(unitWithLimit(long, 1_000)).toBe(long);
		expect(unitWithLimit(long, null)).toBe(long);
		expect(unitWithLimit('tokens', 1_000)).toBe('tokens of 1000');
		expect(unitWithLimit('tokens', null)).toBe('tokens');
	});
});
