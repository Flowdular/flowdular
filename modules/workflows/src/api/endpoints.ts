import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	actorFromContext,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import type {
	JsonValue,
	WorkflowExecutionOrigin,
	WorkflowRunFilters,
	WorkflowRunMode,
	WorkflowRunStatus,
	WorkflowSimulationFixture,
} from '../domain/types.ts';
import { WORKFLOW_LIMITS } from '../domain/types.ts';
import { WORKFLOWS_PERMISSIONS } from '../acl/permissions.ts';
import type { WorkflowsRuntime } from '../server/runtime.ts';
import { WorkflowsServiceError } from '../services/workflows-service.ts';

const TERMINAL_EVENTS = new Set([
	'run.succeeded',
	'run.failed',
	'run.refused',
	'run.cancelled',
]);

function failure(error: unknown): Response {
	if (error instanceof WorkflowsServiceError) {
		return jsonResponse(
			{
				error: {
					code: error.code,
					message: error.message,
					...(error.details === undefined ? {} : { details: error.details }),
				},
			},
			error.status,
		);
	}
	return problemResponse(error, 'The workflows operation failed.');
}

function requireJson(value: unknown, field: string, depth = 0): JsonValue {
	if (depth > 40)
		throw new HttpProblem(
			'INVALID_INPUT',
			`${field} is too deeply nested.`,
			400,
		);
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (Array.isArray(value))
		return value.map((entry) => requireJson(entry, field, depth + 1));
	if (typeof value === 'object') {
		const output: Record<string, JsonValue> = {};
		for (const [key, child] of Object.entries(value)) {
			output[key] = requireJson(child, `${field}.${key}`, depth + 1);
		}
		return output;
	}
	throw new HttpProblem('INVALID_INPUT', `${field} must be valid JSON.`, 400);
}

function optionalQuery(
	url: URL,
	key: string,
	allowed?: readonly string[],
): string | undefined {
	const value = url.searchParams.get(key);
	if (value === null || value === '') return undefined;
	if (value.length > 2_048 || (allowed && !allowed.includes(value))) {
		throw new HttpProblem('INVALID_INPUT', `${key} is invalid.`, 400);
	}
	return value;
}

function requiredDescription(value: Record<string, unknown>): string {
	const description = value.description;
	if (typeof description !== 'string' || description.length > 2_000) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'description must be a string with at most 2000 characters.',
			400,
		);
	}
	return description;
}

function fixtures(value: unknown): readonly WorkflowSimulationFixture[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'fixtures must be an array with at most 100 items.',
			400,
		);
	}
	return value.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new HttpProblem(
				'INVALID_INPUT',
				`fixtures[${index}] must be an object.`,
				400,
			);
		}
		const item = entry as Record<string, unknown>;
		return {
			nodeId: requiredString(item, 'nodeId', { min: 3, max: 128 }),
			...(typeof item.outcomePort === 'string'
				? { outcomePort: requiredString(item, 'outcomePort', { max: 64 }) }
				: {}),
			...(item.output === undefined
				? {}
				: { output: requireJson(item.output, 'output') }),
			...(typeof item.failureCode === 'string'
				? { failureCode: requiredString(item, 'failureCode', { max: 128 }) }
				: {}),
			...(item.simulatedDurationMs === undefined
				? {}
				: {
						simulatedDurationMs: requiredInteger(item, 'simulatedDurationMs', {
							min: 0,
							max: 3_600_000,
						}),
					}),
		};
	});
}

function invocationContext(octane: Parameters<typeof principalFromContext>[0]) {
	const principal = principalFromContext(octane)!;
	const actor = actorFromContext(octane)!;
	if (actor.kind !== 'user') {
		throw new HttpProblem(
			'INVALID_ACTOR',
			'Interactive workflow requests require a user actor.',
			403,
		);
	}
	return {
		tenantId: principal.tenantId,
		actor,
		authorizationSubject: actor,
		origin: { kind: 'manual' } as const,
		permissionSnapshot: [...principal.scopes],
	};
}

