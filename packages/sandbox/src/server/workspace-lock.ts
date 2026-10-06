import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { onExit } from 'signal-exit';
import { sandboxDirectory } from './config.ts';
import {
	acquireDiskLock,
	releaseDiskLock,
	releaseDiskLockSync,
	type LockHolder,
} from './disk-lock.ts';
import { SandboxSetupError } from './workspace-root.ts';

const LOCK_NAME = 'workspace.lock';

export class SandboxAlreadyRunningError extends SandboxSetupError {
	readonly pid: number | null;

	constructor(path: string, holder: LockHolder | null) {
		super(
			'SANDBOX_ALREADY_RUNNING',
			holder
				? `The sandbox is already running for this workspace (PID ${holder.pid}). Use that one, or stop it before starting another.`
				: `The sandbox workspace lock at ${path} names no process. If no sandbox is running for this workspace, remove it and start again.`,
		);
		this.name = 'SandboxAlreadyRunningError';
		this.pid = holder?.pid ?? null;
	}
}

export interface WorkspaceLock {
	release(): Promise<void>;
}

/* One sandbox process per workspace. The launcher and the eval runner both
   write config.json, session records and transcripts, and the queues that
   order those writes (local-file.ts, session-lock.ts) exclude only within one
   process. The lock is released by release(), or as the process ends: on
   exit, and on a signal that ends it by the default action. signal-exit
   leaves a signal another listener handles to that listener, as other
   libraries in the process (Vite's bundler among them) expect, and lets the
   signal end the process otherwise. A process killed outright (SIGKILL)
   leaves a lock whose holder is gone, and the next start takes it over. */
export async function acquireWorkspaceLock(
	workspaceRoot: string,
): Promise<WorkspaceLock> {
	const directory = sandboxDirectory(workspaceRoot);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, LOCK_NAME);
	const id = await acquireDiskLock(path, (holder) => {
		throw new SandboxAlreadyRunningError(path, holder);
	});
	const removeExitHandler = onExit(() => releaseDiskLockSync(path, id));
	let released: Promise<void> | null = null;
	return {
		/* The exit handler stays until the lock is gone, so a release that
		   fails is retried once more as the process ends. */
		release: () =>
			(released ??= releaseDiskLock(path, id).then(() => {
				removeExitHandler();
			})),
	};
}
