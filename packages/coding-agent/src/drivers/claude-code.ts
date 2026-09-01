import { randomUUID } from 'node:crypto';
import type { AiUsage } from '@coreloom/ai-provider';
import {
	CodingAgentError,
	type CodingAgentAvailability,
	type CodingAgentDriver,
	type CodingAgentEvent,
	type CodingAgentTurnRequest,
	type FileChangeKind,
} from '../types.ts';
import {
	parseJsonLine,
	probeCommand,
	spawnLineStream,
	workspaceRelative,
} from '../workspace.ts';

export interface ClaudeCodeDriverOptions {
	readonly command?: string;
	/* Built-in tools the session may use. Command execution stays out: gates are
	   run by the sandbox orchestrator, never by the model. */
	readonly tools?: readonly string[];
	readonly defaultModel?: string | null;
	readonly timeoutMs?: number;
}

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface ContentBlock {
	readonly type?: string;
	readonly text?: string;
	readonly name?: string;
	readonly input?: Record<string, unknown>;
	readonly content?: unknown;
	readonly is_error?: boolean;
}

function toolDetail(input: Record<string, unknown> | undefined): string {
	if (!input) return '';
	for (const key of ['file_path', 'path', 'pattern', 'query', 'command']) {
		const value = input[key];
		if (typeof value === 'string') return value.slice(0, 200);
	}
	return '';
}

function usageOf(value: unknown): AiUsage {
	const usage = (value ?? {}) as Record<string, unknown>;
	const inputTokens = Number(usage.input_tokens ?? 0);
	const outputTokens = Number(usage.output_tokens ?? 0);
	return {
		inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
		outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
		totalTokens:
			(Number.isFinite(inputTokens) ? inputTokens : 0) +
			(Number.isFinite(outputTokens) ? outputTokens : 0),
	};
}

/* A resumed session whose file is still held by the previous process, or was
   never flushed, fails before the init message. The turn then continues on a
   fresh session with the conversation replayed, as the codex driver does. */
function isResumeFailure(error: unknown): boolean {
	return (
		error instanceof CodingAgentError && error.code === 'DRIVER_START_FAILED'
	);
}

function replayedPrompt(request: CodingAgentTurnRequest): string {
	const history = request.history ?? [];
	if (history.length === 0) return request.prompt;
	return [
		'<conversation-so-far>',
		...history.map((message) => `${message.role}: ${message.text.trim()}`),
		'</conversation-so-far>',
		'',
		request.prompt,
	].join('\n');
}

function changeKind(value: unknown): FileChangeKind | null {
	if (value === 'create') return 'created';
	if (value === 'update') return 'modified';
	if (value === 'delete') return 'deleted';
	return null;
}

