import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SandboxRuntimeMode } from '@coreloom/coding-agent';
import type { AiProviderKind } from '@coreloom/ai-provider';
import { SandboxSetupError } from './workspace-root.ts';

export const SANDBOX_DIRECTORY = '.coreloom/sandbox';

export type PreviewDataMode = 'fixtures' | 'bridge';

export interface SealedSecret {
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
}

export interface ByokProviderConfiguration {
	readonly kind: AiProviderKind;
	readonly model: string;
	readonly resourceName?: string;
	readonly baseURL?: string;
	readonly credential: SealedSecret | null;
}

export interface SandboxConfiguration {
	readonly version: 1;
	readonly mode: SandboxRuntimeMode;
	/* Origin of the Coreloom application this sandbox connects to. It may be a
	   local development server or a remote deployment. */
	readonly platformUrl: string;
	readonly platformToken: SealedSecret | null;
	readonly driver: string;
	readonly driverModel: string | null;
	readonly previewData: PreviewDataMode;
	readonly byok: ByokProviderConfiguration | null;
	/* Token for the pull-request provider of the git-pr delivery, handed to gh
	   as GH_TOKEN when the operator's own gh login is not usable. */
	readonly gitProviderToken: SealedSecret | null;
}

export const DEFAULT_CONFIGURATION: SandboxConfiguration = {
	version: 1,
	mode: 'loopback',
	platformUrl: 'http://127.0.0.1:4310',
	platformToken: null,
	driver: 'claude-code',
	driverModel: null,
	previewData: 'fixtures',
	byok: null,
	gitProviderToken: null,
};

function configPath(workspaceRoot: string): string {
	return join(workspaceRoot, SANDBOX_DIRECTORY, 'config.json');
}

function keyPath(workspaceRoot: string): string {
	return join(workspaceRoot, SANDBOX_DIRECTORY, 'secret.key');
}

/* Secrets stay on the machine that runs the sandbox: encrypted at rest with a
   permission-restricted local key, never written to the workspace repository
   and never returned to the browser. */
async function localKey(workspaceRoot: string): Promise<Buffer> {
	const path = keyPath(workspaceRoot);
	try {
		const encoded = await readFile(path, 'utf8');
		const key = Buffer.from(encoded.trim(), 'base64');
		if (key.byteLength === 32) return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const key = randomBytes(32);
	await writeFile(path, key.toString('base64'), {
		encoding: 'utf8',
		mode: 0o600,
	});
	return key;
}

export async function sealSecret(
	workspaceRoot: string,
	value: string,
): Promise<SealedSecret> {
	const key = await localKey(workspaceRoot);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(value, 'utf8'),
		cipher.final(),
	]);
	return {
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		ciphertext: ciphertext.toString('base64'),
	};
}

export async function openSecret(
	workspaceRoot: string,
	sealed: SealedSecret,
): Promise<string> {
	const key = await localKey(workspaceRoot);
	const decipher = createDecipheriv(
		'aes-256-gcm',
		key,
		Buffer.from(sealed.iv, 'base64'),
	);
	decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
	return Buffer.concat([
		decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
		decipher.final(),
	]).toString('utf8');
}

export function secretFingerprint(sealed: SealedSecret | null): string | null {
	return sealed
		? createHash('sha256').update(sealed.ciphertext).digest('hex').slice(0, 8)
		: null;
}

export function assertPlatformUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SandboxSetupError(
			'INVALID_PLATFORM_URL',
			'The platform address must be an absolute URL.',
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SandboxSetupError(
			'INVALID_PLATFORM_URL',
			'The platform address must use http or https.',
		);
	}
	return url.origin;
}

/* The launcher decides the mode from the interface it actually bound, so a
   stored configuration can never grant loopback trust to a public listener. */
function modeFromEnvironment(stored: SandboxRuntimeMode): SandboxRuntimeMode {
	const value = process.env.CORELOOM_SANDBOX_MODE;
	if (value === 'loopback' || value === 'self-hosted') return value;
	return stored;
}

export async function loadSandboxConfiguration(
	workspaceRoot: string,
): Promise<SandboxConfiguration> {
	try {
		const stored = JSON.parse(
			await readFile(configPath(workspaceRoot), 'utf8'),
		) as Partial<SandboxConfiguration>;
		return {
			...DEFAULT_CONFIGURATION,
			...stored,
			version: 1,
			mode: modeFromEnvironment(stored.mode ?? DEFAULT_CONFIGURATION.mode),
			platformUrl: assertPlatformUrl(
				stored.platformUrl ?? DEFAULT_CONFIGURATION.platformUrl,
			),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				...DEFAULT_CONFIGURATION,
				mode: modeFromEnvironment(DEFAULT_CONFIGURATION.mode),
			};
		}
		throw error;
	}
}

export async function saveSandboxConfiguration(
	workspaceRoot: string,
	configuration: SandboxConfiguration,
): Promise<SandboxConfiguration> {
	const path = configPath(workspaceRoot);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(configuration, null, '\t')}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
	return configuration;
}

export interface SafeSandboxConfiguration {
	readonly mode: SandboxRuntimeMode;
	readonly platformUrl: string;
	readonly platformTokenFingerprint: string | null;
	readonly driver: string;
	readonly driverModel: string | null;
	readonly previewData: PreviewDataMode;
	readonly byok: {
		readonly kind: AiProviderKind;
		readonly model: string;
		readonly credentialFingerprint: string | null;
	} | null;
}

/* What the browser is allowed to see. Credentials never leave the server. */
export function safeConfiguration(
	configuration: SandboxConfiguration,
): SafeSandboxConfiguration {
	return {
		mode: configuration.mode,
		platformUrl: configuration.platformUrl,
		platformTokenFingerprint: secretFingerprint(configuration.platformToken),
		driver: configuration.driver,
		driverModel: configuration.driverModel,
		previewData: configuration.previewData,
		byok: configuration.byok
			? {
					kind: configuration.byok.kind,
					model: configuration.byok.model,
					credentialFingerprint: secretFingerprint(
						configuration.byok.credential,
					),
				}
			: null,
	};
}
