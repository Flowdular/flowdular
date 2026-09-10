import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import type { EndpointExecutionContext } from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import type { AgentExecutionEvent } from '@flowdular/harness';
import { userActor } from '@flowdular/kernel';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import type {
	AgentDefinition,
	AgentProcedure,
	AgentProcedureSnapshot,
	AgentProviderKind,
	AgentProviderModelConfiguration,
	AgentRunDetail,
	AgentProcedureStatus,
	AgentStatus,
	CreateAgentInput,
	CreateAgentProviderInput,
	CreateAgentProcedureInput,
	UpdateAgentInput,
	UpdateAgentProviderInput,
	UpdateAgentProcedureInput,
	UpdateModuleAgentBindingInput,
	TenantAgentView,
} from '../domain/types.ts';
import { AgentServiceError } from '../services/agent-service.ts';
import { AgentProviderServiceError } from '../services/provider-service.ts';
import type { AgentRuntime } from '../server/runtime.ts';

function failure(error: unknown): Response {
	if (
		error instanceof AgentServiceError ||
		error instanceof AgentProviderServiceError
	) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The agent operation failed.');
}

function optionalString(
	value: Record<string, unknown>,
	key: string,
	maximum: number,
): string | undefined {
	const result = value[key];
	if (result === undefined || result === null || result === '')
		return undefined;
	if (typeof result !== 'string' || result.length > maximum) {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a string.`, 400);
	}
	return result;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
	const result = value[key];
	if (typeof result !== 'boolean') {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a boolean.`, 400);
	}
	return result;
}

function providerModels(
	value: Record<string, unknown>,
): readonly AgentProviderModelConfiguration[] {
	const result = value.models;
	if (!Array.isArray(result) || result.length > 50) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'models must be an array with at most 50 entries.',
			400,
		);
	}
	return result.map((item, index) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new HttpProblem(
				'INVALID_INPUT',
				`models[${index}] must be an object.`,
				400,
			);
		}
		const model = item as Record<string, unknown>;
		return {
			id: requiredString(model, 'id', { max: 160 }),
			label: requiredString(model, 'label', { max: 120 }),
			enabled: requiredBoolean(model, 'enabled'),
			supportsTools: requiredBoolean(model, 'supportsTools'),
			supportsStreaming: requiredBoolean(model, 'supportsStreaming'),
			supportsWebSearch: requiredBoolean(model, 'supportsWebSearch'),
			/* Absent lets the server apply the catalog rule for the model. */
			...(model.supportsTemperature === undefined
				? {}
				: {
						supportsTemperature: requiredBoolean(model, 'supportsTemperature'),
					}),
		};
	});
}

function createProviderInput(
	value: Record<string, unknown>,
): CreateAgentProviderInput {
	const resourceName = optionalString(value, 'resourceName', 120);
	const baseURL = optionalString(value, 'baseURL', 2_048);
	return {
		key: requiredString(value, 'key', { min: 3, max: 64 }),
		name: requiredString(value, 'name', { min: 2, max: 120 }),
		kind: requiredString(value, 'kind', {
			max: 32,
		}) as Exclude<AgentProviderKind, 'local-simulation'>,
		credential: requiredString(value, 'credential', { min: 8, max: 16_384 }),
		models: providerModels(value),
		...(resourceName ? { resourceName } : {}),
		...(baseURL ? { baseURL } : {}),
	};
}

function stringArray(
	value: Record<string, unknown>,
	key: string,
): readonly string[] {
	const result = value[key];
	if (
		!Array.isArray(result) ||
		result.some((item) => typeof item !== 'string')
	) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be an array of strings.`,
			400,
		);
	}
	return result as string[];
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
	const result = value[key];
	if (typeof result !== 'number' || !Number.isFinite(result)) {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a number.`, 400);
	}
	return result;
}

/* Canonical first, then the deprecated spelling, so a client that still sends
   skillIds keeps working without creating a second field on the agent. */
function procedureIdsInput(value: Record<string, unknown>): readonly string[] {
	if (value.procedureIds === undefined && value.skillIds !== undefined) {
		return stringArray(value, 'skillIds');
	}
	return stringArray(value, 'procedureIds');
}

