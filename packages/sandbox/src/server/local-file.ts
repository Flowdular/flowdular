import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LocalFileTestHooks {
	/* The new bytes are flushed to the temporary file and not yet renamed over
	   the target. Throwing here stands in for the process dying at that point. */
	readonly beforeRename?: (target: string) => Promise<void>;
}

let testHooks: LocalFileTestHooks | null = null;

/* Exposed for the tests that stop a write where a crash would land. Null
   outside tests, so a write pays one check. */
export function setLocalFileTestHooks(hooks: LocalFileTestHooks | null): void {
	testHooks = hooks;
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
