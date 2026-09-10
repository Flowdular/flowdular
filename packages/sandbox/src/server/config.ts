import {
	flowdularEnvironment,
	flowdularStateDirectory,
} from '@flowdular/kernel/runtime-config';
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxRuntimeMode } from '@flowdular/coding-agent';
import type { AiProviderKind } from '@flowdular/ai-provider';
import { SandboxSetupError } from './workspace-root.ts';

export const SANDBOX_DIRECTORY = '.flowdular/sandbox';

export function sandboxDirectory(workspaceRoot: string): string {
	// The parent selects this path before applying the worker filesystem ceiling.
	// A worker cannot inspect sibling state roots to rediscover that selection.
	if (process.env.FD_INTERNAL_SANDBOX_PREVIEW_WORKER === '1') {
		const root = process.env.FD_INTERNAL_SANDBOX_STATE_ROOT;
		if (root !== '.flowdular' && root !== '.coreloom')
			throw new Error('Missing preview state root.');
		return join(workspaceRoot, root, 'sandbox');
	}
	return join(flowdularStateDirectory(workspaceRoot), 'sandbox');
}

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

export type GitHubDeliveryMode = 'auto' | 'direct' | 'fork';

/* Repository delivery is local sandbox configuration, not project source.
   One operator can use a fork while another can push directly without either
   changing flowdular.json for the whole team. */
export interface GitHubDeliveryConfiguration {
	readonly enabled: boolean;
	/* False keeps the repository-owned sandbox.delivery.git values authoritative.
	   True applies the operator's machine-local remote and branch preferences. */
	readonly overridesProject: boolean;
	readonly remote: string;
	/* owner/name of the repository that receives the pull request. Null means
	   derive it from the configured remote. */
	readonly repository: string | null;
	readonly baseBranch: string;
	readonly branchPrefix: string;
	readonly mode: GitHubDeliveryMode;
	readonly forkOwner: string | null;
	readonly reviewers: readonly string[];
}

export interface SandboxConfiguration {
	readonly version: 1;
	readonly mode: SandboxRuntimeMode;
	/* Origin of the Flowdular application this sandbox connects to. It may be a
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
	readonly github: GitHubDeliveryConfiguration;
}

export const DEFAULT_GITHUB_CONFIGURATION: GitHubDeliveryConfiguration = {
	enabled: true,
	overridesProject: false,
	remote: 'origin',
	repository: null,
	baseBranch: 'main',
	branchPrefix: 'sandbox',
	mode: 'auto',
	forkOwner: null,
	reviewers: [],
};

export const DEFAULT_CONFIGURATION: SandboxConfiguration = {
	version: 1,
	mode: 'loopback',
	platformUrl: 'http://localhost:4310',
	platformToken: null,
	driver: 'claude-code',
	driverModel: null,
	previewData: 'fixtures',
	byok: null,
	gitProviderToken: null,
	github: DEFAULT_GITHUB_CONFIGURATION,
};

const GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_GIT_NAME_LENGTH = 120;
const MAX_GITHUB_REVIEWERS = 20;
const GITHUB_REPOSITORY =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function invalidGitHub(detail: string): SandboxSetupError {
	return new SandboxSetupError(
		'GITHUB_CONFIG_INVALID',
		`The GitHub integration is not usable: ${detail}`,
	);
}

export function assertGitName(value: string, field: string): string {
	if (value.length > MAX_GIT_NAME_LENGTH || !GIT_NAME.test(value)) {
		throw invalidGitHub(`${field} must be a plain git name.`);
	}
	return value;
}

export function assertGitHubRepository(value: string | null): string | null {
	if (value === null || value === '') return null;
	if (!GITHUB_REPOSITORY.test(value)) {
		throw invalidGitHub('repository must use the owner/name form.');
	}
	return value;
}

export function assertGitHubAccount(value: string | null): string | null {
	if (value === null || value === '') return null;
	if (!GITHUB_ACCOUNT.test(value)) {
		throw invalidGitHub('forkOwner must be a GitHub account name.');
	}
	return value;
}

export function assertGitHubDeliveryMode(value: string): GitHubDeliveryMode {
	if (value !== 'auto' && value !== 'direct' && value !== 'fork') {
		throw invalidGitHub('mode must be auto, direct, or fork.');
	}
	return value;
}

export function resolveGitHubConfiguration(
	value: Partial<GitHubDeliveryConfiguration> | undefined,
): GitHubDeliveryConfiguration {
	const defaults = DEFAULT_GITHUB_CONFIGURATION;
	if (
		value?.overridesProject !== undefined &&
		typeof value.overridesProject !== 'boolean'
	) {
		throw invalidGitHub('overridesProject must be a boolean.');
	}
	const reviewers = value?.reviewers ?? defaults.reviewers;
	if (
		!Array.isArray(reviewers) ||
		reviewers.length > MAX_GITHUB_REVIEWERS ||
		!reviewers.every((reviewer) => GITHUB_ACCOUNT.test(reviewer))
	) {
		throw invalidGitHub('reviewers must list GitHub account names.');
	}
	const resolved = {
		enabled: value?.enabled ?? defaults.enabled,
		remote: assertGitName(value?.remote ?? defaults.remote, 'remote'),
		repository: assertGitHubRepository(value?.repository ?? null),
		baseBranch: assertGitName(
			value?.baseBranch ?? defaults.baseBranch,
			'baseBranch',
		),
		branchPrefix: assertGitName(
			value?.branchPrefix ?? defaults.branchPrefix,
			'branchPrefix',
		),
		mode: assertGitHubDeliveryMode(value?.mode ?? defaults.mode),
		forkOwner: assertGitHubAccount(value?.forkOwner ?? null),
		reviewers: [...new Set(reviewers)],
	};
	/* Older config files have no explicit override marker. Preserve genuine
	   custom values, but do not let a fully materialized default object shadow
	   the repository-owned delivery configuration. */
	const differsFromDefault =
		resolved.enabled !== defaults.enabled ||
		resolved.remote !== defaults.remote ||
		resolved.repository !== defaults.repository ||
		resolved.baseBranch !== defaults.baseBranch ||
		resolved.branchPrefix !== defaults.branchPrefix ||
		resolved.mode !== defaults.mode ||
		resolved.forkOwner !== defaults.forkOwner ||
		resolved.reviewers.length !== defaults.reviewers.length ||
		resolved.reviewers.some(
			(reviewer, index) => reviewer !== defaults.reviewers[index],
		);
	return {
		...resolved,
		overridesProject: value?.overridesProject ?? differsFromDefault,
	};
}