function agentInput(value: Record<string, unknown>): CreateAgentInput {
	return {
		key: requiredString(value, 'key', { min: 3, max: 64 }),
		name: requiredString(value, 'name', { min: 2, max: 120 }),
		description: requiredString(value, 'description', { min: 2, max: 500 }),
		instructions: requiredString(value, 'instructions', {
			min: 8,
			max: 40_000,
		}),
		/* Empty provider and model fall back to the tenant defaults. */
		provider: optionalString(value, 'provider', 120) ?? '',
		model: optionalString(value, 'model', 160) ?? '',
		allowedTools: stringArray(value, 'allowedTools'),
		procedureIds: procedureIdsInput(value),
		maxSteps: requiredInteger(value, 'maxSteps', { min: 1, max: 32 }),
		timeoutMs: requiredInteger(value, 'timeoutMs', {
			min: 250,
			max: 86_400_000,
		}),
		temperature: requiredNumber(value, 'temperature'),
		...(value.maxOutputTokens === undefined || value.maxOutputTokens === null
			? {}
			: {
					maxOutputTokens: requiredInteger(value, 'maxOutputTokens', {
						min: 256,
						max: 65_536,
					}),
				}),
		status: requiredString(value, 'status') as AgentStatus,
	};
}

/* A tenant agent and a run carry the deprecated projection beside the canonical
   field, so a client on either contract reads the same configuration and the
   same retained evidence. */
function withDeprecatedProcedureFields<
	T extends { readonly procedureIds: readonly string[] },
>(agent: T) {
	return { ...agent, skillIds: agent.procedureIds };
}

function withDeprecatedRunFields<
	T extends { readonly procedureSnapshots: readonly AgentProcedureSnapshot[] },
>(run: T) {
	return { ...run, skillSnapshots: run.procedureSnapshots };
}

/* Both spellings project the same records. A reader on either contract sees one
   resource, never two, because the deprecated field is the canonical value. */
function procedureCollection(procedures: readonly AgentProcedure[]) {
	return { procedures, skills: procedures };
}

function procedureEnvelope(procedure: AgentProcedure) {
	return { procedure, skill: procedure };
}

function procedureInput(
	value: Record<string, unknown>,
): CreateAgentProcedureInput {
	return {
		key: requiredString(value, 'key', { min: 3, max: 64 }),
		name: requiredString(value, 'name', { min: 2, max: 120 }),
		description: requiredString(value, 'description', { min: 2, max: 500 }),
		instructions: requiredString(value, 'instructions', {
			min: 8,
			max: 8_000,
		}),
		requiredTools: stringArray(value, 'requiredTools'),
		status: requiredString(value, 'status') as AgentProcedureStatus,
	};
}

