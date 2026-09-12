import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import type { AgentRunQueue } from '@flowdular/module-agents/server';
import type { JobRunner } from '@flowdular/server';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { cadenceLabel, timestampLabel } from '../src/client/presentation.ts';
import {
	InvalidCadenceError,
	firstCadenceSlot,
	nextCadenceSlot,
	normalizeCadence,
	parseCadence,
} from '../src/domain/cadence.ts';
import { nextCronSlot, parseCron } from '../src/domain/cron.ts';
import { AutomationsServiceError } from '../src/services/automations-service.ts';
import { createAutomationScheduleRunner } from '../src/services/schedule-runner.ts';
import { AutomationScheduleService } from '../src/services/schedule-service.ts';
import {
	openAutomationsTestDatabase,
	type AutomationsTestDatabase,
} from './support/database.ts';

/* Europe/Warsaw moves to CEST on 2026-03-29 at 01:00 UTC, so 02:00 to 02:59
   never happens that day, and back to CET on 2026-10-25 at 01:00 UTC, so the
   same hour happens twice. */
const SPRING_FORWARD = '2026-03-28T12:00:00.000Z';
const FALL_BACK = '2026-10-24T12:00:00.000Z';
const WARSAW = 'Europe/Warsaw';

let shared: AutomationsTestDatabase;

