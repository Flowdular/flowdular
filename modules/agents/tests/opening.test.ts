import type {
	DatabaseAdapterLease,
	DatabaseTransaction,
} from '@flowdular/database';
import type { AgentTool } from '@flowdular/harness';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ASSISTANT_AGENT_ID } from '../src/agent/assistant.ts';
import type {
	ModuleAgentDefinition,
	ModuleAgentView,
} from '../src/domain/types.ts';
import {
	defineAgent,
	moduleAgentDefinitionHash,
	normalizeModuleAgentDefinitions,
} from '../src/server/define-agent.ts';
import {
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentChildCapabilityContext,
	type AgentRevisionExecutionCapability,
} from '../src/server/run-execution.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { DatabaseAgentRepository } from '../src/services/database-repository.ts';
import {
	agentPrincipal,
	composeAgents,
	queueTenantRun,
	type ComposedAgents,
} from './support/composition.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';
import {
	recordingProvider,
	type RecordedStatement,
	type RecordingHooks,
} from './support/recording.ts';

const CATALOG_TENANT = '__flowdular_module_agents__';
const SUPERSEDED = 'MODULE_AGENT_REVISION_SUPERSEDED';
const OWED_READ =
	/^SELECT agent_definitions\.tenant_id FROM agent_definitions WHERE agent_definitions\.tenant_id <> '__flowdular_module_agents__' AND NOT EXISTS .* LIMIT 1$/;
const OWING_PAGE = /^SELECT DISTINCT agent_definitions\.tenant_id/;

const readTool: AgentTool = {
	id: 'ledger.entry.read',
	transport: 'api',
	target: 'ledger.entries.get',
	description: 'Read one ledger entry.',
	requiredPermissions: ['ledger.entries.read'],
	execute: async () => ({}),
};

const writeTool: AgentTool = {
	id: 'ledger.entry.update',
	transport: 'api',
	target: 'ledger.entries.update',
	description: 'Update one ledger entry.',
	requiredPermissions: ['ledger.entries.manage'],
	execute: async () => ({}),
};

function ledgerAgent(
	revision: number,
	options: { readonly key?: string; readonly tools?: readonly string[] } = {},
): ModuleAgentDefinition {
	return defineAgent({
		moduleId: 'ledger.core',
		key: options.key ?? 'ledger-reviewer',
		definitionRevision: revision,
		name: `Ledger reviewer r${revision}`,
		description: 'Reviews ledger entries.',
		instructions: `Review ledger entries under revision ${revision}.`,
		allowedTools: [...(options.tools ?? [readTool.id, writeTool.id])],
		limits: {
			maxSteps: 4,
			timeoutMs: 10_000,
			temperature: 0,
			maxOutputTokens: 1_024,
		},
	});
}

interface Instance extends ComposedAgents {
	readonly statements: RecordedStatement[];
}

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
const instances: ComposedAgents[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const opened of instances.splice(0)) await opened.composed.dispose?.();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await owner?.release();
	await database.dispose();
});

/* One deployment's agents.core, web or worker, over the shared database. Its
   statements are recorded from its first lease on. */
async function instance(
	agents: readonly ModuleAgentDefinition[],
	hooks?: RecordingHooks,
): Promise<Instance> {
	const recorded = recordingProvider(database.databases, hooks);
	const composed = composeAgents({
		databases: recorded.provider,
		agents,
		tools: [readTool, writeTool],
	});
	instances.push(composed);
	await composed.composed.prepare();
	return { ...composed, statements: recorded.statements };
}

function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) {
				return reject(new Error('Condition was not met in time.'));
			}
			setTimeout(() => void tick(), 10);
		};
		void tick();
	});
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 250));

async function listModuleAgents(
	target: ComposedAgents,
	tenant: string,
): Promise<ModuleAgentView[]> {
	const response = await target.call(
		agentPrincipal(tenant),
		'/api/agents/context',
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { moduleAgents: ModuleAgentView[] })
		.moduleAgents;
}

function bindAgent(
	target: ComposedAgents,
	tenant: string,
	agentId: string,
	enabledTools: readonly string[],
	expectedRevision = 0,
): Promise<Response> {
	return target.mutation(
		agentPrincipal(tenant),
		'/api/agents/module-bindings/update',
		{
			agentId,
			provider: 'local-simulation',
			model: 'deterministic-v1',
			enabledTools,
			status: 'active',
			expectedRevision,
		},
	);
}

function runAgent(
	target: ComposedAgents,
	tenant: string,
	agentId: string,
): Promise<Response> {
	return target.mutation(agentPrincipal(tenant), '/api/agent-runs', {
		agentId,
		input: 'Review the open entries.',
		toolGrants: [],
	});
}

const runStatus = async (tenant: string, id: string) =>
	(await database.repository.getRun(tenant, id))?.status;

