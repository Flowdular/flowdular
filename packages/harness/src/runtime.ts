import { AgentHarnessError } from './errors.ts';
import {
	boundToolOutput,
	toolTimeoutMs,
	validateToolInput,
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
	readonly trigger: AgentRunTrigger;
	readonly input: string;
	readonly definition: AgentExecutionDefinition;
	readonly permissionSnapshot: readonly string[];
	readonly toolGrants: readonly string[];
}

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
	readonly usage: AgentUsage;
	readonly finishReason: 'stop' | 'length' | 'tool-limit';
}

export interface AgentToolContext {
	readonly runId: string;
	readonly tenantId: string;
	readonly requestedBy: string;
	readonly permissions: ReadonlySet<string>;
	readonly signal: AbortSignal;
}

export interface AgentTool {
	readonly id: string;
	readonly transport: 'api' | 'cli';
	readonly target: string;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema?: Readonly<Record<string, unknown>>;
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
	invokeTool(id: string, input: unknown): Promise<unknown>;
	emit(
		type: AgentExecutionEvent['type'],
		message: string,
		metadata?: Readonly<Record<string, string | number | boolean>>,
	): void;
}

export interface AgentProvider {
	readonly id: string;
	execute(context: AgentProviderContext): Promise<AgentProviderResult>;
}

export interface AgentExecutionResult extends AgentProviderResult {
	readonly events: readonly AgentExecutionEvent[];
	readonly startedAt: number;
	readonly completedAt: number;
}

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

function assertExecutionRequest(request: AgentExecutionRequest): void {
	boundedText(request.runId, 'runId', 1, 128);
	boundedText(request.tenantId, 'tenantId', 1, 128);
	boundedText(request.requestedBy, 'requestedBy', 1, 128);
	boundedText(request.input, 'input', 1, 100_000);
	boundedText(request.definition.name, 'definition.name', 2, 120);
	boundedText(request.definition.instructions, 'instructions', 8, 40_000);
	identifier(request.definition.provider, 'provider');
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

export class AgentHarness {
	readonly #providers: ReadonlyMap<string, AgentProvider>;
	readonly #tools: ReadonlyMap<string, AgentTool>;

	constructor(options: {
		readonly providers: readonly AgentProvider[];
		readonly tools?: readonly AgentTool[];
	}) {
		const providers = new Map<string, AgentProvider>();
		for (const provider of options.providers) {
			const id = identifier(provider.id, 'provider.id');
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
			toolTimeoutMs(tool.timeoutMs);
			tools.set(id, tool);
		}
		this.#providers = providers;
		this.#tools = tools;
	}

	providers(): readonly string[] {
		return [...this.#providers.keys()].sort();
	}

	tools(): readonly string[] {
		return [...this.#tools.keys()].sort();
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
		const allowed = new Set(request.definition.allowedTools);
		const granted = new Set(request.toolGrants);
		const permissions = new Set(request.permissionSnapshot);
		const availableTools = [...this.#tools.values()]
			.filter((tool) => allowed.has(tool.id) && granted.has(tool.id))
			.filter((tool) =>
				tool.requiredPermissions.every((permission) =>
					permissions.has(permission),
				),
			)
			.sort((left, right) => left.id.localeCompare(right.id));
		const controller = new AbortController();
		const abortFromCaller = () =>
			controller.abort(options.signal?.reason ?? 'aborted');
		if (options.signal?.aborted) abortFromCaller();
		else
			options.signal?.addEventListener('abort', abortFromCaller, {
				once: true,
			});
		const startedAt = Date.now();
		const events: AgentExecutionEvent[] = [];
		const emit: AgentProviderContext['emit'] = (type, message, metadata) => {
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
		const invokeTool = async (id: string, input: unknown): Promise<unknown> => {
			const tool = this.#tools.get(id);
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
			emit('tool.started', `Tool ${id} started.`, { tool: id });
			/* The tool runs foreign code: it gets its own signal, a deadline, and
			   any failure becomes an event plus a stable error, never a crash. */
			const toolController = new AbortController();
			const abortTool = () => toolController.abort(controller.signal.reason);
			if (controller.signal.aborted) abortTool();
			else
				controller.signal.addEventListener('abort', abortTool, { once: true });
			let toolTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const output = await Promise.race([
					tool.execute(input, {
						runId: request.runId,
						tenantId: request.tenantId,
						requestedBy: request.requestedBy,
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
				]);
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
				controller.signal.removeEventListener('abort', abortTool);
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort('timeout');
					reject(
						new AgentHarnessError(
							'EXECUTION_TIMEOUT',
							`Agent execution exceeded ${request.definition.timeoutMs} ms.`,
						),
					);
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
			]);
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
			if (timer !== undefined) clearTimeout(timer);
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
