import {
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	classifyProviderFailure,
	normalizeUsage,
	probeLanguageModel,
	resolveLanguageModel,
	type AiProviderConfiguration,
} from '@flowdular/ai-provider';
import {
	jsonSchema,
	stepCountIs,
	streamText,
	tool,
	type ModelMessage,
	type ToolSet,
} from 'ai';
import {
	type CodingAgentAvailability,
	type CodingAgentDriver,
	type CodingAgentEvent,
	type CodingAgentTurnRequest,
	type FileChangeKind,
} from '../types.ts';
import {
	resolveInsideWorkspace,
	resolveReadableInsideWorkspace,
	resolveWritableInsideWorkspace,
	workspaceRelative,
} from '../workspace.ts';

export interface ByokDriverOptions {
	readonly configuration: AiProviderConfiguration;
	readonly maxSteps?: number;
	readonly maxOutputTokens?: number;
	readonly maxFileBytes?: number;
	readonly maxListedFiles?: number;
}

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_LISTED_FILES = 400;
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);

interface PendingEvent {
	readonly event: CodingAgentEvent;
}

async function listFiles(
	root: string,
	directory: string,
	limit: number,
	found: string[],
): Promise<void> {
	if (found.length >= limit) return;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (found.length >= limit) return;
		if (entry.name.startsWith('.') && entry.name !== '.ai') continue;
		if (IGNORED_DIRECTORIES.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await listFiles(root, path, limit, found);
		else found.push(workspaceRelative(root, path));
	}
}

/* The BYOK driver is the only backend a self-hosted sandbox can offer, so its
   tools are the whole file surface the model gets: bounded to the session
   workspace, size capped, and with no command execution. */
