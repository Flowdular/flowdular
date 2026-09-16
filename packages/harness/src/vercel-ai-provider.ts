import {
	AiProviderError,
	classifyProviderFailure,
	normalizeUsage,
	probeLanguageModel,
	resolveLanguageModel,
	temperatureSetting,
	webSearchPassThrough,
	webSearchReporter,
	type AiProviderConfiguration,
	type AiProviderKind,
	type ProviderReadinessResult,
	type WebSearchPassThrough,
} from '@flowdular/ai-provider';
import {
	jsonSchema,
	Output,
	stepCountIs,
	streamText,
	tool,
	wrapLanguageModel,
	type LanguageModelMiddleware,
	type ToolSet,
} from 'ai';
import { AgentHarnessError } from './errors.ts';
import { withSystemPreamble } from './preamble.ts';
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	NATIVE_TOOL_LIMITS,
	NATIVE_TOOL_UNSUPPORTED,
	type AgentProvider,
	type AgentProviderContext,
	type AgentProviderResult,
	type AgentUsage,
} from './runtime.ts';

/* Provider kinds, model resolution, and failure classification are owned by
   @flowdular/ai-provider so the platform runtime and the sandbox coding agent
   share one definition. This module keeps the agent-runtime contract. */
export type VercelAiProviderKind = AiProviderKind;
export type { ProviderReadinessResult };
export { AiProviderError as VercelAiProviderError };

export interface VercelAiProviderConfiguration extends AiProviderConfiguration {
	readonly id: string;
}

function providerId(value: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 128) {
		throw new AiProviderError(
			'INVALID_PROVIDER_CONFIGURATION',
			'provider id is invalid.',
		);
	}
	return normalized;
}

function finishReason(value: string): AgentProviderResult['finishReason'] {
	if (value === 'length') return 'length';
	if (value === 'tool-calls') return 'tool-limit';
	return 'stop';
}

function toolsFor(context: AgentProviderContext): {
	readonly tools: ToolSet;
	readonly ids: Map<string, string>;
} {
	const tools: ToolSet = {};
	const ids = new Map<string, string>();
	for (const available of context.availableTools) {
		const name = available.id.replace(/[^a-zA-Z0-9_]/g, '_');
		if (ids.has(name)) {
			throw new AiProviderError(
				'TOOL_NAME_COLLISION',
				'Two granted tools resolve to the same provider-safe name.',
			);
		}
		ids.set(name, available.id);
		tools[name] = tool({
			description: available.description,
			inputSchema: jsonSchema(available.inputSchema),
			execute: (input, options) =>
				context.invokeTool(available.id, input, {
					providerCallId: options.toolCallId,
				}),
		});
	}
	return { tools, ids };
}

interface NativeWebSearch {
	readonly middleware: LanguageModelMiddleware;
	readonly providerOptions: WebSearchPassThrough['providerOptions'];
}

/* A request carries at most one web search of the provider's own. Every other
   native tool, and each one a provider kind cannot pass on, is reported as
   unsupported, which the run records without failing. */
async function nativeWebSearch(
	configuration: VercelAiProviderConfiguration,
	context: AgentProviderContext,
	tools: ToolSet,
	ids: Map<string, string>,
): Promise<NativeWebSearch | null> {
	let passed: NativeWebSearch | null = null;
	for (const native of context.nativeTools ?? []) {
		const passThrough: WebSearchPassThrough | null =
			native.kind === 'web-search' && passed === null
				? webSearchPassThrough(configuration.kind, native.config)
				: null;
		if (!passThrough) {
			await context.reportNative({
				id: native.id,
				code: NATIVE_TOOL_UNSUPPORTED,
			});
			continue;
		}
		const name = native.id.replace(/[^a-zA-Z0-9_]/g, '_');
		if (ids.has(name)) {
			throw new AiProviderError(
				'TOOL_NAME_COLLISION',
				'Two granted tools resolve to the same provider-safe name.',
			);
		}
		ids.set(name, native.id);
		tools[name] = passThrough.tool;
		passed = {
			middleware: webSearchReporter({
				kind: configuration.kind,
				toolName: name,
				maxReports: NATIVE_TOOL_LIMITS.reportsPerRun,
				report: (report) =>
					context.reportNative({
						id: native.id,
						...(report.query === null ? {} : { query: report.query }),
						results: report.results,
					}),
				unsupported: (detail) =>
					context.reportNative({
						id: native.id,
						code: NATIVE_TOOL_UNSUPPORTED,
						detail,
					}),
			}),
			providerOptions: passThrough.providerOptions,
		};
	}
	return passed;
}

