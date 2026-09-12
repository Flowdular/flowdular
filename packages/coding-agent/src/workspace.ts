import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CodingAgentError } from './types.ts';

/* Every path a driver touches is resolved against the session workspace and
   rejected when it escapes, so a prompt cannot reach the real module tree. */
export function resolveInsideWorkspace(
	workspacePath: string,
	candidate: string,
): string {
	const root = resolve(workspacePath);
	const absolute = isAbsolute(candidate)
		? resolve(candidate)
		: resolve(root, candidate);
	const fromRoot = relative(root, absolute);
	if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new CodingAgentError(
			'PATH_ESCAPES_WORKSPACE',
			`Path escapes the session workspace: ${candidate}`,
		);
	}
	return absolute;
}

export function workspaceRelative(
	workspacePath: string,
	candidate: string,
): string {
	const root = resolve(workspacePath);
	const absolute = isAbsolute(candidate)
		? resolve(candidate)
		: resolve(root, candidate);
	const fromRoot = relative(root, absolute);
	return fromRoot === '' ? '.' : fromRoot;
}

const PROTECTED_WRITE_SEGMENTS = new Set([
	'node_modules',
	'.git',
	'dist',
	'.turbo',
]);

function normalPath(value: string): string {
	return value.split(sep).join('/');
}

function matchesPath(path: string, pattern: string): boolean {
	const source = pattern
		.split(/(\*\*|\*)/)
		.map((part) => {
			if (part === '**') return '.*';
			if (part === '*') return '[^/]*';
			return part.replace(/[.+?^$()|[\]\\]/g, '\\$&');
		})
		.join('');
	return new RegExp(`^${source}$`).test(path);
}

function assertUnprotected(path: string): void {
	if (
		path.split('/').some((segment) => PROTECTED_WRITE_SEGMENTS.has(segment))
	) {
		throw new CodingAgentError(
			'PATH_NOT_ALLOWED',
			`The coding agent cannot change protected workspace path: ${path}`,
		);
	}
}

function assertContained(root: string, candidate: string): void {
	const fromRoot = relative(root, candidate);
	if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new CodingAgentError(
			'PATH_ESCAPES_WORKSPACE',
			'The path resolves through a symbolic link outside the session workspace.',
		);
	}
}

/* Check every existing component rather than only the lexical path. Without
	this, `module/node_modules/pkg/file` can follow a workspace symlink and let a
	model read or overwrite the host package or pnpm store. */
async function assertPhysicalContainment(
	workspacePath: string,
	absolute: string,
): Promise<void> {
	const lexicalRoot = resolve(workspacePath);
	const physicalRoot = await realpath(lexicalRoot);
	const fromRoot = relative(lexicalRoot, absolute);
	let cursor = physicalRoot;
	for (const segment of fromRoot.split(sep).filter(Boolean)) {
		cursor = join(cursor, segment);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) cursor = await realpath(cursor);
			assertContained(physicalRoot, cursor);
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				(error as { code?: string }).code === 'ENOENT'
			) {
				return;
			}
			throw error;
		}
	}
}

export async function resolveReadableInsideWorkspace(
	workspacePath: string,
	candidate: string,
): Promise<string> {
	const absolute = resolveInsideWorkspace(workspacePath, candidate);
	const path = normalPath(workspaceRelative(workspacePath, absolute));
	assertUnprotected(path);
	await assertPhysicalContainment(workspacePath, absolute);
	return absolute;
}

export async function resolveWritableInsideWorkspace(
	workspacePath: string,
	candidate: string,
	allowedPaths: readonly string[],
): Promise<string> {
	const absolute = resolveInsideWorkspace(workspacePath, candidate);
	const path = normalPath(workspaceRelative(workspacePath, absolute));
	assertUnprotected(path);
	if (!allowedPaths.some((pattern) => matchesPath(path, pattern))) {
		throw new CodingAgentError(
			'PATH_NOT_ALLOWED',
			`The coding agent cannot change a path outside its role allowlist: ${path}`,
		);
	}
	await assertPhysicalContainment(workspacePath, absolute);
	return absolute;
}

export interface ProcessLineStream {
	readonly lines: AsyncIterable<string>;
	readonly finished: Promise<{
		readonly code: number | null;
		readonly stderr: string;
		readonly aborted: boolean;
		readonly timedOut: boolean;
	}>;
}

export interface SpawnJsonOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal | undefined;
	readonly timeoutMs?: number | undefined;
	readonly stderrLimit?: number;
}

/* Drivers stream newline-delimited JSON from a child process. The process is
   killed on abort or timeout, and stderr is captured with a hard cap so a
   failing binary cannot exhaust memory. */
export function spawnLineStream(options: SpawnJsonOptions): ProcessLineStream {
	const child = spawn(options.command, [...options.args], {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const stderrLimit = options.stderrLimit ?? 8_192;
	let stderr = '';
	let aborted = false;
	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		if (stderr.length < stderrLimit) {
			stderr = (stderr + chunk).slice(0, stderrLimit);
		}
	});

	const stop = () => {
		if (aborted) return;
		aborted = true;
		child.kill('SIGTERM');
		killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
		killTimer.unref();
	};
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					if (aborted) return;
					timedOut = true;
					stop();
				}, options.timeoutMs);
	timer?.unref();
	if (options.signal) {
		if (options.signal.aborted) stop();
		else options.signal.addEventListener('abort', stop, { once: true });
	}

	const cleanup = () => {
		if (timer) clearTimeout(timer);
		if (killTimer) clearTimeout(killTimer);
		options.signal?.removeEventListener('abort', stop);
	};

	const finished = new Promise<{
		code: number | null;
		stderr: string;
		aborted: boolean;
		timedOut: boolean;
	}>((resolvePromise, rejectPromise) => {
		child.on('error', (error) => {
			cleanup();
			rejectPromise(
				new CodingAgentError(
					'DRIVER_PROCESS_FAILED',
					`Could not start ${options.command}: ${error.message}`,
				),
			);
		});
		child.on('close', (code) => {
			cleanup();
			resolvePromise({ code, stderr, aborted, timedOut });
		});
	});

	/* A spawn failure rejects before the caller has drained the lines and
	   awaited this promise; without a handler of its own that rejection is
	   unhandled and takes the process down. */
	finished.catch(() => undefined);
	return {
		lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
		finished,
	};
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const value = JSON.parse(trimmed) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export async function probeCommand(
	command: string,
	args: readonly string[] = ['--version'],
): Promise<{ available: boolean; detail: string; version: string | null }> {
	try {
		const stream = spawnLineStream({
			command,
			args,
			cwd: process.cwd(),
			timeoutMs: 10_000,
		});
		let first = '';
		for await (const line of stream.lines) {
			if (!first) first = line.trim();
		}
		const result = await stream.finished;
		if (result.code !== 0) {
			return {
				available: false,
				detail:
					result.stderr.trim().slice(0, 200) ||
					`${command} exited with code ${result.code}.`,
				version: null,
			};
		}
		return {
			available: true,
			detail: `${command} is installed.`,
			version: first || null,
		};
	} catch (error) {
		return {
			available: false,
			detail:
				error instanceof CodingAgentError
					? error.message
					: `${command} is not installed.`,
			version: null,
		};
	}
}
