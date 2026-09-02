import { createHash, randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type PlatformCapabilityRegistry,
	type UserActor,
} from '@coreloom/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@coreloom/module-agents/server';
import {
	compileWorkflowGraph,
	EMPTY_WORKFLOW_GRAPH,
	jsonByteSize,
	jsonHash,
	parseWorkflowGraph,
	validateJsonSchema,
	type WorkflowReferenceCatalog,
} from '../domain/graph.ts';
import type {
	CreateWorkflowDefinitionInput,
	JsonValue,
	WorkflowAuditVerification,
	WorkflowCancellationResult,
	WorkflowCapabilityContext,
	WorkflowCostRollupV1,
	WorkflowDefinition,
	WorkflowDefinitionDetail,
	WorkflowDryRunResponseV1,
	WorkflowEnqueueRequest,
	WorkflowExecutionCapability,
	WorkflowExecutionOrigin,
	WorkflowGraphV1,
	WorkflowInvocationContext,
	WorkflowPublishedInspection,
	WorkflowPublishedReference,
	WorkflowRevision,
	WorkflowRunAccepted,
	WorkflowRunDetail,
	WorkflowRunEventV1,
	WorkflowRunFilters,
	WorkflowRunPage,
	WorkflowRunSummary,
	WorkflowSimulationRequest,
	WorkflowUsageRollupV1,
} from '../domain/types.ts';
import { WORKFLOW_LIMITS } from '../domain/types.ts';
import { WORKFLOWS_PERMISSIONS } from '../acl/permissions.ts';
import type { WorkflowCursorCodec } from './cursor-codec.ts';
import { safePayloadEvidence } from './payload-codec.ts';
import type {
	WorkflowAuditPage,
	WorkflowRunRecord,
	WorkflowsRepository,
} from './repository.ts';
import { simulateWorkflow } from './simulation.ts';

const KEY = /^[a-z][a-z0-9-]{2,119}$/;

function pageLimit(
	value: number | undefined,
	field: string,
	maximum: number,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new WorkflowsServiceError(
			'WORKFLOW_LIMIT_INVALID',
			`${field} must be an integer between 1 and ${maximum}.`,
		);
	}
	return value;
}

function parsedGraph(value: unknown): WorkflowGraphV1 {
	try {
		return parseWorkflowGraph(value);
	} catch {
		throw new WorkflowsServiceError(
			'WORKFLOW_GRAPH_INVALID',
			'The workflow graph must use the version 1 JSON graph contract.',
		);
	}
}

const PROVISIONAL_USAGE: WorkflowUsageRollupV1 = {
	version: 1,
	state: 'provisional',
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	includedChildRunIds: [],
	pricedChildRuns: 0,
	unpricedChildRuns: 0,
	actionInvocations: 0,
	unpricedActions: 0,
};

const PROVISIONAL_COST: WorkflowCostRollupV1 = {
	version: 1,
	state: 'provisional',
	currency: 'USD',
	amountMicros: 0,
	pricingSnapshotIds: [],
	unpricedChildRuns: 0,
	unpricedActions: 0,
};

export class WorkflowsServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly details?: JsonValue,
	) {
		super(message);
		this.name = 'WorkflowsServiceError';
	}
}

export interface WorkflowsServiceOptions {
	readonly capabilities: PlatformCapabilityRegistry;
	readonly cursorCodec: WorkflowCursorCodec;
	readonly now?: () => number;
	readonly onRunQueued?: () => void;
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new WorkflowsServiceError(
			'WORKFLOW_INPUT_INVALID',
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}

function trustedActor(actor: Actor): Actor {
	const normalized = normalizeActor(actor);
	if (!normalized) {
		throw new WorkflowsServiceError(
			'WORKFLOW_ACTOR_INVALID',
			'The workflow actor is invalid.',
		);
	}
	return normalized;
}

function trustedAuthorizationSubject(
	actor: Actor,
	subject?: UserActor,
): UserActor {
	const trusted = trustedActor(actor);
	const derived =
		trusted.kind === 'user'
			? trusted
			: trusted.kind === 'service'
				? trusted.configuredBy
				: undefined;
	const normalized = subject ? normalizeActor(subject) : derived;
	if (!normalized || normalized.kind !== 'user') {
		throw new WorkflowsServiceError(
			'WORKFLOW_AUTHORIZATION_SUBJECT_REQUIRED',
			'Agent-authored workflow runs require an explicit delegated user.',
			403,
		);
	}
	if (derived && normalized.id !== derived.id) {
		throw new WorkflowsServiceError(
			'WORKFLOW_AUTHORIZATION_SUBJECT_INVALID',
			'The delegated user does not match the workflow actor authority.',
			403,
		);
	}
	return normalized;
}

function requirePermission(
	permissions: readonly string[],
	permission: string,
): void {
	if (!permissions.includes(permission)) {
		throw new WorkflowsServiceError(
			'WORKFLOW_PERMISSION_DENIED',
			'The workflow permission is required.',
			403,
		);
	}
}

function digest(values: readonly string[]): string {
	return `sha256:${createHash('sha256')
		.update(JSON.stringify([...new Set(values)].sort()))
		.digest('hex')}`;
}

function manualContext(
	tenantId: string,
	actor: Actor,
	permissionSnapshot: readonly string[],
): WorkflowInvocationContext {
	return {
		tenantId,
		actor: trustedActor(actor),
		authorizationSubject: trustedAuthorizationSubject(actor),
		origin: { kind: 'manual' },
		permissionSnapshot: [...new Set(permissionSnapshot)].sort(),
	};
}

function validateInputSize(input: JsonValue): void {
	if (jsonByteSize(input) > WORKFLOW_LIMITS.maxInputBytes) {
		throw new WorkflowsServiceError(
			'WORKFLOW_LIMIT_EXCEEDED',
			'Workflow input exceeds 64 KB.',
			413,
		);
	}
}

export class WorkflowsService {
	readonly #now: () => number;

