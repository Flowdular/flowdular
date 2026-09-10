import { flowdularStateDirectory } from '@flowdular/kernel/runtime-config';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSetupToken } from './access.ts';

export const SETUP_TOKEN_FILE = 'setup-token';

export interface IssuedSetupToken {
	readonly token: string;
	/** Where the token was written, or null when the filesystem refused it. */
	readonly file: string | null;
	readonly banner: string;
}

export interface IssueSetupTokenOptions {
	readonly workspaceRoot: string;
	readonly origin: string;
	readonly token?: string;
}

function banner(token: string, origin: string, file: string | null): string {
	const lines = [
		'',
		'  Flowdular is not configured yet and started its first-run setup.',
		'',
		`  Open   ${origin}/setup`,
		`  Token  ${token}`,
		'',
		file
			? `  The same token is in ${file} (readable only by this user).`
			: '  This filesystem is read only, so the token exists only in this output.',
		'  It is required for every setup request and is not shown again after',
		'  setup completes. Restarting the process issues a new one.',
		'',
	];
	return lines.join('\n');
}

/**
 * Mints the token that binds every first-run request, prints it, and stores it
 * with owner-only permissions. A filesystem that refuses the write is not an
 * error: the token is still on stdout, which is where a container operator
 * reads it anyway.
 */
export function issueSetupToken(
	options: IssueSetupTokenOptions,
): IssuedSetupToken {
	const token = options.token ?? generateSetupToken();
	const directory = flowdularStateDirectory(options.workspaceRoot);
	const path = resolve(directory, SETUP_TOKEN_FILE);
	let file: string | null = null;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
		/* An existing file keeps its old mode through an overwrite, so the mode
		   is asserted rather than only requested. */
		chmodSync(path, 0o600);
		file = path;
	} catch {
		/* Read-only root filesystems are a deliberate deployment choice; the
		   reason is not reported because it cannot change the outcome. */
		file = null;
	}
	return { token, file, banner: banner(token, options.origin, file) };
}

/**
 * Removes the token a previous first run left behind. A configured deployment
 * has no setup routes, so the file is a stale secret with nothing to unlock.
 */
export function clearSetupToken(workspaceRoot: string): void {
	try {
		rmSync(resolve(flowdularStateDirectory(workspaceRoot), SETUP_TOKEN_FILE), {
			force: true,
		});
	} catch {
		/* A read-only state directory cannot hold a stale token either. */
	}
}
