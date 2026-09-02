import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredInteger,
	requiredString,
} from '@coreloom/server';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@coreloom/module-auth/server';
import type { AgentExecutionEvent } from '@coreloom/harness';
import { userActor } from '@coreloom/kernel';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import type {
	AgentProviderKind,
	AgentProviderModelConfiguration,
	AgentRunDetail,
	AgentSkillStatus,
	AgentStatus,
	CreateAgentInput,
	CreateAgentProviderInput,
	CreateAgentSkillInput,
	UpdateAgentInput,
	UpdateAgentProviderInput,
	UpdateAgentSkillInput,
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
		skillIds: stringArray(value, 'skillIds'),
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

function skillInput(value: Record<string, unknown>): CreateAgentSkillInput {
	return {
		key: requiredString(value, 'key', { min: 3, max: 64 }),
		name: requiredString(value, 'name', { min: 2, max: 120 }),
		description: requiredString(value, 'description', { min: 2, max: 500 }),
		instructions: requiredString(value, 'instructions', {
			min: 8,
			max: 8_000,
		}),
		requiredTools: stringArray(value, 'requiredTools'),
		status: requiredString(value, 'status') as AgentSkillStatus,
	};
}

function runEventStream(
	runtime: AgentRuntime,
	tenantId: string,
	runId: string,
	after: number,
	request: Request,
): Response {
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
		return `id: ${sequence}\ndata: ${JSON.stringify({ run: summary, events })}\n\n`;
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
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
			const pump = () => {
				if (closed || request.signal.aborted) return close();
				try {
					const run = runtime.service().getRun(tenantId, runId);
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
				timer = setTimeout(pump, 300);
			};
			pump();
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
		handler: ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				agents: runtime
					.service()
					.listAgents(principal.tenantId)
					.map(
						(agent): TenantAgentView => ({
							...agent,
							ownership: { kind: 'tenant' },
						}),
					),
				moduleAgents: runtime.service().listModuleAgents(principal.tenantId),
				providers: principal.scopes.includes(AGENT_PERMISSIONS.providersRead)
					? runtime.service().providers(principal.tenantId)
					: [],
				tools: runtime.service().tools(),
				skills: principal.scopes.includes(AGENT_PERMISSIONS.skillsRead)
					? runtime.service().listSkills(principal.tenantId)
					: [],
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
					agent: runtime
						.service()
						.configureModuleAgent(
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
						agent: runtime
							.service()
							.createAgent(
								principal.tenantId,
								principal.accountId,
								agentInput(value),
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
					agent: runtime
						.service()
						.updateAgent(
							principal.tenantId,
							requiredString(value, 'id', { max: 128 }),
							principal.accountId,
							input,
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
					agent: runtime
						.service()
						.archiveAgent(
							principal.tenantId,
							requiredString(value, 'id', { max: 128 }),
							principal.accountId,
							requiredInteger(value, 'expectedRevision', { min: 1 }),
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
				runtime
					.service()
					.deleteAgent(
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
	const createSkill = defineEndpoint({
		id: 'agents.skills.create',
		path: '/api/agent-skills',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.skillsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 32 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					{
						skill: runtime
							.service()
							.createSkill(
								principal.tenantId,
								principal.accountId,
								skillInput(value),
							),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const updateSkill = defineEndpoint({
		id: 'agents.skills.update',
		path: '/api/agent-skills/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.skillsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 32 * 1_024);
				const principal = principalFromContext(octane)!;
				const input: UpdateAgentSkillInput = {
					...skillInput(value),
					expectedRevision: requiredInteger(value, 'expectedRevision', {
						min: 1,
					}),
				};
				return jsonResponse({
					skill: runtime
						.service()
						.updateSkill(
							principal.tenantId,
							requiredString(value, 'id', { max: 128 }),
							principal.accountId,
							input,
						),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const archiveSkill = defineEndpoint({
		id: 'agents.skills.archive',
		path: '/api/agent-skills/archive',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.skillsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					skill: runtime
						.service()
						.archiveSkill(
							principal.tenantId,
							requiredString(value, 'id', { max: 128 }),
							principal.accountId,
							requiredInteger(value, 'expectedRevision', { min: 1 }),
						),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const deleteSkill = defineEndpoint({
		id: 'agents.skills.delete',
		path: '/api/agent-skills/delete',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AGENT_PERMISSIONS.skillsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				runtime
					.service()
					.deleteSkill(
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
	const listRuns = defineEndpoint({
		id: 'agents.runs.list',
		path: '/api/agent-runs',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const runId = url.searchParams.get('id');
				return runId
					? jsonResponse({
							run: runtime.service().getRunTimeline(principal.tenantId, runId),
						})
					: jsonResponse({
							runs: runtime.service().listRuns(principal.tenantId),
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
				const run = await runtime.service().enqueueRun(
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
					run: runtime
						.service()
						.cancelRun(
							principal.tenantId,
							userActor(principal),
							principal.scopes,
							requiredString(value, 'id', { max: 128 }),
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
		handler: () => jsonResponse({ worker: runtime.workerStatus() }),
	});
	const streamRun = defineEndpoint({
		id: 'agents.runs.stream',
		path: '/api/agent-runs/stream',
		methods: ['GET'],
		access: { kind: 'permission', permission: AGENT_PERMISSIONS.runsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
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
		handler: ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const limit = Number(url.searchParams.get('limit') ?? '50');
				return jsonResponse(
					runtime
						.service()
						.pageAuditEvents(
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
		handler: ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse(runtime.service().verifyAudit(principal.tenantId));
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
		handler: ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				providers: runtime.providerService().list(principal.tenantId),
				readinessTtlMs: runtime.providerService().readinessTtlMs,
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
						provider: runtime
							.providerService()
							.create(
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
					provider: runtime
						.providerService()
						.update(principal.tenantId, principal.accountId, input),
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
					provider: await runtime
						.providerService()
						.test(
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
				runtime
					.providerService()
					.delete(
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
		handler: ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				return jsonResponse(
					runtime
						.usageService()
						.summary(principal.tenantId, Number(url.searchParams.get('days'))),
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
