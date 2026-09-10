import { spawnSync } from 'node:child_process';

export interface GitResult {
	readonly ok: boolean;
	readonly reason?: string;
}

function git(directory: string, ...arguments_: string[]): GitResult {
	const result = spawnSync('git', arguments_, {
		cwd: directory,
		stdio: 'ignore',
	});
	if (result.error) return { ok: false, reason: 'git is not available' };
	if (result.status !== 0) {
		return { ok: false, reason: `git ${arguments_[0]} failed` };
	}
	return { ok: true };
}

/** Initializes a repository with one commit. A failure is reported, never fatal. */
export function initializeRepository(directory: string): GitResult {
	const initialized = git(directory, 'init', '-b', 'main');
	if (!initialized.ok) return initialized;
	const staged = git(directory, 'add', '-A');
	if (!staged.ok) return staged;
	const committed = git(
		directory,
		'commit',
		'-m',
		'chore: scaffold Flowdular app',
	);
	if (!committed.ok) {
		return {
			ok: false,
			reason:
				'the repository was created but the first commit failed, most likely because git has no user.name and user.email',
		};
	}
	return { ok: true };
}