async function runEventStream(
	runtime: AgentRuntime,
	tenantId: string,
	runId: string,
	after: number,
	request: Request,
): Promise<Response> {
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let sequence = Math.max(0, Math.trunc(after));
	let previousStatus = '';
	/* Each message carries only the events after the last acknowledged
	   sequence; the browser resumes from `Last-Event-ID` after a recycle. */
	const message = (
		run: AgentRunDetail,
		events: readonly AgentExecutionEvent[],
	) => {
		const { events: _all, ...summary } = run;
		return `id: ${sequence}\ndata: ${JSON.stringify({
			run: withDeprecatedRunFields(summary),
			events,
		})}\n\n`;
	};
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const close = () => {
				if (closed) return;
				closed = true;
				if (timer !== undefined) clearTimeout(timer);
				try {
					controller.close();
				} catch {
					// The observer disconnected. The durable run remains unaffected.
				}
			};
			request.signal.addEventListener('abort', close, { once: true });
			controller.enqueue(encoder.encode('retry: 1000\n\n'));
			const expiresAt = Date.now() + 30_000;
			const pump = async () => {
				if (closed || request.signal.aborted) return close();
				try {
					const run = await (await runtime.service()).getRun(tenantId, runId);
					const newEvents = run.events.filter(
						(event) => event.sequence > sequence,
					);
					const statusChanged = run.status !== previousStatus;
					if (newEvents.length > 0 || statusChanged) {
						sequence = Math.max(
							sequence,
							...newEvents.map((event) => event.sequence),
						);
						previousStatus = run.status;
						controller.enqueue(encoder.encode(message(run, newEvents)));
					}
					if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
						return close();
					}
				} catch (error) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								error: {
									code: 'RUN_STREAM_FAILED',
									message:
										error instanceof AgentServiceError
											? error.message
											: 'Run stream failed.',
								},
							})}\n\n`,
						),
					);
					return close();
				}
				if (Date.now() >= expiresAt) return close();
				timer = setTimeout(() => void pump(), 300);
			};
			void pump();
		},
		cancel() {
			closed = true;
			if (timer !== undefined) clearTimeout(timer);
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

export function createAgentRoutes(auth: AuthRuntime, runtime: AgentRuntime) {
	const listAgents = defineEndpoint({
		id: 'agents.definitions.list',
		path: '/api/agents',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.definitionsRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				agents: (
					await (await runtime.service()).listAgents(principal.tenantId)
				).map((agent: AgentDefinition) =>
					withDeprecatedProcedureFields<TenantAgentView>({
						...agent,
						ownership: { kind: 'tenant' },
					}),
				),
				moduleAgents: await (
					await runtime.service()
				).listModuleAgents(principal.tenantId),
				providers: principal.scopes.includes(AGENT_PERMISSIONS.providersRead)
					? await (await runtime.service()).providers(principal.tenantId)
					: [],
				tools: (await runtime.service()).tools(),
				...procedureCollection(
					principal.scopes.includes(AGENT_PERMISSIONS.proceduresRead)
						? await (await runtime.service()).listProcedures(principal.tenantId)
						: [],
				),
			});
		},
	});
	const updateModuleAgentBinding = defineEndpoint({
		id: 'agents.module-bindings.update',
		path: '/api/agents/module-bindings/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.definitionsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 16 * 1_024);
				const principal = principalFromContext(octane)!;
				const input: UpdateModuleAgentBindingInput = {
					agentId: requiredString(value, 'agentId', { max: 128 }),
					provider: requiredString(value, 'provider', { max: 120 }),
					model: requiredString(value, 'model', { max: 160 }),
					enabledTools: stringArray(value, 'enabledTools'),
					status: requiredString(value, 'status', {
						max: 16,
					}) as UpdateModuleAgentBindingInput['status'],
					expectedRevision: requiredInteger(value, 'expectedRevision', {
						min: 0,
					}),
				};
				return jsonResponse({
					agent: await (
						await runtime.service()
					).configureModuleAgent(
						principal.tenantId,
						principal.accountId,
						input,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const createAgent = defineEndpoint({
		id: 'agents.definitions.create',
		path: '/api/agents',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.definitionsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 64 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					{
						agent: withDeprecatedProcedureFields(
							await (
								await runtime.service()
							).createAgent(
								principal.tenantId,
								principal.accountId,
								agentInput(value),
							),
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const updateAgent = defineEndpoint({
		id: 'agents.definitions.update',
		path: '/api/agents/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.definitionsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 64 * 1_024);
				const principal = principalFromContext(octane)!;
				const input: UpdateAgentInput = {
					...agentInput(value),
					expectedRevision: requiredInteger(value, 'expectedRevision', {
						min: 1,
					}),
				};
				return jsonResponse({
					agent: withDeprecatedProcedureFields(
						await (
							await runtime.service()
						).updateAgent(
							principal.tenantId,
							requiredString(value, 'id', { max: 128 }),
							principal.accountId,
							input,
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const archiveAgent = defineEndpoint({
		id: 'agents.definitions.archive',
		path: '/api/agents/archive',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.definitionsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					agent: withDeprecatedProcedureFields(
						await (
							await runtime.service()
						).archiveAgent(
							principal.tenantId,
							requiredString(value, 'id', { max: 128 }),
							principal.accountId,
							requiredInteger(value, 'expectedRevision', { min: 1 }),
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const deleteAgent = defineEndpoint({
		id: 'agents.definitions.delete',
		path: '/api/agents/delete',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.definitionsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				await (
					await runtime.service()
				).deleteAgent(
					principal.tenantId,
					requiredString(value, 'id', { max: 128 }),
					principal.accountId,
					requiredInteger(value, 'expectedRevision', { min: 1 }),
				);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	/* One handler per operation, published under the canonical procedure path and
	   the deprecated skill path. Both reach the same records, so calling either
	   surface with the same id can never create a second resource. */
	const createProcedureHandler = async ({
		octane,
	}: EndpointExecutionContext) => {
		const denial = sessionMutationDenial(octane, auth);
		if (denial) return denial;
		try {
			const value = await readJsonObject(octane.request, 32 * 1_024);
			const principal = principalFromContext(octane)!;
			return jsonResponse(
				procedureEnvelope(
					await (
						await runtime.service()
					).createProcedure(
						principal.tenantId,
						principal.accountId,
						procedureInput(value),
					),
				),
				201,
			);
		} catch (error) {
			return failure(error);
		}
	};
	const updateProcedureHandler = async ({
		octane,
	}: EndpointExecutionContext) => {
		const denial = sessionMutationDenial(octane, auth);
		if (denial) return denial;
		try {
			const value = await readJsonObject(octane.request, 32 * 1_024);
			const principal = principalFromContext(octane)!;
			const input: UpdateAgentProcedureInput = {
				...procedureInput(value),
				expectedRevision: requiredInteger(value, 'expectedRevision', {
					min: 1,
				}),
			};
			return jsonResponse(
				procedureEnvelope(
					await (
						await runtime.service()
					).updateProcedure(
						principal.tenantId,
						requiredString(value, 'id', { max: 128 }),
						principal.accountId,
						input,
					),
				),
			);
		} catch (error) {
			return failure(error);
		}
	};
	const archiveProcedureHandler = async ({
		octane,
	}: EndpointExecutionContext) => {
		const denial = sessionMutationDenial(octane, auth);
		if (denial) return denial;
		try {
			const value = await readJsonObject(octane.request, 8 * 1_024);
			const principal = principalFromContext(octane)!;
			return jsonResponse(
				procedureEnvelope(
					await (
						await runtime.service()
					).archiveProcedure(
						principal.tenantId,
						requiredString(value, 'id', { max: 128 }),
						principal.accountId,
						requiredInteger(value, 'expectedRevision', { min: 1 }),
					),
				),
			);
		} catch (error) {
			return failure(error);
		}
	};
	const deleteProcedureHandler = async ({
		octane,
	}: EndpointExecutionContext) => {
		const denial = sessionMutationDenial(octane, auth);
		if (denial) return denial;
		try {
			const value = await readJsonObject(octane.request, 8 * 1_024);
			const principal = principalFromContext(octane)!;
			await (
				await runtime.service()
			).deleteProcedure(
				principal.tenantId,
				requiredString(value, 'id', { max: 128 }),
				principal.accountId,
				requiredInteger(value, 'expectedRevision', { min: 1 }),
			);
			return jsonResponse({ deleted: true });
		} catch (error) {
			return failure(error);
		}
	};

	const procedureMutation = (
		id: string,
		path: string,
		handler: (arguments_: EndpointExecutionContext) => Promise<Response>,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: {
				kind: 'permission',
				permission: AGENT_PERMISSIONS.proceduresManage,
			},
			resolveIdentity: endpointIdentityFromContext,
			handler,
		});

	const createProcedure = procedureMutation(
		'agents.procedures.create',
		'/api/agent-procedures',
		createProcedureHandler,
	);
	const updateProcedure = procedureMutation(
		'agents.procedures.update',
		'/api/agent-procedures/update',
		updateProcedureHandler,
	);
	const archiveProcedure = procedureMutation(
		'agents.procedures.archive',
		'/api/agent-procedures/archive',
		archiveProcedureHandler,
	);
	const deleteProcedure = procedureMutation(
		'agents.procedures.delete',
		'/api/agent-procedures/delete',
		deleteProcedureHandler,
	);
	const createSkill = procedureMutation(
		'agents.skills.create',
		'/api/agent-skills',
		createProcedureHandler,
	);
	const updateSkill = procedureMutation(
		'agents.skills.update',
		'/api/agent-skills/update',
		updateProcedureHandler,
	);
	const archiveSkill = procedureMutation(
		'agents.skills.archive',
		'/api/agent-skills/archive',
		archiveProcedureHandler,
	);
	const deleteSkill = procedureMutation(
		'agents.skills.delete',
		'/api/agent-skills/delete',
		deleteProcedureHandler,
	);
	const listRuns = defineEndpoint({
		id: 'agents.runs.list',
		path: '/api/agent-runs',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const runId = url.searchParams.get('id');
				return runId
					? jsonResponse({
							run: await (
								await runtime.service()
							).getRunTimeline(principal.tenantId, runId),
						})
					: jsonResponse({
							runs: (
								await (await runtime.service()).listRuns(principal.tenantId)
							).map(withDeprecatedRunFields),
						});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const enqueueRun = defineEndpoint({
		id: 'agents.runs.enqueue',
		path: '/api/agent-runs',
		methods: ['POST'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsExecute },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 128 * 1_024);
				const principal = principalFromContext(octane)!;
				const idempotencyKey = octane.request.headers.get('idempotency-key');
				const tenantName =
					principal.tenants.find(
						(tenant) => tenant.tenantId === principal.tenantId,
					)?.name ?? principal.tenantId;
				/* A browser session can only start playground runs. Workflow,
				   service, and schedule triggers are enqueued in-process by the
				   platform, never by a client-supplied field. */
				const run = await (
					await runtime.service()
				).enqueueRun(
					principal.tenantId,
					userActor(principal),
					principal.scopes,
					{
						agentId: requiredString(value, 'agentId', { max: 128 }),
						trigger: 'playground',
						input: requiredString(value, 'input', { max: 100_000 }),
						toolGrants: stringArray(value, 'toolGrants'),
						...(idempotencyKey ? { idempotencyKey } : {}),
					},
					{
						tenantName,
						userDisplayName: principal.displayName,
						userEmail: principal.email,
					},
				);
				return jsonResponse({ run }, 202);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const cancelRun = defineEndpoint({
		id: 'agents.runs.cancel',
		path: '/api/agent-runs/cancel',
		methods: ['POST'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsExecute },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					run: withDeprecatedRunFields(
						await (
							await runtime.service()
						).cancelRun(
							principal.tenantId,
							userActor(principal),
							principal.scopes,
							requiredString(value, 'id', { max: 128 }),
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const workerStatus = defineEndpoint({
		id: 'agents.runs.worker',
		path: '/api/agent-runs/worker',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async () => jsonResponse({ worker: await runtime.workerStatus() }),
	});
	const streamRun = defineEndpoint({
		id: 'agents.runs.stream',
		path: '/api/agent-runs/stream',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const runId = url.searchParams.get('id');
				if (!runId || runId.length > 128) {
					throw new HttpProblem('INVALID_INPUT', 'id is required.', 400);
				}
				const rawAfter =
					octane.request.headers.get('last-event-id') ??
					url.searchParams.get('after') ??
					'0';
				const after = Number(rawAfter);
				if (!Number.isSafeInteger(after) || after < 0) {
					throw new HttpProblem(
						'INVALID_INPUT',
						'after must be a non-negative integer.',
						400,
					);
				}
				return runEventStream(
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
	const listAudit = defineEndpoint({
		id: 'agents.audit.list',
		path: '/api/agent-audit',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const limit = Number(url.searchParams.get('limit') ?? '50');
				return jsonResponse(
					await (
						await runtime.service()
					).pageAuditEvents(
						principal.tenantId,
						url.searchParams.get('cursor'),
						limit,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const verifyAudit = defineEndpoint({
		id: 'agents.audit.verify',
		path: '/api/agent-audit/verify',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					await (await runtime.service()).verifyAudit(principal.tenantId),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const listProviders = defineEndpoint({
		id: 'agents.providers.list',
		path: '/api/agent-providers',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.providersRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				providers: await (
					await runtime.providerService()
				).list(principal.tenantId),
				readinessTtlMs: (await runtime.providerService()).readinessTtlMs,
			});
		},
	});
	const createProvider = defineEndpoint({
		id: 'agents.providers.create',
		path: '/api/agent-providers',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.providersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 64 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					{
						provider: await (
							await runtime.providerService()
						).create(
							principal.tenantId,
							principal.accountId,
							createProviderInput(value),
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const updateProvider = defineEndpoint({
		id: 'agents.providers.update',
		path: '/api/agent-providers/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.providersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 64 * 1_024);
				const principal = principalFromContext(octane)!;
				const credential = optionalString(value, 'credential', 16_384);
				const resourceName = optionalString(value, 'resourceName', 120);
				const baseURL = optionalString(value, 'baseURL', 2_048);
				const input: UpdateAgentProviderInput = {
					id: requiredString(value, 'id', { max: 128 }),
					expectedRevision: requiredInteger(value, 'expectedRevision', {
						min: 1,
					}),
					name: requiredString(value, 'name', { min: 2, max: 120 }),
					enabled: requiredBoolean(value, 'enabled'),
					models: providerModels(value),
					...(credential ? { credential } : {}),
					...(resourceName ? { resourceName } : {}),
					...(baseURL ? { baseURL } : {}),
				};
				return jsonResponse({
					provider: await (
						await runtime.providerService()
					).update(principal.tenantId, principal.accountId, input),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const testProvider = defineEndpoint({
		id: 'agents.providers.test',
		path: '/api/agent-providers/test',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.providersTest,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					provider: await (
						await runtime.providerService()
					).test(
						principal.tenantId,
						requiredString(value, 'id', { max: 128 }),
						requiredString(value, 'model', { max: 160 }),
						principal.accountId,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const deleteProvider = defineEndpoint({
		id: 'agents.providers.delete',
		path: '/api/agent-providers/delete',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.providersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				await (
					await runtime.providerService()
				).delete(
					principal.tenantId,
					principal.accountId,
					requiredString(value, 'id', { max: 128 }),
					requiredInteger(value, 'expectedRevision', { min: 1 }),
				);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const readUsage = defineEndpoint({
		id: 'agents.usage.read',
		path: '/api/agent-usage',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				return jsonResponse(
					await (
						await runtime.usageService()
					).summary(principal.tenantId, Number(url.searchParams.get('days'))),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [
		listAgents.serverRoute,
		updateModuleAgentBinding.serverRoute,
		createAgent.serverRoute,
		updateAgent.serverRoute,
		archiveAgent.serverRoute,
		deleteAgent.serverRoute,
		createProcedure.serverRoute,
		updateProcedure.serverRoute,
		archiveProcedure.serverRoute,
		deleteProcedure.serverRoute,
		createSkill.serverRoute,
		updateSkill.serverRoute,
		archiveSkill.serverRoute,
		deleteSkill.serverRoute,
		listRuns.serverRoute,
		enqueueRun.serverRoute,
		cancelRun.serverRoute,
		workerStatus.serverRoute,
		streamRun.serverRoute,
		listAudit.serverRoute,
		verifyAudit.serverRoute,
		listProviders.serverRoute,
		createProvider.serverRoute,
		updateProvider.serverRoute,
		testProvider.serverRoute,
		deleteProvider.serverRoute,
		readUsage.serverRoute,
	] as const;
}

export const endpoints = [
	'agents.definitions.list',
	'agents.module-bindings.update',
	'agents.definitions.create',
	'agents.definitions.update',
	'agents.definitions.archive',
	'agents.definitions.delete',
	'agents.procedures.create',
	'agents.procedures.update',
	'agents.procedures.archive',
	'agents.procedures.delete',
	'agents.skills.create',
	'agents.skills.update',
	'agents.skills.archive',
	'agents.skills.delete',
	'agents.runs.list',
	'agents.runs.enqueue',
	'agents.runs.cancel',
	'agents.runs.worker',
	'agents.runs.stream',
	'agents.audit.list',
	'agents.audit.verify',
	'agents.providers.list',
	'agents.providers.create',
	'agents.providers.update',
	'agents.providers.test',
	'agents.providers.delete',
	'agents.usage.read',
] as const;
