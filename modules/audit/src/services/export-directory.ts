import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { AuditServiceError } from './service-error.ts';

/**
 * Where a deployment allows an export archive to be written. The archive
 * carries every row of one workspace, so the deployment names the directory
 * and the operator may only pick a place inside it; a command cannot write a
 * workspace's data wherever the process happens to have permission.
 */
export const AUDIT_EXPORT_DIRECTORY_VARIABLE = 'FD_AUDIT_EXPORT_DIRECTORY';

/** Longest path a request may carry, so one stored row stays bounded. */
export const EXPORT_PATH_LIMIT = 512;

export interface ExportDirectoryRequest {
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	/** What the operator asked for; absolute. */
	readonly requested: string;
}

/**
 * Answers the absolute directory the archive may be written to, or throws with
 * a stable reason. Both the operator command and the platform run it: the
 * command so the operator learns immediately, the platform because the stored
 * request is data, and data is never trusted.
 */
export function exportOutputDirectory(request: ExportDirectoryRequest): string {
	const configured =
		request.environment[AUDIT_EXPORT_DIRECTORY_VARIABLE]?.trim();
	if (!configured) {
		throw new AuditServiceError(
			'EXPORT_DIRECTORY_NOT_CONFIGURED',
			`${AUDIT_EXPORT_DIRECTORY_VARIABLE} is not set, so this deployment allows no export directory.`,
			412,
		);
	}
	if (
		typeof request.requested !== 'string' ||
		request.requested.length === 0 ||
		request.requested.length > EXPORT_PATH_LIMIT ||
		!isAbsolute(request.requested)
	) {
		throw new AuditServiceError(
			'EXPORT_OUTPUT_REQUIRED',
			`The export needs an absolute output directory of at most ${EXPORT_PATH_LIMIT} characters.`,
		);
	}
	/* Containment is decided on the real paths. A symbolic link inside the
	   allowed directory resolves textually to a path under it and physically to
	   wherever it points, so comparing the requested text would let one carry a
	   workspace's archive anywhere the process can write. */
	const root = real(
		resolve(
			isAbsolute(configured)
				? configured
				: resolve(request.workspaceRoot, configured),
		),
	);
	const directory = real(resolve(request.requested));
	if (!contains(root, directory)) {
		throw new AuditServiceError(
			'EXPORT_OUTPUT_NOT_ALLOWED',
			`${directory} is outside ${root}, the only directory ${AUDIT_EXPORT_DIRECTORY_VARIABLE} allows.`,
		);
	}
	/* Inside the workspace tree a deployment step could commit, serve or
	   package the archive by accident, so the allowed directory is refused
	   there too rather than only the requested one. */
	if (contains(real(resolve(request.workspaceRoot)), directory)) {
		throw new AuditServiceError(
			'EXPORT_OUTPUT_INSIDE_WORKSPACE',
			`${directory} is inside the workspace tree; write the export outside it.`,
		);
	}
	return directory;
}

/**
 * The absolute path with every link on it resolved. The requested directory
 * need not exist yet, so the deepest ancestor that does is resolved and the
 * names below it are appended: a link anywhere on the existing part is what a
 * containment check has to see. The walk ends at the filesystem root.
 */
function real(candidate: string): string {
	let head = candidate;
	const tail: string[] = [];
	for (;;) {
		try {
			const resolved = realpathSync(head);
			return tail.length === 0 ? resolved : resolve(resolved, ...tail);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			const parent = dirname(head);
			if (parent === head) return candidate;
			tail.unshift(basename(head));
			head = parent;
		}
	}
}

function contains(root: string, candidate: string): boolean {
	const inside = relative(root, candidate);
	return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
}
