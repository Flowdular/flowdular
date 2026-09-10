import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	createClaudeCodeDriver,
	createCodexDriver,
	createCodingAgentRegistry,
	resolveInsideWorkspace,
	resolveReadableInsideWorkspace,
	resolveWritableInsideWorkspace,
	type CodingAgentDriver,
	type CodingAgentEvent,
} from '../src/index.ts';

/* A stand-in binary that replays a recorded event stream, so the mapping is
   verified against the real protocol shape without calling a provider. */
async function replayBinary(lines: readonly unknown[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-replay-'));
	const fixture = join(directory, 'stream.jsonl');
	await writeFile(
		fixture,
		`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
		'utf8',
	);
	const binary = join(directory, 'replay.sh');
	await writeFile(binary, `#!/bin/sh\ncat ${fixture}\n`, 'utf8');
	await chmod(binary, 0o755);
	return binary;
}

/* A codex whose thread store is already locked: resuming fails the way the real
   binary fails, a fresh exec replays the recorded stream. */
async function lockedResumeBinary(lines: readonly unknown[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-replay-'));
	const fixture = join(directory, 'stream.jsonl');
	await writeFile(
		fixture,
		`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
		'utf8',
	);
	const binary = join(directory, 'replay.sh');
	await writeFile(
		binary,
		`#!/bin/sh\ncase "$*" in\n  *resume*)\n    echo "ERROR codex_core::session: failed to initialize thread persistence: thread-store conflict: thread thread-1 already has an active writer" >&2\n    exit 1\n    ;;\nesac\ncat ${fixture}\n`,
		'utf8',
	);
	await chmod(binary, 0o755);
	return binary;
}

async function collect(
	driver: CodingAgentDriver,
	workspacePath: string,
): Promise<readonly CodingAgentEvent[]> {
	const events: CodingAgentEvent[] = [];
	for await (const event of driver.run({
		workspacePath,
		role: 'backend-engineer',
		systemInstruction: 'contract',
		prompt: 'do the thing',
	})) {
		events.push(event);
	}
	return events;
}

describe('claude-code driver', () => {
	it('maps the print-mode stream to sandbox events', async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-claude-'));
		const command = await replayBinary([
			{ type: 'system', subtype: 'init', session_id: 'session-1' },
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Writing the entry point.' },
						{
							type: 'tool_use',
							name: 'Write',
							input: { file_path: `${workspacePath}/src/index.ts` },
						},
					],
				},
			},
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', is_error: false }] },
				tool_use_result: {
					type: 'create',
					filePath: `${workspacePath}/src/index.ts`,
				},
			},
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'Created the entry point.',
				session_id: 'session-1',
				total_cost_usd: 0.01,
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		]);
		const events = await collect(
			createClaudeCodeDriver({ command }),
			workspacePath,
		);

		expect(events[0]).toEqual({
			type: 'turn.started',
			driver: 'claude-code',
			role: 'backend-engineer',
			resumeId: 'session-1',
		});
		expect(events).toContainEqual({
			type: 'assistant.message',
			text: 'Writing the entry point.',
		});
		expect(events).toContainEqual({
			type: 'file.changed',
			path: 'src/index.ts',
			change: 'created',
		});
		expect(events.at(-1)).toEqual({
			type: 'turn.completed',
			resumeId: 'session-1',
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			costUsd: 0.01,
			finishReason: 'stop',
		});
	});

	it('surfaces a failed turn as an error event', async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-claude-'));
		const command = await replayBinary([
			{ type: 'system', subtype: 'init', session_id: 'session-2' },
			{
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				result: 'The model stopped early.',
				session_id: 'session-2',
				usage: {},
			},
		]);
		const events = await collect(
			createClaudeCodeDriver({ command }),
			workspacePath,
		);
		expect(events).toContainEqual({
			type: 'error',
			code: 'DRIVER_TURN_FAILED',
			message: 'The model stopped early.',
		});
		expect(events.at(-1)).toMatchObject({ finishReason: 'error' });
	});

	it('fails loudly when the binary exits before completing a turn', async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-claude-'));
		const command = await replayBinary([{ type: 'rate_limit_event' }]);
		await expect(
			collect(createClaudeCodeDriver({ command }), workspacePath),
		).rejects.toThrow(/before completing the turn/);
	});

	it('continues on a fresh session when the resumed one cannot start', async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-claude-'));
		const command = await lockedResumeBinary([
			{ type: 'system', subtype: 'init', session_id: 'session-3' },
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'Back on a new session.',
				session_id: 'session-3',
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		]);
		const events: CodingAgentEvent[] = [];
		for await (const event of createClaudeCodeDriver({ command }).run({
			workspacePath,
			role: 'backend-engineer',
			systemInstruction: 'contract',
			prompt: 'keep going',
			resumeId: 'session-1',
			history: [{ role: 'user', text: 'the earlier request' }],
		})) {
			events.push(event);
		}
		expect(events[0]).toMatchObject({
			type: 'error',
			code: 'DRIVER_SESSION_LOCKED',
		});
		expect(events.at(-1)).toMatchObject({
			type: 'turn.completed',
			resumeId: 'session-3',
			finishReason: 'stop',
		});
	});
});

