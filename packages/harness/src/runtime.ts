import { createHash } from 'node:crypto';
import { AgentHarnessError } from './errors.ts';
import { normalizeActor, type Actor, type UserActor } from '@flowdular/kernel';
import {
	boundToolOutput,
	toolTimeoutMs,
	validateJsonValue,
	validateToolInput,
	validateToolOutput,
	validateStructuredOutput,
} from './tool-contract.ts';

export { AgentHarnessError } from './errors.ts';

export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const MIN_MAX_OUTPUT_TOKENS = 256;
export const MAX_MAX_OUTPUT_TOKENS = 65_536;

export type AgentRunTrigger =
	| 'playground'
	| 'workflow'
	| 'service'
	| 'schedule';

export interface AgentExecutionDefinition {
	readonly id: string;
	readonly name: string;
	readonly revision: number;
	readonly instructions: string;
	readonly provider: string;
	readonly model: string;
	readonly allowedTools: readonly string[];
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly temperature: number;
	/* Absent means the provider default of 4096 tokens. */
	readonly maxOutputTokens?: number;
}

export interface AgentExecutionRequest {
	readonly runId: string;
	readonly tenantId: string;
	readonly requestedBy: string;
	readonly requestedActor: Actor;
	/* Audit provenance remains requestedActor. Live authorization uses this user. */
	readonly authorizationSubject?: UserActor | null;
	readonly trigger: AgentRunTrigger;
	readonly input: string;
	readonly definition: AgentExecutionDefinition;
	readonly permissionSnapshot: readonly string[];
	readonly toolGrants: readonly string[];
	/* Absent keeps the v1 text behavior. */
	readonly outputContract?: AgentOutputContract;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type AgentOutputContract =
	| { readonly kind: 'text' }
	| {
			readonly kind: 'json-schema';
			readonly name: string;
			readonly schema: Readonly<Record<string, unknown>>;
	  };

export interface AgentExecutionEvent {
	readonly sequence: number;
	readonly type:
		| 'run.started'
		| 'provider.started'
		| 'provider.output.delta'
		| 'tool.started'
		| 'tool.completed'
		| 'tool.failed'
		| 'tool.denied'
		| 'provider.completed'
		| 'run.completed';
	readonly timestamp: number;
	readonly message: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AgentUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

export interface AgentProviderResult {
	readonly output: string;
	readonly structuredOutput?: JsonValue;
	readonly usage: AgentUsage;
	readonly finishReason: 'stop' | 'length' | 'tool-limit';
}

export interface AgentToolContext {
	readonly runId: string;
	readonly tenantId: string;
	readonly requestedBy: string;
	/* Present for real agent runs. Optional keeps direct module tests and action
	   execution source-compatible while callers that need an agent actor can
	   refuse when the trusted identity is absent. */
	readonly agentId?: string;
	readonly agentName?: string;
	/* How the tool was reached: a model turn inside an agent run, or a workflow
	   node running it as a published action. A tool whose admission differs per
	   caller kind reads this instead of assuming one. Optional keeps v1 callers
	   and direct module tests source-compatible; absent means an agent run,
	   because the workflow action runtime always states it. */
	readonly invocation?: 'agent-run' | 'workflow-action';
	readonly idempotencyKey?: string;
	/* Trusted provenance for record history. Optional preserves v1 direct tool
	   callers; harness and workflow executions always provide it. */
	readonly actor?: Actor;
	readonly authorizationSubject?: UserActor;
	readonly permissions: ReadonlySet<string>;
	readonly signal: AbortSignal;
}

export interface AgentToolConsentDecision {
	readonly granted: boolean;
	/** Stable code recorded on the denial event when the gate refuses. */
	readonly reason?: string;
}

/**
 * A module-owned gate asked before every call of a tool that declares one, so
 * a workspace can admit a tool per record (a connector instance an owner
 * consented to) without the tool declaring a risk the harness refuses outright.
 * The answer is computed per call from the already validated input and is never
 * cached; a gate that throws denies.
 */
export interface AgentToolConsent {
	/** Stable id of the gate, recorded on the denial event. */
	readonly id: string;
	check(
		input: unknown,
		context: AgentToolContext,
	): Promise<AgentToolConsentDecision> | AgentToolConsentDecision;
}

export interface AgentTool {
	readonly id: string;
	readonly transport: 'api' | 'cli';
	readonly target: string;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema?: Readonly<Record<string, unknown>>;
	readonly contractVersion?: number;
	readonly outputSchema?: Readonly<Record<string, unknown>>;
	readonly risk?: 'read' | 'workspace-write' | 'external' | 'destructive';
	/* Run-time admission on top of the permission snapshot. A tool declaring one
	   is offered to the model as usual and refused per call when the gate says so. */
	readonly consent?: AgentToolConsent;
	readonly idempotency?: 'required';
	/* A mutating tool is executable only when its target persists the key and
	   returns the first result on retry. Declaring `required` alone is not that
	   guarantee. */
	readonly idempotencyProtection?: 'target-ledger';
	readonly cancellation?: 'cooperative' | 'not-supported';
	/* Per call. Defaults to 30 s; the run's own timeout still applies. */
	readonly timeoutMs?: number;
	execute(input: unknown, context: AgentToolContext): Promise<unknown>;
}

export interface AgentProviderContext {
	readonly request: AgentExecutionRequest;
	readonly signal: AbortSignal;
	readonly availableTools: readonly {
		readonly id: string;
		readonly transport: 'api' | 'cli';
		readonly target: string;
		readonly description: string;
		readonly inputSchema: Readonly<Record<string, unknown>>;
	}[];
	invokeTool(
		id: string,
		input: unknown,
		invocation?: { readonly providerCallId?: string },
	): Promise<unknown>;
	emit(
		type: AgentExecutionEvent['type'],
		message: string,
		metadata?: Readonly<Record<string, string | number | boolean>>,
	): void;
}

export interface AgentProvider {
	readonly id: string;
	readonly capabilities?: {
		readonly structuredOutput: boolean;
	};
	execute(context: AgentProviderContext): Promise<AgentProviderResult>;
}

export interface AgentExecutionResult extends AgentProviderResult {
	readonly events: readonly AgentExecutionEvent[];
	readonly startedAt: number;
	readonly completedAt: number;
}

export interface AgentToolAuthorizationRequest {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly signal: AbortSignal;
}

export type AgentToolAccessAuthorizer = (
	request: AgentToolAuthorizationRequest,
) => readonly string[] | Promise<readonly string[]>;

function identifier(value: string, field: string): string {
	const normalized = value.trim();
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(normalized)) {
		throw new AgentHarnessError(
			'INVALID_IDENTIFIER',
			`${field} must be a lowercase dot-separated identifier.`,
		);
	}
	return normalized;
}

function boundedText(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AgentHarnessError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	return normalized;
}

/** Opaque connection IDs may contain generated numeric segments. Authority
 * comes from provider resolution and the exact snapshot match, not this syntax. */
function providerReference(value: string): string {
	const normalized = boundedText(value, 'provider', 1, 128);
	if (/[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new AgentHarnessError(
			'INVALID_INPUT',
			'provider contains an unsupported character.',
		);
	}
	return normalized;
}

function assertExecutionRequest(request: AgentExecutionRequest): void {
	boundedText(request.runId, 'runId', 1, 128);
	boundedText(request.tenantId, 'tenantId', 1, 128);
	const requestedBy = boundedText(request.requestedBy, 'requestedBy', 1, 128);
	const requestedActor = normalizeActor(request.requestedActor);
	if (!requestedActor || requestedActor.id !== requestedBy) {
		throw new AgentHarnessError(
			'INVALID_ACTOR',
			'requestedActor must be valid and match requestedBy.',
		);
	}
	const suppliedSubject = request.authorizationSubject
		? normalizeActor(request.authorizationSubject)
		: undefined;
	const derivedSubject =
		requestedActor.kind === 'user'
			? requestedActor
			: requestedActor.kind === 'service'
				? requestedActor.configuredBy
				: undefined;
	if (
		(suppliedSubject != null && suppliedSubject.kind !== 'user') ||
		(derivedSubject !== undefined &&
			suppliedSubject != null &&
			derivedSubject.id !== suppliedSubject.id)
	) {
		throw new AgentHarnessError(
			'INVALID_AUTHORIZATION_SUBJECT',
			'authorizationSubject must be the trusted delegated user.',
		);
	}
	boundedText(request.input, 'input', 1, 100_000);
	boundedText(request.definition.name, 'definition.name', 2, 120);
	boundedText(request.definition.instructions, 'instructions', 8, 40_000);
	providerReference(request.definition.provider);
	boundedText(request.definition.model, 'model', 1, 160);
	if (
		!Number.isSafeInteger(request.definition.revision) ||
		request.definition.revision < 1
	) {
		throw new AgentHarnessError(
			'INVALID_REVISION',
			'definition.revision must be a positive integer.',
		);
	}
	if (
		!Number.isSafeInteger(request.definition.maxSteps) ||
		request.definition.maxSteps < 1 ||
		request.definition.maxSteps > 32
	) {
		throw new AgentHarnessError(
			'INVALID_MAX_STEPS',
			'definition.maxSteps must be between 1 and 32.',
		);
	}
	if (
		!Number.isSafeInteger(request.definition.timeoutMs) ||
		request.definition.timeoutMs < 250 ||
		request.definition.timeoutMs > 86_400_000
	) {
		throw new AgentHarnessError(
			'INVALID_TIMEOUT',
			'definition.timeoutMs must be between 250 and 86400000.',
		);
	}
	if (
		!Number.isFinite(request.definition.temperature) ||
		request.definition.temperature < 0 ||
		request.definition.temperature > 2
	) {
		throw new AgentHarnessError(
			'INVALID_TEMPERATURE',
			'definition.temperature must be between 0 and 2.',
		);
	}
	const maxOutputTokens = request.definition.maxOutputTokens;
	if (
		maxOutputTokens !== undefined &&
		(!Number.isSafeInteger(maxOutputTokens) ||
			maxOutputTokens < MIN_MAX_OUTPUT_TOKENS ||
			maxOutputTokens > MAX_MAX_OUTPUT_TOKENS)
	) {
		throw new AgentHarnessError(
			'INVALID_MAX_OUTPUT_TOKENS',
			`definition.maxOutputTokens must be between ${MIN_MAX_OUTPUT_TOKENS} and ${MAX_MAX_OUTPUT_TOKENS}.`,
		);
	}
	if (request.outputContract?.kind === 'json-schema') {
		boundedText(request.outputContract.name, 'outputContract.name', 1, 64);
		if (
			!request.outputContract.schema ||
			Array.isArray(request.outputContract.schema) ||
			typeof request.outputContract.schema !== 'object'
		) {
			throw new AgentHarnessError(
				'INVALID_OUTPUT_CONTRACT',
				'outputContract.schema must be a JSON object.',
			);
		}
		validateJsonValue(
			request.outputContract.schema,
			'INVALID_OUTPUT_CONTRACT',
			'outputContract.schema',
		);
		let serialized: string;
		try {
			serialized = JSON.stringify(request.outputContract.schema);
		} catch {
			throw new AgentHarnessError(
				'INVALID_OUTPUT_CONTRACT',
				'outputContract.schema must be JSON serializable.',
			);
		}
		if (serialized.length > 32_768) {
			throw new AgentHarnessError(
				'INVALID_OUTPUT_CONTRACT',
				'outputContract.schema exceeds 32768 characters.',
			);
		}
	}
}

function toolFailure(error: unknown): { code: string; message: string } {
	if (error instanceof AgentHarnessError) {
		return { code: error.code, message: error.message };
	}
	const message =
		error instanceof Error && error.message
			? error.message.slice(0, 300)
			: 'The tool failed.';
	return { code: 'TOOL_EXECUTION_FAILED', message };
}

/**
 * `external` is the ceiling no unattended caller crosses: the CLI runner
 * refuses it, `defineCliAgentTool` and `defineApiAgentTool` refuse to build it,
 * and a hand-built tool object is refused here as well, before the model is
 * ever told the tool exists.
 */
function admissibleRisk(tool: AgentTool): boolean {
	return tool.risk !== 'external';
}

/* A refusal code comes from module code, so it is bounded to the shape an
   event metadata field may carry before it is recorded. */
function consentReason(reason: string | undefined): string {
	return reason !== undefined && /^[A-Z][A-Z0-9_]{2,63}$/.test(reason)
		? reason
		: 'TOOL_CONSENT_REFUSED';
}

export class AgentHarness {
	readonly #providers: ReadonlyMap<string, AgentProvider>;
	readonly #tools: ReadonlyMap<string, AgentTool>;
	readonly #authorizeToolAccess: AgentToolAccessAuthorizer;

	constructor(options: {
		readonly providers: readonly AgentProvider[];
		readonly tools?: readonly AgentTool[];
		readonly authorizeToolAccess?: AgentToolAccessAuthorizer;
	}) {
		const providers = new Map<string, AgentProvider>();
		for (const provider of options.providers) {
			const id = providerReference(provider.id);
			if (providers.has(id)) {
				throw new AgentHarnessError(
					'DUPLICATE_PROVIDER',
					`Provider ${id} is already registered.`,
				);
			}
			providers.set(id, provider);
		}
		const tools = new Map<string, AgentTool>();
		for (const tool of options.tools ?? []) {
			const id = identifier(tool.id, 'tool.id');
			if (tools.has(id)) {
				throw new AgentHarnessError(
					'DUPLICATE_TOOL',
					`Tool ${id} is already registered.`,
				);
			}
			/* The gate id reaches the denial event, so it is held to the same
			   shape as the tool id rather than checked only where it is emitted. */
			if (tool.consent) identifier(tool.consent.id, 'tool.consent.id');
			toolTimeoutMs(tool.timeoutMs);
			tools.set(id, tool);
		}
		this.#providers = providers;
		this.#tools = tools;
		/* No callback means no live authority. This keeps standalone runtimes and
		   service actors fail-closed instead of treating a stored snapshot as a
		   permanent credential. */
		this.#authorizeToolAccess = options.authorizeToolAccess ?? (() => []);
	}

	providers(): readonly string[] {
		return [...this.#providers.keys()].sort();
	}

	providerSupportsStructuredOutput(id: string): boolean {
		return this.#providers.get(id)?.capabilities?.structuredOutput === true;
	}

	tools(): readonly string[] {
		return [...this.#tools.keys()].sort();
	}

	/* This is the single access calculation used both when a durable run is
	   created and when it is executed. A tool must be present in the code
	   registry, allowed by the agent, explicitly requested for the run, and
	   covered by the trusted permission snapshot. */
	effectiveToolGrants(
		allowedTools: readonly string[],
		requestedToolGrants: readonly string[],
		permissionSnapshot: readonly string[],
	): readonly string[] {
		const allowed = new Set(allowedTools);
		const requested = new Set(requestedToolGrants);
		const permissions = new Set(permissionSnapshot);
		return [...this.#tools.values()]
			.filter((tool) => allowed.has(tool.id) && requested.has(tool.id))
			.filter((tool) =>
				tool.requiredPermissions.every((permission) =>
					permissions.has(permission),
				),
			)
			.map((tool) => tool.id)
			.sort();
	}

	async execute(
		request: AgentExecutionRequest,
		options: {
			readonly onEvent?: (event: AgentExecutionEvent) => void;
			readonly provider?: AgentProvider;
			readonly signal?: AbortSignal;
		} = {},
	): Promise<AgentExecutionResult> {
		assertExecutionRequest(request);
		const auditActor = normalizeActor(request.requestedActor)!;
		const authorizationSubject = request.authorizationSubject
			? normalizeActor(request.authorizationSubject)
			: auditActor.kind === 'user'
				? auditActor
				: auditActor.kind === 'service'
					? auditActor.configuredBy
					: null;
		const provider =
			options.provider ?? this.#providers.get(request.definition.provider);
		if (!provider) {
			throw new AgentHarnessError(
				'PROVIDER_NOT_AVAILABLE',
				`Provider ${request.definition.provider} is not registered.`,
			);
		}
		if (provider.id !== request.definition.provider) {
			throw new AgentHarnessError(
				'PROVIDER_MISMATCH',
				'The resolved provider does not match the run snapshot.',
			);
		}
		const outputContract = request.outputContract ?? { kind: 'text' as const };
		if (
			outputContract.kind === 'json-schema' &&
			provider.capabilities?.structuredOutput !== true
		) {
			throw new AgentHarnessError(
				'STRUCTURED_OUTPUT_UNSUPPORTED',
				`Provider ${provider.id} cannot guarantee structured output for this run.`,
			);
		}
		const snapshotGrants = new Set(
			this.effectiveToolGrants(
				request.definition.allowedTools,
				request.toolGrants,
				request.permissionSnapshot,
			),
		);
		const controller = new AbortController();
		const abortFromCaller = () =>
			controller.abort(options.signal?.reason ?? 'aborted');
		if (options.signal?.aborted) abortFromCaller();
		else
			options.signal?.addEventListener('abort', abortFromCaller, {
				once: true,
			});
		const livePermissions = async (): Promise<Set<string>> => {
			if (!authorizationSubject || authorizationSubject.kind !== 'user') {
				return new Set();
			}
			let authorized: readonly string[];
			try {
				authorized = await this.#authorizeToolAccess({
					tenantId: request.tenantId,
					actor: authorizationSubject,
					signal: controller.signal,
				});
			} catch {
				throw new AgentHarnessError(
					'TOOL_AUTHORIZATION_FAILED',
					'Live tool authorization is unavailable.',
				);
			}
			const currentlyHeld = new Set(authorized);
			return new Set(
				request.permissionSnapshot.filter((permission) =>
					currentlyHeld.has(permission),
				),
			);
		};
		const initialPermissions = await livePermissions();
		const availableTools = [...this.#tools.values()]
			.filter((tool) => snapshotGrants.has(tool.id))
			.filter(admissibleRisk)
			.filter((tool) =>
				tool.requiredPermissions.every((permission) =>
					initialPermissions.has(permission),
				),
			)
			.sort((left, right) => left.id.localeCompare(right.id));
		const startedAt = Date.now();
		const events: AgentExecutionEvent[] = [];
		let acceptingEvents = true;
		const emit: AgentProviderContext['emit'] = (type, message, metadata) => {
			if (!acceptingEvents) return;
			/* Streamed output deltas are kept verbatim: a whitespace-only chunk
			   carries formatting and must not fail the run. */
			const text =
				type === 'provider.output.delta'
					? message.slice(0, 500)
					: boundedText(message, 'event.message', 1, 500);
			if (text.length === 0) return;
			const event: AgentExecutionEvent = {
				sequence: events.length + 1,
				type,
				timestamp: Date.now(),
				message: text,
				...(metadata === undefined ? {} : { metadata }),
			};
			events.push(event);
			options.onEvent?.(event);
		};
		emit('run.started', 'Harness accepted the claimed run.');
		emit('provider.started', `Provider ${provider.id} started.`, {
			model: request.definition.model,
		});
		const grantedIds = new Set(availableTools.map((tool) => tool.id));
		let toolCallOrdinal = 0;
		const invokeTool = async (
			id: string,
			input: unknown,
			invocation: { readonly providerCallId?: string } = {},
		): Promise<unknown> => {
			const ordinal = ++toolCallOrdinal;
			const tool = this.#tools.get(id);
			if (tool && !admissibleRisk(tool)) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_RISK_REFUSED',
				});
				throw new AgentHarnessError(
					'TOOL_RISK_REFUSED',
					`Tool ${id} declares external risk and cannot run unattended.`,
				);
			}
			if (!tool || !grantedIds.has(id)) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_NOT_GRANTED',
				});
				throw new AgentHarnessError(
					'TOOL_NOT_GRANTED',
					`Tool ${id} was not granted for this run.`,
				);
			}
			let permissions: Set<string>;
			try {
				permissions = await livePermissions();
			} catch (error) {
				const failure = toolFailure(error);
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: failure.code,
				});
				throw error;
			}
			if (
				tool.requiredPermissions.some(
					(permission) => !permissions.has(permission),
				)
			) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_AUTHORIZATION_REVOKED',
				});
				throw new AgentHarnessError(
					'TOOL_AUTHORIZATION_REVOKED',
					`The initiating actor no longer has permission for tool ${id}.`,
				);
			}
			if (
				tool.risk !== undefined &&
				tool.risk !== 'read' &&
				tool.idempotency === 'required' &&
				tool.idempotencyProtection !== 'target-ledger'
			) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_IDEMPOTENCY_UNAVAILABLE',
				});
				throw new AgentHarnessError(
					'TOOL_IDEMPOTENCY_UNAVAILABLE',
					`Tool ${id} has no durable target-side idempotency guarantee.`,
				);
			}
			let idempotencyKey: string | undefined;
			if (tool.idempotency === 'required') {
				/* Provider call ids are useful evidence but are not guaranteed to be
				   reproduced after a process crash. The run id and call ordinal are. */
				idempotencyKey = createHash('sha256')
					.update(`${request.runId}\u0000${ordinal}`)
					.digest('hex');
			}
			try {
				validateToolInput(tool.inputSchema, input);
			} catch (error) {
				const failure = toolFailure(error);
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: failure.code,
				});
				throw error;
			}
			if (tool.consent) {
				/* Foreign code: a throw is a refusal, never a crash. The run deadline
				   already bounds it, because the provider call this runs inside races
				   the execution timeout. */
				let decision: AgentToolConsentDecision;
				try {
					decision = await tool.consent.check(input, {
						runId: request.runId,
						tenantId: request.tenantId,
						requestedBy: request.requestedBy,
						agentId: request.definition.id,
						agentName: request.definition.name,
						invocation: 'agent-run',
						actor: {
							kind: 'agent',
							id: request.definition.id,
							label: request.definition.name,
							runId: request.runId,
						},
						...(authorizationSubject?.kind === 'user'
							? { authorizationSubject }
							: {}),
						permissions,
						signal: controller.signal,
					});
				} catch {
					decision = { granted: false, reason: 'TOOL_CONSENT_UNAVAILABLE' };
				}
				if (!decision.granted) {
					const reason = consentReason(decision.reason);
					emit('tool.denied', `Tool ${id} was denied.`, {
						tool: id,
						consent: tool.consent.id,
						reason,
					});
					throw new AgentHarnessError(
						reason,
						`Tool ${id} was not consented for this workspace.`,
					);
				}
			}
			emit('tool.started', `Tool ${id} started.`, {
				tool: id,
				ordinal,
				...(invocation.providerCallId
					? { providerCallId: invocation.providerCallId.slice(0, 128) }
					: {}),
			});
			/* The tool runs foreign code: it gets its own signal, a deadline, and
			   any failure becomes an event plus a stable error, never a crash. */
			const toolController = new AbortController();
			const abortTool = () => toolController.abort(controller.signal.reason);
			if (controller.signal.aborted) abortTool();
			else
				controller.signal.addEventListener('abort', abortTool, { once: true });
			let toolTimer: ReturnType<typeof setTimeout> | undefined;
			let rejectToolAbort: (() => void) | undefined;
			try {
				const toolAborted = new Promise<never>((_, reject) => {
					rejectToolAbort = () =>
						reject(
							new AgentHarnessError('TOOL_ABORTED', `Tool ${id} was aborted.`),
						);
					if (toolController.signal.aborted) rejectToolAbort();
					else
						toolController.signal.addEventListener('abort', rejectToolAbort, {
							once: true,
						});
				});
				const output = await Promise.race([
					tool.execute(input, {
						runId: request.runId,
						tenantId: request.tenantId,
						requestedBy: request.requestedBy,
						agentId: request.definition.id,
						agentName: request.definition.name,
						invocation: 'agent-run',
						actor: {
							kind: 'agent',
							id: request.definition.id,
							label: request.definition.name,
							runId: request.runId,
						},
						...(authorizationSubject?.kind === 'user'
							? { authorizationSubject }
							: {}),
						...(idempotencyKey ? { idempotencyKey } : {}),
						permissions,
						signal: toolController.signal,
					}),
					new Promise<never>((_, reject) => {
						/* Reject before aborting: a tool that settles on abort must
						   not win the race against its own deadline. */
						toolTimer = setTimeout(() => {
							reject(
								new AgentHarnessError(
									'TOOL_TIMEOUT',
									`Tool ${id} exceeded ${toolTimeoutMs(tool.timeoutMs)} ms.`,
								),
							);
							toolController.abort('timeout');
						}, toolTimeoutMs(tool.timeoutMs));
					}),
					toolAborted,
				]);
				validateToolOutput(tool.outputSchema, output);
				const bounded = boundToolOutput(output);
				emit('tool.completed', `Tool ${id} completed.`, {
					tool: id,
					outputCharacters: bounded.characters,
					truncated: bounded.truncated,
				});
				return bounded.value;
			} catch (error) {
				const failure = toolFailure(error);
				emit('tool.failed', `Tool ${id} failed.`, {
					tool: id,
					reason: failure.code,
				});
				throw error instanceof AgentHarnessError
					? error
					: new AgentHarnessError(failure.code, failure.message);
			} finally {
				if (toolTimer !== undefined) clearTimeout(toolTimer);
				if (rejectToolAbort)
					toolController.signal.removeEventListener('abort', rejectToolAbort);
				controller.signal.removeEventListener('abort', abortTool);
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectProviderAbort: (() => void) | undefined;
		try {
			const providerAborted = new Promise<never>((_, reject) => {
				rejectProviderAbort = () =>
					reject(
						new AgentHarnessError(
							'EXECUTION_ABORTED',
							String(controller.signal.reason ?? 'aborted'),
						),
					);
				if (controller.signal.aborted) rejectProviderAbort();
				else
					controller.signal.addEventListener('abort', rejectProviderAbort, {
						once: true,
					});
			});
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(
						new AgentHarnessError(
							'EXECUTION_TIMEOUT',
							`Agent execution exceeded ${request.definition.timeoutMs} ms.`,
						),
					);
					controller.abort('timeout');
				}, request.definition.timeoutMs);
			});
			const providerResult = await Promise.race([
				provider.execute({
					request,
					signal: controller.signal,
					availableTools: availableTools.map((tool) => ({
						id: tool.id,
						transport: tool.transport,
						target: tool.target,
						description: tool.description,
						inputSchema: tool.inputSchema ?? {
							type: 'object',
							additionalProperties: false,
						},
					})),
					invokeTool,
					emit,
				}),
				timeout,
				providerAborted,
			]);
			if (outputContract.kind === 'json-schema') {
				if (providerResult.structuredOutput === undefined) {
					throw new AgentHarnessError(
						'STRUCTURED_OUTPUT_MISSING',
						'The provider did not return the required structured output.',
					);
				}
				validateStructuredOutput(
					outputContract.schema,
					providerResult.structuredOutput,
				);
			}
			const output = boundedText(
				providerResult.output,
				'provider output',
				1,
				100_000,
			);
			emit('provider.completed', `Provider ${provider.id} completed.`, {
				finishReason: providerResult.finishReason,
			});
			const completedAt = Date.now();
			emit('run.completed', 'Harness completed the run.');
			return {
				...providerResult,
				output,
				events,
				startedAt,
				completedAt,
			};
		} finally {
			acceptingEvents = false;
			if (timer !== undefined) clearTimeout(timer);
			if (rejectProviderAbort)
				controller.signal.removeEventListener('abort', rejectProviderAbort);
			options.signal?.removeEventListener('abort', abortFromCaller);
		}
	}
}

export class LocalSimulationProvider implements AgentProvider {
	readonly id = 'local-simulation';

	async execute(context: AgentProviderContext): Promise<AgentProviderResult> {
		await Promise.resolve();
		if (context.signal.aborted) {
			throw new AgentHarnessError(
				'EXECUTION_ABORTED',
				'The simulation was aborted.',
			);
		}
		const input = context.request.input.trim();
		const output = [
			'Local simulation completed.',
			`Agent: ${context.request.definition.name}`,
			`Trigger: ${context.request.trigger}`,
			`Input: ${input}`,
			'No external model or network was called.',
		].join('\n');
		for (const chunk of output.match(/.{1,160}/gs) ?? []) {
			context.emit('provider.output.delta', chunk);
		}
		return {
			output,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			},
			finishReason: 'stop',
		};
	}
}
