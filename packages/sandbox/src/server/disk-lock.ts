import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* Who holds a lock. start identifies the holder's process beyond its PID,
   which the operating system reuses; it is absent where this platform cannot
   tell. */
export interface LockHolder {
	readonly pid: number;
	readonly id: string;
	readonly start?: string;
}

/* Called when the lock is held by a live process, or cannot be taken over.
   holder is null when the lock names no readable holder. */
export type LockBusy = (holder: LockHolder | null) => never;

function lockHolder(value: unknown): LockHolder | null {
	if (!value || typeof value !== 'object') return null;
	const record = value as { pid?: unknown; id?: unknown; start?: unknown };
	if (
		!Number.isSafeInteger(record.pid) ||
		(record.pid as number) <= 0 ||
		typeof record.id !== 'string' ||
		!/^[0-9a-f-]{36}$/.test(record.id)
	)
		return null;
	return {
		pid: record.pid as number,
		id: record.id,
		...(typeof record.start === 'string' && record.start.length <= 64
			? { start: record.start }
			: {}),
	};
}

async function readLockHolder(path: string): Promise<LockHolder | null> {
	try {
		return lockHolder(
			JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')),
		);
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

/* When the process with this PID started, as the kernel reports it, or null
   where that cannot be read. Two reads for one process always agree, so the
   value is compared, never interpreted. Linux reads its start tick from
   /proc; macOS asks ps, at one-second resolution. */
async function processStart(pid: number): Promise<string | null> {
	try {
		if (process.platform === 'linux') {
			const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
			/* The command name in parentheses may contain spaces and
			   parentheses; field 22, the start time, counts from after it. */
			return (
				stat
					.slice(stat.lastIndexOf(')') + 2)
					.split(' ')[19]
					?.trim() || null
			);
		}
		if (process.platform === 'darwin') {
			const { stdout } = await execFileAsync(
				'/bin/ps',
				['-o', 'lstart=', '-p', String(pid)],
				{ env: { LC_ALL: 'C' }, timeout: 5_000 },
			);
			return stdout.trim() || null;
		}
	} catch {
		return null;
	}
	return null;
}

let ownStart: Promise<string | null> | null = null;

/* A holder whose PID now belongs to a process that started at another time
   is gone: the PID was reused. Without a recorded or readable start time a
   live PID counts as the holder, so a lock is never taken from a process
   that may still own it. */
async function holderAlive(holder: LockHolder): Promise<boolean> {
	if (!processAlive(holder.pid)) return false;
	if (!holder.start) return true;
	const start = await processStart(holder.pid);
	return start === null || start === holder.start;
}

/* Windows reports a directory renamed onto an existing one as EPERM. */
async function occupiedLock(error: unknown, path: string): Promise<boolean> {
	const code = (error as NodeJS.ErrnoException).code ?? '';
	if (code === 'EEXIST' || code === 'ENOTEMPTY') return true;
	if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES'))
		return false;
	return stat(path).then(
		() => true,
		() => false,
	);
}

/* Every lock, including a recovery claim, starts as a complete temporary
   directory and becomes visible through one atomic rename. If a reclaimer
   dies, its claim is another dead lock and can be recovered by the same rule. */
export async function acquireDiskLock(
	path: string,
	busy: LockBusy,
	depth = 0,
): Promise<string> {
	if (depth > 64) return busy(null);
	const id = randomUUID();
	const start = await (ownStart ??= processStart(process.pid));
	const temporary = `${path}.${id}.tmp`;
	await mkdir(temporary, { mode: 0o700 });
	try {
		await writeFile(
			join(temporary, 'owner.json'),
			JSON.stringify({ pid: process.pid, id, ...(start ? { start } : {}) }) +
				'\n',
			{ flag: 'wx', mode: 0o600 },
		);
		try {
			await rename(temporary, path);
		} catch (error) {
			if (!(await occupiedLock(error, path))) throw error;
			await recoverDeadLock(path, depth + 1, busy);
			try {
				await rename(temporary, path);
			} catch (retryError) {
				if (await occupiedLock(retryError, path))
					return busy(await readLockHolder(path));
				throw retryError;
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return id;
}

/* False when the lock is no longer the one id acquired. */
export async function releaseDiskLock(
	path: string,
	id: string,
): Promise<boolean> {
	const current = await readLockHolder(path);
	if (current?.id !== id) return false;
	const retired = `${path}.${id}.retired`;
	await rename(path, retired);
	await rm(retired, { recursive: true, force: true });
	return true;
}

/* For a process 'exit' listener, where nothing asynchronous runs. A failure
   leaves a lock whose holder is gone, which the next acquirer recovers. */
export function releaseDiskLockSync(path: string, id: string): void {
	try {
		const current = lockHolder(
			JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')),
		);
		if (current?.id !== id) return;
		const retired = `${path}.${id}.retired`;
		renameSync(path, retired);
		rmSync(retired, { recursive: true, force: true });
	} catch {
		return;
	}
}

async function recoverDeadLock(
	path: string,
	depth: number,
	busy: LockBusy,
): Promise<void> {
	if (depth > 64) return busy(null);
	const owner = await readLockHolder(path);
	if (!owner || (await holderAlive(owner))) return busy(owner);
	const claim = join(path, 'recovery');
	const claimId = await acquireDiskLock(claim, busy, depth + 1);
	let retired: string | null = null;
	let moved = false;
	try {
		const current = await readLockHolder(path);
		if (!current || current.id !== owner.id || (await holderAlive(current)))
			return busy(current);
		retired = `${path}.${randomUUID()}.retired`;
		await rename(path, retired);
		moved = true;
	} finally {
		if (moved && retired) await rm(retired, { recursive: true, force: true });
		else await releaseDiskLock(claim, claimId);
	}
}
