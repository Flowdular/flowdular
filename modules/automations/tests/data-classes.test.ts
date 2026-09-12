import { createDataClassRegistry } from '@flowdular/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { automationsDataClasses } from '../src/services/data-classes.ts';
import type { AutomationsRepository } from '../src/services/repository.ts';
import {
	openAutomationsTestDatabase,
	type AutomationsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-retention';
const OTHER = 'tenant-other';
const DAY_MS = 86_400_000;
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);

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

function declared(repository: AutomationsRepository, pageSize?: number) {
	const registry = createDataClassRegistry();
	registry.declare(
		'automations.core',
		automationsDataClasses(async () => repository, pageSize),
	);
	const trail = registry
		.list()
		.find((module) => module.moduleId === 'automations.core')
		?.classes.find((declaration) => declaration.key === 'audit-events');
	if (!trail)
		throw new Error('automations.core declared no audit-events class.');
	return trail;
}

/** Four events of one workspace, the oldest first. */
async function seedFourEvents(tenantId = TENANT): Promise<void> {
	for (let offset = 0; offset < 4; offset += 1) {
		await shared.repository.appendAuditEvent({
			tenantId,
			actorId: 'account-ada',
			action: 'schedule.created',
			subjectType: 'automation-schedule',
			subjectId: `schedule-${offset}`,
			metadata: { label: `Nightly ${offset}` },
			occurredAt: SEPTEMBER - (3 - offset) * DAY_MS,
		});
	}
}

async function collect(
	trail: ReturnType<typeof declared>,
	tenantId: string,
): Promise<{
	readonly rows: Record<string, unknown>[];
	readonly summary: Awaited<ReturnType<NonNullable<typeof trail.export>>>;
}> {
	const rows: Record<string, unknown>[] = [];
	const summary = await trail.export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return { rows, summary };
}

describe('automations.core.audit-events data class', () => {
	it('declares the audit trail class with its retention, and nothing else', () => {
		const registry = createDataClassRegistry();
		registry.declare(
			'automations.core',
			automationsDataClasses(async () => shared.repository),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.label,
						declaration.defaultRetentionDays,
						declaration.exportable,
					]),
				),
		).toEqual([
			['automations.core.audit-events', 'Automation audit trail', null, true],
		]);
	});

	/* The trail is hash chained and verifyAuditChain walks it from sequence 1,
	   so removing the oldest links by age would report the chain broken. The
	   class is declared without a sweep on purpose, and the catalogue says so by
	   carrying no retention period rather than one nothing enforces. */
	it('declares no sweep, because the chain cannot lose its oldest links', () => {
		const trail = declared(shared.repository);

		expect(trail.sweep).toBeUndefined();
		expect(trail.defaultRetentionDays).toBeNull();
	});

	it('exports every event of one workspace with its oldest and newest time', async () => {
		await seedFourEvents();

		const { rows, summary } = await collect(
			declared(shared.repository),
			TENANT,
		);

		expect(summary.rows).toBe(4);
		expect(summary.from?.toISOString()).toBe('2026-09-08T09:30:00.000Z');
		expect(summary.to?.toISOString()).toBe('2026-09-11T09:30:00.000Z');
		expect(rows.map((row) => row['subjectId']).sort()).toEqual([
			'schedule-0',
			'schedule-1',
			'schedule-2',
			'schedule-3',
		]);
		expect(rows.map((row) => row['occurredAt'])).toContain(
			'2026-09-08T09:30:00.000Z',
		);
	});

	it('exports the given workspace only', async () => {
		await seedFourEvents();
		await shared.repository.appendAuditEvent({
			tenantId: OTHER,
			actorId: 'account-bo',
			action: 'trigger.created',
			subjectType: 'automation-trigger',
			subjectId: 'trigger-other',
			metadata: {},
			occurredAt: SEPTEMBER,
		});

		const mine = await collect(declared(shared.repository), TENANT);
		const theirs = await collect(declared(shared.repository), OTHER);

		expect(mine.summary.rows).toBe(4);
		expect(mine.rows.every((row) => row['tenantId'] === TENANT)).toBe(true);
		expect(theirs.rows.map((row) => row['subjectId'])).toEqual([
			'trigger-other',
		]);
	});

	it('walks the export in pages rather than one query', async () => {
		await seedFourEvents();

		const { rows, summary } = await collect(
			declared(shared.repository, 2),
			TENANT,
		);

		expect(summary.rows).toBe(4);
		expect(new Set(rows.map((row) => row['id'])).size).toBe(4);
	});

	it('exports nothing and reports no range for a workspace without events', async () => {
		const summary = await declared(shared.repository).export!({
			tenantId: 'tenant-empty',
			sink: { write: async () => undefined },
		});

		expect(summary).toEqual({ rows: 0, from: null, to: null });
	});
});
