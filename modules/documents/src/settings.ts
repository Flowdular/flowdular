import {
	defineModuleSettings,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import {
	DEFAULT_STORAGE_MAX_OBJECT_BYTES,
	storageConfigFromEnvironment,
	STORAGE_READ_URL_MAX_SECONDS,
} from '@flowdular/storage';

export const DOCUMENTS_MODULE_ID = 'documents.core';

export const DEFAULT_DOCUMENTS_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_DOCUMENTS_READ_URL_SECONDS = 300;
export const MIN_DOCUMENTS_READ_URL_SECONDS = 30;
/* A quota is a workspace bound, not a licence: a terabyte is far past what the
   25 MB object limit and one workspace's records reach, and a larger number is
   a mistake rather than a policy. */
export const MAX_DOCUMENTS_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024;

export const DOCUMENTS_MODULE_SETTINGS = defineModuleSettings({
	moduleId: DOCUMENTS_MODULE_ID,
	settings: {
		quotaBytes: {
			type: 'number',
			defaultValue: DEFAULT_DOCUMENTS_QUOTA_BYTES,
			min: 0,
			max: MAX_DOCUMENTS_QUOTA_BYTES,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			labelKey: 'documents.settings.quotaBytes.label',
			label: 'Storage quota (bytes)',
			descriptionKey: 'documents.settings.quotaBytes.description',
			description:
				'Bytes this workspace may hold in document storage; 0 refuses every upload.',
		},
		readUrlSeconds: {
			type: 'number',
			defaultValue: DEFAULT_DOCUMENTS_READ_URL_SECONDS,
			min: MIN_DOCUMENTS_READ_URL_SECONDS,
			max: STORAGE_READ_URL_MAX_SECONDS,
			visibility: 'private',
			client: false,
			scope: 'platform',
			labelKey: 'documents.settings.readUrlSeconds.label',
			label: 'Read URL lifetime (seconds)',
			descriptionKey: 'documents.settings.readUrlSeconds.description',
			description:
				'How long a signed download link stays valid after it is issued.',
		},
	},
});

/* A setting read must never take an upload down, so both accessors fall back to
   the declared default when the runtime has not registered the module yet. */
function value(
	settings: ModuleSettingsRuntime,
	tenantId: string,
	key: 'quotaBytes' | 'readUrlSeconds',
	fallback: number,
): number {
	try {
		return settings.get<number>(tenantId, DOCUMENTS_MODULE_ID, key);
	} catch {
		return fallback;
	}
}

export function documentsQuotaBytes(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): number {
	return value(settings, tenantId, 'quotaBytes', DEFAULT_DOCUMENTS_QUOTA_BYTES);
}

/**
 * The object ceiling the platform built its storage port with, read through the
 * storage package's own parser so there is one rule for it. It is not a module
 * setting: the limit belongs to the deployment, and this module only repeats it
 * to the uploader. A configuration this call refuses has already stopped the
 * platform from composing a port, so the declared default is what a screen is
 * told rather than a failure of its own.
 */
export function documentsMaxObjectBytes(
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
): number {
	try {
		return storageConfigFromEnvironment(environment, workspaceRoot)
			.maxObjectBytes;
	} catch {
		return DEFAULT_STORAGE_MAX_OBJECT_BYTES;
	}
}

export function documentsReadUrlSeconds(
	settings: ModuleSettingsRuntime,
): number {
	return value(
		settings,
		PLATFORM_SETTINGS_TENANT,
		'readUrlSeconds',
		DEFAULT_DOCUMENTS_READ_URL_SECONDS,
	);
}