export function createVercelAiSdkProvider(
	configuration: VercelAiProviderConfiguration,
): AgentProvider {
	const id = providerId(configuration.id);
	return {
		id,
		capabilities: { structuredOutput: true },
		async execute(context): Promise<AgentProviderResult> {
			try {
				const { tools, ids } = toolsFor(context);
				const webSearch = await nativeWebSearch(
					configuration,
					context,
					tools,
					ids,
				);
				const model = resolveLanguageModel(configuration);
				const outputContract = context.request.outputContract ?? {
					kind: 'text' as const,
				};
				const outputSpec =
					outputContract.kind === 'json-schema'
						? Output.object({
								schema: jsonSchema(outputContract.schema),
								name: outputContract.name,
							})
						: Output.text();
				const result = streamText({
					model: webSearch
						? wrapLanguageModel({ model, middleware: webSearch.middleware })
						: model,
					...(webSearch?.providerOptions
						? { providerOptions: webSearch.providerOptions }
						: {}),
					instructions: withSystemPreamble(
						context.request,
						context.availableTools.map((available) => available.id),
					),
					prompt: context.request.input,
					...temperatureSetting(
						configuration,
						context.request.definition.temperature,
					),
					maxOutputTokens:
						context.request.definition.maxOutputTokens ??
						DEFAULT_MAX_OUTPUT_TOKENS,
					maxRetries: 1,
					abortSignal: context.signal,
					stopWhen: stepCountIs(context.request.definition.maxSteps),
					tools,
					output: outputSpec,
				});
				let output = '';
				let totalUsage: AgentUsage = {
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
				};
				let completedReason: AgentProviderResult['finishReason'] = 'stop';
				for await (const part of result.fullStream) {
					if (part.type === 'text-delta') {
						output += part.text;
						/* The text block id travels with every delta so a reader can fold
						   one block into one answer and never merge two of them. */
						for (const chunk of part.text.match(/.{1,450}/gs) ?? []) {
							context.emit('provider.output.delta', chunk, {
								stream: part.id,
							});
						}
					}
					/* The harness already recorded failures raised by its own tools.
					   What remains here is the SDK refusing a call before execution,
					   such as unparseable arguments from the model. */
					if (
						part.type === 'tool-error' &&
						!(part.error instanceof AgentHarnessError)
					) {
						context.emit(
							'tool.failed',
							`Tool ${ids.get(part.toolName) ?? part.toolName} failed.`,
							{
								tool: ids.get(part.toolName) ?? part.toolName,
								reason: 'PROVIDER_TOOL_ERROR',
							},
						);
					}
					if (part.type === 'finish') {
						totalUsage = normalizeUsage(part.totalUsage);
						completedReason = finishReason(part.finishReason);
					}
					if (part.type === 'error') throw part.error;
				}
				const structuredOutput =
					outputContract.kind === 'json-schema'
						? ((await result.output) as AgentProviderResult['structuredOutput'])
						: undefined;
				return {
					output:
						outputContract.kind === 'json-schema'
							? JSON.stringify(structuredOutput)
							: output.trim() || 'The provider completed without text output.',
					...(structuredOutput === undefined ? {} : { structuredOutput }),
					usage: totalUsage,
					finishReason: completedReason,
				};
			} catch (error) {
				/* A native report the harness refused, such as one after the actor
				   lost the tool's permission, keeps the harness's own code. */
				if (error instanceof AgentHarnessError) throw error;
				const failure = classifyProviderFailure(error);
				/* The run keeps the stable code. The provider's own reason is
				   redacted of credentials and stays in the server log, which is the
				   only place a failed run can be diagnosed. */
				console.error(
					`[harness] provider ${id} failed on ${configuration.model}: ${failure.code}`,
					failure.detail ?? '',
				);
				throw failure;
			}
		},
	};
}

export function probeVercelAiSdkProvider(
	configuration: VercelAiProviderConfiguration,
	timeoutMs = 10_000,
): Promise<ProviderReadinessResult> {
	return probeLanguageModel(configuration, timeoutMs);
}
