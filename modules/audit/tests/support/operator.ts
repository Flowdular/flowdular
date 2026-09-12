import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_EXPORT_DIRECTORY_VARIABLE } from '../../src/services/export-directory.ts';

export interface OperatorDirectory {
	/** The directory the deployment allows, and the one a command may write to. */
	readonly allowed: string;
	/** A workspace tree the allowed directory is deliberately outside of. */
	readonly workspaceRoot: string;
	readonly environment: NodeJS.ProcessEnv;
	cleanup(): Promise<void>;
}

/**
 * The two directories every operator command needs: the one the deployment
 * allows and a workspace tree it is outside of, because an archive or a segment
 * written inside the application tree could be committed or served by accident.
 */
export async function openOperatorDirectory(): Promise<OperatorDirectory> {
	const allowed = await mkdtemp(join(tmpdir(), 'audit-operator-'));
	const workspaceRoot = await mkdtemp(join(tmpdir(), 'audit-workspace-'));
	return {
		allowed,
		workspaceRoot,
		environment: {
			NODE_ENV: 'test',
			[AUDIT_EXPORT_DIRECTORY_VARIABLE]: allowed,
		},
		async cleanup() {
			await rm(allowed, { recursive: true, force: true });
			await rm(workspaceRoot, { recursive: true, force: true });
		},
	};
}
