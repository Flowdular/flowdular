import {
	agentActor,
	createDataClassRegistry,
	serviceActor,
	userActor,
	type Actor,
	type UserActor,
} from '@flowdular/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import type {
	JsonValue,
	WorkflowExecutionOrigin,
	WorkflowGraphV1,
	WorkflowPayloadEvidenceV1,
} from '../src/domain/types.ts';
import {
	RUN_RETENTION_DAYS,
	workflowsDataClasses,
} from '../src/services/data-classes.ts';
import type {
	CreateWorkflowRunWrite,
	WorkflowsRepository,
} from '../src/services/repository.ts';
import {
	openWorkflowsTestRepository,
	withHandle,
	type WorkflowsTestRepository,
} from './support/database.ts';

const TENANT = 'tenant-classes';
const OTHER = 'tenant-other';
const ADA = 'account-ada';
const BO = 'account-bo';
const DAY_MS = 86_400_000;
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);
const SECRET = 'the-customer-answer';

const ada = userActor({ accountId: ADA, email: 'ada@example.com' });
const bo = userActor({ accountId: BO, email: 'bo@example.com' });
const origin: WorkflowExecutionOrigin = { kind: 'manual' };
const schema = {
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
} as const;

const evidence: WorkflowPayloadEvidenceV1 = {
	version: 1,
	state: 'available',
	schemaId: 'schema.data',
	hash: 'sha256:input',
	originalByteSize: 24,
};

function graph(): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [
			{
				id: 'input.start',
				label: 'Input',
				type: 'input',
				inputPorts: [],
				outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
			},
			{
				id: 'output.done',
				label: 'Output',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.done',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'output.done', port: 'input' },
			},
		],
		schemas: { 'schema.data': schema },
		layout: { 'input.start': { x: 0, y: 0 }, 'output.done': { x: 300, y: 0 } },
	};
}

/** Who started a run, for the cases where that is not the person behind it. */
interface RunAuthority {
	readonly actor: Actor;
	readonly authorizationSubject: UserActor | null;
}

function runWrite(
	tenantId: string,
	id: string,
	requester: typeof ada,
	queuedAt: number,
	authority?: RunAuthority,
): CreateWorkflowRunWrite {
	return {
		run: {
			id,
			tenantId,
			workflowId: `workflow-${tenantId}`,
			workflowKey: 'probe',
			workflowName: 'Probe',
			workflowRevision: 1,
			graphChecksum: 'checksum',
			graph: graph(),
			compiledOrder: ['input.start', 'output.done'],
			mode: 'live',
			status: 'queued',
			actor: authority?.actor ?? requester,
			authorizationSubject:
				authority === undefined ? requester : authority.authorizationSubject,
			origin,
			permissionSnapshot: [WORKFLOWS_PERMISSIONS.runsExecute],
			permissionDigest: 'digest',
			inputHash: 'sha256:input',
			inputPayloadId: '',
			idempotencyKey: `${id}-key`,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedNodes: 0,
			totalNodes: 2,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				actionInvocations: 0,
				unpricedActions: 0,
				includedChildRunIds: [],
				unpricedChildRuns: 0,
			},
			cost: { unpricedActions: 0, unpricedChildRuns: 0 },
			failureCode: null,
			queuedAt,
			startedAt: null,
			completedAt: null,
			durationMs: null,
			cancellationRequestedAt: null,
		},
		input: { name: 'Ada' },
		inputEvidence: evidence,
	} as unknown as CreateWorkflowRunWrite;
}

const databases: WorkflowsTestRepository[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.dispose();
});

async function open(): Promise<WorkflowsTestRepository> {
	const database = await openWorkflowsTestRepository();
	databases.push(database);
	return database;
}

