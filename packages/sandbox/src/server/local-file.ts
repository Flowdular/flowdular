import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface LocalFileTestHooks {
	/* The new bytes are flushed to the temporary file and not yet renamed over
	   the target. Throwing here stands in for the process dying at that point. */
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
   the flush and the rename leaves the temporary file behind. The file is
   always new, so its creation mode is its mode: the preview worker's
   permission model refuses fchmod. */
export async function replaceLocalFile(
	path: string,
	value: string,
): Promise<void> {
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
		await testHooks?.beforeRename?.(path);
		await rename(temporary, path);
	} catch (error) {
		/* The write's own failure is what the caller needs; a leftover that
		   cannot be removed is owner-only and never read. */
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	await syncDirectory(dirname(path));
}

/* Makes the rename itself survive a power loss. Windows cannot open a
   directory for this, and some filesystems refuse to flush one; the rename has
   already landed in both cases. */
async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === 'win32') return;
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
	} finally {
		await handle.close();
	}
}