beforeAll(async () => {
	shared = await openAutomationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function runQueue() {
	const runs = new Map<string, { readonly id: string }>();
	const enqueue = vi.fn<AgentRunQueue['enqueue']>(async (_context, input) => {
		const key = input.idempotencyKey ?? 'unkeyed:' + runs.size;
		const existing = runs.get(key);
		if (existing)
			return existing as Awaited<ReturnType<AgentRunQueue['enqueue']>>;
		const created = { id: 'run-' + (runs.size + 1) };
		runs.set(key, created);
		return created as Awaited<ReturnType<AgentRunQueue['enqueue']>>;
	});
	const queue: AgentRunQueue = {
		listAgents: async (tenantId) => [
			{
				id: tenantId + '-agent',
				name: 'Workspace agent',
				status: 'active',
				allowedTools: [],
				revision: 1,
				ownership: { kind: 'tenant' },
			},
		],
		enqueue,
		enqueueWithOutcome: async (context, input) => {
			const key = input.idempotencyKey ?? 'unkeyed:' + runs.size;
			const created = !runs.has(key);
			return { run: await enqueue(context, input), created };
		},
	};
	return { queue, runs };
}

/** The scheduler pass as the platform runner drives it. */
function scheduleRunner(
	service: AutomationScheduleService,
	now: () => number,
): JobRunner {
	return createAutomationScheduleRunner({
		repository: async () => shared.repository,
		service: async () => service,
		intervalMs: 30_000,
		now,
	});
}

function scheduleInput(cadence: string) {
	return {
		agentId: 'tenant-a-agent',
		label: 'Cron schedule',
		inputTemplate: 'Summarize the day.',
		cadence,
		enabled: true,
	};
}

function at(iso: string): number {
	return Date.parse(iso);
}

describe('cron cadence', () => {
	it('parses steps, ranges, lists and three letter names', () => {
		expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
		expect(parseCron('0 9-17/4 * * *').hours).toEqual([9, 13, 17]);
		expect(parseCron('0,30 6 * * *').minutes).toEqual([0, 30]);
		expect(parseCron('0 6 * jan,mar *').months).toEqual([1, 3]);
		expect(parseCron('0 6 * * mon-fri').daysOfWeek).toEqual([1, 2, 3, 4, 5]);
		/* Sunday is 0 and 7 on input, one value in the matcher. */
		expect(parseCron('0 6 * * 0,7').daysOfWeek).toEqual([0]);
		expect(parseCron('0 6 * * *').dayUnion).toBe(false);
		expect(parseCron('0 0 13 * 5').dayUnion).toBe(true);
		expect(normalizeCadence('CRON:  0   6  *  *  1-5 ')).toBe(
			'cron:0 6 * * 1-5',
		);
	});

	// Vixie reads a day field as unrestricted when it starts with `*`, step or
	// not, so a stepped day of month keeps the intersection: an odd day that is
	// also a Friday, rather than every odd day and every Friday.
	it('takes a day field that starts with * as unrestricted', () => {
		expect(parseCron('0 0 */2 * 5').dayUnion).toBe(false);
		expect(parseCron('0 0 13 * */2').dayUnion).toBe(false);
		expect(parseCron('0 0 1-31/2 * 5').dayUnion).toBe(true);

		const fields = parseCron('0 0 */2 * 5');
		const slots: number[] = [];
		let cursor = at('2026-09-01T00:00:00.000Z');
		while (slots.length < 3) {
			cursor = nextCronSlot(fields, cursor, 'UTC')!;
			slots.push(cursor);
		}
		expect(slots).toEqual([
			at('2026-09-11T00:00:00.000Z'),
			at('2026-09-25T00:00:00.000Z'),
			at('2026-10-09T00:00:00.000Z'),
		]);
	});

	it('AUTO-CRON-INVALID refuses an expression it cannot honour', () => {
		for (const expression of [
			'* * * *',
			'* * * * * *',
			'60 * * * *',
			'* 24 * * *',
			'0 6 0 * *',
			'0 6 * * 8',
			'*/0 * * * *',
			'5/2 * * * *',
			'17-5 * * * *',
			'0-a * * * *',
			'',
		]) {
			expect(() => parseCadence('cron:' + expression), expression).toThrowError(
				InvalidCadenceError,
			);
		}
		expect(() => parseCadence('cron:' + '0,'.repeat(40) + '0 6 * * *')).toThrow(
			InvalidCadenceError,
		);
	});

	it('AUTO-CRON-NEXT-RUN computes the slot in the workspace zone', () => {
		const cadence = parseCadence('cron:0 6 * * 1-5');
		const now = at('2026-09-12T00:00:00.000Z');
		/* Saturday, so the next weekday slot is Monday 06:00 local. */
		expect(firstCadenceSlot(cadence, now, 'UTC')).toBe(
			at('2026-09-14T06:00:00.000Z'),
		);
		expect(firstCadenceSlot(cadence, now, WARSAW)).toBe(
			at('2026-09-14T04:00:00.000Z'),
		);
	});

	it('AUTO-CRON-DST keeps the wall clock hour across a transition', () => {
		const daily = parseCron('30 2 * * *');
		/* The clock jumps 02:00 to 03:00, so that day has no 02:30 and the slot
		   is skipped rather than moved. */
		expect(nextCronSlot(daily, at(SPRING_FORWARD), WARSAW)).toBe(
			at('2026-03-30T00:30:00.000Z'),
		);
		/* The hour repeats, and the slot resolves to the first of the two. */
		expect(nextCronSlot(daily, at(FALL_BACK), WARSAW)).toBe(
			at('2026-10-25T00:30:00.000Z'),
		);
		/* Asking again from inside the repeated hour never answers behind it. */
		const repeated = at('2026-10-25T01:30:00.000Z');
		const following = nextCronSlot(daily, repeated, WARSAW)!;
		expect(following).toBeGreaterThan(repeated);
		expect(following).toBe(at('2026-10-26T01:30:00.000Z'));
		/* An hourly cadence keeps its local minute over the missing hour. */
		expect(
			nextCronSlot(
				parseCron('0 * * * *'),
				at('2026-03-29T00:30:00.000Z'),
				WARSAW,
			),
		).toBe(at('2026-03-29T01:00:00.000Z'));
	});

	it('skips missed cron slots instead of replaying them', () => {
		const cadence = parseCadence('cron:0 * * * *');
		const firedSlot = at('2026-09-12T06:00:00.000Z');
		const now = at('2026-09-15T09:20:00.000Z');
		expect(nextCadenceSlot(cadence, firedSlot, now, 'UTC')).toBe(
			at('2026-09-15T10:00:00.000Z'),
		);
	});

	it('shows either cadence form and the run times in the workspace zone', () => {
		registerModuleTranslations([
			{
				moduleId: 'automations.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('en');
		expect(cadenceLabel('cron:0 6 * * 1-5')).toContain('0 6 * * 1-5');
		expect(cadenceLabel('every:60')).toBe('Every hour');
		const instant = at('2026-09-14T23:30:00.000Z');
		expect(timestampLabel(instant, WARSAW)).not.toBe(
			timestampLabel(instant, 'UTC'),
		);
	});

	it('leaves the every:N cadence untouched', () => {
		const cadence = parseCadence('every:60');
		expect(cadence).toEqual({ kind: 'every', minutes: 60 });
		expect(normalizeCadence('EVERY:60')).toBe('every:60');
		const firedSlot = at('2026-09-12T06:00:00.000Z');
		/* No zone reaches an interval cadence: the phase stays on the fired slot
		   and every skipped interval is dropped. */
		expect(
			nextCadenceSlot(
				cadence,
				firedSlot,
				at('2026-09-12T09:20:00.000Z'),
				WARSAW,
			),
		).toBe(at('2026-09-12T10:00:00.000Z'));
		expect(
			firstCadenceSlot(cadence, at('2026-09-12T06:00:00.000Z'), WARSAW),
		).toBe(at('2026-09-12T07:00:00.000Z'));
	});
});

describe('cron schedules', () => {
	it('AUTO-CRON-NEXT-RUN stores the next run in UTC for the workspace zone', async () => {
		const { queue } = runQueue();
		const now = at('2026-09-12T00:00:00.000Z');
		const service = new AutomationScheduleService(
			shared.repository,
			queue,
			() => now,
			undefined,
			undefined,
			undefined,
			() => WARSAW,
		);
		const created = await service.create(
			'tenant-a',
			'user-a',
			scheduleInput('cron: 0 6 * * 1-5 '),
		);
		expect(created.cadence).toBe('cron:0 6 * * 1-5');
		expect(created.nextRunAt).toBe(at('2026-09-14T04:00:00.000Z'));
		expect(service.timeZone('tenant-a')).toBe(WARSAW);
	});

	it('AUTO-CRON-INVALID refuses a bad expression with a stable code', async () => {
		const { queue } = runQueue();
		const service = new AutomationScheduleService(
			shared.repository,
			queue,
			() => at('2026-09-12T00:00:00.000Z'),
		);
		await expect(
			service.create('tenant-a', 'user-a', scheduleInput('cron:0 6 32 * *')),
		).rejects.toMatchObject({ code: 'INVALID_CADENCE' });
		await expect(
			service.create('tenant-a', 'user-a', scheduleInput('cron:0 6 30 2 *')),
		).rejects.toBeInstanceOf(AutomationsServiceError);
		expect(await service.list('tenant-a')).toEqual([]);
	});

	it('fires one cron slot and advances past the slots it missed', async () => {
		const { queue, runs } = runQueue();
		let now = at('2026-09-12T05:30:00.000Z');
		const service = new AutomationScheduleService(
			shared.repository,
			queue,
			() => now,
			undefined,
			undefined,
			undefined,
			() => 'UTC',
		);
		const created = await service.create(
			'tenant-a',
			'user-a',
			scheduleInput('cron:0 * * * *'),
		);
		expect(created.nextRunAt).toBe(at('2026-09-12T06:00:00.000Z'));

		now = at('2026-09-15T09:20:00.000Z');
		const runner = scheduleRunner(service, () => now);
		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		expect(await runner.tick()).toEqual({
			claimed: 0,
			performed: 0,
			failed: 0,
			claimLost: 0,
		});
		expect(runs.size).toBe(1);
		const [advanced] = await service.list('tenant-a');
		expect(advanced!.lastRunAt).toBe(now);
		expect(advanced!.nextRunAt).toBe(at('2026-09-15T10:00:00.000Z'));
	});

	it('AUTO-CRON-INVALID disables a schedule whose stored cadence cannot advance', async () => {
		const { queue, runs } = runQueue();
		let now = at('2026-09-12T05:30:00.000Z');
		const service = new AutomationScheduleService(
			shared.repository,
			queue,
			() => now,
			undefined,
			undefined,
			undefined,
			() => 'UTC',
		);
		const created = await service.create(
			'tenant-a',
			'user-a',
			scheduleInput('cron:0 * * * *'),
		);
		/* Written past the service, the way a repaired row or an older release
		   could leave a cadence this module can no longer honour. */
		const stored = (await shared.repository.getSchedule(
			'tenant-a',
			created.id,
		))!;
		await shared.repository.updateSchedule({
			...stored,
			cadence: 'cron:0 6 30 2 *',
		});

		now = at('2026-09-12T06:30:00.000Z');
		expect(await scheduleRunner(service, () => now).tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		expect(runs.size).toBe(0);
		const [disabled] = await service.list('tenant-a');
		expect(disabled!.enabled).toBe(false);
		expect(disabled!.disabledReason).toMatch(/^INVALID_CADENCE/);
	});

	it('moves a pending cron slot when the workspace zone changes', async () => {
		const { queue } = runQueue();
		const now = at('2026-09-12T00:00:00.000Z');
		let zone = 'UTC';
		const service = new AutomationScheduleService(
			shared.repository,
			queue,
			() => now,
			undefined,
			undefined,
			undefined,
			() => zone,
		);
		const interval = await service.create('tenant-a', 'user-a', {
			...scheduleInput('every:60'),
			label: 'Interval schedule',
		});
		const cron = await service.create(
			'tenant-a',
			'user-a',
			scheduleInput('cron:0 6 * * *'),
		);
		expect(cron.nextRunAt).toBe(at('2026-09-12T06:00:00.000Z'));

		zone = WARSAW;
		expect(await service.retime('tenant-a')).toBe(1);
		const schedules = await service.list('tenant-a');
		expect(schedules.find((entry) => entry.id === cron.id)!.nextRunAt).toBe(
			at('2026-09-12T04:00:00.000Z'),
		);
		/* An interval cadence has no wall clock, so the zone never moves it. */
		expect(schedules.find((entry) => entry.id === interval.id)!.nextRunAt).toBe(
			interval.nextRunAt,
		);
		expect(
			(await shared.repository.listAuditEvents('tenant-a', 20)).some(
				(event) => event.action === 'automation-schedule.retimed',
			),
		).toBe(true);
		/* Re-timing the same zone twice changes nothing. */
		expect(await service.retime('tenant-a')).toBe(0);
	});
});