/** One run with a node attempt, its sealed payload and an edge transfer. */
async function seedRun(
	repository: WorkflowsRepository,
	tenantId: string,
	id: string,
	requester: typeof ada,
	at: number,
	settle: 'succeeded' | 'queued' = 'succeeded',
	authority?: RunAuthority,
): Promise<void> {
	await repository.createRun(runWrite(tenantId, id, requester, at, authority));
	await repository.startAttempt(
		{
			tenantId,
			runId: id,
			nodeId: 'input.start',
			nodeType: 'input',
			attempt: 1,
			semanticGroup: `${id}:input.start`,
			sideEffectIdempotencyKey: `${tenantId}:${id}:input.start`,
			input: { name: SECRET } as JsonValue,
			inputEvidence: evidence,
			schemaId: 'schema.data',
			recordedAt: at,
		},
		authority?.actor ?? requester,
		origin,
	);
	await repository.settleEdge({
		tenantId,
		runId: id,
		transfer: {
			edgeId: 'edge.done',
			sourceNodeId: 'input.start',
			sourcePort: 'data',
			sourceAttempt: 1,
			targetNodeId: 'output.done',
			targetPort: 'input',
			state: 'emitted',
			reason: null,
			evidence,
			settledAt: at,
		},
		payload: { name: SECRET } as JsonValue,
	});
	if (settle === 'queued') return;
	await repository.settleRun(
		tenantId,
		id,
		'succeeded',
		null,
		undefined,
		evidence,
		{
			version: 1,
			state: 'final',
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			includedChildRunIds: [],
			pricedChildRuns: 0,
			unpricedChildRuns: 0,
			actionInvocations: 0,
			unpricedActions: 0,
		},
		{
			version: 1,
			state: 'final',
			currency: 'USD',
			amountMicros: 0,
			pricingSnapshotIds: [],
			unpricedChildRuns: 0,
			unpricedActions: 0,
		},
		at,
	);
}

function declared(
	database: WorkflowsTestRepository,
	key: 'runs' | 'audit-events' | 'definitions',
	pageSize?: number,
) {
	const registry = createDataClassRegistry();
	registry.declare(
		'workflows.core',
		pageSize === undefined
			? workflowsDataClasses(async () => database.repository)
			: workflowsDataClasses(async () => database.repository, pageSize),
	);
	const declaration = registry
		.list()
		.find((module) => module.moduleId === 'workflows.core')
		?.classes.find((item) => item.key === key);
	if (!declaration) throw new Error(`workflows.core declared no ${key} class.`);
	return declaration;
}

async function exported(
	database: WorkflowsTestRepository,
	key: 'runs' | 'audit-events' | 'definitions',
	tenantId: string,
	pageSize?: number,
): Promise<readonly Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	await declared(database, key, pageSize).export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return rows;
}

async function runIds(
	database: WorkflowsTestRepository,
	tenantId: string,
): Promise<readonly string[]> {
	return (await exported(database, 'runs', tenantId)).map((row) =>
		String(row['id']),
	);
}

async function publishedWorkflow(
	database: WorkflowsTestRepository,
	tenantId: string,
	key: string,
	name: string,
	publish: boolean,
): Promise<void> {
	const created = await database.repository.createDefinition({
		definition: {
			id: `workflow-${key}`,
			tenantId,
			key,
			name,
			description: 'Seeded by the data class test.',
			status: 'active',
			currentDraftRevision: 1,
			publishedRevision: null,
			createdAt: SEPTEMBER,
			updatedAt: SEPTEMBER,
		},
		revision: {
			id: `revision-${key}`,
			workflowId: `workflow-${key}`,
			revision: 1,
			graph: graph(),
			graphChecksum: `checksum-${key}`,
			compilerVersion: 1,
			compiledOrder: ['input.start', 'output.done'],
			publishedAt: null,
			publishedBy: null,
		},
		actor: ada,
		origin,
	});
	if (!publish) return;
	await database.repository.publish(
		tenantId,
		created.definition.id,
		created.definition.currentDraftRevision,
		ada,
		origin,
		SEPTEMBER,
	);
}

