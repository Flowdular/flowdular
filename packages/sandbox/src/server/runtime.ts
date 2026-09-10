import { randomBytes } from 'node:crypto';
import {
	createByokDriver,
	createClaudeCodeDriver,
	createCodexDriver,
	createCodingAgentRegistry,
	loadAgentRoles,
	type AgentRoleDefinition,
	type CodingAgentDriver,
	type CodingAgentRegistry,
} from '@flowdular/coding-agent';
import {
	loadSandboxConfiguration,
	openSecret,
	saveSandboxConfiguration,
	type SandboxConfiguration,
} from './config.ts';
import { PlatformClient, type PlatformAuthority } from './platform-client.ts';
import { SandboxSetupError } from './workspace-root.ts';

export interface SandboxConnection {
	readonly connected: boolean;
	readonly authority: PlatformAuthority | null;
	readonly error: { readonly code: string; readonly message: string } | null;
}

export interface BrowserSession {
	readonly id: string;
	readonly token: string;
	readonly authority: PlatformAuthority;
	readonly createdAt: number;
}

/* Matches the cookie lifetime, so a session the browser still presents is
   also one the server still honours. */
export const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SandboxRuntime {
	readonly workspaceRoot: string;
	configuration(): SandboxConfiguration;
	registry(): CodingAgentRegistry;
	roles(): readonly AgentRoleDefinition[];
	platform(): PlatformClient | null;
	connection(): SandboxConnection;
	refresh(): Promise<SandboxConnection>;
	update(patch: Partial<SandboxConfiguration>): Promise<SandboxConnection>;
	/* Self-hosted sandboxes keep one browser session per operator token. A
	   loopback sandbox uses the configured connection directly. */
	openBrowserSession(token: string): Promise<BrowserSession>;
	browserSession(id: string | null): BrowserSession | null;
	closeBrowserSession(id: string): void;
}

async function buildDrivers(
	workspaceRoot: string,
	configuration: SandboxConfiguration,
): Promise<readonly CodingAgentDriver[]> {
	const drivers: CodingAgentDriver[] = [
		createClaudeCodeDriver({ defaultModel: configuration.driverModel }),
		createCodexDriver({ defaultModel: configuration.driverModel }),
	];
	if (configuration.byok) {
		const credential = configuration.byok.credential
			? await openSecret(workspaceRoot, configuration.byok.credential)
			: '';
		drivers.push(
			createByokDriver({
				configuration: {
					kind: configuration.byok.kind,
					model: configuration.byok.model,
					credential,
					...(configuration.byok.resourceName
						? { resourceName: configuration.byok.resourceName }
						: {}),
					...(configuration.byok.baseURL
						? { baseURL: configuration.byok.baseURL }
						: {}),
				},
			}),
		);
	}
	return drivers;
}

export async function createSandboxRuntime(
	workspaceRoot: string,
): Promise<SandboxRuntime> {
	let configuration = await loadSandboxConfiguration(workspaceRoot);
	let roles = await loadAgentRoles(workspaceRoot);
	let registry = createCodingAgentRegistry({
		mode: configuration.mode,
		drivers: await buildDrivers(workspaceRoot, configuration),
	});
	let platform: PlatformClient | null = null;
	let connection: SandboxConnection = {
		connected: false,
		authority: null,
		error: null,
	};
	const browserSessions = new Map<string, BrowserSession>();

	const rebuild = async (): Promise<SandboxConnection> => {
		roles = await loadAgentRoles(workspaceRoot);
		registry = createCodingAgentRegistry({
			mode: configuration.mode,
			drivers: await buildDrivers(workspaceRoot, configuration),
		});
		if (!configuration.platformToken) {
			platform = null;
			connection = {
				connected: false,
				authority: null,
				error: {
					code: 'PLATFORM_TOKEN_MISSING',
					message:
						'Paste an API token from the Flowdular application to connect this sandbox.',
				},
			};
			return connection;
		}
		platform = new PlatformClient({
			platformUrl: configuration.platformUrl,
			token: await openSecret(workspaceRoot, configuration.platformToken),
		});
		try {
			const authority = await platform.authority();
			connection = { connected: true, authority, error: null };
		} catch (error) {
			connection = {
				connected: false,
				authority: null,
				error:
					error instanceof SandboxSetupError
						? { code: error.code, message: error.message }
						: {
								code: 'PLATFORM_UNREACHABLE',
								message: `The sandbox could not reach ${configuration.platformUrl}.`,
							},
			};
		}
		return connection;
	};

	await rebuild();

	return {
		workspaceRoot,
		configuration: () => configuration,
		registry: () => registry,
		roles: () => roles,
		platform: () => platform,
		connection: () => connection,
		refresh: rebuild,
		update: async (patch) => {
			configuration = await saveSandboxConfiguration(workspaceRoot, {
				...configuration,
				...patch,
				version: 1,
			});
			return rebuild();
		},
		openBrowserSession: async (token) => {
			const client = new PlatformClient({
				platformUrl: configuration.platformUrl,
				token,
			});
			const authority = await client.authority();
			if (!authority.authority.granted) {
				throw new SandboxSetupError(
					'SANDBOX_ACCESS_DENIED',
					'This account has no active sandbox grant in the connected workspace.',
				);
			}
			const session: BrowserSession = {
				id: randomBytes(24).toString('base64url'),
				token,
				authority,
				createdAt: Date.now(),
			};
			browserSessions.set(session.id, session);
			return session;
		},
		browserSession: (id) => (id ? (browserSessions.get(id) ?? null) : null),
		closeBrowserSession: (id) => {
			browserSessions.delete(id);
		},
	};
}