function configPath(workspaceRoot: string): string {
	return join(sandboxDirectory(workspaceRoot), 'config.json');
}

function keyPath(workspaceRoot: string): string {
	return join(sandboxDirectory(workspaceRoot), 'secret.key');
}

function unsafeLocalPath(path: string): SandboxSetupError {
	return new SandboxSetupError(
		'UNSAFE_SANDBOX_CONFIG_PATH',
		`The sandbox local path ${path} must be regular and must not be a symbolic link.`,
	);
}

async function assertSafeLocalPath(
	workspaceRoot: string,
	path: string,
	createDirectory: boolean,
): Promise<void> {
	for (const directory of [
		flowdularStateDirectory(workspaceRoot),
		sandboxDirectory(workspaceRoot),
	]) {
		try {
			const info = await lstat(directory);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				throw unsafeLocalPath(directory);
			}
			await chmod(directory, 0o700);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			if (!createDirectory) return;
			await mkdir(directory, { mode: 0o700 });
		}
	}
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw unsafeLocalPath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

async function readLocalFile(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		await handle.chmod(0o600);
		return await handle.readFile('utf8');
	} finally {
		await handle.close();
	}
}

async function writeLocalFile(path: string, value: string): Promise<void> {
	const handle = await open(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_TRUNC |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(value, 'utf8');
	} finally {
		await handle.close();
	}
}

/* Secrets stay on the machine that runs the sandbox: encrypted at rest with a
   permission-restricted local key, never written to the workspace repository
   and never returned to the browser. */
async function localKey(workspaceRoot: string): Promise<Buffer> {
	const path = keyPath(workspaceRoot);
	try {
		await assertSafeLocalPath(workspaceRoot, path, false);
		const encoded = await readLocalFile(path);
		const key = Buffer.from(encoded.trim(), 'base64');
		if (key.byteLength === 32) return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	await assertSafeLocalPath(workspaceRoot, path, true);
	const key = randomBytes(32);
	await writeLocalFile(path, key.toString('base64'));
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
	const loopback =
		url.hostname === 'localhost' ||
		url.hostname === '::1' ||
		url.hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== 'https:' && !loopback) {
		throw new SandboxSetupError(
			'INVALID_PLATFORM_URL',
			'The platform address must use HTTPS unless it is a loopback address.',
		);
	}
	return url.origin;
}

/* The launcher decides the mode from the interface it actually bound, so a
   stored configuration can never grant loopback trust to a public listener. */
function modeFromEnvironment(stored: SandboxRuntimeMode): SandboxRuntimeMode {
	const value = flowdularEnvironment(process.env).FD_SANDBOX_MODE;
	if (value === 'loopback' || value === 'self-hosted') return value;
	return stored;
}

export async function loadSandboxConfiguration(
	workspaceRoot: string,
): Promise<SandboxConfiguration> {
	try {
		await assertSafeLocalPath(workspaceRoot, configPath(workspaceRoot), false);
		const stored = JSON.parse(
			await readLocalFile(configPath(workspaceRoot)),
		) as Partial<SandboxConfiguration>;
		return {
			...DEFAULT_CONFIGURATION,
			...stored,
			version: 1,
			mode: modeFromEnvironment(stored.mode ?? DEFAULT_CONFIGURATION.mode),
			platformUrl: assertPlatformUrl(
				stored.platformUrl ?? DEFAULT_CONFIGURATION.platformUrl,
			),
			github: resolveGitHubConfiguration(stored.github),
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
	await assertSafeLocalPath(workspaceRoot, path, true);
	await writeLocalFile(path, `${JSON.stringify(configuration, null, '\t')}\n`);
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
	readonly github: GitHubDeliveryConfiguration & {
		readonly tokenFingerprint: string | null;
	};
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
		github: {
			...configuration.github,
			tokenFingerprint: secretFingerprint(configuration.gitProviderToken),
		},
	};
}
