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

export interface CodexDriverOptions {
	readonly command?: string;
	readonly defaultModel?: string | null;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface CodexItem {
	readonly id?: string;
	readonly type?: string;
	readonly text?: string;
	readonly command?: string;
	readonly status?: string;
	readonly exit_code?: number | null;
	readonly changes?: readonly { path?: string; kind?: string }[];
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

function changeKind(value: string | undefined): FileChangeKind {
	if (value === 'add') return 'created';
	if (value === 'delete') return 'deleted';
	return 'modified';
}

/* Codex has no system prompt flag, so the role contract is prepended as a
   delimited preamble the model reads before the request. A turn that could not
   resume its thread also replays the conversation, because a fresh thread
   starts with no memory of it. */
function composePrompt(
	request: CodingAgentTurnRequest,
	replayHistory: boolean,
): string {
	const history = replayHistory ? (request.history ?? []) : [];
	return [
		'<role-contract>',
		request.systemInstruction.trim(),
		'</role-contract>',
		...(history.length > 0
			? [
					'',
					'<conversation-so-far>',
					...history.map(
						(message) => `${message.role}: ${message.text.trim()}`,
					),
					'</conversation-so-far>',
				]
			: []),
		'',
		'<request>',
		request.prompt.trim(),
		'</request>',
	].join('\n');
}

/* Codex keeps one writer per thread. A previous turn that has not released it
   yet, or was killed before it could, makes every resume of that thread fail. */
function isThreadLocked(error: unknown): boolean {
	return (
		error instanceof CodingAgentError &&
		/thread-store conflict|active writer/i.test(error.message)
	);
}

export function createCodexDriver(
	options: CodexDriverOptions = {},
): CodingAgentDriver {
	const command = options.command ?? 'codex';

	return {
		id: 'codex',
		label: 'Codex CLI',
		kind: 'local-cli',
		requiresLoopback: true,
		description:
			'Local codex binary in exec mode with a workspace-write sandbox rooted at the session workspace.',

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
				yield* runThread(request, null);
				return;
			}
			try {
				yield* runThread(request, resumeId);
			} catch (error) {
				if (!isThreadLocked(error)) throw error;
				yield {
					type: 'error',
					code: 'DRIVER_THREAD_LOCKED',
					message:
						'The previous codex thread was still open, so this turn continues on a new thread with the conversation replayed.',
				};
				yield* runThread(request, null);
			}
		},
	};

	async function* runThread(
		request: CodingAgentTurnRequest,
		resumeId: string | null,
	): AsyncIterable<CodingAgentEvent> {
		const model = request.model ?? options.defaultModel ?? null;
		/* The resume subcommand takes a narrower option set than a fresh exec: it
		   has no --cd or --sandbox, so the working directory comes from the child
		   process and the sandbox policy from a config override. */
		const args = resumeId
			? [
					'exec',
					'resume',
					resumeId,
					'--json',
					'--skip-git-repo-check',
					'-c',
					'sandbox_mode="workspace-write"',
					...(model ? ['--model', model] : []),
					composePrompt(request, resumeId === null),
				]
			: [
					'exec',
					'--json',
					'--cd',
					request.workspacePath,
					'--sandbox',
					'workspace-write',
					'--skip-git-repo-check',
					...(model ? ['--model', model] : []),
					composePrompt(request, resumeId === null),
				];

		const stream = spawnLineStream({
			command,
			args,
			cwd: request.workspacePath,
			signal: request.signal,
			timeoutMs: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});

		let currentResumeId = resumeId;
		let started = false;
		let completed = false;
		for await (const line of stream.lines) {
			const message = parseJsonLine(line);
			if (!message) continue;
			const type = message.type;

			if (type === 'thread.started') {
				currentResumeId =
					typeof message.thread_id === 'string'
						? message.thread_id
						: currentResumeId;
				continue;
			}

			if (type === 'turn.started') {
				started = true;
				yield {
					type: 'turn.started',
					driver: 'codex',
					role: request.role,
					resumeId: currentResumeId,
				};
				continue;
			}

			if (type === 'item.started' || type === 'item.completed') {
				const item = (message.item ?? {}) as CodexItem;
				const done = type === 'item.completed';
				if (item.type === 'agent_message' && done && item.text?.trim()) {
					yield { type: 'assistant.message', text: item.text };
				}
				if (item.type === 'reasoning' && done && item.text?.trim()) {
					yield { type: 'reasoning', text: item.text };
				}
				if (item.type === 'command_execution') {
					yield done
						? {
								type: 'tool.completed',
								tool: 'command',
								detail: (item.command ?? '').slice(0, 200),
								ok: (item.exit_code ?? 0) === 0,
							}
						: {
								type: 'tool.started',
								tool: 'command',
								detail: (item.command ?? '').slice(0, 200),
							};
				}
				if (item.type === 'file_change' && done) {
					for (const change of item.changes ?? []) {
						if (!change.path) continue;
						yield {
							type: 'file.changed',
							path: workspaceRelative(request.workspacePath, change.path),
							change: changeKind(change.kind),
						};
					}
				}
				continue;
			}

			if (type === 'turn.completed' || type === 'turn.failed') {
				completed = true;
				if (type === 'turn.failed') {
					const error = (message.error ?? {}) as { message?: string };
					yield {
						type: 'error',
						code: 'DRIVER_TURN_FAILED',
						message: (error.message ?? 'The codex turn failed.').slice(0, 500),
					};
				}
				yield {
					type: 'turn.completed',
					resumeId: currentResumeId,
					usage: usageOf(message.usage),
					costUsd: null,
					finishReason: type === 'turn.failed' ? 'error' : 'stop',
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