function streamEvents(
	runtime: WorkflowsRuntime,
	tenantId: string,
	runId: string,
	afterSequence: number,
	request: Request,
): Response {
	const encoder = new TextEncoder();
	let cursor = afterSequence;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let nextHeartbeatAt = Date.now() + 15_000;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const close = () => {
				if (closed) return;
				closed = true;
				if (timer) clearTimeout(timer);
				request.signal.removeEventListener('abort', close);
				controller.close();
			};
			request.signal.addEventListener('abort', close, { once: true });
			controller.enqueue(encoder.encode('retry: 1000\n\n'));
			const pump = async () => {
				if (closed || request.signal.aborted) return close();
				try {
					const events = await (
						await runtime.service()
					).readEvents(tenantId, runId, cursor);
					for (const event of events) {
						cursor = event.sequence;
						const eventCursor = (await runtime.service()).eventCursor(
							tenantId,
							runId,
							event.sequence,
						);
						controller.enqueue(
							encoder.encode(
								`id: ${eventCursor}\ndata: ${JSON.stringify(event)}\n\n`,
							),
						);
					}
					if (events.some((event) => TERMINAL_EVENTS.has(event.type))) {
						controller.enqueue(
							encoder.encode('event: workflow.stream-complete\ndata: {}\n\n'),
						);
						return close();
					}
					if (events.length === WORKFLOW_LIMITS.maxReplayEvents) {
						const replayCursor = (await runtime.service()).eventCursor(
							tenantId,
							runId,
							cursor,
						);
						controller.enqueue(
							encoder.encode(
								`event: workflow.replay-boundary\ndata: ${JSON.stringify({ cursor: replayCursor })}\n\n`,
							),
						);
						timer = setTimeout(() => void pump(), 0);
						return;
					}
					/* A terminal projection can be ahead of this replay page. Drain every
					   full page before using the projection as the close shortcut, otherwise
					   a resumed client can miss the persisted terminal event. */
					const run = await (await runtime.service()).getRun(tenantId, runId);
					if (
						run &&
						['succeeded', 'failed', 'refused', 'cancelled'].includes(run.status)
					) {
						controller.enqueue(
							encoder.encode('event: workflow.stream-complete\ndata: {}\n\n'),
						);
						return close();
					}
				} catch (error) {
					controller.enqueue(
						encoder.encode(
							`event: workflow.stream-error\ndata: ${JSON.stringify({ error: { code: error instanceof WorkflowsServiceError ? error.code : 'WORKFLOW_STREAM_FAILED' } })}\n\n`,
						),
					);
					return close();
				}
				if (Date.now() >= nextHeartbeatAt) {
					controller.enqueue(
						encoder.encode('event: workflow.heartbeat\ndata: {}\n\n'),
					);
					nextHeartbeatAt = Date.now() + 15_000;
				}
				timer = setTimeout(() => void pump(), 300);
			};
			void pump();
		},
		cancel() {
			closed = true;
			if (timer) clearTimeout(timer);
		},
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		},
	});
}

