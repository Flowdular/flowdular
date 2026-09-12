import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
	BACKUP_MANIFEST_FILE,
	parseBackupManifest,
	type BackupKeyFingerprint,
} from '@flowdular/database';
import { AUDIT_REASONS } from '../domain/types.ts';

/**
 * How a deployment records that a backup exists. It points at the directory or
 * at the `backup.json` that `flowdular database backup --apply` wrote. The
 * sweep and the export read it and refuse while it names nothing, so a policy
 * defect can never destroy data no backup holds.
 */
export const AUDIT_BACKUP_MANIFEST_VARIABLE = 'FD_AUDIT_BACKUP_MANIFEST';

/* A manifest is a few hundred bytes; anything this size is not one, and the
   read is bounded before the file reaches memory. */
const MANIFEST_SIZE_LIMIT = 1_048_576;

export interface BackupEvidence {
	readonly manifestPath: string;
	readonly createdAt: string;
	readonly adapter: string;
	readonly platformVersion: string;
	/** The key fingerprints the backup was taken under; never key material. */
	readonly keys: readonly BackupKeyFingerprint[];
}

export type BackupGuardResult =
	| { readonly ok: true; readonly evidence: BackupEvidence }
	| { readonly ok: false; readonly reason: string; readonly detail: string };

export type BackupGuard = () => Promise<BackupGuardResult>;

function missing(detail: string): BackupGuardResult {
	return {
		ok: false,
		reason: AUDIT_REASONS.backupManifestMissing,
		detail,
	};
}

function manifestPath(value: string, workspaceRoot: string): string {
	const base = isAbsolute(value) ? value : resolve(workspaceRoot, value);
	return base.endsWith('.json') ? base : resolve(base, BACKUP_MANIFEST_FILE);
}

/**
 * Reads the recorded manifest on every call. It is asked once per sweep pass
 * and once per export, so a backup taken while the platform runs is picked up
 * without a restart and a backup directory that disappeared stops the sweep at
 * the next interval.
 */
export function createBackupGuard(
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
): BackupGuard {
	return async () => {
		const configured = environment[AUDIT_BACKUP_MANIFEST_VARIABLE]?.trim();
		if (!configured) {
			return missing(
				`${AUDIT_BACKUP_MANIFEST_VARIABLE} is not set, so this deployment records no backup.`,
			);
		}
		const path = manifestPath(configured, workspaceRoot);
		try {
			const stats = await stat(path);
			if (!stats.isFile()) return missing(`${path} is not a backup manifest.`);
			if (stats.size > MANIFEST_SIZE_LIMIT) {
				return missing(`${path} is too large to be a backup manifest.`);
			}
			const manifest = parseBackupManifest(
				JSON.parse(await readFile(path, 'utf8')),
			);
			return {
				ok: true,
				evidence: {
					manifestPath: path,
					createdAt: manifest.createdAt,
					adapter: manifest.adapter,
					platformVersion: manifest.platformVersion,
					keys: manifest.keys,
				},
			};
		} catch (error) {
			return missing(
				`${path} could not be read as a backup manifest: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	};
}