const binding = (tenant: string, agentId: string) =>
	database.repository.getModuleAgentBinding(tenant, agentId);

async function auditActions(tenant: string, action: string) {
	return (await database.repository.listAuditEvents(tenant, 50)).filter(
		(event) => event.action === action,
	);
}

const writesTo = (statements: readonly RecordedStatement[], table: string) =>
	statements.filter((statement) =>
		new RegExp(`^(INSERT INTO|UPDATE|DELETE FROM) ${table}\\b`).test(
			statement.text,
		),
	);

const workspaceStatements = (statements: readonly RecordedStatement[]) =>
	statements.filter(
		(statement) =>
			statement.tenantId !== undefined &&
			!statement.tenantId.startsWith('__flowdular_'),
	);

describe('agents.core opening and module agent bindings', () => {
	it('AGENTS-WEB-BIND-BEFORE-WORKER reconciles on the first web request, binds a module agent and the assistant and queues a run for a later worker', async () => {
		const agent = ledgerAgent(1);
		const web = await instance([agent]);
		const listed = await listModuleAgents(web, 'tenant-a');

		const catalogueWrites = web.statements.flatMap((statement, index) =>
			/^INSERT INTO module_agent_definitions/.test(statement.text)
				? [index]
				: [],
		);
		const firstBindingRead = web.statements.findIndex(
			(statement) =>
				statement.purpose !== 'migration' &&
				/module_agent_bindings/.test(statement.text),
		);
		expect(catalogueWrites).toHaveLength(2);
		expect(Math.max(...catalogueWrites)).toBeLessThan(firstBindingRead);
		for (const id of [agent.id, ASSISTANT_AGENT_ID]) {
			expect(listed.find((candidate) => candidate.id === id)).toMatchObject({
				status: 'unconfigured',
				revision: null,
			});
			const bound = await bindAgent(
				web,
				'tenant-a',
				id,
				id === agent.id ? [readTool.id] : [],
			);
			expect(bound.status).toBe(200);
			expect(await bound.json()).toMatchObject({
				agent: { id, status: 'active', revision: 1, bindingRevision: 1 },
			});
		}
		expect(
			(await auditActions('tenant-a', 'module-agent.binding-created'))
				.map((event) => event.subjectId)
				.sort(),
		).toEqual([agent.id, ASSISTANT_AGENT_ID].sort());

		const queued = await runAgent(web, 'tenant-a', agent.id);
		expect(queued.status).toBe(202);
		const { run } = (await queued.json()) as {
			run: { id: string; status: string; agentRevision: number };
		};
		expect(run).toMatchObject({ status: 'queued', agentRevision: 1 });
		await idle();
		expect(await runStatus('tenant-a', run.id)).toBe('queued');

		const worker = await instance([agent]);
		await worker.composed.startWorker();
		await waitFor(
			async () => (await runStatus('tenant-a', run.id)) === 'succeeded',
		);
	});

	it('AGENTS-BINDING-REFRESH-ON-REQUEST advances a stale binding once when two web instances list and run the agent together', async () => {
		const agentId = ledgerAgent(1).id;
		const previous = await instance([ledgerAgent(1)]);
		for (const tenant of ['tenant-a', 'tenant-b']) {
			expect(
				(
					await bindAgent(previous, tenant, agentId, [
						readTool.id,
						writeTool.id,
					])
				).status,
			).toBe(200);
		}
		const next = ledgerAgent(2, { tools: [readTool.id] });
		const first = await instance([next]);
		const second = await instance([next]);
		/* Each opens on a request of a workspace without a binding. */
		for (const opened of [first, second]) {
			await listModuleAgents(opened, 'tenant-c');
		}
		expect(await binding('tenant-a', agentId)).toMatchObject({
			moduleDefinitionRevision: 1,
			executableRevision: 1,
			enabledTools: [readTool.id, writeTool.id],
		});
		const marks = [first.statements.length, second.statements.length];

		const [listed, queued] = await Promise.all([
			listModuleAgents(first, 'tenant-a'),
			runAgent(second, 'tenant-a', agentId),
		]);
		expect(listed.find((agent) => agent.id === agentId)).toMatchObject({
			status: 'active',
			revision: 2,
			bindingRevision: 2,
			allowedTools: [readTool.id],
			enabledTools: [readTool.id],
		});
		expect(queued.status).toBe(202);
		const { run } = (await queued.json()) as { run: { id: string } };
		expect(await database.repository.getRun('tenant-a', run.id)).toMatchObject({
			agentRevision: 2,
			agentName: next.name,
		});
		expect(
			await database.repository.getAgentRevision('tenant-a', agentId, 2),
		).toMatchObject({
			instructions: next.instructions,
			allowedTools: [readTool.id],
		});
		expect(await binding('tenant-a', agentId)).toMatchObject({
			moduleDefinitionRevision: 2,
			executableRevision: 2,
			revision: 2,
			enabledTools: [readTool.id],
		});
		expect(
			await auditActions('tenant-a', 'module-agent.definition-reconciled'),
		).toHaveLength(1);

		expect(await binding('tenant-b', agentId)).toMatchObject({
			moduleDefinitionRevision: 1,
			executableRevision: 1,
			revision: 1,
		});
		const touched = [
			...first.statements.slice(marks[0]),
			...second.statements.slice(marks[1]),
		].filter((statement) => /module_agent_bindings/.test(statement.text));
		expect(touched.length).toBeGreaterThan(0);
		expect(new Set(touched.map((statement) => statement.tenantId))).toEqual(
			new Set(['tenant-a']),
		);
	});

	it('AGENTS-WORKER-BINDING-PASS opens no workspace transaction when every binding is current', async () => {
		const agent = ledgerAgent(1);
		const web = await instance([agent]);
		for (const tenant of ['tenant-a', 'tenant-b', 'tenant-c']) {
			expect(
				(await bindAgent(web, tenant, agent.id, [readTool.id])).status,
			).toBe(200);
		}
		const pass = vi.spyOn(
			AgentService.prototype,
			'advanceStaleModuleAgentBindings',
		);
		const worker = await instance([agent]);
		const prepared = worker.statements.length;
		await worker.composed.startWorker();
		await waitFor(() => pass.mock.results.length === 1);
		await pass.mock.results[0]!.value;

		expect(
			worker.statements.filter((statement) =>
				/^SELECT tenant_id FROM module_agent_bindings/.test(statement.text),
			),
		).toEqual([
			expect.objectContaining({ purpose: 'background' }),
			expect.objectContaining({ purpose: 'background' }),
		]);
		expect(workspaceStatements(worker.statements)).toEqual([]);
		/* The catalogue is current, so the opening reads it once and writes
		   nothing. */
		const catalogue = worker.statements
			.slice(prepared)
			.filter((statement) => statement.tenantId === CATALOG_TENANT);
		expect(
			catalogue.filter((statement) => statement.access === 'write'),
		).toEqual([]);
		expect(
			catalogue.filter((statement) =>
				/^SELECT agent_id, definition_revision, content_hash FROM module_agent_definitions$/.test(
					statement.text,
				),
			),
		).toHaveLength(1);
	});

	it('AGENTS-WORKER-BINDING-PASS advances the bindings behind after the worker is ready, logs a failing workspace without its data and continues', async () => {
		const agentId = ledgerAgent(1).id;
		const previous = await instance([ledgerAgent(1)]);
		for (const tenant of ['tenant-a', 'tenant-b', 'tenant-c']) {
			expect(
				(await bindAgent(previous, tenant, agentId, [readTool.id])).status,
			).toBe(200);
		}
		const next = ledgerAgent(2);
		const web = await instance([next]);
		expect(
			(await bindAgent(web, 'tenant-d', agentId, [readTool.id])).status,
		).toBe(200);
		await owner.database.execute({
			text: `CREATE TRIGGER fail_binding_pass BEFORE INSERT ON agent_audit_events_v4
			FOR EACH ROW WHEN (NEW.tenant_id = 'tenant-b' AND NEW.action = 'module-agent.definition-reconciled')
			EXECUTE FUNCTION flowdular_reject_change('reconciliation audit unavailable')`,
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const readBindings =
			DatabaseAgentRepository.prototype.readModuleAgentBindings;
		const reads = vi
			.spyOn(DatabaseAgentRepository.prototype, 'readModuleAgentBindings')
			.mockImplementation(async function (
				this: DatabaseAgentRepository,
				...args: Parameters<typeof readBindings>
			) {
				if (args[0] === 'tenant-a') await held;
				return readBindings.apply(this, args);
			});
		const pass = vi.spyOn(
			AgentService.prototype,
			'advanceStaleModuleAgentBindings',
		);
		try {
			const worker = await instance([next]);
			await worker.composed.startWorker();
			await waitFor(() => pass.mock.calls.length === 1);
			const runId = await queueTenantRun(worker, 'tenant-e');
			await waitFor(
				async () => (await runStatus('tenant-e', runId)) === 'succeeded',
			);
			expect(await binding('tenant-a', agentId)).toMatchObject({
				moduleDefinitionRevision: 1,
			});

			release();
			await pass.mock.results[0]!.value;
			expect(
				await Promise.all(
					['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d'].map(
						async (tenant) =>
							(await binding(tenant, agentId))?.moduleDefinitionRevision,
					),
				),
			).toEqual([2, 1, 2, 2]);
			expect(await binding('tenant-d', agentId)).toMatchObject({ revision: 1 });
			expect(
				reads.mock.calls
					.map((call) => call[0])
					.filter((tenant) => tenant !== 'tenant-e'),
			).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
			expect(
				workspaceStatements(worker.statements).filter(
					(statement) => statement.tenantId === 'tenant-d',
				),
			).toEqual([]);
			const skipped = logged.mock.calls.filter((call) =>
				/binding pass skipped a workspace/.test(String(call[0])),
			);
			expect(skipped).toHaveLength(1);
			expect(JSON.stringify(skipped)).not.toMatch(/tenant-/);
		} finally {
			release();
			await owner.database.execute({
				text: 'DROP TRIGGER fail_binding_pass ON agent_audit_events_v4',
			});
		}
	});
});

describe('agents.core module agent catalogue', () => {
	/* Both roles read the catalogue before either writes; `first` then writes
	   before `second` goes on. The preflight in prepare() reads it too, so the
	   hooks wait until both are prepared. */
	async function raceOpenings(
		firstAgents: readonly ModuleAgentDefinition[],
		secondAgents: readonly ModuleAgentDefinition[],
	) {
		let armed = false;
		let reads = 0;
		let bothRead!: () => void;
		const readsDone = new Promise<void>((resolve) => {
			bothRead = resolve;
		});
		let firstWrote!: () => void;
		const firstWrite = new Promise<void>((resolve) => {
			firstWrote = resolve;
		});
		const hooks = (position: 'first' | 'second'): RecordingHooks => {
			let read = false;
			return {
				afterTransaction: async (_purpose, options) => {
					if (!armed || options?.tenantId !== CATALOG_TENANT) return;
					if (!read && options.access === 'read') {
						read = true;
						reads += 1;
						if (reads === 2) bothRead();
						await readsDone;
						if (position === 'second') await firstWrite;
					} else if (options.access === 'write' && position === 'first') {
						firstWrote();
					}
				},
			};
		};
		const first = await instance(firstAgents, hooks('first'));
		const second = await instance(secondAgents, hooks('second'));
		armed = true;
		const [firstList, secondList] = await Promise.all([
			listModuleAgents(first, 'tenant-a'),
			listModuleAgents(second, 'tenant-b'),
		]);
		return { first, second, firstList, secondList };
	}

	async function catalogue(agentId: string) {
		return (
			await owner.database.query<{
				definition_revision: number;
				content_hash: string;
			}>({
				text: `SELECT definition_revision, content_hash
				       FROM module_agent_definitions WHERE agent_id = $1`,
				parameters: [agentId],
			})
		).rows;
	}

	it('AGENTS-CATALOG-CONCURRENT writes each missing definition once when two roles open at the same moment', async () => {
		const agent = ledgerAgent(1);
		const { first, second, firstList, secondList } = await raceOpenings(
			[agent],
			[agent],
		);
		for (const listed of [firstList, secondList]) {
			expect(
				listed.find((candidate) => candidate.id === agent.id),
			).toMatchObject({ status: 'unconfigured' });
		}
		const statements = [...first.statements, ...second.statements];
		expect(writesTo(statements, 'module_agent_definitions')).toHaveLength(2);
		expect(writesTo(statements, 'agent_definitions')).toHaveLength(2);
		for (const role of [first, second]) {
			const locked = role.statements.find((statement) =>
				/pg_advisory_xact_lock/.test(statement.text),
			);
			expect(locked).toMatchObject({
				tenantId: CATALOG_TENANT,
				access: 'write',
			});
			expect(
				role.statements.find(
					(statement) => statement.transaction === locked!.transaction,
				),
			).toBe(locked);
		}
		expect(writesTo(second.statements, 'module_agent_definitions')).toEqual([]);
		expect(await catalogue(agent.id)).toEqual([
			{
				definition_revision: 1,
				content_hash: moduleAgentDefinitionHash(
					normalizeModuleAgentDefinitions([agent])[0]!,
				),
			},
		]);
	});

	it('AGENTS-CATALOG-CONCURRENT ends at the higher revision whichever role opens first and supersedes the lower one', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const lower = ledgerAgent(1, { key: 'concurrent-reviewer' });
		const higher = ledgerAgent(2, { key: 'concurrent-reviewer' });
		for (const order of [
			[lower, higher],
			[higher, lower],
		] as const) {
			await database.truncate();
			const { first, second } = await raceOpenings([order[0]], [order[1]]);
			expect(await catalogue(higher.id)).toEqual([
				{
					definition_revision: 2,
					content_hash: moduleAgentDefinitionHash(
						normalizeModuleAgentDefinitions([higher])[0]!,
					),
				},
			]);
			/* A role that wrote the lower revision first learns on its next
			   request that the catalogue moved on. */
			const [lowerRole, higherRole] =
				order[0] === lower ? [first, second] : [second, first];
			expect(
				(await listModuleAgents(higherRole, 'tenant-c')).find(
					(candidate) => candidate.id === higher.id,
				),
			).toMatchObject({ status: 'unconfigured' });
			expect(
				(await listModuleAgents(lowerRole, 'tenant-c')).find(
					(candidate) => candidate.id === higher.id,
				),
			).toMatchObject({
				status: 'unavailable',
				unavailableReason: expect.stringMatching(new RegExp(`^${SUPERSEDED}`)),
			});
			const run = await runAgent(lowerRole, 'tenant-c', higher.id);
			expect(run.status).toBe(409);
			expect(await run.json()).toMatchObject({ error: { code: SUPERSEDED } });
		}
	});

	it('AGENTS-ROLLING-OLDER-INSTANCE serves an agent a newer deployment advanced as superseded, refuses to change or run it and writes nothing', async () => {
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const older = ledgerAgent(1, { key: 'rolling-reviewer' });
		const newer = ledgerAgent(2, { key: 'rolling-reviewer' });
		const openedBefore = await instance([older]);
		for (const tenant of ['tenant-a', 'tenant-b']) {
			expect(
				(await bindAgent(openedBefore, tenant, older.id, [readTool.id])).status,
			).toBe(200);
		}
		const newDeployment = await instance([newer]);
		expect(
			(await listModuleAgents(newDeployment, 'tenant-a')).find(
				(agent) => agent.id === newer.id,
			),
		).toMatchObject({ status: 'active', revision: 2 });
		const mark = openedBefore.statements.length;
		const openedAfter = await instance([older]);

		const refusedSave = await bindAgent(
			openedBefore,
			'tenant-a',
			older.id,
			[],
			2,
		);
		expect(refusedSave.status).toBe(409);
		expect(await refusedSave.json()).toMatchObject({
			error: { code: SUPERSEDED },
		});
		for (const role of [openedBefore, openedAfter]) {
			for (const tenant of ['tenant-a', 'tenant-b']) {
				expect(
					(await listModuleAgents(role, tenant)).find(
						(agent) => agent.id === older.id,
					),
				).toMatchObject({
					status: 'unavailable',
					unavailableReason: expect.stringMatching(
						new RegExp(`^${SUPERSEDED}`),
					),
				});
			}
			const save = await bindAgent(role, 'tenant-b', older.id, [], 1);
			expect(save.status).toBe(409);
			expect(await save.json()).toMatchObject({ error: { code: SUPERSEDED } });
			const run = await runAgent(role, 'tenant-b', older.id);
			expect(run.status).toBe(409);
			expect(await run.json()).toMatchObject({ error: { code: SUPERSEDED } });
			await queueTenantRun(
				role,
				role === openedBefore ? 'tenant-c' : 'tenant-d',
			);
		}

		const revisions =
			openedBefore.capabilities.get<AgentRevisionExecutionCapability>(
				AGENT_RUN_EXECUTION_CAPABILITY,
			)!;
		const context: AgentChildCapabilityContext = {
			tenantId: 'tenant-b',
			workflowRunId: 'workflow-rolling',
			actor: { kind: 'user', id: 'owner-tenant-b', label: 'Owner' },
			permissionSnapshot: [
				'agents.definitions.read',
				'agents.runs.execute',
				'agents.runs.read',
			],
		};
		expect(await revisions.getRevision(older.id, 1, context)).toMatchObject({
			revision: 1,
			name: older.name,
		});
		const pinned = await revisions.enqueueRevision(
			{
				agentId: older.id,
				revision: 1,
				input: 'Review the open entries.',
				toolGrants: [],
				outputContract: { kind: 'text' },
				idempotencyKey: 'rolling-pinned-1',
			},
			context,
		);
		await openedBefore.composed.startWorker();
		await openedAfter.composed.startWorker();
		await waitFor(
			async () => (await runStatus('tenant-b', pinned.runId)) === 'succeeded',
		);

		const olderStatements = [
			...openedBefore.statements.slice(mark),
			...openedAfter.statements,
		];
		expect(writesTo(olderStatements, 'module_agent_definitions')).toEqual([]);
		expect(writesTo(olderStatements, 'module_agent_bindings')).toEqual([]);
		expect(
			writesTo(olderStatements, 'agent_definitions').filter(
				(statement) =>
					statement.tenantId === CATALOG_TENANT ||
					statement.parameters.includes(older.id),
			),
		).toEqual([]);
		expect(await catalogue(older.id)).toEqual([
			expect.objectContaining({ definition_revision: 2 }),
		]);
		expect(await binding('tenant-a', older.id)).toMatchObject({
			moduleDefinitionRevision: 2,
			revision: 2,
		});
		expect(await binding('tenant-b', older.id)).toMatchObject({
			moduleDefinitionRevision: 1,
			revision: 1,
		});
		expect(
			warned.mock.calls.filter((call) =>
				String(call[0]).includes(`${SUPERSEDED}: ${older.id}`),
			),
		).toHaveLength(1);
	});
});

describe('agents.core revision adoption', () => {
	/* Definitions saved before the retained revision ledger: a current
	   revision with no retained row. */
	/* Forced row-level security binds the owner too, so each workspace is
	   seeded and read in its own tenant transaction. */
	const asTenant = <T>(
		tenantId: string,
		operation: (transaction: DatabaseTransaction) => Promise<T>,
	) => owner.database.transaction(operation, { tenantId, access: 'write' });

	async function legacyAgents(tenants: readonly string[]) {
		for (const tenant of tenants) {
			await asTenant(tenant, (transaction) =>
				transaction.execute({
					text: `INSERT INTO agent_definitions
					       (id, tenant_id, agent_key, name, description, instructions,
					        provider, model, allowed_tools_json, max_steps, timeout_ms,
					        temperature_milli, status, revision, created_by, created_at,
					        updated_by, updated_at)
					       VALUES ($1, $2, 'legacy', 'Legacy agent',
					        'Saved before the ledger.', 'Answer briefly.', 'local-simulation',
					        'deterministic-v1', '[]', 2, 5000, 0, 'active', 3, 'owner', 1,
					        'owner', 1)`,
					parameters: [`legacy-${tenant}`, tenant],
				}),
			);
		}
	}

	async function retained(tenants: readonly string[]) {
		const rows: Record<string, unknown>[] = [];
		for (const tenant of tenants) {
			rows.push(
				...(await asTenant(
					tenant,
					async (transaction) =>
						(
							await transaction.query<Record<string, unknown>>({
								text: `SELECT tenant_id, agent_id, revision, name, instructions, retained_at
								       FROM agent_definition_revisions WHERE tenant_id = $1
								       ORDER BY agent_id, revision`,
								parameters: [tenant],
							})
						).rows,
				)),
			);
		}
		return rows;
	}

	const delegated = (tenantId: string): AgentChildCapabilityContext => ({
		tenantId,
		workflowRunId: `workflow-${tenantId}`,
		actor: { kind: 'user', id: `owner-${tenantId}`, label: 'Owner' },
		permissionSnapshot: ['agents.definitions.read'],
	});

	it('AGENTS-REVISION-ADOPTION makes one identifiers-only read and opens no workspace transaction when nothing is owed', async () => {
		const seed = await instance([]);
		for (const tenant of ['tenant-1', 'tenant-2', 'tenant-3']) {
			await queueTenantRun(seed, tenant);
		}
		const web = await instance([]);
		await listModuleAgents(web, 'tenant-1');
		const opening = web.statements.slice(
			0,
			web.statements.findIndex(
				(statement) => statement.tenantId === 'tenant-1',
			),
		);
		expect(workspaceStatements(opening)).toEqual([]);
		expect(
			web.statements.filter((statement) => statement.purpose === 'background'),
		).toEqual([
			expect.objectContaining({ text: expect.stringMatching(OWED_READ) }),
		]);
		expect(
			workspaceStatements(web.statements).filter(
				(statement) => statement.tenantId !== 'tenant-1',
			),
		).toEqual([]);

		const adopt = vi.spyOn(
			DatabaseAgentRepository.prototype,
			'adoptCurrentAgentRevisions',
		);
		const pass = vi.spyOn(
			AgentService.prototype,
			'advanceStaleModuleAgentBindings',
		);
		const worker = await instance([]);
		await worker.composed.startWorker();
		await waitFor(() => pass.mock.results.length === 1);
		await pass.mock.results[0]!.value;
		await idle();
		expect(adopt).not.toHaveBeenCalled();
		expect(
			worker.statements.filter(
				(statement) =>
					OWED_READ.test(statement.text) || OWING_PAGE.test(statement.text),
			),
		).toEqual([expect.objectContaining({ purpose: 'background' })]);
	});

	it('AGENTS-REVISION-ADOPTION adopts the requesting workspace in its own transaction and the rest in worker pages, skips a failing one and settles to one read', async () => {
		const paged = Array.from(
			{ length: 105 },
			(_, index) => `t-${String(index + 1).padStart(3, '0')}`,
		);
		const requesting = ['tenant-fail', 'tenant-pin', 'tenant-req'];
		await legacyAgents([...paged, ...requesting]);
		await owner.database.execute({
			text: `CREATE TRIGGER fail_revision_adoption BEFORE INSERT ON agent_definition_revisions
			FOR EACH ROW WHEN (NEW.tenant_id = 'tenant-fail')
			EXECUTE FUNCTION flowdular_reject_change('adoption unavailable')`,
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const adopt = vi.spyOn(
			DatabaseAgentRepository.prototype,
			'adoptCurrentAgentRevisions',
		);
		try {
			const web = await instance([]);
			const revisions = web.capabilities.get<AgentRevisionExecutionCapability>(
				AGENT_RUN_EXECUTION_CAPABILITY,
			)!;
			expect(await revisions.listRevisions(delegated('tenant-req'))).toEqual([
				expect.objectContaining({ agentId: 'legacy-tenant-req', revision: 3 }),
			]);
			const adopted = web.statements.find(
				(statement) =>
					/^INSERT INTO agent_definition_revisions/.test(statement.text) &&
					statement.tenantId === 'tenant-req',
			);
			expect(adopted).toMatchObject({ access: 'write' });
			expect(
				web.statements.some(
					(statement) =>
						statement.transaction === adopted!.transaction &&
						/^SELECT .* FROM agent_definition_revisions/.test(statement.text),
				),
			).toBe(true);
			expect(
				await revisions.getRevision(
					'legacy-tenant-pin',
					3,
					delegated('tenant-pin'),
				),
			).toMatchObject({ revision: 3 });
			expect(
				web.statements.filter((statement) => OWING_PAGE.test(statement.text)),
			).toEqual([]);
			expect(
				workspaceStatements(web.statements).filter(
					(statement) =>
						statement.tenantId !== 'tenant-req' &&
						statement.tenantId !== 'tenant-pin',
				),
			).toEqual([]);
			const adoptedByRequests = await retained(requesting);

			const worker = await instance([]);
			await worker.composed.startWorker();
			await waitFor(() => adopt.mock.results.length === 1);
			expect(await adopt.mock.results[0]!.value).toBe(false);
			const pages = worker.statements.filter((statement) =>
				OWING_PAGE.test(statement.text),
			);
			expect(pages.length).toBeGreaterThanOrEqual(2);
			for (const page of pages) {
				expect(page).toMatchObject({ purpose: 'background' });
				expect(page.parameters[1]).toBe(100);
			}
			const heartbeat = worker.statements.findIndex((statement) =>
				/^INSERT INTO agent_worker_heartbeats/.test(statement.text),
			);
			expect(heartbeat).toBeGreaterThanOrEqual(0);
			expect(heartbeat).toBeLessThan(worker.statements.indexOf(pages[0]!));
			expect((await retained(paged)).map((row) => row.tenant_id)).toEqual(
				paged,
			);
			expect(await retained(['tenant-fail'])).toEqual([]);
			expect(await retained(requesting)).toEqual(adoptedByRequests);
			const skipped = logged.mock.calls.filter((call) =>
				/revision adoption skipped a workspace/.test(String(call[0])),
			);
			expect(skipped).toHaveLength(1);
			expect(JSON.stringify(skipped)).not.toMatch(/tenant-|t-\d/);
		} finally {
			await owner.database.execute({
				text: 'DROP TRIGGER fail_revision_adoption ON agent_definition_revisions',
			});
		}

		const retry = await instance([]);
		await retry.composed.startWorker();
		await waitFor(() => adopt.mock.results.length === 2);
		expect(await adopt.mock.results[1]!.value).toBe(true);
		expect(await retained(['tenant-fail'])).toHaveLength(1);

		const pass = vi.spyOn(
			AgentService.prototype,
			'advanceStaleModuleAgentBindings',
		);
		const later = await instance([]);
		await listModuleAgents(later, 't-001');
		await later.composed.startWorker();
		await waitFor(() => pass.mock.results.length === 1);
		await pass.mock.results[0]!.value;
		await idle();
		expect(adopt).toHaveBeenCalledTimes(2);
		expect(
			later.statements.filter(
				(statement) =>
					OWED_READ.test(statement.text) || OWING_PAGE.test(statement.text),
			),
		).toEqual([expect.objectContaining({ purpose: 'background' })]);
		expect(
			workspaceStatements(later.statements).filter(
				(statement) => statement.tenantId !== 't-001',
			),
		).toEqual([]);
	});
});

/* PGlite runs one transaction at a time, so only a server can hold one request
   inside its transaction while another runs. CI runs this on PostgreSQL. */
describe.runIf(process.env.FD_TEST_DATABASE_ADAPTER === 'postgresql')(
	'agents.core binding advance under real overlap',
	() => {
		const LOCK_BINDING =
			/^SELECT \* FROM module_agent_bindings WHERE tenant_id = \$1 AND agent_id = \$2 FOR UPDATE$/;
		const AUDIT_LOCK =
			/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/;

		function gate() {
			let open!: () => void;
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { open, opened };
		}

		/* tenant-a holds a binding of each agent built from revision 1, and two
		   instances serve revision 2. The first holds its tenant-a request just
		   before it locks `heldAgent`'s binding until the second's request has
		   finished, or has waited on the tenant's audit lock long enough for a
		   lock cycle to form. */
		async function overlap(
			keys: readonly string[],
			heldAgent: (agents: readonly ModuleAgentDefinition[]) => string,
		) {
			const previous = await instance(
				keys.map((key) => ledgerAgent(1, { key })),
			);
			for (const key of keys) {
				const bound = await bindAgent(
					previous,
					'tenant-a',
					ledgerAgent(1, { key }).id,
					[readTool.id],
				);
				expect(bound.status).toBe(200);
			}
			const agents = keys.map((key) => ledgerAgent(2, { key }));
			const held = heldAgent(agents);
			const reachedLock = gate();
			const contenderWaits = gate();
			const contenderSettled = gate();
			const first = await instance(agents, {
				beforeStatement: async (statement) => {
					if (
						statement.tenantId !== 'tenant-a' ||
						!LOCK_BINDING.test(statement.text) ||
						statement.parameters[1] !== held
					) {
						return;
					}
					reachedLock.open();
					await Promise.race([
						contenderSettled.opened,
						contenderWaits.opened.then(idle),
					]);
				},
			});
			const second = await instance(agents, {
				beforeStatement: (statement) => {
					if (
						statement.tenantId === 'tenant-a' &&
						AUDIT_LOCK.test(statement.text)
					) {
						contenderWaits.open();
					}
				},
			});
			for (const opened of [first, second]) {
				await listModuleAgents(opened, 'tenant-c');
			}
			return {
				agents,
				async race<T>(
					request: (first: Instance) => Promise<T>,
					contender: (second: Instance) => Promise<Response>,
				): Promise<[T, Response]> {
					const pending = request(first);
					await reachedLock.opened;
					const contended = contender(second);
					void contended.then(contenderSettled.open, contenderSettled.open);
					return Promise.all([pending, contended]);
				},
			};
		}

		const reconciled = async (agentId: string) =>
			(
				await auditActions('tenant-a', 'module-agent.definition-reconciled')
			).filter((event) => event.subjectId === agentId);

		it('AGENTS-BINDING-REFRESH-ON-REQUEST advances a stale binding once when a request reads it after another advanced it while it waited', async () => {
			const { agents, race } = await overlap(
				['ledger-reviewer'],
				([agent]) => agent!.id,
			);
			const agent = agents[0]!;
			const [listed, queued] = await race(
				(first) => listModuleAgents(first, 'tenant-a'),
				(second) => runAgent(second, 'tenant-a', agent.id),
			);
			expect(queued.status).toBe(202);
			expect(
				listed.find((candidate) => candidate.id === agent.id),
			).toMatchObject({ revision: 2, bindingRevision: 2 });
			expect(await binding('tenant-a', agent.id)).toMatchObject({
				moduleDefinitionRevision: 2,
				executableRevision: 2,
				revision: 2,
			});
			expect(await reconciled(agent.id)).toHaveLength(1);
		});

		it('AGENTS-BINDING-REFRESH-ON-REQUEST advances two stale bindings in a list while a run advances one of them, without a deadlock', async () => {
			const { agents, race } = await overlap(
				['a-reviewer', 'b-reviewer'],
				(served) => served[1]!.id,
			);
			const [first, second] = agents as [
				ModuleAgentDefinition,
				ModuleAgentDefinition,
			];
			const [listed, queued] = await race(
				(listing) => listModuleAgents(listing, 'tenant-a'),
				(running) => runAgent(running, 'tenant-a', second.id),
			);
			expect(queued.status).toBe(202);
			for (const agent of [first, second]) {
				expect(
					listed.find((candidate) => candidate.id === agent.id),
				).toMatchObject({ revision: 2, bindingRevision: 2 });
				expect(await reconciled(agent.id)).toHaveLength(1);
			}
		});

		it('AGENTS-BINDING-REFRESH-ON-REQUEST advances two stale bindings in a list while a save configures one of them, without a deadlock', async () => {
			const { agents, race } = await overlap(
				['a-reviewer', 'b-reviewer'],
				(served) => served[1]!.id,
			);
			const [first, second] = agents as [
				ModuleAgentDefinition,
				ModuleAgentDefinition,
			];
			const [listed, saved] = await race(
				(listing) => listModuleAgents(listing, 'tenant-a'),
				(saving) => bindAgent(saving, 'tenant-a', second.id, [readTool.id], 1),
			);
			expect(saved.status).toBe(200);
			for (const agent of [first, second]) {
				expect(
					listed.find((candidate) => candidate.id === agent.id),
				).toMatchObject({ revision: 2, bindingRevision: 2 });
			}
			expect(await reconciled(first.id)).toHaveLength(1);
			expect(await reconciled(second.id)).toEqual([]);
			expect(
				(await auditActions('tenant-a', 'module-agent.binding-updated')).map(
					(event) => event.subjectId,
				),
			).toEqual([second.id]);
		});
	},
);