	constructor(
		private readonly repository: WorkflowsRepository,
		private readonly options: WorkflowsServiceOptions,
	) {
		this.#now = options.now ?? Date.now;
	}

	#agents(): AgentRevisionExecutionCapability | null {
		return this.options.capabilities.get<AgentRevisionExecutionCapability>(
			AGENT_RUN_EXECUTION_CAPABILITY,
		);
	}

	#actions(): AgentActionExecutionCapability | null {
		return this.options.capabilities.get<AgentActionExecutionCapability>(
			AGENT_ACTION_EXECUTION_CAPABILITY,
		);
	}

	#referenceCatalog(
		context: WorkflowCapabilityContext,
	): WorkflowReferenceCatalog | null {
		const agents = this.#agents();
		const actions = this.#actions();
		if (!agents || !actions) return null;
		const actionDescriptors = actions.listWorkflowActions();
		return {
			agent: (agentId, revision) => {
				const reference = agents.getRevision(agentId, revision, {
					tenantId: context.tenantId,
					workflowRunId: 'workflow-preflight',
					actor: context.actor,
					authorizationSubject: trustedAuthorizationSubject(
						context.actor,
						context.authorizationSubject,
					),
					permissionSnapshot: context.permissionSnapshot,
				});
				return {
					available: reference?.status === 'active',
					allowedTools: reference?.allowedTools ?? [],
				};
			},
			action: (actionId, contractVersion) => {
				const action = actionDescriptors.find(
					(entry) =>
						entry.id === actionId && entry.contractVersion === contractVersion,
				);
				return action
					? {
							available: true,
							requiredPermissions: action.requiredPermissions,
							risk: action.risk,
							idempotency: action.idempotency,
						}
					: { available: false, requiredPermissions: [] };
			},
		};
	}

	list(tenantId: string): readonly WorkflowDefinition[] {
		return this.repository.listDefinitions(
			bounded(tenantId, 'tenantId', 1, 128),
		);
	}

	detail(tenantId: string, workflowId: string): WorkflowDefinitionDetail {
		const detail = this.repository.definitionDetail(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(workflowId, 'workflowId', 1, 128),
		);
		if (!detail) {
			throw new WorkflowsServiceError(
				'WORKFLOW_NOT_FOUND',
				'The workflow was not found.',
				404,
			);
		}
		return detail;
	}

	create(
		tenantId: string,
		input: CreateWorkflowDefinitionInput,
		actor: Actor,
	): WorkflowDefinitionDetail {
		const now = this.#now();
		const key = bounded(input.key, 'key', 3, 120);
		if (!KEY.test(key)) {
			throw new WorkflowsServiceError(
				'WORKFLOW_INPUT_INVALID',
				'Workflow key must be a lowercase slug.',
			);
		}
		const definition: WorkflowDefinition = {
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			key,
			name: bounded(input.name, 'name', 2, 160),
			description: bounded(input.description, 'description', 0, 2_000),
			status: 'active',
			currentDraftRevision: 1,
			publishedRevision: null,
			createdAt: now,
			updatedAt: now,
		};
		const report = compileWorkflowGraph(EMPTY_WORKFLOW_GRAPH);
		const revision: WorkflowRevision = {
			id: randomUUID(),
			workflowId: definition.id,
			revision: 1,
			graph: EMPTY_WORKFLOW_GRAPH,
			graphChecksum: report.graphChecksum,
			compilerVersion: 1,
			compiledOrder: report.compiledOrder,
			publishedAt: null,
			publishedBy: null,
		};
		try {
			return this.repository.createDefinition({
				definition,
				revision,
				actor: trustedActor(actor),
				origin: { kind: 'manual' },
			});
		} catch (error) {
			if (String(error).includes('workflow_definitions.tenant_id')) {
				throw new WorkflowsServiceError(
					'WORKFLOW_KEY_CONFLICT',
					'A workflow with this key already exists.',
					409,
				);
			}
			throw error;
		}
	}

	update(
		tenantId: string,
		input: {
			readonly workflowId: string;
			readonly expectedRevision: number;
			readonly name: string;
			readonly description: string;
			readonly graph: unknown;
		},
		actor: Actor,
	): WorkflowDefinitionDetail {
		const current = this.detail(tenantId, input.workflowId);
		if (current.definition.status === 'archived') {
			throw new WorkflowsServiceError(
				'WORKFLOW_ARCHIVED',
				'Archived workflows cannot be edited.',
				409,
			);
		}
		const graph = parsedGraph(input.graph);
		const report = compileWorkflowGraph(graph);
		if (
			input.expectedRevision !== current.definition.currentDraftRevision ||
			!Number.isSafeInteger(input.expectedRevision)
		) {
			throw new WorkflowsServiceError(
				'WORKFLOW_REVISION_CONFLICT',
				'The workflow draft changed before this save.',
				409,
			);
		}
		const now = this.#now();
		const nextRevision = input.expectedRevision + 1;
		const definition: WorkflowDefinition = {
			...current.definition,
			name: bounded(input.name, 'name', 2, 160),
			description: bounded(input.description, 'description', 0, 2_000),
			currentDraftRevision: nextRevision,
			updatedAt: now,
		};
		const revision: WorkflowRevision = {
			id: randomUUID(),
			workflowId: definition.id,
			revision: nextRevision,
			graph,
			graphChecksum: report.graphChecksum,
			compilerVersion: 1,
			compiledOrder: report.compiledOrder,
			publishedAt: null,
			publishedBy: null,
		};
		const saved = this.repository.saveDraft({
			definition,
			revision,
			expectedRevision: input.expectedRevision,
			actor: trustedActor(actor),
			origin: { kind: 'manual' },
		});
		if (saved === 'conflict') {
			throw new WorkflowsServiceError(
				'WORKFLOW_REVISION_CONFLICT',
				'The workflow draft changed before this save.',
				409,
			);
		}
		return saved;
	}

	validate(
		graph: unknown,
		context: WorkflowInvocationContext,
	): WorkflowDryRunResponseV1 {
		const parsed = parsedGraph(graph);
		const catalog = this.#referenceCatalog(context);
		return compileWorkflowGraph(parsed, catalog ?? undefined);
	}

	publish(
		tenantId: string,
		workflowId: string,
		expectedRevision: number,
		actor: Actor,
		permissionSnapshot: readonly string[],
	): WorkflowDefinitionDetail {
		const context = manualContext(tenantId, actor, permissionSnapshot);
		const catalog = this.#referenceCatalog(context);
		if (!catalog) {
			throw new WorkflowsServiceError(
				'WORKFLOW_LIVE_CAPABILITIES_UNAVAILABLE',
				'Agent revision and action execution capabilities are required before publication.',
				503,
			);
		}
		const detail = this.detail(tenantId, workflowId);
		if (detail.definition.currentDraftRevision !== expectedRevision) {
			throw new WorkflowsServiceError(
				'WORKFLOW_REVISION_CONFLICT',
				'The workflow draft changed before publication.',
				409,
			);
		}
		const report = compileWorkflowGraph(detail.draft.graph, catalog);
		if (!report.valid) {
			throw new WorkflowsServiceError(
				'WORKFLOW_GRAPH_INVALID',
				'The workflow graph cannot be published.',
				400,
				report.issues as unknown as JsonValue,
			);
		}
		for (const permission of report.requiredPermissions) {
			requirePermission(permissionSnapshot, permission);
		}
		const published = this.repository.publish(
			tenantId,
			workflowId,
			expectedRevision,
			trustedActor(actor),
			{ kind: 'manual' },
			this.#now(),
		);
		if (published === 'conflict') {
			throw new WorkflowsServiceError(
				'WORKFLOW_REVISION_CONFLICT',
				'The workflow draft changed before publication.',
				409,
			);
		}
		if (!published) {
			throw new WorkflowsServiceError(
				'WORKFLOW_NOT_FOUND',
				'The workflow was not found.',
				404,
			);
		}
		return published;
	}

	archive(
		tenantId: string,
		workflowId: string,
		actor: Actor,
	): WorkflowDefinition {
		const definition = this.repository.archive(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(workflowId, 'workflowId', 1, 128),
			trustedActor(actor),
			{ kind: 'manual' },
			this.#now(),
		);
		if (!definition) {
			throw new WorkflowsServiceError(
				'WORKFLOW_NOT_FOUND',
				'The workflow was not found.',
				404,
			);
		}
		return definition;
	}

	delete(tenantId: string, workflowId: string, actor: Actor): void {
		const result = this.repository.deleteDraft(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(workflowId, 'workflowId', 1, 128),
			trustedActor(actor),
			{ kind: 'manual' },
			this.#now(),
		);
		if (result === 'not-found') {
			throw new WorkflowsServiceError(
				'WORKFLOW_NOT_FOUND',
				'The workflow was not found.',
				404,
			);
		}
		if (result === 'in-use') {
			throw new WorkflowsServiceError(
				'WORKFLOW_DELETE_INELIGIBLE',
				'Only an unpublished workflow without run history can be deleted.',
				409,
			);
		}
	}

	listAgentCatalog(context: WorkflowInvocationContext): readonly unknown[] {
		const agents = this.#agents();
		if (!agents) return [];
		return agents
			.listRevisions({
				tenantId: context.tenantId,
				workflowRunId: 'workflow-catalog',
				actor: context.actor,
				authorizationSubject: trustedAuthorizationSubject(
					context.actor,
					context.authorizationSubject,
				),
				permissionSnapshot: context.permissionSnapshot,
			})
			.map((agent) => ({
				agentId: agent.agentId,
				revision: agent.revision,
				name: agent.name,
				description: '',
				status: agent.status,
				supportsStructuredOutput: agent.supportsStructuredOutput,
				allowedTools: agent.allowedTools,
			}));
	}

	listActionCatalog(context: WorkflowInvocationContext): readonly unknown[] {
		const actions = this.#actions();
		if (!actions) return [];
		return actions
			.listWorkflowActions()
			.filter(
				(action) =>
					(action.risk === 'read' || action.risk === 'workspace-write') &&
					action.requiredPermissions.every((permission) =>
						context.permissionSnapshot.includes(permission),
					),
			)
			.map((action) => ({
				actionId: action.id,
				label: action.id,
				description: action.description,
				contractVersion: action.contractVersion,
				risk: action.risk,
				requiredPermissions: action.requiredPermissions,
				inputSchema: action.inputSchema,
				outputSchema: action.outputSchema,
			}));
	}

	#publishedDefinition(
		tenantId: string,
		workflowKey: string,
	): {
		readonly definition: WorkflowDefinition;
		readonly revision: WorkflowRevision;
	} {
		const definition = this.repository.findDefinitionByKey(
			tenantId,
			workflowKey,
		);
		if (!definition) {
			throw new WorkflowsServiceError(
				'WORKFLOW_NOT_FOUND',
				'The workflow was not found.',
				404,
			);
		}
		if (definition.status === 'archived') {
			throw new WorkflowsServiceError(
				'WORKFLOW_ARCHIVED',
				'Archived workflows cannot start new runs.',
				409,
			);
		}
		if (definition.publishedRevision === null) {
			throw new WorkflowsServiceError(
				'WORKFLOW_NOT_PUBLISHED',
				'The workflow has no published revision.',
				409,
			);
		}
		const revision = this.repository.findRevision(
			tenantId,
			definition.id,
			definition.publishedRevision,
		);
		if (!revision || revision.publishedAt === null) {
			throw new WorkflowsServiceError(
				'WORKFLOW_RECOVERY_INCONSISTENT',
				'The published workflow revision is missing.',
				500,
			);
		}
		return { definition, revision };
	}

	async enqueue(
		request: WorkflowEnqueueRequest,
		context: WorkflowInvocationContext,
	): Promise<WorkflowRunAccepted> {
		const trustedContext: WorkflowInvocationContext = {
			tenantId: bounded(context.tenantId, 'tenantId', 1, 128),
			actor: trustedActor(context.actor),
			authorizationSubject: trustedAuthorizationSubject(
				context.actor,
				context.authorizationSubject,
			),
			origin: context.origin,
			permissionSnapshot: [...new Set(context.permissionSnapshot)].sort(),
		};
		requirePermission(
			trustedContext.permissionSnapshot,
			WORKFLOWS_PERMISSIONS.runsExecute,
		);
		const workflowKey = bounded(request.workflowKey, 'workflowKey', 3, 120);
		const idempotencyKey = bounded(
			request.idempotencyKey,
			'idempotencyKey',
			8,
			200,
		);
		validateInputSize(request.input);
		const { definition, revision } = this.#publishedDefinition(
			trustedContext.tenantId,
			workflowKey,
		);
		const catalog = this.#referenceCatalog(trustedContext);
		if (!catalog) {
			throw new WorkflowsServiceError(
				'WORKFLOW_LIVE_CAPABILITIES_UNAVAILABLE',
				'Agent revision and action execution capabilities are unavailable.',
				503,
			);
		}
		const report = compileWorkflowGraph(revision.graph, catalog);
		if (!report.valid) {
			throw new WorkflowsServiceError(
				'WORKFLOW_GRAPH_INVALID',
				'The published workflow no longer passes live preflight.',
				409,
				report.issues as unknown as JsonValue,
			);
		}
		for (const permission of report.requiredPermissions) {
			requirePermission(trustedContext.permissionSnapshot, permission);
		}
		const inputNode = revision.graph.nodes.find(
			(node) => node.type === 'input',
		);
		const inputSchemaId = inputNode?.outputPorts[0]?.schemaId;
		if (
			!inputSchemaId ||
			validateJsonSchema(
				request.input,
				revision.graph.schemas[inputSchemaId] ?? {},
			).length > 0
		) {
			throw new WorkflowsServiceError(
				'WORKFLOW_INPUT_INVALID',
				'Workflow input does not match the published input schema.',
			);
		}
		const inputHash = jsonHash(request.input);
		const existing = this.repository.findRunByIdempotency(
			trustedContext.tenantId,
			idempotencyKey,
		);
		if (existing) {
			if (
				existing.workflowId !== definition.id ||
				existing.inputHash !== inputHash
			) {
				throw new WorkflowsServiceError(
					'WORKFLOW_IDEMPOTENCY_CONFLICT',
					'The idempotency key belongs to another workflow invocation.',
					409,
				);
			}
			return {
				runId: existing.id,
				workflowId: existing.workflowId,
				workflowRevision: existing.workflowRevision!,
				status: 'queued',
				created: false,
			};
		}
		const now = this.#now();
		const runId = randomUUID();
		const run: WorkflowRunRecord = {
			id: runId,
			tenantId: trustedContext.tenantId,
			workflowId: definition.id,
			workflowKey: definition.key,
			workflowName: definition.name,
			workflowRevision: revision.revision,
			graphChecksum: revision.graphChecksum,
			graph: revision.graph,
			compiledOrder: revision.compiledOrder,
			mode: 'live',
			status: 'queued',
			actor: trustedContext.actor,
			authorizationSubject: trustedContext.authorizationSubject!,
			origin: trustedContext.origin,
			permissionSnapshot: trustedContext.permissionSnapshot,
			permissionDigest: digest(trustedContext.permissionSnapshot),
			inputHash,
			inputPayloadId: '',
			idempotencyKey,
			leaseOwner: null,
			leaseExpiresAt: null,
			cancellationRequestedAt: null,
			queuedAt: now,
			startedAt: null,
			completedAt: null,
			durationMs: null,
			completedNodes: 0,
			totalNodes: revision.graph.nodes.length,
			failureCode: null,
			usage: PROVISIONAL_USAGE,
			cost: PROVISIONAL_COST,
		};
		this.repository.createRun({
			run,
			input: request.input,
			inputEvidence: safePayloadEvidence(request.input, inputSchemaId, {
				schema: revision.graph.schemas[inputSchemaId] ?? {},
				permissionSnapshot: trustedContext.permissionSnapshot,
			}),
		});
		this.options.onRunQueued?.();
		return {
			runId,
			workflowId: definition.id,
			workflowRevision: revision.revision,
			status: 'queued',
			created: true,
		};
	}

	simulate(
		request: WorkflowSimulationRequest,
		context: WorkflowInvocationContext,
	): WorkflowRunDetail {
		requirePermission(
			context.permissionSnapshot,
			WORKFLOWS_PERMISSIONS.runsExecute,
		);
		validateInputSize(request.input);
		if (request.fixtures.length > WORKFLOW_LIMITS.maxNodes) {
			throw new WorkflowsServiceError(
				'WORKFLOW_LIMIT_EXCEEDED',
				'Simulation fixtures exceed the graph node limit.',
				413,
			);
		}
		const detail = this.detail(context.tenantId, request.workflowId);
		const fixtureIds = new Set(
			request.fixtures.map((fixture) => fixture.nodeId),
		);
		if (fixtureIds.size !== request.fixtures.length) {
			throw new WorkflowsServiceError(
				'WORKFLOW_INPUT_INVALID',
				'Simulation fixtures must have unique node ids.',
			);
		}
		const report = compileWorkflowGraph(detail.draft.graph, {
			agent: () => true,
			action: () => ({
				available: true,
				requiredPermissions: [],
				risk: 'read',
				idempotency: 'required',
			}),
		});
		if (!report.valid) {
			throw new WorkflowsServiceError(
				'WORKFLOW_GRAPH_INVALID',
				'The draft graph cannot be simulated.',
				400,
				report.issues as unknown as JsonValue,
			);
		}
		const inputNode = detail.draft.graph.nodes.find(
			(node) => node.type === 'input',
		);
		const inputSchemaId = inputNode?.outputPorts[0]?.schemaId;
		const inputSchema = inputSchemaId
			? detail.draft.graph.schemas[inputSchemaId]
			: undefined;
		if (
			!inputSchemaId ||
			validateJsonSchema(request.input, inputSchema ?? {}).length > 0
		) {
			throw new WorkflowsServiceError(
				'WORKFLOW_INPUT_INVALID',
				'Simulation input does not match the workflow input schema.',
			);
		}
		const now = this.#now();
		const runId = randomUUID();
		const run = this.repository.createRun({
			run: {
				id: runId,
				tenantId: context.tenantId,
				workflowId: detail.definition.id,
				workflowKey: detail.definition.key,
				workflowName: detail.definition.name,
				workflowRevision: detail.draft.revision,
				graphChecksum: detail.draft.graphChecksum,
				graph: detail.draft.graph,
				compiledOrder: report.compiledOrder,
				mode: 'simulate',
				status: 'queued',
				actor: trustedActor(context.actor),
				authorizationSubject: trustedAuthorizationSubject(
					context.actor,
					context.authorizationSubject,
				),
				origin: context.origin,
				permissionSnapshot: [...new Set(context.permissionSnapshot)].sort(),
				permissionDigest: digest(context.permissionSnapshot),
				inputHash: jsonHash(request.input),
				inputPayloadId: '',
				idempotencyKey: null,
				leaseOwner: null,
				leaseExpiresAt: null,
				cancellationRequestedAt: null,
				queuedAt: now,
				startedAt: null,
				completedAt: null,
				durationMs: null,
				completedNodes: 0,
				totalNodes: detail.draft.graph.nodes.length,
				failureCode: null,
				usage: { ...PROVISIONAL_USAGE, state: 'not-applicable' },
				cost: { ...PROVISIONAL_COST, state: 'not-applicable' },
			},
			input: request.input,
			inputEvidence: safePayloadEvidence(request.input, inputSchemaId, {
				...(inputSchema ? { schema: inputSchema } : {}),
				permissionSnapshot: context.permissionSnapshot,
			}),
		});
		return simulateWorkflow(
			this.repository,
			run,
			request.input,
			request.fixtures,
		);
	}

	listRuns(tenantId: string, filters: WorkflowRunFilters): WorkflowRunPage {
		const normalizedTenant = bounded(tenantId, 'tenantId', 1, 128);
		const limit = pageLimit(
			filters.limit,
			'limit',
			WORKFLOW_LIMITS.maxInteractivePage,
			50,
		);
		const normalized = { ...filters, limit, cursor: null };
		const filterDigest = jsonHash(normalized as unknown as JsonValue);
		let rawCursor: string | null = null;
		if (filters.cursor) {
			try {
				const decoded = this.options.cursorCodec.decode<{
					readonly tenantId: string;
					readonly filterDigest: string;
					readonly raw: string;
				}>('wfrc1', filters.cursor);
				if (
					decoded.tenantId !== normalizedTenant ||
					decoded.filterDigest !== filterDigest
				) {
					throw new WorkflowsServiceError(
						'WORKFLOW_CURSOR_MISMATCH',
						'The run cursor belongs to another tenant or filter.',
						409,
					);
				}
				rawCursor = decoded.raw;
			} catch (error) {
				if (error instanceof WorkflowsServiceError) throw error;
				throw new WorkflowsServiceError(
					'WORKFLOW_CURSOR_INVALID',
					'The run cursor is invalid.',
				);
			}
		}
		const page = this.repository.listRuns(normalizedTenant, {
			...filters,
			limit,
			cursor: rawCursor,
		});
		return {
			runs: page.runs,
			nextCursor: page.nextCursor
				? this.options.cursorCodec.encode('wfrc1', {
						tenantId: normalizedTenant,
						filterDigest,
						raw: page.nextCursor,
					})
				: null,
		};
	}

	getRun(tenantId: string, runId: string): WorkflowRunSummary | null {
		return this.repository.getRun(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
	}

	getRunDetail(tenantId: string, runId: string): WorkflowRunDetail {
		const detail = this.repository.runDetail(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
		if (!detail) {
			throw new WorkflowsServiceError(
				'WORKFLOW_RUN_NOT_FOUND',
				'The workflow run was not found.',
				404,
			);
		}
		return detail;
	}

	readEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
		limit: number = WORKFLOW_LIMITS.maxReplayEvents,
	): readonly WorkflowRunEventV1[] {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new WorkflowsServiceError(
				'WORKFLOW_EVENT_CURSOR_INVALID',
				'The event sequence is invalid.',
			);
		}
		const replayLimit = pageLimit(
			limit,
			'limit',
			WORKFLOW_LIMITS.maxReplayEvents,
			WORKFLOW_LIMITS.maxReplayEvents,
		);
		const detail = this.getRunDetail(tenantId, runId);
		const latestSequence = detail.events.at(-1)?.sequence ?? 0;
		if (afterSequence > latestSequence) {
			throw new WorkflowsServiceError(
				'WORKFLOW_EVENT_CURSOR_AHEAD',
				'The event cursor is ahead of the persisted stream.',
				409,
			);
		}
		return this.repository.readEvents(
			tenantId,
			runId,
			afterSequence,
			replayLimit,
		);
	}

	eventCursor(tenantId: string, runId: string, sequence: number): string {
		if (!Number.isSafeInteger(sequence) || sequence < 0) {
			throw new WorkflowsServiceError(
				'WORKFLOW_EVENT_CURSOR_INVALID',
				'The event sequence is invalid.',
			);
		}
		return this.options.cursorCodec.encode('wfre1', {
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			runId: bounded(runId, 'runId', 1, 128),
			sequence,
		});
	}

	eventSequence(tenantId: string, runId: string, cursor: string): number {
		try {
			const decoded = this.options.cursorCodec.decode<{
				readonly tenantId: string;
				readonly runId: string;
				readonly sequence: number;
			}>('wfre1', cursor);
			if (
				decoded.tenantId !== bounded(tenantId, 'tenantId', 1, 128) ||
				decoded.runId !== bounded(runId, 'runId', 1, 128) ||
				!Number.isSafeInteger(decoded.sequence) ||
				decoded.sequence < 0
			) {
				throw new Error('cursor-binding');
			}
			return decoded.sequence;
		} catch {
			throw new WorkflowsServiceError(
				'WORKFLOW_EVENT_CURSOR_INVALID',
				'The event cursor is invalid for this workflow run.',
				409,
			);
		}
	}

	cancel(
		tenantId: string,
		runId: string,
		actor: Actor,
	): WorkflowCancellationResult {
		const result = this.repository.requestCancellation(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
			trustedActor(actor),
			{ kind: 'manual' },
			this.#now(),
		);
		if (!result) {
			throw new WorkflowsServiceError(
				'WORKFLOW_RUN_NOT_FOUND',
				'The workflow run was not found.',
				404,
			);
		}
		this.options.onRunQueued?.();
		return {
			runId: result.run.id,
			status: result.run.status,
			requested: result.requested,
		};
	}

	retry(
		tenantId: string,
		runId: string,
		actor: Actor,
		permissionSnapshot: readonly string[],
	): WorkflowRunAccepted {
		requirePermission(permissionSnapshot, WORKFLOWS_PERMISSIONS.runsExecute);
		const prior = this.repository.getRun(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
		if (!prior) {
			throw new WorkflowsServiceError(
				'WORKFLOW_RUN_NOT_FOUND',
				'The workflow run was not found.',
				404,
			);
		}
		if (
			prior.mode !== 'live' ||
			!['failed', 'refused', 'cancelled'].includes(prior.status)
		) {
			throw new WorkflowsServiceError(
				'WORKFLOW_RUN_TERMINAL',
				'Only a terminal failed, refused, or cancelled live run can be retried.',
				409,
			);
		}
		const context = manualContext(tenantId, actor, permissionSnapshot);
		const catalog = this.#referenceCatalog(context);
		if (!catalog) {
			throw new WorkflowsServiceError(
				'WORKFLOW_LIVE_CAPABILITIES_UNAVAILABLE',
				'Agent and action execution capabilities are unavailable.',
				503,
			);
		}
		const report = compileWorkflowGraph(prior.graph, catalog);
		if (!report.valid) {
			throw new WorkflowsServiceError(
				'WORKFLOW_GRAPH_INVALID',
				'The pinned workflow revision no longer passes live preflight.',
				409,
				report.issues as unknown as JsonValue,
			);
		}
		for (const permission of report.requiredPermissions)
			requirePermission(permissionSnapshot, permission);
		const input = this.repository.readExecutionPayload(
			tenantId,
			prior.id,
			prior.inputPayloadId,
		);
		const now = this.#now();
		const nextId = randomUUID();
		const inputNode = prior.graph.nodes.find((node) => node.type === 'input');
		const schemaId = inputNode?.outputPorts[0]?.schemaId ?? 'workflow.input';
		const created = this.repository.createRun({
			run: {
				...prior,
				id: nextId,
				actor: context.actor,
				origin: context.origin,
				permissionSnapshot: context.permissionSnapshot,
				permissionDigest: digest(context.permissionSnapshot),
				status: 'queued',
				inputPayloadId: '',
				idempotencyKey: `retry:${prior.id}:${nextId}`,
				leaseOwner: null,
				leaseExpiresAt: null,
				cancellationRequestedAt: null,
				queuedAt: now,
				startedAt: null,
				completedAt: null,
				durationMs: null,
				completedNodes: 0,
				failureCode: null,
				usage: PROVISIONAL_USAGE,
				cost: PROVISIONAL_COST,
			},
			input,
			inputEvidence: safePayloadEvidence(input, schemaId, {
				schema: prior.graph.schemas[schemaId] ?? {},
				permissionSnapshot,
			}),
		});
		this.options.onRunQueued?.();
		return {
			runId: created.id,
			workflowId: created.workflowId,
			workflowRevision: created.workflowRevision!,
			status: 'queued',
			created: true,
		};
	}

	listAudit(
		tenantId: string,
		limit: number,
		cursor?: string | null,
	): WorkflowAuditPage {
		const normalizedTenant = bounded(tenantId, 'tenantId', 1, 128);
		const pageSize = pageLimit(
			limit,
			'limit',
			WORKFLOW_LIMITS.maxInteractivePage,
			50,
		);
		let beforeSequence: number | undefined;
		if (cursor) {
			try {
				const decoded = this.options.cursorCodec.decode<{
					readonly tenantId: string;
					readonly beforeSequence: number;
				}>('wfac1', cursor);
				if (decoded.tenantId !== normalizedTenant) {
					throw new WorkflowsServiceError(
						'WORKFLOW_CURSOR_MISMATCH',
						'The audit cursor belongs to another tenant.',
						409,
					);
				}
				beforeSequence = decoded.beforeSequence;
			} catch (error) {
				if (error instanceof WorkflowsServiceError) throw error;
				throw new WorkflowsServiceError(
					'WORKFLOW_CURSOR_INVALID',
					'The audit cursor is invalid.',
				);
			}
		}
		const page = this.repository.listAudit(
			normalizedTenant,
			pageSize,
			beforeSequence,
		);
		return {
			events: page.events,
			nextCursor: page.nextCursor
				? this.options.cursorCodec.encode('wfac1', {
						tenantId: normalizedTenant,
						beforeSequence: Number(page.nextCursor),
					})
				: null,
		};
	}

	verifyAudit(tenantId: string): WorkflowAuditVerification {
		return this.repository.verifyAudit(bounded(tenantId, 'tenantId', 1, 128));
	}

	executionDependencies(): {
		readonly agents: AgentRevisionExecutionCapability;
		readonly actions: AgentActionExecutionCapability;
	} | null {
		const agents = this.#agents();
		const actions = this.#actions();
		return agents && actions ? { agents, actions } : null;
	}

	executionCapability(): WorkflowExecutionCapability {
		return {
			listPublished: (context) => {
				requirePermission(
					context.permissionSnapshot,
					WORKFLOWS_PERMISSIONS.read,
				);
				return this.repository.listPublished(context.tenantId);
			},
			getPublishedReference: (workflowKey, context) => {
				requirePermission(
					context.permissionSnapshot,
					WORKFLOWS_PERMISSIONS.read,
				);
				const reference = this.repository
					.listPublished(context.tenantId)
					.find(
						(candidate) =>
							candidate.key === bounded(workflowKey, 'workflowKey', 3, 120),
					);
				if (!reference) return null;
				const revision = this.repository.findRevision(
					context.tenantId,
					reference.id,
					reference.revision,
				);
				if (!revision || revision.publishedAt === null) {
					throw new WorkflowsServiceError(
						'WORKFLOW_RECOVERY_INCONSISTENT',
						'The published workflow revision is missing.',
						500,
					);
				}
				const catalog = this.#referenceCatalog(context);
				if (!catalog) {
					throw new WorkflowsServiceError(
						'WORKFLOW_LIVE_CAPABILITIES_UNAVAILABLE',
						'Agent revision and action execution capabilities are required to inspect a workflow.',
						503,
					);
				}
				const report = compileWorkflowGraph(revision.graph, catalog);
				if (!report.valid) {
					throw new WorkflowsServiceError(
						'WORKFLOW_PUBLISHED_REFERENCE_UNAVAILABLE',
						'The published workflow references are no longer available.',
						409,
						report.issues as unknown as JsonValue,
					);
				}
				return {
					...reference,
					requiredPermissions: report.requiredPermissions,
				} satisfies WorkflowPublishedInspection;
			},
			enqueue: (request, context) => this.enqueue(request, context),
			getRun: (runId, context) => {
				requirePermission(
					context.permissionSnapshot,
					WORKFLOWS_PERMISSIONS.runsRead,
				);
				return this.getRun(context.tenantId, runId);
			},
			cancel: (runId, context) => {
				requirePermission(
					context.permissionSnapshot,
					WORKFLOWS_PERMISSIONS.runsCancel,
				);
				return this.cancel(context.tenantId, runId, context.actor);
			},
		};
	}
}
