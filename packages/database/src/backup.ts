import { createHash } from 'node:crypto';
import { DatabaseError } from './contracts.ts';
import type { ConfiguredDatabaseAdapter } from './provider.ts';

export const BACKUP_MANIFEST_FILE = 'backup.json';
export const BACKUP_MANIFEST_VERSION = 1;

/**
 * The encryption keys that protect data stored inside the database. A dump
 * alone restores unreadable credentials and workflow payloads, so every backup
 * records which keys it was taken under. Only a SHA-256 fingerprint of the key
 * material is recorded; the material itself never enters a backup.
 */
export const BACKUP_KEY_VARIABLES = Object.freeze([
	'FD_AGENT_CREDENTIAL_KEY',
	'FD_AGENT_RUN_GRANT_KEY',
	'FD_WORKFLOWS_PAYLOAD_KEY',
	'FD_WORKFLOWS_CURSOR_KEY',
	'FD_AUTH_MFA_KEY',
	'FD_AUTOMATIONS_CREDENTIAL_KEY',
	'FD_NOTIFICATIONS_SECRET_KEY',
	'FD_STORAGE_ENCRYPTION_KEY',
	'FD_CONNECTORS_SECRET_KEY',
	'FD_AUDIT_ANCHOR_KEY',
] as const);

export interface BackupKeyFingerprint {
	readonly variable: string;
	/** `sha256:<hex>` of the key material, or null when the key was not set. */
	readonly fingerprint: string | null;
}

export interface BackupManifest {
	readonly schemaVersion: number;
	readonly createdAt: string;
	readonly adapter: ConfiguredDatabaseAdapter;
	readonly platformVersion: string;
	readonly modules: readonly string[];
	readonly keys: readonly BackupKeyFingerprint[];
}

export type BackupKeyStatus =
	| 'match'
	| 'different'
	| 'missing-in-environment'
	| 'missing-in-backup';

export interface BackupKeyComparison {
	readonly variable: string;
	readonly status: BackupKeyStatus;
}

/* One 32 byte key is written as hex, base64 or base64url depending on the
   module that reads it, so the fingerprint covers the decoded bytes and not the
   spelling. A value that decodes to anything else is fingerprinted verbatim. */
function keyMaterial(value: string): Buffer {
	if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
	const decoded = Buffer.from(value, 'base64');
	return decoded.byteLength === 32 ? decoded : Buffer.from(value, 'utf8');
}

export function backupKeyFingerprint(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const material = keyMaterial(trimmed);
	const digest = createHash('sha256').update(material).digest('hex');
	material.fill(0);
	return `sha256:${digest}`;
}

export function backupKeyFingerprints(
	environment: NodeJS.ProcessEnv,
): readonly BackupKeyFingerprint[] {
	return BACKUP_KEY_VARIABLES.map((variable) => ({
		variable,
		fingerprint: backupKeyFingerprint(environment[variable]),
	}));
}

/**
 * Every key the backup or this platform knows about, so a restore can warn
 * before the data it is about to write becomes unreadable.
 */
export function compareBackupKeys(
	manifest: BackupManifest,
	environment: NodeJS.ProcessEnv,
): readonly BackupKeyComparison[] {
	const recorded = new Map(
		manifest.keys.map((key) => [key.variable, key.fingerprint]),
	);
	const variables = [
		...new Set([...recorded.keys(), ...BACKUP_KEY_VARIABLES]),
	].sort((left, right) => left.localeCompare(right));
	return variables.map((variable) => {
		const backup = recorded.get(variable) ?? null;
		const current = backupKeyFingerprint(environment[variable]);
		if (backup === current) return { variable, status: 'match' as const };
		if (!current)
			return { variable, status: 'missing-in-environment' as const };
		if (!backup) return { variable, status: 'missing-in-backup' as const };
		return { variable, status: 'different' as const };
	});
}

export function createBackupManifest(input: {
	readonly adapter: ConfiguredDatabaseAdapter;
	readonly platformVersion: string;
	readonly modules: readonly string[];
	readonly environment: NodeJS.ProcessEnv;
	readonly createdAt?: Date;
}): BackupManifest {
	return {
		schemaVersion: BACKUP_MANIFEST_VERSION,
		createdAt: (input.createdAt ?? new Date()).toISOString(),
		adapter: input.adapter,
		platformVersion: input.platformVersion,
		modules: [...input.modules],
		keys: backupKeyFingerprints(input.environment),
	};
}

function invalid(reason: string): never {
	throw new DatabaseError(
		'INVALID_ARGUMENT',
		`The backup manifest is invalid: ${reason}`,
	);
}

function boundedString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
		invalid(`${field} must be a string of 1 to 256 characters.`);
	}
	return value;
}

/** Parses a manifest read from disk. Bounded so a hostile file cannot grow the process. */
export function parseBackupManifest(value: unknown): BackupManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		invalid('it is not an object.');
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== BACKUP_MANIFEST_VERSION) {
		invalid(`schemaVersion must be ${BACKUP_MANIFEST_VERSION}.`);
	}
	const adapter = record.adapter;
	if (adapter !== 'pglite' && adapter !== 'postgresql') {
		invalid('adapter must be "pglite" or "postgresql".');
	}
	if (!Array.isArray(record.modules) || record.modules.length > 512) {
		invalid('modules must be a list of at most 512 module ids.');
	}
	if (!Array.isArray(record.keys) || record.keys.length > 64) {
		invalid('keys must be a list of at most 64 fingerprints.');
	}
	return {
		schemaVersion: BACKUP_MANIFEST_VERSION,
		createdAt: boundedString(record.createdAt, 'createdAt'),
		adapter,
		platformVersion: boundedString(record.platformVersion, 'platformVersion'),
		modules: record.modules.map((entry) => boundedString(entry, 'modules[]')),
		keys: record.keys.map((entry) => {
			if (typeof entry !== 'object' || entry === null) {
				invalid('keys[] must be an object.');
			}
			const key = entry as Record<string, unknown>;
			const fingerprint = key.fingerprint;
			if (fingerprint !== null && typeof fingerprint !== 'string') {
				invalid('keys[].fingerprint must be a string or null.');
			}
			return {
				variable: boundedString(key.variable, 'keys[].variable'),
				fingerprint:
					fingerprint === null
						? null
						: boundedString(fingerprint, 'keys[].fingerprint'),
			};
		}),
	};
}