describe('codex driver', () => {
	it('maps the exec JSONL stream to sandbox events', async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-codex-'));
		const command = await replayBinary([
			{ type: 'thread.started', thread_id: 'thread-1' },
			{ type: 'turn.started' },
			{
				type: 'item.completed',
				item: { id: 'item_0', type: 'agent_message', text: 'Adding the file.' },
			},
			{
				type: 'item.started',
				item: {
					id: 'item_1',
					type: 'command_execution',
					command: 'ls -la',
					status: 'in_progress',
				},
			},
			{
				type: 'item.completed',
				item: {
					id: 'item_1',
					type: 'command_execution',
					command: 'ls -la',
					exit_code: 0,
					status: 'completed',
				},
			},
			{
				type: 'item.completed',
				item: {
					id: 'item_2',
					type: 'file_change',
					status: 'completed',
					changes: [{ path: `${workspacePath}/ok.txt`, kind: 'add' }],
				},
			},
			{
				type: 'turn.completed',
				usage: { input_tokens: 100, output_tokens: 20 },
			},
		]);
		const events = await collect(createCodexDriver({ command }), workspacePath);

		expect(events[0]).toMatchObject({ type: 'turn.started', driver: 'codex' });
		expect(events).toContainEqual({
			type: 'assistant.message',
			text: 'Adding the file.',
		});
		expect(events).toContainEqual({
			type: 'tool.completed',
			tool: 'command',
			detail: 'ls -la',
			ok: true,
		});
		expect(events).toContainEqual({
			type: 'file.changed',
			path: 'ok.txt',
			change: 'created',
		});
		expect(events.at(-1)).toEqual({
			type: 'turn.completed',
			resumeId: 'thread-1',
			usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
			costUsd: null,
			finishReason: 'stop',
		});
	});

	it('starts a fresh thread when the previous one still holds the writer', async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-codex-'));
		const command = await lockedResumeBinary([
			{ type: 'thread.started', thread_id: 'thread-2' },
			{ type: 'turn.started' },
			{
				type: 'item.completed',
				item: { id: 'item_0', type: 'agent_message', text: 'Back at it.' },
			},
			{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
		]);
		const events: CodingAgentEvent[] = [];
		for await (const event of createCodexDriver({ command }).run({
			workspacePath,
			role: 'backend-engineer',
			systemInstruction: 'contract',
			prompt: 'keep going',
			resumeId: 'thread-1',
			history: [{ role: 'user', text: 'the earlier request' }],
		})) {
			events.push(event);
		}

		expect(events[0]).toMatchObject({
			type: 'error',
			code: 'DRIVER_THREAD_LOCKED',
		});
		expect(events).toContainEqual({
			type: 'assistant.message',
			text: 'Back at it.',
		});
		expect(events.at(-1)).toMatchObject({
			type: 'turn.completed',
			resumeId: 'thread-2',
			finishReason: 'stop',
		});
	});

	it('is a loopback-only local binary', () => {
		const driver = createCodexDriver();
		expect(driver.kind).toBe('local-cli');
		expect(driver.requiresLoopback).toBe(true);
	});
});

