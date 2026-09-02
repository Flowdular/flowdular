import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	checkpointModulePath,
	copyModuleTree,
	modulePathOf,
	readSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
	type SessionCheckpoint,
	type SessionModule,
	type SessionPaths,
} from './sessions.ts';

/* The workspace keeps at most this many restore points. The oldest is pruned
   when a new one pushes past the cap, except the start checkpoint, which is the
   only way back to the pristine module and is never dropped. */
export const MAX_CHECKPOINTS = 24;
const START_SEQUENCE = 0;

async function writeCheckpointTree(
	paths: SessionPaths,
	modules: readonly SessionModule[],
	sequence: number,
): Promise<void> {
	await rm(join(paths.checkpoints, String(sequence)), {
		recursive: true,
		force: true,
	});
	for (const module of modules) {
		await copyModuleTree(
			modulePathOf(paths, module.directory),
			checkpointModulePath(paths, sequence, module.directory),
		);
	}
}

/* Keeps the newest MAX_CHECKPOINTS while always keeping the start, and names the
   sequences whose snapshot directories must be removed to honour the cap. */
function boundCheckpoints(checkpoints: readonly SessionCheckpoint[]): {
	readonly kept: readonly SessionCheckpoint[];
	readonly dropped: readonly number[];
} {
	if (checkpoints.length <= MAX_CHECKPOINTS) {
		return { kept: checkpoints, dropped: [] };
	}
	const dropped = checkpoints
		.filter((entry) => entry.sequence !== START_SEQUENCE)
		.sort((left, right) => left.sequence - right.sequence)
		.slice(0, checkpoints.length - MAX_CHECKPOINTS)
		.map((entry) => entry.sequence);
	const droppedSet = new Set(dropped);
	return {
		kept: checkpoints.filter((entry) => !droppedSet.has(entry.sequence)),
		dropped,
	};
}

/* Snapshots every draft module tree after a turn changed files. The snapshot
   excludes node_modules; the metadata is recorded on session.json keyed by the
   chat entry sequence, so the restore point and its transcript line share one
   identity. Re-capturing a sequence replaces the earlier snapshot. */
export async function captureCheckpoint(
	workspaceRoot: string,
	session: SandboxSession,
	sequence: number,
	meta: { readonly label: string; readonly role: string },
): Promise<SandboxSession> {
	const current = await readSession(workspaceRoot, session.id);
	const paths = sessionPaths(workspaceRoot, current.id, current.moduleSuffix);
	await writeCheckpointTree(paths, current.modules, sequence);
	const checkpoint: SessionCheckpoint = {
		sequence,
		at: Date.now(),
		label: meta.label,
		role: meta.role,
	};
	const { kept, dropped } = boundCheckpoints([
		...current.checkpoints.filter((entry) => entry.sequence !== sequence),
		checkpoint,
	]);
	for (const sequenceToDrop of dropped) {
		await rm(join(paths.checkpoints, String(sequenceToDrop)), {
			recursive: true,
			force: true,
		});
	}
	return updateSession(workspaceRoot, current.id, { checkpoints: kept });
}