export function createByokDriver(
	options: ByokDriverOptions,
): CodingAgentDriver {
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxListedFiles = options.maxListedFiles ?? DEFAULT_MAX_LISTED_FILES;

	function workspaceTools(
		workspacePath: string,
		allowedPaths: readonly string[],
		emit: (event: CodingAgentEvent) => void,
	): ToolSet {
		const record = (
			name: string,
			detail: string,
			run: () => Promise<string>,
		) => {
			emit({ type: 'tool.started', tool: name, detail });
			return run().then(
				(value) => {
					emit({ type: 'tool.completed', tool: name, detail, ok: true });
					return value;
				},
				(error: unknown) => {
					emit({ type: 'tool.completed', tool: name, detail, ok: false });
					return `Error: ${error instanceof Error ? error.message : String(error)}`;
				},
			);
		};
		const changed = async (
			path: string,
			absolute: string,
		): Promise<FileChangeKind> => {
			try {
				await stat(absolute);
				return 'modified';
			} catch {
				return 'created';
			}
		};

		return {
			list_files: tool({
				description:
					'List the files of the session workspace, relative to its root.',
				inputSchema: jsonSchema<{ directory?: string }>({
					type: 'object',
					properties: {
						directory: {
							type: 'string',
							description: 'Optional subdirectory, relative to the workspace.',
						},
					},
					additionalProperties: false,
				}),
				execute: (input) =>
					record('list_files', input.directory ?? '.', async () => {
						const start = resolveInsideWorkspace(
							workspacePath,
							input.directory ?? '.',
						);
						const found: string[] = [];
						await listFiles(workspacePath, start, maxListedFiles, found);
						return found.sort().join('\n') || '(empty)';
					}),
			}),
			read_file: tool({
				description: 'Read one file of the session workspace.',
				inputSchema: jsonSchema<{ path: string }>({
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
					additionalProperties: false,
				}),
				execute: (input) =>
					record('read_file', input.path, async () => {
						const absolute = await resolveReadableInsideWorkspace(
							workspacePath,
							input.path,
						);
						const content = await readFile(absolute, 'utf8');
						return content.length > maxFileBytes
							? `${content.slice(0, maxFileBytes)}\n… truncated at ${maxFileBytes} bytes.`
							: content;
					}),
			}),
			write_file: tool({
				description:
					'Create or replace one file of the session workspace with the complete new content.',
				inputSchema: jsonSchema<{ path: string; content: string }>({
					type: 'object',
					properties: {
						path: { type: 'string' },
						content: { type: 'string' },
					},
					required: ['path', 'content'],
					additionalProperties: false,
				}),
				execute: (input) =>
					record('write_file', input.path, async () => {
						if (input.content.length > maxFileBytes) {
							throw new Error(
								`File content exceeds ${maxFileBytes} bytes for this workspace.`,
							);
						}
						const absolute = await resolveWritableInsideWorkspace(
							workspacePath,
							input.path,
							allowedPaths,
						);
						const change = await changed(input.path, absolute);
						await mkdir(dirname(absolute), { recursive: true });
						await writeFile(absolute, input.content, 'utf8');
						emit({
							type: 'file.changed',
							path: workspaceRelative(workspacePath, absolute),
							change,
						});
						return `Wrote ${workspaceRelative(workspacePath, absolute)}.`;
					}),
			}),
			delete_file: tool({
				description: 'Delete one file of the session workspace.',
				inputSchema: jsonSchema<{ path: string }>({
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
					additionalProperties: false,
				}),
				execute: (input) =>
					record('delete_file', input.path, async () => {
						const absolute = await resolveWritableInsideWorkspace(
							workspacePath,
							input.path,
							allowedPaths,
						);
						await rm(absolute, { force: true });
						emit({
							type: 'file.changed',
							path: workspaceRelative(workspacePath, absolute),
							change: 'deleted',
						});
						return `Deleted ${workspaceRelative(workspacePath, absolute)}.`;
					}),
			}),
		};
	}

	return {
		id: 'byok',
		label: 'Bring your own key',
		kind: 'byok',
		requiresLoopback: false,
		description:
			'Vercel AI SDK provider driving the sandbox file tools. The only backend a self-hosted sandbox can offer.',

		async probe(): Promise<CodingAgentAvailability> {
			if (!options.configuration.credential.trim()) {
				return {
					available: false,
					detail: 'No provider credential is configured for this sandbox.',
					version: null,
				};
			}
			const readiness = await probeLanguageModel(options.configuration);
			return {
				available: readiness.healthy,
				detail: readiness.healthy
					? `${options.configuration.kind} responded in ${readiness.latencyMs} ms.`
					: (readiness.errorCode ?? 'The provider probe failed.'),
				version: options.configuration.model,
			};
		},

		async *run(
			request: CodingAgentTurnRequest,
		): AsyncIterable<CodingAgentEvent> {
			yield {
				type: 'turn.started',
				driver: 'byok',
				role: request.role,
				resumeId: request.resumeId ?? null,
			};

			const queue: PendingEvent[] = [];
			const emit = (event: CodingAgentEvent) => queue.push({ event });
			const messages: ModelMessage[] = [
				...(request.history ?? []).map((message) => ({
					role: message.role,
					content: message.text,
				})),
				{ role: 'user' as const, content: request.prompt },
			];

			try {
				const result = streamText({
					model: resolveLanguageModel({
						...options.configuration,
						...(request.model ? { model: request.model } : {}),
					}),
					system: request.systemInstruction,
					messages,
					maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					maxRetries: 1,
					...(request.signal ? { abortSignal: request.signal } : {}),
					stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
					tools: workspaceTools(
						request.workspacePath,
						/* An omitted role boundary is no write authority. The sandbox always
						   supplies an explicit allowlist for its selected specialist. */
						request.allowedPaths ?? [],
						emit,
					),
				});

				let text = '';
				let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
				for await (const part of result.fullStream) {
					while (queue.length > 0) yield queue.shift()!.event;
					if (part.type === 'text-delta') text += part.text;
					if (part.type === 'finish') usage = normalizeUsage(part.totalUsage);
					if (part.type === 'error') throw part.error;
				}
				while (queue.length > 0) yield queue.shift()!.event;
				if (text.trim()) yield { type: 'assistant.message', text: text.trim() };
				yield {
					type: 'turn.completed',
					resumeId: request.resumeId ?? null,
					usage,
					costUsd: null,
					finishReason: 'stop',
				};
			} catch (error) {
				while (queue.length > 0) yield queue.shift()!.event;
				const failure = classifyProviderFailure(error);
				yield { type: 'error', code: failure.code, message: failure.message };
				yield {
					type: 'turn.completed',
					resumeId: request.resumeId ?? null,
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					costUsd: null,
					finishReason: request.signal?.aborted ? 'aborted' : 'error',
				};
			}
		},
	};
}