describe('workflows.core data classes', () => {
	it('declares runs and published definitions with their retention', async () => {
		const database = await open();
		const registry = createDataClassRegistry();
		registry.declare(
			'workflows.core',
			workflowsDataClasses(async () => database.repository),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
						Boolean(declaration.sweep),
						Boolean(declaration.erase),
					]),
				),
		).toEqual([
			['workflows.core.runs', RUN_RETENTION_DAYS, true, true, true],
			['workflows.core.audit-events', null, true, false, false],
			['workflows.core.definitions', null, true, false, false],
		]);
	});

	it('sweeps settled runs older than the cutoff in one workspace only', async () => {
		const database = await open();
		await seedRun(
			database.repository,
			TENANT,
			'run-old',
			ada,
			SEPTEMBER - 3 * DAY_MS,
		);
		await seedRun(
			database.repository,
			TENANT,
			'run-cutoff',
			ada,
			SEPTEMBER - DAY_MS,
		);
		await seedRun(
			database.repository,
			TENANT,
			'run-open',
			ada,
			SEPTEMBER - 9 * DAY_MS,
			'queued',
		);
		await seedRun(
			database.repository,
			OTHER,
			'run-foreign',
			bo,
			SEPTEMBER - 3 * DAY_MS,
		);

		const removed = await declared(database, 'runs').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - DAY_MS),
			limit: 100,
		});

		/* The run settled exactly on the cutoff stays, which is what "strictly
		   older" means, and the run still working stays however old it is. */
		expect(removed).toEqual({ removed: 1 });
		expect([...(await runIds(database, TENANT))].sort()).toEqual([
			'run-cutoff',
			'run-open',
		]);
		expect(await runIds(database, OTHER)).toEqual(['run-foreign']);
	});

	it('takes the node states, events and sealed payloads of a swept run with it', async () => {
		const database = await open();
		await seedRun(database.repository, TENANT, 'run-a', ada, SEPTEMBER);
		const count = async (table: string) =>
			(
				await withHandle(database.databases, 'runtime', (handle) =>
					handle.transaction(
						(transaction) =>
							transaction.query<{ count: number | string }>({
								text: `SELECT count(*) AS count FROM ${table} WHERE run_id = $1`,
								parameters: ['run-a'],
							}),
						{ access: 'read', tenantId: TENANT },
					),
				)
			).rows.map((row) => Number(row.count))[0];
		/* The edge settlement readies the target node, so the run holds a state
		   for both. */
		expect(await count('workflow_node_states')).toBe(2);
		expect(await count('workflow_payloads')).toBeGreaterThan(0);

		await declared(database, 'runs').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 10,
		});

		for (const table of [
			'workflow_node_states',
			'workflow_node_attempts',
			'workflow_edge_transfers',
			'workflow_run_events',
			'workflow_payloads',
		]) {
			expect(await count(table)).toBe(0);
		}
		expect(await runIds(database, TENANT)).toEqual([]);
	});

	it('removes no more runs than the limit it was given', async () => {
		const database = await open();
		for (let offset = 0; offset < 3; offset += 1) {
			await seedRun(
				database.repository,
				TENANT,
				`run-${offset}`,
				ada,
				SEPTEMBER - offset * DAY_MS,
			);
		}

		const removed = await declared(database, 'runs').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 2,
		});

		expect(removed).toEqual({ removed: 2 });
		expect(await runIds(database, TENANT)).toHaveLength(1);
	});

	it('exports one workspace with its nodes, edges and time range', async () => {
		const database = await open();
		await seedRun(
			database.repository,
			TENANT,
			'run-old',
			ada,
			SEPTEMBER - 2 * DAY_MS,
		);
		await seedRun(database.repository, TENANT, 'run-new', ada, SEPTEMBER);
		await seedRun(database.repository, OTHER, 'run-foreign', bo, SEPTEMBER);
		const rows: Record<string, unknown>[] = [];

		const summary = await declared(database, 'runs').export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(2);
		expect(summary.from?.toISOString()).toBe(
			new Date(SEPTEMBER - 2 * DAY_MS).toISOString(),
		);
		expect(summary.to?.toISOString()).toBe(new Date(SEPTEMBER).toISOString());
		expect(rows.map((row) => row['id'])).toEqual(['run-new', 'run-old']);
		expect(rows.every((row) => row['tenantId'] === TENANT)).toBe(true);
		expect(rows[0]).toMatchObject({
			status: 'succeeded',
			queuedAt: new Date(SEPTEMBER).toISOString(),
		});
		expect(
			(rows[0]!['nodes'] as readonly { nodeId: string }[]).map(
				(node) => node.nodeId,
			),
		).toEqual(['input.start', 'output.done']);
		expect(
			(rows[0]!['edges'] as readonly { edgeId: string }[]).map(
				(edge) => edge.edgeId,
			),
		).toEqual(['edge.done']);
	});

	it('walks the run export in keyset pages rather than one query', async () => {
		const database = await open();
		for (let offset = 0; offset < 5; offset += 1) {
			await seedRun(
				database.repository,
				TENANT,
				`run-${offset}`,
				ada,
				SEPTEMBER - offset * DAY_MS,
			);
		}

		const rows = await exported(database, 'runs', TENANT, 2);

		expect(new Set(rows.map((row) => row['id'])).size).toBe(5);
	});

	it('pages a run export whose rows share one queue time', async () => {
		const database = await open();
		for (let index = 0; index < 4; index += 1) {
			await seedRun(
				database.repository,
				TENANT,
				`run-${index}`,
				ada,
				SEPTEMBER,
			);
		}

		const rows = await exported(database, 'runs', TENANT, 2);

		expect(new Set(rows.map((row) => row['id'])).size).toBe(4);
	});

	it('keeps the sealed execution payload out of the export', async () => {
		const database = await open();
		await seedRun(database.repository, TENANT, 'run-a', ada, SEPTEMBER);
		const ciphertext = (
			await withHandle(database.databases, 'runtime', (handle) =>
				handle.transaction(
					(transaction) =>
						transaction.query<{ ciphertext: string | null }>({
							text: `SELECT ciphertext FROM workflow_payloads
							       WHERE run_id = $1 AND kind = 'execution'`,
							parameters: ['run-a'],
						}),
					{ access: 'read', tenantId: TENANT },
				),
			)
		).rows[0]?.ciphertext;
		expect(ciphertext).toBeTruthy();

		const archive = JSON.stringify(await exported(database, 'runs', TENANT));

		expect(archive).not.toContain(ciphertext);
		expect(archive).not.toContain(SECRET);
	});

	it('exports the published workflows and not the drafts', async () => {
		const database = await open();
		await publishedWorkflow(database, TENANT, 'beta', 'Beta', true);
		await publishedWorkflow(database, TENANT, 'alpha', 'Alpha', true);
		await publishedWorkflow(database, TENANT, 'draft', 'Draft', false);
		await publishedWorkflow(database, OTHER, 'foreign', 'Foreign', true);

		const rows = await exported(database, 'definitions', TENANT, 1);

		expect(rows.map((row) => row['key'])).toEqual(['alpha', 'beta']);
		expect(rows[0]).toMatchObject({
			tenantId: TENANT,
			publishedRevision: 1,
			graphChecksum: 'checksum-alpha',
		});
		expect(rows[0]!['graph']).toEqual(graph());
		expect(declared(database, 'definitions').sweep).toBeUndefined();
	});

	it('exports nothing and reports no range for a workspace that holds none', async () => {
		const database = await open();
		await seedRun(database.repository, TENANT, 'run-a', ada, SEPTEMBER);
		await publishedWorkflow(database, TENANT, 'alpha', 'Alpha', true);

		for (const key of ['runs', 'definitions'] as const) {
			expect(
				await declared(database, key).export!({
					tenantId: 'tenant-empty',
					sink: { write: async () => undefined },
				}),
			).toEqual({ rows: 0, from: null, to: null });
		}
	});

	it('erases the runs one account requested and leaves the others', async () => {
		const database = await open();
		await seedRun(database.repository, TENANT, 'run-ada', ada, SEPTEMBER);
		await seedRun(database.repository, TENANT, 'run-bo', bo, SEPTEMBER);
		await seedRun(database.repository, OTHER, 'run-foreign', ada, SEPTEMBER);

		const result = await declared(database, 'runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 100,
		});

		expect(result).toEqual({ removed: 1 });
		expect(await runIds(database, TENANT)).toEqual(['run-bo']);
		expect(await runIds(database, OTHER)).toEqual(['run-foreign']);
	});

	it('reports an erasure batch that filled its limit as truncated', async () => {
		const database = await open();
		for (let index = 0; index < 3; index += 1) {
			await seedRun(
				database.repository,
				TENANT,
				`run-${index}`,
				ada,
				SEPTEMBER - index * DAY_MS,
			);
		}

		const first = await declared(database, 'runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 2,
		});
		const second = await declared(database, 'runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 2,
		});

		expect(first).toEqual({ removed: 2, truncated: true });
		expect(second).toEqual({ removed: 1 });
		expect(await runIds(database, TENANT)).toEqual([]);
	});

	it('erases the runs a schedule and an agent started for the subject', async () => {
		const database = await open();
		const schedule = serviceActor({
			serviceId: 'schedule-nightly',
			label: 'Nightly schedule',
			configuredBy: ada,
		});
		const agent = agentActor({
			runId: 'agent-run-1',
			agentId: 'agent-7',
			agentName: 'Assistant',
		});
		await seedRun(database.repository, TENANT, 'run-self', ada, SEPTEMBER);
		/* A run a schedule, a webhook or an automation started carries the person
		   only in the actor it was configured by. */
		await seedRun(
			database.repository,
			TENANT,
			'run-schedule',
			ada,
			SEPTEMBER,
			'succeeded',
			{ actor: schedule, authorizationSubject: null },
		);
		/* A run an agent started carries the person only in the delegated
		   authorization subject. */
		await seedRun(
			database.repository,
			TENANT,
			'run-agent',
			ada,
			SEPTEMBER,
			'succeeded',
			{ actor: agent, authorizationSubject: ada },
		);
		await seedRun(database.repository, TENANT, 'run-bo', bo, SEPTEMBER);
		await seedRun(database.repository, OTHER, 'run-foreign', ada, SEPTEMBER);

		const result = await declared(database, 'runs').erase!({
			tenantId: TENANT,
			subject: { accountId: ADA },
			limit: 100,
		});

		expect(result).toEqual({ removed: 3 });
		expect(await runIds(database, TENANT)).toEqual(['run-bo']);
		expect(await runIds(database, OTHER)).toEqual(['run-foreign']);
	});

	it('gives every run of a page its own node states, attempts and edges', async () => {
		const database = await open();
		for (let index = 0; index < 4; index += 1) {
			await seedRun(
				database.repository,
				TENANT,
				`run-${index}`,
				ada,
				SEPTEMBER - index * DAY_MS,
			);
		}

		const page = await database.repository.exportRunsPage(TENANT, null, 4);

		expect(page.map((entry) => entry.run.id)).toEqual([
			'run-0',
			'run-1',
			'run-2',
			'run-3',
		]);
		/* Every run holds the same node and edge ids, so a page that mixed the
		   child rows of one run into another would still look well formed. The
		   attempt keys are what name the run each row came from. */
		for (const { run, nodes, edges } of page) {
			expect(nodes.map((node) => node.nodeId)).toEqual([
				'input.start',
				'output.done',
			]);
			expect(
				nodes.flatMap((node) =>
					node.attempts.map((attempt) => attempt.semanticGroup),
				),
			).toEqual([`${run.id}:input.start`]);
			expect(edges.map((edge) => edge.edgeId)).toEqual(['edge.done']);
		}
	});

	it('assembles an export page without re-scanning the child rows per run', async () => {
		const database = await open();
		const runs = 24;
		for (let index = 0; index < runs; index += 1) {
			await seedRun(
				database.repository,
				TENANT,
				`run-${index}`,
				ada,
				SEPTEMBER - index * DAY_MS,
			);
		}
		/* Counts every predicate the call runs, which is the work a per-run scan
		   of the child rows spends and a bucketing pass does not. */
		const filter = Array.prototype.filter;
		let predicates = 0;
		Array.prototype.filter = function (
			this: unknown[],
			callback: (value: unknown, index: number, array: unknown[]) => unknown,
			thisArgument?: unknown,
		) {
			return filter.call(this, (value, index, array) => {
				predicates += 1;
				return callback.call(thisArgument, value, index, array);
			});
		} as never;
		let page;
		try {
			page = await database.repository.exportRunsPage(TENANT, null, runs);
		} finally {
			Array.prototype.filter = filter;
		}

		expect(page).toHaveLength(runs);
		/* A scan per run costs the page's runs times its child rows; one pass per
		   result set costs the rows alone. The bound sits far above what the
		   driver itself spends and far below the quadratic figure. */
		expect(predicates).toBeLessThan(runs * 8);
	});

	it('exports the workspace audit trail in chain order and sweeps none of it', async () => {
		const database = await open();
		await publishedWorkflow(database, TENANT, 'alpha', 'Alpha', true);
		await seedRun(database.repository, TENANT, 'run-a', ada, SEPTEMBER);
		await seedRun(database.repository, OTHER, 'run-foreign', bo, SEPTEMBER);

		const rows = await exported(database, 'audit-events', TENANT, 2);

		expect(rows.length).toBeGreaterThan(2);
		expect(rows.map((row) => row['sequence'])).toEqual(
			rows.map((_, index) => index + 1),
		);
		/* Every link names the hash of the one before it, which is why the class
		   carries no sweep: removing the oldest would break the next
		   verification with no way to tell retention from tampering. */
		expect(rows[0]!['previousHash']).toBeNull();
		expect(rows[1]!['previousHash']).toBe(rows[0]!['eventHash']);
		const archive = JSON.stringify(rows);
		expect(archive).toContain('run-a');
		expect(archive).not.toContain('run-foreign');

		const declaration = declared(database, 'audit-events');
		expect([
			declaration.defaultRetentionDays,
			declaration.sweep,
			declaration.erase,
		]).toEqual([null, undefined, undefined]);
	});

	it('finds a subject by index on the connection the erasure runs on', async () => {
		const database = await open();
		/* Enough rows that a workspace scan is the expensive plan, and statistics
		   the planner can actually see. Reading the person out of the stored actor
		   document instead cannot be indexed here: the jsonb extraction is not
		   leakproof, so the forced row level security policy is applied first and
		   the comparison stays a filter. */
		await withHandle(database.databases, 'runtime', (handle) =>
			handle.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO workflow_runs
						 (id, tenant_id, workflow_id, workflow_key, workflow_name,
						  workflow_revision, graph_checksum, compiler_version, graph_json,
						  compiled_order_json, mode, status, actor_json, origin_json,
						  subject_account_id, permission_snapshot_json, permission_digest,
						  input_hash, input_payload_id, input_evidence_json, limits_json,
						  total_nodes, usage_json, cost_json, queued_at)
						 SELECT 'plan-' || g, $1, 'w', 'k', 'n', 1, 'c', 1, '{}', '[]',
						  'live', 'succeeded', '{}', '{}', 'person-' || (g % 500),
						  '[]', 'd', 'h', '', '{}', '{}', 2, '{}', '{}', g
						 FROM generate_series(1, 5000) AS g`,
						parameters: [TENANT],
					}),
				{ access: 'write', tenantId: TENANT },
			),
		);
		await withHandle(database.databases, 'migration', (handle) =>
			handle.transaction(
				(transaction) => transaction.execute({ text: 'ANALYZE workflow_runs' }),
				{ access: 'write' },
			),
		);

		const plan = (
			await withHandle(database.databases, 'runtime', (handle) =>
				handle.transaction(
					(transaction) =>
						transaction.query<{ 'QUERY PLAN': string }>({
							text: `EXPLAIN SELECT id FROM workflow_runs
							 WHERE tenant_id = $1 AND subject_account_id = $2
							 ORDER BY id LIMIT $3`,
							parameters: [TENANT, 'person-7', 100],
						}),
					{ access: 'read', tenantId: TENANT },
				),
			)
		).rows
			.map((row) => row['QUERY PLAN'])
			.join('\n');

		expect(plan).toContain('workflow_runs_tenant_subject_account_idx');
		expect(plan).not.toContain('Seq Scan');
	});
});
