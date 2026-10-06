import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive } from './disk-lock.ts';

export interface LocalFileTestHooks {
	/* The new bytes are flushed to the temporary file and not yet renamed or
	   linked to the target. Throwing here stands in for the process dying at
	   that point; an error with an errno code stands in for the rename or the
	   link failing with it. */
	readonly beforeRename?: (target: string) => Promise<void>;
	/* A withLocalFileLock caller is waiting for an earlier one on the target. */
	readonly queued?: (target: string) => void;
}

let testHooks: LocalFileTestHooks | null = null;

/* Exposed for the tests that stop a write where a crash or a second writer
   would land. Null outside tests, so a write pays one check. */
export function setLocalFileTestHooks(hooks: LocalFileTestHooks | null): void {
	testHooks = hooks;
}

const LOCKS = Symbol.for('flowdular.sandbox.local-file-locks');
type Locks = Map<string, Promise<void>>;

/* The launcher imports the sandbox server natively and the runtime loads it
   again through Vite in the same process, so the queue lives on globalThis:
   two module copies with their own queues would not exclude each other. */
function locks(): Locks {
	const state = globalThis as unknown as Record<symbol, Locks | undefined>;
	return (state[LOCKS] ??= new Map());
}

/* Runs work after every earlier work on the same file in this process has
   settled, so a read-modify-write cannot interleave with another. Failed work
   releases the next caller and an idle file keeps no entry. */
export async function withLocalFileLock<T>(
	path: string,
	work: () => Promise<T>,
): Promise<T> {
	const key = resolve(path);
	const pending = locks();
	const previous = pending.get(key);
	let release!: () => void;
	const current = new Promise<void>((done) => {
		release = done;
	});
	pending.set(key, current);
	if (previous) {
		testHooks?.queued?.(key);
		await previous;
	}
	try {
		return await work();
	} finally {
		release();
		if (pending.get(key) === current) pending.delete(key);
	}
}

/* Replaces path so a reader, and the next start after a crash, finds either
   the old bytes or the new ones, never a torn file. The sibling temporary file
   is created exclusively, owner-only and without following a link, and the
   rename replaces a symbolic link at path rather than writing through it.
   Callers that must refuse such a link check before calling. A crash between
   the flush and the rename leaves the temporary file behind, for
   removeStaleTemporaryFiles. The file is always new, so its creation mode is
   its mode: the preview worker's permission model refuses fchmod. */
export async function replaceLocalFile(
	path: string,
	value: string,
): Promise<void> {
	await moveIntoPlace(await writeTemporaryFile(path, value), path);
}

/* What link reports where the filesystem makes no hard links: ENOTSUP on FAT
   and exFAT under macOS, EPERM on Linux. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'ENOSYS']);

/* Creates path with value unless it already exists, and says which happened.
   The file appears complete or not at all, and when two processes publish at
   once exactly one link lands, so both can read back the same value. Without
   hard links the file is renamed into place instead: still whole, but a
   second process publishing at the same moment can replace it. */
export async function publishLocalFile(
	path: string,
	value: string,
): Promise<boolean> {
	const temporary = await writeTemporaryFile(path, value);
	try {
		await testHooks?.beforeRename?.(path);
		await link(temporary, path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? '';
		if (NO_HARD_LINKS.has(code)) {
			await moveIntoPlace(temporary, path);
			return true;
		}
		await rm(temporary, { force: true }).catch(() => undefined);
		if (code === 'EEXIST') return false;
		throw error;
	}
	await rm(temporary, { force: true }).catch(() => undefined);
	await syncDirectory(dirname(path));
	return true;
}

async function moveIntoPlace(temporary: string, path: string): Promise<void> {
	try {
		await renameOver(temporary, path);
	} catch (error) {
		/* The write's own failure is what the caller needs; a leftover that
		   cannot be removed is owner-only and never read. */
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	await syncDirectory(dirname(path));
}

async function writeTemporaryFile(
	path: string,
	value: string,
): Promise<string> {
	const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}`;
	const handle = await open(
		temporary,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		try {
			await handle.writeFile(value, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return temporary;
}

/* Windows refuses to replace a file that another process holds open, and
   antivirus scanners and indexers open new files for a moment. Those
   refusals pass, so there, and only there, the rename is retried for about
   two seconds. Elsewhere the same codes mean a real permission problem. */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 800];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameOver(temporary: string, path: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await testHooks?.beforeRename?.(path);
			await rename(temporary, path);
			return;
		} catch (error) {
			const wait = RENAME_RETRY_DELAYS_MS[attempt];
			if (
				process.platform !== 'win32' ||
				wait === undefined ||
				!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
			)
				throw error;
			await delay(wait);
		}
	}
}

const TEMPORARY_FILE = /^.+\.(\d+)\.[0-9a-f]{8}$/;

/* Removes the temporary files a writer here left in directory when its
   process died before moving them into place. Only that name pattern, only
   regular files, and only when the PID in the name is not running: a live
   process with that PID may be the writer, whatever it is now. Best effort,
   so a failure here never stops the caller. */
export async function removeStaleTemporaryFiles(
	directory: string,
): Promise<void> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number(TEMPORARY_FILE.exec(name)?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) continue;
		const path = join(directory, name);
		const info = await lstat(path).catch(() => null);
		if (info?.isFile()) await rm(path, { force: true }).catch(() => undefined);
	}
}

/* Makes the rename itself survive a power loss where the platform allows it.
   Windows cannot open a directory, and a filesystem or a permission model may
   refuse to open or flush one. The rename has landed by then, so a refusal
   costs only that guarantee; failing the call would report as lost a write
   every reader already sees. */
async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === 'win32') return;
	try {
		const handle = await open(directory, constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		return;
	}
}