export function createClaudeCodeDriver(
	options: ClaudeCodeDriverOptions = {},
): CodingAgentDriver {
	const command = options.command ?? 'claude';
	const tools = (options.tools ?? DEFAULT_TOOLS).join(',');

	return {
		id: 'claude-code',
		label: 'Claude Code',
		kind: 'local-cli',
		requiresLoopback: true,
		description:
			'Local claude binary in print mode with restricted tools and the session workspace as its only writable directory.',

		async probe(): Promise<CodingAgentAvailability> {
			const result = await probeCommand(command, ['--version']);
			return {
				available: result.available,
				detail: result.available
					? `Uses the operator login of ${command}.`
					: result.detail,
				version: result.version,
			};
		},

		async *run(
			request: CodingAgentTurnRequest,
		): AsyncIterable<CodingAgentEvent> {
			const resumeId = request.resumeId ?? null;
			if (!resumeId) {
				yield* runSession(request, null);
				return;
			}
			try {
				yield* runSession(request, resumeId);
			} catch (error) {
				if (!isResumeFailure(error)) throw error;
				yield {
					type: 'error',
					code: 'DRIVER_SESSION_LOCKED',
					message:
						'The previous claude session could not be resumed, so this turn continues on a new session with the conversation replayed.',
				};
				yield* runSession(request, null, true);
			}
		},
	};

	async function* runSession(
		request: CodingAgentTurnRequest,
		resumeId: string | null,
		replayHistory = false,
	): AsyncIterable<CodingAgentEvent> {
		const sessionId = resumeId ?? randomUUID();
		const args = [
			'--print',
			'--output-format',
			'stream-json',
			'--verbose',
			'--permission-mode',
			'acceptEdits',
			'--restricted',
			'--strict-mcp-config',
			'--tools',
			tools,
			'--add-dir',
			request.workspacePath,
			'--append-system-prompt',
			request.systemInstruction,
			...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]),
			...((request.model ?? options.defaultModel)
				? ['--model', (request.model ?? options.defaultModel)!]
				: []),
			replayHistory ? replayedPrompt(request) : request.prompt,
		];

		const stream = spawnLineStream({
			command,
			args,
			cwd: request.workspacePath,
			signal: request.signal,
			timeoutMs: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});

		let started = false;
		let completed = false;
		let currentResumeId = resumeId;
		for await (const line of stream.lines) {
			const message = parseJsonLine(line);
			if (!message) continue;
			const type = message.type;

			if (type === 'system' && message.subtype === 'init') {
				currentResumeId =
					typeof message.session_id === 'string'
						? message.session_id
						: currentResumeId;
				started = true;
				yield {
					type: 'turn.started',
					driver: 'claude-code',
					role: request.role,
					resumeId: currentResumeId,
				};
				continue;
			}

			if (type === 'assistant') {
				const content = ((message.message ?? {}) as Record<string, unknown>)
					.content;
				for (const block of (content ?? []) as ContentBlock[]) {
					if (block.type === 'text' && block.text?.trim()) {
						yield { type: 'assistant.message', text: block.text };
					}
					if (block.type === 'thinking' && typeof block.text === 'string') {
						yield { type: 'reasoning', text: block.text };
					}
					if (block.type === 'tool_use' && block.name) {
						yield {
							type: 'tool.started',
							tool: block.name,
							detail: toolDetail(block.input),
						};
					}
				}
				continue;
			}

			if (type === 'user') {
				const content = ((message.message ?? {}) as Record<string, unknown>)
					.content;
				const result = (message.tool_use_result ?? {}) as Record<
					string,
					unknown
				>;
				for (const block of (content ?? []) as ContentBlock[]) {
					if (block.type !== 'tool_result') continue;
					yield {
						type: 'tool.completed',
						tool: typeof result.type === 'string' ? result.type : 'tool',
						detail: typeof result.filePath === 'string' ? result.filePath : '',
						ok: block.is_error !== true,
					};
				}
				const change = changeKind(result.type);
				if (change && typeof result.filePath === 'string') {
					yield {
						type: 'file.changed',
						path: workspaceRelative(request.workspacePath, result.filePath),
						change,
					};
				}
				continue;
			}

			if (type === 'result') {
				completed = true;
				const failed = message.is_error === true;
				if (failed && typeof message.result === 'string') {
					yield {
						type: 'error',
						code: 'DRIVER_TURN_FAILED',
						message: message.result.slice(0, 500),
					};
				} else if (typeof message.result === 'string' && message.result) {
					yield { type: 'assistant.message', text: message.result };
				}
				yield {
					type: 'turn.completed',
					resumeId:
						typeof message.session_id === 'string'
							? message.session_id
							: currentResumeId,
					usage: usageOf(message.usage),
					costUsd:
						typeof message.total_cost_usd === 'number'
							? message.total_cost_usd
							: null,
					finishReason: failed ? 'error' : 'stop',
				};
			}
		}

		const exit = await stream.finished;
		if (completed) return;
		if (exit.aborted) {
			yield {
				type: 'turn.completed',
				resumeId: currentResumeId,
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				costUsd: null,
				finishReason: 'aborted',
			};
			return;
		}
		throw new CodingAgentError(
			started ? 'DRIVER_STREAM_INCOMPLETE' : 'DRIVER_START_FAILED',
			exit.stderr.trim().slice(0, 300) ||
				`The ${command} process exited with code ${exit.code} before completing the turn.`,
		);
	}
}