export function createWorkflowsRoutes(
	auth: AuthRuntime,
	runtime: WorkflowsRuntime,
) {
	const list = defineEndpoint({
		id: 'workflows.definitions.list',
		path: '/api/workflows',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) =>
			jsonResponse({
				definitions: await (
					await runtime.service()
				).list(principalFromContext(octane)!.tenantId),
			}),
	});
	const create = defineEndpoint({
		id: 'workflows.definitions.create',
		path: '/api/workflows',
		methods: ['POST'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const detail = await (
					await runtime.service()
				).create(
					principalFromContext(octane)!.tenantId,
					{
						key: requiredString(value, 'key', { min: 3, max: 120 }),
						name: requiredString(value, 'name', { min: 2, max: 160 }),
						description: requiredDescription(value),
					},
					actorFromContext(octane)!,
				);
				return jsonResponse({ definition: detail.definition }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const detail = defineEndpoint({
		id: 'workflows.definitions.detail',
		path: '/api/workflows/detail',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const id = optionalQuery(new URL(octane.request.url), 'id');
				if (!id) throw new HttpProblem('INVALID_INPUT', 'id is required.', 400);
				return jsonResponse({
					detail: await (
						await runtime.service()
					).detail(principalFromContext(octane)!.tenantId, id),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const update = defineEndpoint({
		id: 'workflows.definitions.update',
		path: '/api/workflows/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 96 * 1_024);
				return jsonResponse({
					detail: await (
						await runtime.service()
					).update(
						principalFromContext(octane)!.tenantId,
						{
							workflowId: requiredString(value, 'workflowId', { max: 128 }),
							expectedRevision: requiredInteger(value, 'expectedRevision', {
								min: 1,
							}),
							name: requiredString(value, 'name', { min: 2, max: 160 }),
							description: requiredDescription(value),
							graph: value.graph,
						},
						actorFromContext(octane)!,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const validate = defineEndpoint({
		id: 'workflows.definitions.validate',
		path: '/api/workflows/validate',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: WORKFLOWS_PERMISSIONS.runsExecute,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 96 * 1_024);
				return jsonResponse({
					report: await (
						await runtime.service()
					).validate(value.graph, invocationContext(octane)),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const publish = defineEndpoint({
		id: 'workflows.definitions.publish',
		path: '/api/workflows/publish',
		methods: ['POST'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.publish },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					detail: await (
						await runtime.service()
					).publish(
						principal.tenantId,
						requiredString(value, 'workflowId', { max: 128 }),
						requiredInteger(value, 'expectedRevision', { min: 1 }),
						actorFromContext(octane)!,
						principal.scopes,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const archive = defineEndpoint({
		id: 'workflows.definitions.archive',
		path: '/api/workflows/archive',
		methods: ['POST'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				return jsonResponse({
					definition: await (
						await runtime.service()
					).archive(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'workflowId', { max: 128 }),
						actorFromContext(octane)!,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const remove = defineEndpoint({
		id: 'workflows.definitions.delete',
		path: '/api/workflows/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				await (
					await runtime.service()
				).delete(
					principalFromContext(octane)!.tenantId,
					requiredString(value, 'workflowId', { max: 128 }),
					actorFromContext(octane)!,
				);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const agentCatalog = defineEndpoint({
		id: 'workflows.catalog.agents',
		path: '/api/workflow-catalog/agents',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				return jsonResponse({
					agents: await (
						await runtime.service()
					).listAgentCatalog(invocationContext(octane)),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const actionCatalog = defineEndpoint({
		id: 'workflows.catalog.actions',
		path: '/api/workflow-catalog/actions',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				return jsonResponse({
					actions: await (
						await runtime.service()
					).listActionCatalog(invocationContext(octane)),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const listRuns = defineEndpoint({
		id: 'workflows.runs.list',
		path: '/api/workflow-runs',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const rawLimit = optionalQuery(url, 'limit');
				const workflowId = optionalQuery(url, 'workflowId');
				const mode = optionalQuery(url, 'mode', ['simulate', 'live']);
				const status = optionalQuery(url, 'status', [
					'queued',
					'running',
					'waiting-agent',
					'waiting-retry',
					'cancel-requested',
					'succeeded',
					'failed',
					'refused',
					'cancelled',
				]);
				const actorKind = optionalQuery(url, 'actorKind', [
					'user',
					'agent',
					'service',
				]);
				const originKind = optionalQuery(url, 'originKind', [
					'manual',
					'module',
					'schedule',
					'webhook',
				]);
				const cursor = optionalQuery(url, 'cursor');
				const filters: WorkflowRunFilters = {
					...(workflowId ? { workflowId } : {}),
					...(mode ? { mode: mode as WorkflowRunMode } : {}),
					...(status ? { status: status as WorkflowRunStatus } : {}),
					...(actorKind
						? { actorKind: actorKind as 'user' | 'agent' | 'service' }
						: {}),
					...(originKind
						? { originKind: originKind as WorkflowExecutionOrigin['kind'] }
						: {}),
					...(rawLimit ? { limit: Number(rawLimit) } : {}),
					...(cursor ? { cursor } : {}),
				};
				return jsonResponse(
					await (await runtime.service()).listRuns(principal.tenantId, filters),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const enqueueRun = defineEndpoint({
		id: 'workflows.runs.enqueue',
		path: '/api/workflow-runs',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: WORKFLOWS_PERMISSIONS.runsExecute,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 72 * 1_024);
				return jsonResponse(
					{
						accepted: await (
							await runtime.service()
						).enqueue(
							{
								workflowKey: requiredString(value, 'workflowKey', {
									min: 3,
									max: 120,
								}),
								input: requireJson(value.input, 'input'),
								idempotencyKey: requiredString(value, 'idempotencyKey', {
									min: 8,
									max: 200,
								}),
							},
							invocationContext(octane),
						),
					},
					202,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const simulate = defineEndpoint({
		id: 'workflows.runs.simulate',
		path: '/api/workflow-runs/simulate',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: WORKFLOWS_PERMISSIONS.runsExecute,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 128 * 1_024);
				return jsonResponse({
					run: await (
						await runtime.service()
					).simulate(
						{
							workflowId: requiredString(value, 'workflowId', { max: 128 }),
							input: requireJson(value.input, 'input'),
							fixtures: fixtures(value.fixtures),
						},
						invocationContext(octane),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const runDetail = defineEndpoint({
		id: 'workflows.runs.detail',
		path: '/api/workflow-runs/detail',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const id = optionalQuery(new URL(octane.request.url), 'id');
				if (!id) throw new HttpProblem('INVALID_INPUT', 'id is required.', 400);
				return jsonResponse(
					await (
						await runtime.service()
					).getRunDetail(principalFromContext(octane)!.tenantId, id),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const cancel = defineEndpoint({
		id: 'workflows.runs.cancel',
		path: '/api/workflow-runs/cancel',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: WORKFLOWS_PERMISSIONS.runsCancel,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				return jsonResponse(
					await (
						await runtime.service()
					).cancel(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'runId', { max: 128 }),
						actorFromContext(octane)!,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const retry = defineEndpoint({
		id: 'workflows.runs.retry',
		path: '/api/workflow-runs/retry',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: WORKFLOWS_PERMISSIONS.runsExecute,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					await (
						await runtime.service()
					).retry(
						principal.tenantId,
						requiredString(value, 'runId', { max: 128 }),
						actorFromContext(octane)!,
						principal.scopes,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const events = defineEndpoint({
		id: 'workflows.runs.events',
		path: '/api/workflow-runs/events',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const runId = optionalQuery(url, 'runId');
				if (!runId)
					throw new HttpProblem('INVALID_INPUT', 'runId is required.', 400);
				const headerCursor = octane.request.headers.get('last-event-id');
				const queryCursor = url.searchParams.get('afterSequence');
				const principal = principalFromContext(octane)!;
				const fromHeader =
					headerCursor === null
						? null
						: (await runtime.service()).eventSequence(
								principal.tenantId,
								runId,
								headerCursor,
							);
				const fromQuery = queryCursor === null ? null : Number(queryCursor);
				if (
					fromQuery !== null &&
					(!Number.isSafeInteger(fromQuery) || fromQuery < 0)
				)
					throw new HttpProblem(
						'INVALID_INPUT',
						'afterSequence must be a non-negative integer.',
						400,
					);
				if (
					fromHeader !== null &&
					fromQuery !== null &&
					fromHeader !== fromQuery
				)
					throw new WorkflowsServiceError(
						'WORKFLOW_EVENT_CURSOR_CONFLICT',
						'The event cursors do not match.',
						409,
					);
				const after = fromHeader ?? fromQuery ?? 0;
				await (
					await runtime.service()
				).readEvents(principal.tenantId, runId, after, 1);
				return streamEvents(
					runtime,
					principal.tenantId,
					runId,
					after,
					octane.request,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const audit = defineEndpoint({
		id: 'workflows.audit.list',
		path: '/api/workflow-audit',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const limit = Number(url.searchParams.get('limit') ?? '50');
				return jsonResponse(
					await (
						await runtime.service()
					).listAudit(
						principalFromContext(octane)!.tenantId,
						limit,
						url.searchParams.get('cursor'),
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const verify = defineEndpoint({
		id: 'workflows.audit.verify',
		path: '/api/workflow-audit/verify',
		methods: ['GET'],
		access: { kind: 'permission', permission: WORKFLOWS_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				return jsonResponse(
					await (
						await runtime.service()
					).verifyAudit(principalFromContext(octane)!.tenantId),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [
		list,
		create,
		detail,
		update,
		validate,
		publish,
		archive,
		remove,
		agentCatalog,
		actionCatalog,
		listRuns,
		enqueueRun,
		simulate,
		runDetail,
		cancel,
		retry,
		events,
		audit,
		verify,
	].map((endpoint) => endpoint.serverRoute);
}

export const endpoints = [
	'workflows.definitions.list',
	'workflows.definitions.create',
	'workflows.definitions.detail',
	'workflows.definitions.update',
	'workflows.definitions.validate',
	'workflows.definitions.publish',
	'workflows.definitions.archive',
	'workflows.definitions.delete',
	'workflows.catalog.agents',
	'workflows.catalog.actions',
	'workflows.runs.list',
	'workflows.runs.enqueue',
	'workflows.runs.simulate',
	'workflows.runs.detail',
	'workflows.runs.cancel',
	'workflows.runs.retry',
	'workflows.runs.events',
	'workflows.audit.list',
	'workflows.audit.verify',
] as const;
