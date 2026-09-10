import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/* Bundled next to the entrypoint, so the same resolution works from src under
   tsx and from dist in the published tarball. */
export function templatesRoot(): string {
	return resolve(import.meta.dirname, '..', 'template');
}

export function templateRoot(name: string): string {
	return join(templatesRoot(), name);
}

/* npm refuses to publish a .gitignore inside a package, so the template ships
   the file under a neutral name and the copy restores it. */
const RENAMED: Readonly<Record<string, string>> = { _gitignore: '.gitignore' };

export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TemplateError';
	}
}

function assertInside(root: string, candidate: string): void {
	const inside = relative(root, candidate);
	if (inside.length === 0 || inside === '..' || inside.startsWith('..' + sep)) {
		throw new TemplateError(
			`The template tried to write outside the target directory: ${candidate}`,
		);
	}
}

/** Copies the template tree into `destination`. Returns the file count. */
export async function copyTemplate(
	source: string,
	destination: string,
): Promise<number> {
	const root = resolve(destination);
	await mkdir(root, { recursive: true });
	let files = 0;
	const pending: { from: string; to: string }[] = [{ from: source, to: root }];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		const entries = await readdir(directory.from, { withFileTypes: true });
		for (const entry of entries) {
			const to = join(directory.to, RENAMED[entry.name] ?? entry.name);
			assertInside(root, to);
			const from = join(directory.from, entry.name);
			if (entry.isDirectory()) {
				await mkdir(to, { recursive: true });
				pending.push({ from, to });
				continue;
			}
			if (!entry.isFile()) {
				throw new TemplateError(
					`The template contains an entry that is neither a file nor a directory: ${from}`,
				);
			}
			await copyFile(from, to);
			files += 1;
		}
	}
	return files;
}
