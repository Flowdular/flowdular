import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
	createKeyring,
	parsePreviousKeys,
	type Keyring,
} from '@flowdular/kernel';
import {
	flowdularEnvironment,
	flowdularStateDirectory,
} from '@flowdular/kernel/runtime-config';

export type ConfiguredStorageAdapter = 'local' | 's3';

export interface StorageConfig {
	readonly adapter: ConfiguredStorageAdapter;
	readonly production: boolean;
	readonly maxObjectBytes: number;
	readonly local: { readonly directory: string };
	readonly s3: {
		readonly bucket: string;
		readonly region: string;
		readonly endpoint: string | undefined;
		readonly accessKeyId: string;
		readonly secretAccessKey: string;
		readonly forcePathStyle: boolean;
	};
}

export const DEFAULT_STORAGE_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
/* The port authenticates a whole object before handing out a byte of it, so the
   limit also bounds what one request holds in memory. */
const STORAGE_MAX_OBJECT_BYTES_CEILING = 256 * 1024 * 1024;
const STORAGE_KEY_VARIABLE = 'FD_STORAGE_ENCRYPTION_KEY';

function adapterOf(
	environment: NodeJS.ProcessEnv,
	production: boolean,
): ConfiguredStorageAdapter {
	const configured = environment.FD_STORAGE_ADAPTER?.trim();
	const adapter = configured || (production ? 's3' : 'local');
	if (adapter !== 'local' && adapter !== 's3') {
		throw new Error('FD_STORAGE_ADAPTER must be "local" or "s3".');
	}
	/* The local adapter writes to the container filesystem, which no replica
	   shares and no backup covers. Production refuses it exactly as it refuses
	   the embedded database. */
	if (production && adapter === 'local') {
		throw new Error(
			'FD_STORAGE_ADAPTER=local is refused in production; configure the S3-compatible adapter.',
		);
	}
	return adapter;
}

function booleanEnvironment(
	value: string | undefined,
	fallback: boolean,
	name: string,
): boolean {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed === '') return fallback;
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	throw new Error(`${name} must be true or false.`);
}

function required(
	environment: NodeJS.ProcessEnv,
	name: string,
	adapter: string,
): string {
	const value = environment[name]?.trim();
	if (!value)
		throw new Error(`${name} is required by FD_STORAGE_ADAPTER=${adapter}.`);
	return value;
}

export function storageConfigFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): StorageConfig {
	environment = flowdularEnvironment(environment);
	const production = environment.NODE_ENV === 'production';
	const adapter = adapterOf(environment, production);
	if (production && !environment[STORAGE_KEY_VARIABLE]?.trim()) {
		throw new Error(
			`${STORAGE_KEY_VARIABLE} is required in production. Provide a base64-encoded 32-byte key through deployment secrets.`,
		);
	}
	const configuredLimit = environment.FD_STORAGE_MAX_OBJECT_BYTES?.trim();
	const maxObjectBytes = configuredLimit
		? Number(configuredLimit)
		: DEFAULT_STORAGE_MAX_OBJECT_BYTES;
	if (
		!Number.isSafeInteger(maxObjectBytes) ||
		maxObjectBytes < 1024 ||
		maxObjectBytes > STORAGE_MAX_OBJECT_BYTES_CEILING
	) {
		throw new Error(
			`FD_STORAGE_MAX_OBJECT_BYTES must be an integer between 1024 and ${STORAGE_MAX_OBJECT_BYTES_CEILING}.`,
		);
	}
	return {
		adapter,
		production,
		maxObjectBytes,
		local: {
			directory:
				environment.FD_STORAGE_LOCAL_DIRECTORY?.trim() ||
				resolve(flowdularStateDirectory(workspaceRoot), 'data', 'storage'),
		},
		s3:
			adapter === 's3'
				? {
						bucket: required(environment, 'FD_STORAGE_S3_BUCKET', adapter),
						region: required(environment, 'FD_STORAGE_S3_REGION', adapter),
						endpoint: environment.FD_STORAGE_S3_ENDPOINT?.trim() || undefined,
						accessKeyId: required(
							environment,
							'FD_STORAGE_S3_ACCESS_KEY_ID',
							adapter,
						),
						secretAccessKey: required(
							environment,
							'FD_STORAGE_S3_SECRET_ACCESS_KEY',
							adapter,
						),
						forcePathStyle: booleanEnvironment(
							environment.FD_STORAGE_S3_FORCE_PATH_STYLE,
							false,
							'FD_STORAGE_S3_FORCE_PATH_STYLE',
						),
					}
				: {
						bucket: '',
						region: '',
						endpoint: undefined,
						accessKeyId: '',
						secretAccessKey: '',
						forcePathStyle: false,
					},
	};
}

function decodeStorageKey(
	value: string,
	variable = STORAGE_KEY_VARIABLE,
): Buffer {
	const trimmed = value.trim();
	const decoded = /^[0-9a-f]{64}$/i.test(trimmed)
		? Buffer.from(trimmed, 'hex')
		: Buffer.from(trimmed, 'base64');
	if (decoded.length !== 32) {
		throw new Error(`${variable} must encode exactly 32 bytes.`);
	}
	return decoded;
}

/* A local checkout stores objects without a configured key, the way it runs
   without a database URL. The value is derived from the workspace path, so it
   is stable across restarts and useless anywhere else. */
function derivedDevelopmentKey(workspaceRoot: string): Buffer {
	return createHash('sha256')
		.update(`flowdular-storage-development\u0000${workspaceRoot}`)
		.digest();
}

/**
 * The ring that seals every stored object and every read token. Rotation adds
 * the retired key to `FD_STORAGE_ENCRYPTION_KEY_PREVIOUS`, which opens objects
 * written before the rotation while new writes use the current key.
 */
export function createStorageKeyring(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): Keyring {
	environment = flowdularEnvironment(environment);
	const configured = environment[STORAGE_KEY_VARIABLE];
	return createKeyring({
		current: configured
			? decodeStorageKey(configured)
			: derivedDevelopmentKey(workspaceRoot),
		previous: parsePreviousKeys(
			environment[`${STORAGE_KEY_VARIABLE}_PREVIOUS`],
			(entry) => decodeStorageKey(entry, `${STORAGE_KEY_VARIABLE}_PREVIOUS`),
		),
	});
}
