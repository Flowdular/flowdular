import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readSetupEnvironment(root: string): Promise<string> {
	try {
		return await readFile(join(root, '.env'), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	}
}

export async function saveSetupEnvironment(
	root: string,
	before: string,
	updates: Readonly<Record<string, string>>,
): Promise<void> {
	const path = join(root, '.env');
	try {
		if (!(await lstat(path)).isFile())
			throw new Error('Setup requires .env to be a regular file.');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	for (const [key, value] of Object.entries(updates)) {
		if (!/^FD_DATABASE_[A-Z_]+$/.test(key) || /[\r\n'\0]/.test(value))
			throw new Error('Invalid database setting.');
	}
	const lines = before.split(/\r?\n/).filter((line) => {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
			line,
		);
		if (!match || !(match[1]! in updates)) return true;
		const value = match[2]!.trim();
		if (
			(value.startsWith('"') && !value.endsWith('"')) ||
			(value.startsWith("'") && !value.endsWith("'"))
		)
			throw new Error(
				'Edit multiline database settings in .env before using setup.',
			);
		return false;
	});
	const source =
		lines.join('\n').trimEnd() +
		'\n' +
		Object.entries(updates)
			.map(([key, value]) => `${key}='${value}'`)
			.join('\n') +
		'\n';
	const temporary = join(root, `.env.setup-${randomUUID()}.tmp`);
	const lockPath = join(root, '.env.setup.lock');
	const lock = await open(lockPath, 'wx', 0o600);
	try {
		await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
		if ((await readSetupEnvironment(root)) !== before)
			throw new Error('The .env file changed during setup. Run setup again.');
		await rename(temporary, path);
	} finally {
		try {
			await rm(temporary, { force: true });
		} finally {
			await lock.close();
			await rm(lockPath, { force: true });
		}
	}
}