describe('driver registry', () => {
	const localDriver: CodingAgentDriver = {
		id: 'claude-code',
		label: 'Claude Code',
		kind: 'local-cli',
		requiresLoopback: true,
		description: 'local',
		probe: async () => ({ available: true, detail: 'ok', version: '1.0.0' }),
		run: async function* () {},
	};
	const byokDriver: CodingAgentDriver = {
		id: 'byok',
		label: 'Bring your own key',
		kind: 'byok',
		requiresLoopback: false,
		description: 'byok',
		probe: async () => ({ available: true, detail: 'ok', version: 'model' }),
		run: async function* () {},
	};

	it('offers a local binary only in loopback mode', async () => {
		const loopback = createCodingAgentRegistry({
			mode: 'loopback',
			drivers: [localDriver, byokDriver],
		});
		const hosted = createCodingAgentRegistry({
			mode: 'self-hosted',
			drivers: [localDriver, byokDriver],
		});
		expect(
			(await loopback.status())
				.filter((entry) => entry.offered)
				.map((entry) => entry.id),
		).toEqual(['claude-code', 'byok']);
		const hostedStatus = await hosted.status();
		expect(
			hostedStatus.filter((entry) => entry.offered).map((entry) => entry.id),
		).toEqual(['byok']);
		expect(hostedStatus[0]?.blockedReason).toMatch(/loopback/);
		await expect(hosted.resolve('claude-code')).rejects.toThrow(/loopback/);
		await expect(hosted.resolve('byok')).resolves.toBeDefined();
	});

	it('rejects duplicate and unknown drivers', async () => {
		expect(() =>
			createCodingAgentRegistry({
				mode: 'loopback',
				drivers: [localDriver, localDriver],
			}),
		).toThrow(/already registered/);
		const registry = createCodingAgentRegistry({
			mode: 'loopback',
			drivers: [byokDriver],
		});
		await expect(registry.resolve('codex')).rejects.toThrow(/Unknown/);
	});

	it('reports an unavailable driver instead of starting a turn', async () => {
		const registry = createCodingAgentRegistry({
			mode: 'loopback',
			drivers: [
				{
					...byokDriver,
					probe: async () => ({
						available: false,
						detail: 'No provider credential is configured.',
						version: null,
					}),
				},
			],
		});
		await expect(registry.resolve('byok')).rejects.toThrow(/not available/);
	});
});

describe('workspace guards', () => {
	it('keeps every path inside the session workspace', () => {
		expect(resolveInsideWorkspace('/tmp/session', 'src/index.ts')).toBe(
			'/tmp/session/src/index.ts',
		);
		expect(() =>
			resolveInsideWorkspace('/tmp/session', '../../etc/passwd'),
		).toThrow(/escapes the session workspace/);
		expect(() => resolveInsideWorkspace('/tmp/session', '/etc/passwd')).toThrow(
			/escapes the session workspace/,
		);
	});

	it('rejects writes outside the role allowlist and through escaping symlinks', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-workspace-guard-'));
		const outside = await mkdtemp(
			join(tmpdir(), 'flowdular-workspace-outside-'),
		);
		await mkdir(join(root, 'modules', 'catalog', 'src'), { recursive: true });
		await symlink(outside, join(root, 'modules', 'catalog', 'src', 'escape'));

		await expect(
			resolveWritableInsideWorkspace(root, 'modules/catalog/src/owned.ts', [
				'modules/catalog/src/**',
			]),
		).resolves.toBe(join(root, 'modules', 'catalog', 'src', 'owned.ts'));
		await expect(
			resolveWritableInsideWorkspace(root, 'flowdular.json', [
				'modules/catalog/src/**',
			]),
		).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
		await expect(
			resolveWritableInsideWorkspace(
				root,
				'modules/catalog/src/escape/host.ts',
				['modules/catalog/src/**'],
			),
		).rejects.toMatchObject({ code: 'PATH_ESCAPES_WORKSPACE' });
		await expect(
			resolveReadableInsideWorkspace(
				root,
				'modules/catalog/src/escape/secret.txt',
			),
		).rejects.toMatchObject({ code: 'PATH_ESCAPES_WORKSPACE' });
	});

	it('never allows model tools to write dependency or repository control paths', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-workspace-guard-'));
		await mkdir(join(root, 'node_modules'), { recursive: true });
		await mkdir(join(root, '.git'), { recursive: true });
		for (const path of ['node_modules/.bin/vitest', '.git/config']) {
			await expect(
				resolveWritableInsideWorkspace(root, path, ['**']),
			).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
		}
	});
});
