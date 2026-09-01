import { SandboxSetupError } from './workspace-root.ts';

export interface PlatformPrincipal {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly tenantName: string;
	readonly tenantSlug: string;
}

export interface PlatformAuthority {
	readonly principal: PlatformPrincipal;
	readonly authority:
		| {
				readonly granted: true;
				readonly grantId: string;
				readonly capabilities: readonly string[];
				readonly expiresAt: number | null;
		  }
		| { readonly granted: false; readonly reason: string };
}

export interface BridgeRequest {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly accept: string | null;
}

export interface BridgeResponse {
	readonly status: number;
	readonly contentType: string;
	readonly body: string;
}

const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_BODY_LIMIT = 2 * 1024 * 1024;

export interface PlatformClientOptions {
	readonly platformUrl: string;
	readonly token: string;
	readonly fetch?: typeof globalThis.fetch;
}

export class PlatformClient {
	readonly #platformUrl: string;
	readonly #token: string;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: PlatformClientOptions) {
		this.#platformUrl = options.platformUrl.replace(/\/+$/, '');
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async authority(): Promise<PlatformAuthority> {
		const response = await this.#request('GET', '/api/sandbox/authority');
		if (response.status === 401) {
			throw new SandboxSetupError(
				'PLATFORM_TOKEN_REJECTED',
				'The platform rejected this API token. Issue a new one in Administration.',
			);
		}
		if (response.status === 403) {
			throw new SandboxSetupError(
				'SANDBOX_SCOPE_MISSING',
				'The token does not carry sandbox.access.use for this workspace.',
			);
		}
		if (response.status === 404) {
			throw new SandboxSetupError(
				'SANDBOX_MODULE_MISSING',
				'The connected application does not expose sandbox.core. Enable the module there first.',
			);
		}
		if (!response.ok) {
			throw new SandboxSetupError(
				'PLATFORM_UNREACHABLE',
				`The platform answered ${response.status} for the sandbox authority check.`,
			);
		}
		return (await response.json()) as PlatformAuthority;
	}

	async registerSession(input: {
		readonly sessionId: string;
		readonly moduleId: string;
		readonly title: string;
		readonly blueprint: string;
		readonly driver: string;
		readonly mode: string;
	}): Promise<void> {
		await this.#json('POST', '/api/sandbox/sessions', input);
	}

	async updateSessionState(sessionId: string, state: string): Promise<void> {
		await this.#json('POST', '/api/sandbox/sessions/state', {
			sessionId,
			state,
		});
	}

	/* A delivered module is audit evidence on the platform, next to the
	   session record it came from. */
	async recordEject(
		sessionId: string,
		metadata: Readonly<Record<string, string | number | boolean>>,
	): Promise<void> {
		await this.#json('POST', '/api/sandbox/sessions/eject', {
			sessionId,
			metadata,
		});
	}

	/* The read-only data bridge. A preview screen asks the sandbox for a path
	   the draft module does not own, and the sandbox forwards it to the real
	   application under the connected account's own authorization. */
	async bridge(request: BridgeRequest): Promise<BridgeResponse> {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return {
				status: 405,
				contentType: 'application/json',
				body: JSON.stringify({
					error: {
						code: 'BRIDGE_READ_ONLY',
						message:
							'The preview data bridge forwards read requests only. Mutations must run against the real application.',
					},
				}),
			};
		}
		const response = await this.#request(
			request.method,
			`${request.path}${request.search}`,
			undefined,
			request.accept,
		);
		const text = await response.text();
		return {
			status: response.status,
			contentType: response.headers.get('content-type') ?? 'application/json',
			body:
				text.length > BRIDGE_BODY_LIMIT
					? JSON.stringify({
							error: {
								code: 'BRIDGE_RESPONSE_TOO_LARGE',
								message: 'The bridged response exceeded the sandbox limit.',
							},
						})
					: text,
		};
	}

	async #json(method: string, path: string, body: unknown): Promise<Response> {
		const response = await this.#request(method, path, body);
		if (!response.ok) {
			const payload = (await response.json().catch(() => ({}))) as {
				error?: { message?: string };
			};
			throw new SandboxSetupError(
				'PLATFORM_REQUEST_FAILED',
				payload.error?.message ??
					`The platform answered ${response.status} for ${path}.`,
			);
		}
		return response;
	}

	#request(
		method: string,
		path: string,
		body?: unknown,
		accept: string | null = 'application/json',
	): Promise<Response> {
		return this.#fetch(`${this.#platformUrl}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.#token}`,
				...(accept ? { accept } : {}),
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
		});
	}
}
