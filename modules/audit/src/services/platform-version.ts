import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The version the export manifest records. It is read from the workspace
 * configuration rather than a package, so the archive names the deployment an
 * operator can identify, and an unreadable file is not worth failing an export
 * for: `unknown` is a truthful answer.
 */
export async function readPlatformVersion(
	workspaceRoot: string,
): Promise<string> {
	try {
		const config = JSON.parse(
			await readFile(resolve(workspaceRoot, 'flowdular.json'), 'utf8'),
		) as { architectureVersion?: unknown };
		return typeof config.architectureVersion === 'string'
			? config.architectureVersion
			: 'unknown';
	} catch {
		return 'unknown';
	}
}
