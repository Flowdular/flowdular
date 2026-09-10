import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import type { DatabaseProvider } from '@flowdular/database';
import type { AgentRunQueue } from '@flowdular/module-agents/server';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { cadenceLabel, timestampLabel } from '../src/client/presentation.ts';
import {
	AUTOMATION_SCHEDULE_VARIABLES,
	createScheduleVariableRegistry,
	resolveScheduleTemplate,
	scheduleVariablesForScopes,
} from '../src/domain/variables.ts';
import { AUTOMATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import { moduleDefinition } from '../src/index.ts';
import { createAutomationsRuntime } from '../src/server/runtime.ts';
import { AutomationScheduleService } from '../src/services/schedule-service.ts';
import { AesGcmSecretVault } from '../src/services/secret-vault.ts';
import {
	AutomationTriggerService,
	TriggerRejectedError,
	triggerSignature,
	triggerSignedPayload,
} from '../src/services/trigger-service.ts';
import { createAutomationTargetRegistry } from '../src/server/targets.ts';
import {
	openAutomationsTestDatabase,
	type AutomationsTestDatabase,
} from './support/database.ts';

/* Starting the embedded engine costs about half a second, so the file shares
   one and empties it between cases. */
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

function runQueue(allowedTools: readonly string[] = []) {
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
				allowedTools,
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

describe('automations.core', () => {
	it('owns a versioned target registry and refuses duplicate adapters', async () => {
		const registry = createAutomationTargetRegistry();
		const adapter = {
			kind: 'workflow',
			contractVersion: 1,
			available: () => true,
			list: async () => [],
			validate: async () => ({ key: 'review', label: 'Review' }),
			invoke: async () => ({
				correlationId: 'run-1',
				created: true,
				status: 'queued',
			}),
		} as const;
		registry.register(adapter);
		expect(registry.get('workflow')).toBe(adapter);
		expect(registry.list()).toEqual([adapter]);
		expect(() => registry.register(adapter)).toThrow(/already registered/);
	});

	it('acquires no database lease while the platform composition is built', async () => {
		const { queue } = runQueue();
		let acquisitions = 0;
		const databases: DatabaseProvider = {
			acquire: async () => {
				acquisitions += 1;
				throw new Error('Composition must not acquire a lease.');
			},
			dispose: async () => undefined,
		};
		createAutomationsRuntime({
			databases,
			runQueue: () => queue,
			secretVault: new AesGcmSecretVault(Buffer.alloc(32, 5)),
		});
		expect(acquisitions).toBe(0);
	});

	it('formats cadence and timestamps in the active locale', async () => {
		registerModuleTranslations([
			{
				moduleId: 'automations.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		expect(cadenceLabel(60)).toBe('Co godzinę');
		expect(cadenceLabel(180)).toBe('Co 3 godz.');
		expect(timestampLabel(null)).toBe('Jeszcze nie uruchomiono');
		setActiveLocale('en');
	});

	it('translates the variable picker and every schedule variable label', async () => {
		registerModuleTranslations([
			{
				moduleId: 'automations.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const key of [
				'automations.template.insert',
				'automations.template.available',
				'automations.template.empty',
				'automations.template.sample.agent',
				'automations.template.sample.schedule',
				...AUTOMATION_SCHEDULE_VARIABLES.map(
					(variable) => 'automations.variables.' + variable.key + '.label',
				),
			]) {
				expect(t(key)).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('ships the same translation keys in English and Polish', async () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('exports its validated identity', async () => {
		expect(moduleDefinition.manifest.id).toBe('automations.core');
	});

	it('isolates schedules by the trusted tenant id', async () => {
		const { repository } = shared;
		const { queue } = runQueue();
		const schedules = new AutomationScheduleService(
			repository,
			queue,
			() => 1_000,
		);
		await schedules.create('tenant-a', 'user-a', {
			agentId: 'tenant-a-agent',
			label: 'Alpha schedule',
			inputTemplate: 'Run alpha.',
			cadence: 'every:60',
			enabled: true,
		});
		await schedules.create('tenant-b', 'user-b', {
			agentId: 'tenant-b-agent',
			label: 'Beta schedule',
			inputTemplate: 'Run beta.',
			cadence: 'every:60',
			enabled: true,
		});

		expect(
			(await schedules.list('tenant-a')).map((entry) => entry.label),
		).toEqual(['Alpha schedule']);
		expect(
			(await schedules.list('tenant-b')).map((entry) => entry.label),
		).toEqual(['Beta schedule']);
	});

	it('offers protected variables only to a schedule manager', async () => {
		expect(
			scheduleVariablesForScopes([]).map((variable) => variable.key),
		).toEqual(['context.today', 'context.now']);
		expect(
			scheduleVariablesForScopes([AUTOMATIONS_PERMISSIONS.manage]).map(
				(variable) => variable.key,
			),
		).toContain('agent.name');
	});

	it('rejects unknown and forbidden schedule template variables', async () => {
		const schedules = new AutomationScheduleService(
			shared.repository,
			runQueue().queue,
			() => 1_000,
		);
		const input = {
			agentId: 'tenant-a-agent',
			label: 'Template schedule',
			cadence: 'every:60',
			enabled: true,
		};
		await expect(
			schedules.create('tenant-a', 'user-a', {
				...input,
				inputTemplate: '{{ unknown.value }}',
			}),
		).rejects.toThrow(/Unknown template variable/);
		await expect(
			schedules.create('tenant-a', 'user-a', {
				...input,
				inputTemplate: '{{ agent.name }}',
			}),
		).rejects.toThrow(/cannot use template variable/);
	});

	it('resolves a scheduled input once and retains its raw template', async () => {
		let now = Date.parse('2026-09-02T09:30:00.000Z');
		const { queue } = runQueue();
		const { repository } = shared;
		const schedules = new AutomationScheduleService(
			repository,
			queue,
			() => now,
		);
		const created = await schedules.create(
			'tenant-a',
			'user-a',
			{
				agentId: 'tenant-a-agent',
				label: 'Morning summary',
				inputTemplate:
					'{{ automation.schedule.label }} for {{ agent.name }} on {{ context.today }}',
				cadence: 'every:1',
				enabled: true,
			},
			[AUTOMATIONS_PERMISSIONS.manage],
		);
		now += 60_000;
		await schedules.tick();

		expect(
			(await repository.getSchedule('tenant-a', created.id))?.inputTemplate,
		).toBe(
			'{{ automation.schedule.label }} for {{ agent.name }} on {{ context.today }}',
		);
		expect(queue.enqueue).toHaveBeenCalledWith(
			{
				tenantId: 'tenant-a',
				permissionSnapshot: [],
				actor: {
					kind: 'service',
					id: `schedule:${created.id}`,
					label: 'Schedule: Morning summary',
					configuredBy: {
						kind: 'user',
						id: 'user-a',
						label: 'user-a',
					},
				},
			},
			expect.objectContaining({
				input: 'Morning summary for Workspace agent on 2026-09-02',
			}),
		);
	});

	it('grants a manual schedule run only the agent tools covered by the current user scopes', async () => {
		const { queue } = runQueue(['parties.customer.read']);
		const schedules = new AutomationScheduleService(
			shared.repository,
			queue,
			() => Date.parse('2026-09-02T09:30:00.000Z'),
		);
		const created = await schedules.create(
			'tenant-a',
			'user-a',
			{
				agentId: 'tenant-a-agent',
				label: 'Customer summary',
				inputTemplate: 'Summarize customers.',
				cadence: 'every:60',
				enabled: true,
			},
			[AUTOMATIONS_PERMISSIONS.manage],
		);
		await schedules.runNow(
			'tenant-a',
			{
				kind: 'user',
				id: 'user-a',
				label: 'Ada',
			},
			created.id,
			[AUTOMATIONS_PERMISSIONS.manage, 'parties.records.read'],
		);

		expect(queue.enqueue).toHaveBeenCalledWith(
			{
				tenantId: 'tenant-a',
				actor: { kind: 'user', id: 'user-a', label: 'Ada' },
				permissionSnapshot: [
					AUTOMATIONS_PERMISSIONS.manage,
					'parties.records.read',
				],
			},
			expect.objectContaining({
				toolGrants: ['parties.customer.read'],
			}),
		);
	});

	it('deduplicates a repeated manual run per actor without duplicating audit', async () => {
		const now = Date.parse('2026-09-02T09:30:00.000Z');
		const { repository } = shared;
		const { queue, runs } = runQueue();
		const schedules = new AutomationScheduleService(
			repository,
			queue,
			() => now,
		);
		const created = await schedules.create('tenant-a', 'user-a', {
			agentId: 'tenant-a-agent',
			label: 'Manual summary',
			inputTemplate: 'Summarize now.',
			cadence: 'every:60',
			enabled: true,
		});
		const ada = { kind: 'user', id: 'user-a', label: 'Ada' } as const;
		const first = await schedules.runNow('tenant-a', ada, created.id);
		const retry = await schedules.runNow('tenant-a', ada, created.id);

		expect(retry.id).toBe(first.id);
		expect(runs.size).toBe(1);
		expect(
			(await repository.listAuditEvents('tenant-a', 100)).filter(
				(event) => event.action === 'automation-schedule.fired',
			),
		).toHaveLength(1);
	});

	it('does not collide manual run keys across actors', async () => {
		const now = Date.parse('2026-09-02T09:30:00.000Z');
		const { repository } = shared;
		const { queue, runs } = runQueue();
		const schedules = new AutomationScheduleService(
			repository,
			queue,
			() => now,
		);
		const created = await schedules.create('tenant-a', 'user-a', {
			agentId: 'tenant-a-agent',
			label: 'Manual summary',
			inputTemplate: 'Summarize now.',
			cadence: 'every:60',
			enabled: true,
		});
		const first = await schedules.runNow(
			'tenant-a',
			{ kind: 'user', id: 'user-a', label: 'Ada' },
			created.id,
		);
		const second = await schedules.runNow(
			'tenant-a',
			{ kind: 'user', id: 'user-b', label: 'Bea' },
			created.id,
		);

		expect(second.id).not.toBe(first.id);
		expect(runs.size).toBe(2);
		expect(
			(await repository.listAuditEvents('tenant-a', 100)).filter(
				(event) => event.action === 'automation-schedule.fired',
			),
		).toHaveLength(2);
	});

	it('refuses a cross-tenant agent binding without exposing another tenant', async () => {
		const { queue } = runQueue();
		await expect(
			resolveScheduleTemplate(
				createScheduleVariableRegistry(queue),
				'{{ agent.name }} {{ context.today }}',
				{
					tenantId: 'tenant-a',
					agentId: 'tenant-b-agent',
					id: 'schedule-1',
					label: 'Daily',
				},
				Date.parse('2026-09-02T09:30:00.000Z'),
				{ kind: 'user', id: 'account-a', label: 'Account A' },
				[AUTOMATIONS_PERMISSIONS.manage],
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: 'VARIABLE_VALUE_UNAVAILABLE' });
	});

	it('settles one durable run for one due schedule slot', async () => {
		let now = 10_000;
		const { repository } = shared;
		const { queue, runs } = runQueue();
		const schedules = new AutomationScheduleService(
			repository,
			queue,
			() => now,
		);
		await schedules.create('tenant-a', 'user-a', {
			agentId: 'tenant-a-agent',
			label: 'Minute schedule',
			inputTemplate: 'Run once.',
			cadence: 'every:1',
			enabled: true,
		});
		now += 60_000;

		expect(await schedules.tick()).toBe(1);
		expect(await schedules.tick()).toBe(0);
		expect(runs.size).toBe(1);
		await expect(repository.verifyAuditChain('tenant-a')).resolves.toEqual({
			verified: true,
			brokenAt: null,
		});
	});

	it('disables a due schedule when its bound agent was removed', async () => {
		let now = 10_000;
		let agentExists = true;
		const enqueue = vi.fn<AgentRunQueue['enqueue']>();
		const queue: AgentRunQueue = {
			listAgents: async (tenantId) =>
				agentExists
					? [
							{
								id: tenantId + '-agent',
								name: 'Workspace agent',
								status: 'active',
								allowedTools: [],
								revision: 1,
								ownership: { kind: 'tenant' },
							},
						]
					: [],
			enqueue,
			enqueueWithOutcome: async (context, input) => ({
				run: await enqueue(context, input),
				created: true,
			}),
		};
		const { repository } = shared;
		const schedules = new AutomationScheduleService(
			repository,
			queue,
			() => now,
		);
		const created = await schedules.create(
			'tenant-a',
			'user-a',
			{
				agentId: 'tenant-a-agent',
				label: 'Removed agent schedule',
				inputTemplate: '{{ agent.name }}',
				cadence: 'every:1',
				enabled: true,
			},
			[AUTOMATIONS_PERMISSIONS.manage],
		);
		agentExists = false;
		now += 60_000;

		expect(await schedules.tick()).toBe(0);
		expect(await schedules.get('tenant-a', created.id)).toMatchObject({
			enabled: false,
			disabledReason: expect.stringContaining('AGENT_NOT_FOUND'),
		});
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('accepts a fresh signed webhook and makes a replay idempotent', async () => {
		const now = 1_700_000_000_000;
		const { repository } = shared;
		const { queue, runs } = runQueue();
		const triggers = new AutomationTriggerService(
			repository,
			new AesGcmSecretVault(Buffer.alloc(32, 7)),
			queue,
			() => now,
		);
		const created = await triggers.create('tenant-a', 'user-a', {
			agentId: 'tenant-a-agent',
			label: 'Signed trigger',
			enabled: true,
		});
		const timestamp = String(now);
		const body = '{"order":"42"}';
		const signature =
			'v1=' +
			triggerSignature(created.secret, triggerSignedPayload(timestamp, body));
		const request = {
			triggerId: created.trigger.id,
			body,
			signature,
			timestamp,
		};

		const first = await triggers.fire(request);
		const replay = await triggers.fire(request);
		expect(replay.id).toBe(first.id);
		expect(runs.size).toBe(1);
		await expect(
			repository.getTrigger('tenant-a', created.trigger.id),
		).resolves.toMatchObject({
			acceptedCount: 1,
		});
		expect(
			(await repository.listAuditEvents('tenant-a', 100)).filter(
				(event) => event.action === 'automation-trigger.fired',
			),
		).toHaveLength(1);
		expect(queue.enqueue).toHaveBeenLastCalledWith(
			{
				tenantId: 'tenant-a',
				permissionSnapshot: [],
				actor: {
					kind: 'service',
					id: `trigger:${created.trigger.id}`,
					label: 'Webhook trigger: Signed trigger',
					configuredBy: {
						kind: 'user',
						id: 'user-a',
						label: 'user-a',
					},
				},
			},
			expect.objectContaining({ input: body }),
		);
		expect((await repository.verifyAuditChain('tenant-a')).verified).toBe(true);
	});

	it('uses the same refusal for unknown and incorrectly signed triggers', async () => {
		const now = 1_700_000_000_000;
		const { repository } = shared;
		const { queue } = runQueue();
		const triggers = new AutomationTriggerService(
			repository,
			new AesGcmSecretVault(Buffer.alloc(32, 9)),
			queue,
			() => now,
		);
		const created = await triggers.create('tenant-a', 'user-a', {
			agentId: 'tenant-a-agent',
			label: 'Signed trigger',
			enabled: true,
		});
		const rejected = (triggerId: string) =>
			triggers.fire({
				triggerId,
				body: '{}',
				signature: 'v1=wrong',
				timestamp: String(now),
			});

		await expect(rejected(created.trigger.id)).rejects.toMatchObject({
			name: TriggerRejectedError.name,
			message: 'The trigger request was rejected.',
		});
		await expect(rejected('unknown-trigger')).rejects.toMatchObject({
			name: TriggerRejectedError.name,
			message: 'The trigger request was rejected.',
		});
	});
});

describe('automations PostgreSQL boundary', () => {
	function schedule(
		tenantId: string,
		id: string,
		label: string,
		nextRunAt: number,
	) {
		return {
			id,
			tenantId,
			targetKind: 'agent',
			targetKey: 'agent-1',
			agentId: 'agent-1',
			label,
			inputTemplate: 'Summarize the day.',
			cadence: 'every:60',
			enabled: true,
			disabledReason: null,
			nextRunAt,
			lastRunAt: null,
			lastRunId: null,
			lastError: null,
			createdAt: 1,
			updatedAt: 1,
			createdBy: 'account-a',
			configuredBy: {
				kind: 'user',
				id: 'account-a',
				label: 'Owner',
			},
			permissionSnapshot: ['agents.runs.create'],
		} as const;
	}

	it('keeps schedules tenant scoped and limits the scheduler poll to routing data', async () => {
		const { repository } = shared;
		await repository.createSchedule(
			schedule('tenant-a', 'schedule-a', 'Daily digest for A', 10),
		);
		await repository.createSchedule(
			schedule('tenant-b', 'schedule-b', 'Daily digest for B', 20),
		);

		expect(
			(await repository.listSchedules('tenant-a')).map((record) => record.id),
		).toEqual(['schedule-a']);
		expect(await repository.getSchedule('tenant-a', 'schedule-b')).toBeNull();

		/* The poll crosses tenants on purpose. It must return the routing columns
		   and nothing else, so a leak here cannot carry a label, a prompt
		   template, or a permission snapshot out of a tenant. */
		const due = await repository.listDueSchedules(1_000, 10);
		expect(due).toEqual([
			{ tenantId: 'tenant-a', id: 'schedule-a', nextRunAt: 10 },
			{ tenantId: 'tenant-b', id: 'schedule-b', nextRunAt: 20 },
		]);
		for (const routing of due) {
			expect(Object.keys(routing).sort()).toEqual([
				'id',
				'nextRunAt',
				'tenantId',
			]);
		}

		/* The scheduler re-reads under the tenant the poll named, so the full row
		   is reachable only through a tenant-bound handle. */
		expect(
			(await repository.getSchedule('tenant-b', 'schedule-b'))?.label,
		).toBe('Daily digest for B');
	});

	it('refuses a runtime transaction that carries no tenant', async () => {
		const { runtime } = shared;
		await expect(
			runtime.transaction(
				(transaction) => transaction.query({ text: 'SELECT 1 AS one' }),
				{ access: 'read' },
			),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('denies the background role every column outside the routing set and every write', async () => {
		const { repository, background } = shared;
		await repository.createSchedule(
			schedule('tenant-a', 'schedule-a', 'Confidential label', 10),
		);

		const identity = await background.transaction(
			(transaction) =>
				transaction.query<{ role: string }>({
					text: 'SELECT current_user AS role',
				}),
			{ access: 'read' },
		);
		/* The grants only mean something against a distinct role. A suite must
		   actually be connected as it, or this would pass by reading nothing. */
		expect(identity.rows[0]?.role).toBe('coreloom_background');

		for (const text of [
			'SELECT label FROM automations_schedules',
			'SELECT input_template FROM automations_schedules',
			'SELECT permission_snapshot_json FROM automations_schedules',
			'SELECT * FROM automations_schedules',
			'SELECT secret_ciphertext FROM automations_triggers',
			'SELECT label FROM automations_triggers',
			'SELECT * FROM automations_triggers',
			'SELECT * FROM automations_audit_events',
		]) {
			await expect(
				background.transaction((transaction) => transaction.query({ text }), {
					access: 'read',
				}),
			).rejects.toBeDefined();
		}

		await expect(
			background.transaction(
				(transaction) =>
					transaction.execute({
						text: 'UPDATE automations_schedules SET enabled = 0',
					}),
				{ access: 'write' },
			),
		).rejects.toBeDefined();
	});

	it('advances a due schedule exactly once for the slot the poll named', async () => {
		const { repository } = shared;
		await repository.createSchedule(
			schedule('tenant-a', 'schedule-a', 'Daily digest for A', 10),
		);
		const advance = {
			tenantId: 'tenant-a',
			scheduleId: 'schedule-a',
			firedSlot: 10,
			nextRunAt: 70,
			lastRunAt: 12,
			lastRunId: 'run-1',
			lastError: null,
		};
		await expect(repository.advanceSchedule(advance)).resolves.toBe(true);
		/* A second worker holding the same poll result must lose: next_run_at has
		   moved past the slot it claimed. */
		await expect(repository.advanceSchedule(advance)).resolves.toBe(false);
	});
});
