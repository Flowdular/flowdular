import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import type {
	ConnectorCallCapability,
	ConnectorCallRequest,
	ConnectorCallResult,
	ConnectorJsonValue,
} from '../domain/calls.ts';
import {
	definitionAllowedPorts,
	type ConnectorDefinitionRegistry,
} from '../domain/definitions.ts';
import {
	CONNECTOR_CALLERS,
	type ConnectorCall,
	type ConnectorCaller,
	type ConnectorCallOutcome,
	type ConnectorCredentials,
	type ConnectorDefinition,
	type ConnectorErrorClass,
	type ConnectorOperation,
} from '../domain/types.ts';
import { credentialContext, type CredentialVault } from './credential-vault.ts';
import {
	connectorHostAllowlist,
	ConnectorEgressError,
	createConnectorEgressPolicy,
	normalizeHost,
	pinnedLookup,
	type HostAddressResolver,
	type ResolvedAddress,
} from './egress.ts';
import type {
	ConnectorsRepository,
	StoredConnectorInstance,
} from './repository.ts';
import { bounded, ConnectorsServiceError, oneOf } from './service-error.ts';

/** Bytes of the response kept as readable text for a test call. */
export const CALL_BODY_PREVIEW_BYTES = 4_096;
/** Bytes a request body may carry. Independent of the response cap. */
export const MAX_REQUEST_BYTES = 256 * 1_024;
/** Query parameters one call may append. */
export const MAX_QUERY_PARAMETERS = 32;
/** Bytes of an OAuth2 token response that are read before it is refused. */
export const TOKEN_RESPONSE_CAP_BYTES = 16 * 1_024;
/**
 * Instances whose access token is cached at once. Tokens are per instance and
 * short lived, so the cap is a leak guard, not a tuning knob: the oldest entry
 * is dropped when a new one arrives.
 */
export const MAX_CACHED_TOKENS = 256;
/** Taken off a token's lifetime so it is never used in its final seconds. */
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;
export const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
/**
 * How long a claimed idempotency key stays in flight before another attempt may
 * take it over. It is well past the highest call timeout the settings allow, so
 * a retake only ever follows a process that died mid-call; without it a crash
 * between the claim and the call log would block that key forever.
 */
export const CALL_KEY_CLAIM_MS = 5 * 60_000;

export interface ConnectorCallLimits {
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
}

/**
 * Test seam for the outbound socket; never reachable from configuration. A
 * deployment leaves it unset, so a call dials the address the policy verified
 * and trusts the system store. A test maps that address onto the loopback port
 * its server listens on and adds that server's certificate, which runs the call
 * path with exactly the address rules a deployment has. `ca` only ever widens
 * trust: there is no form of this seam that turns verification off.
 */
export interface ConnectorConnectSeam {
	readonly dial?: ((address: string) => string) | undefined;
	readonly ca?: string | undefined;
}

export interface ConnectorCallServiceOptions {
	readonly repository: ConnectorsRepository;
	readonly vault: CredentialVault;
	readonly definitions: () => ConnectorDefinitionRegistry;
	/** Live platform settings, read again for every call. */
	readonly limits: () => ConnectorCallLimits;
	/** Test seam for the address check; never reachable from configuration. */
	readonly hostResolver?: HostAddressResolver | undefined;
	readonly connect?: ConnectorConnectSeam | undefined;
	readonly now?: () => number;
}

interface CachedToken {
	readonly token: string;
	readonly expiresAt: number;
}

interface PreparedRequest {
	readonly target: URL;
	readonly body: string | null;
}

class CallRefusal extends Error {
	constructor(
		readonly outcome: Exclude<ConnectorCallOutcome, 'succeeded'>,
		readonly errorClass: ConnectorErrorClass,
		readonly status: number | null = null,
	) {
		super(errorClass);
		this.name = 'CallRefusal';
	}
}

/* A separator no tenant id can carry, so two workspaces can never be read as
   one key. The credential fingerprint closes the key, so a token the previous
   client secret obtained is never served for the one that replaced it. */
function tokenCacheKey(
	tenantId: string,
	instanceId: string,
	fingerprint: string | null,
): string {
	return `${tenantId}\u0000${instanceId}\u0000${fingerprint ?? ''}`;
}

function tokenCachePrefix(tenantId: string, instanceId: string): string {
	return `${tenantId}\u0000${instanceId}\u0000`;
}

function jsonBody(value: unknown): ConnectorJsonValue | null {
	try {
		return JSON.parse(String(value)) as ConnectorJsonValue;
	} catch {
		return null;
	}
}

/** Encodes every segment while keeping the path structure of the template. */
function encodePath(value: string): string {
	return value
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

function templateValue(
	input: Readonly<Record<string, unknown>>,
	name: string,
): string {
	const value = input[name];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	const normalized = value.trim();
	if (normalized.length > 1_024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	/* A dot segment survives both encoders and `new URL` then resolves it away,
	   which is how a value alone could reach a path the definition never
	   declared. Refused for either branch: the value names a resource, never a
	   piece of path syntax, so a single segment has no use for one either. */
	if (
		normalized.split('/').some((segment) => segment === '.' || segment === '..')
	) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	return normalized;
}

/**
 * Expands `{name}` as one escaped segment and `{+name}` as a whole path. The
 * caller supplies only values, never the shape of the path, so a definition
 * keeps control of which resources its instances can reach.
 */
export function expandPath(
	template: string,
	input: Readonly<Record<string, unknown>>,
): string {
	return template.replace(
		/\{(\+?)([a-z][a-zA-Z0-9_]*)\}/g,
		(_match, reserved: string, name: string) => {
			const value = templateValue(input, name);
			if (reserved === '') return encodeURIComponent(value);
			if (
				!value.startsWith('/') ||
				value.includes('?') ||
				value.includes('#')
			) {
				throw new CallRefusal('refused', 'invalid-input');
			}
			return encodePath(value);
		},
	);
}

function queryParameters(
	value: unknown,
): readonly (readonly [string, string])[] {
	if (value === undefined || value === null) return [];
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_QUERY_PARAMETERS) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	return entries.map(([key, entry]) => {
		if (
			key.length === 0 ||
			key.length > 64 ||
			(typeof entry !== 'string' &&
				typeof entry !== 'number' &&
				typeof entry !== 'boolean')
		) {
			throw new CallRefusal('refused', 'invalid-input');
		}
		const text = String(entry);
		if (text.length > 1_024) throw new CallRefusal('refused', 'invalid-input');
		return [key, text] as const;
	});
}

function requestBody(
	operation: ConnectorOperation,
	input: Readonly<Record<string, unknown>>,
): string | null {
	if (operation.method === 'GET' || operation.method === 'DELETE') return null;
	const body = input.body;
	if (body === undefined) return null;
	let serialized: string;
	try {
		serialized = JSON.stringify(body);
	} catch {
		throw new CallRefusal('refused', 'invalid-input');
	}
	if (serialized === undefined)
		throw new CallRefusal('refused', 'invalid-input');
	if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	return serialized;
}

/** Builds the absolute target under the instance base URL, or refuses. */
export function prepareRequest(
	baseUrl: string,
	operation: ConnectorOperation,
	input: Readonly<Record<string, unknown>>,
): PreparedRequest {
	const base = new URL(baseUrl);
	const prefix = base.pathname.replace(/\/+$/, '');
	const target = new URL(prefix + expandPath(operation.path, input), base);
	/* `new URL` normalizes `..`, so this is what stops a path value from
	   climbing out of the base path or reaching another origin. */
	if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) {
		throw new CallRefusal('refused', 'invalid-input');
	}
	for (const [key, value] of queryParameters(input.query)) {
		target.searchParams.append(key, value);
	}
	return { target, body: requestBody(operation, input) };
}

interface HttpExchange {
	readonly status: number;
	readonly text: string;
	readonly bytes: number;
	readonly exceeded: boolean;
}

async function readBounded(
	response: IncomingMessage,
	cap: number,
): Promise<{
	readonly text: string;
	readonly bytes: number;
	readonly exceeded: boolean;
}> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	try {
		for await (const chunk of response) {
			const buffer = chunk as Buffer;
			bytes += buffer.byteLength;
			/* The socket goes down with the first chunk past the cap, so a sender
			   that keeps streaming cannot hold the call open past it. */
			if (bytes > cap) return { text: '', bytes, exceeded: true };
			chunks.push(buffer);
		}
	} finally {
		response.destroy();
	}
	return {
		text: Buffer.concat(chunks).toString('utf8'),
		bytes,
		exceeded: false,
	};
}

/** Reads as an abort so the transport classifier records a timeout, not a reset. */
function abortFailure(): Error {
	const error = new Error('The connector request was aborted.');
	error.name = 'AbortError';
	return error;
}

/**
 * One request over TLS to an address the egress policy already accepted. The
 * agent is built per call and destroyed with it: a pooled socket would outlive
 * the address check that admitted it, which is the window this closes.
 */
function sendPinned(
	target: URL,
	init: {
		readonly method: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string | null;
		readonly addresses: readonly ResolvedAddress[];
		readonly cap: number;
		readonly signal: AbortSignal;
		readonly ca?: string | undefined;
		/** Called once the request has been handed to the operating system. */
		readonly onWritten?: (() => void) | undefined;
	},
): Promise<HttpExchange> {
	const agent = new Agent({
		keepAlive: false,
		maxSockets: 1,
		lookup: pinnedLookup(normalizeHost(target.hostname), init.addresses),
		...(init.ca === undefined ? {} : { ca: init.ca }),
	});
	return new Promise<HttpExchange>((resolve, reject) => {
		const fail = (error: unknown) =>
			reject(init.signal.aborted ? abortFailure() : error);
		/* A redirect is a refusal, not a hop: node never follows one, so the 3xx
		   comes back and the call is recorded rather than chased to another host. */
		const request = httpsRequest(target, {
			method: init.method,
			agent,
			/* An explicit length rather than a chunked body: an external system
			   that refuses chunked requests must still see the same request it
			   saw before the transport changed. */
			headers:
				init.body === null
					? init.headers
					: {
							...init.headers,
							'content-length': String(Buffer.byteLength(init.body, 'utf8')),
						},
			signal: init.signal,
		});
		request.on('error', fail);
		if (init.onWritten) request.on('finish', init.onWritten);
		request.on('response', (response) => {
			void readBounded(response, init.cap).then(
				(payload) => resolve({ status: response.statusCode ?? 0, ...payload }),
				fail,
			);
		});
		if (init.body !== null) request.write(init.body);
		request.end();
	}).finally(() => agent.destroy());
}

function transportFailure(error: unknown): CallRefusal {
	if (error instanceof CallRefusal) return error;
	if (error instanceof ConnectorEgressError) {
		return error.code === 'CONNECTOR_HOST_UNRESOLVED'
			? new CallRefusal('failed', 'dns')
			: new CallRefusal('refused', 'egress-refused');
	}
	const name = (error as { name?: unknown })?.name;
	if (name === 'TimeoutError' || name === 'AbortError') {
		return new CallRefusal('failed', 'timeout');
	}
	/* node reports the resolver failure on the error, fetch reported it on the
	   cause; both shapes are read so the class stays the same either way. */
	const failure = error as { code?: unknown; cause?: { code?: unknown } };
	const code = String(failure?.code ?? failure?.cause?.code);
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
		return new CallRefusal('failed', 'dns');
	}
	return new CallRefusal('failed', 'network');
}

/* A definition names the ports its instances may reach and 443 is the default,
   so an instance cannot be aimed at an internal service that happens to answer
   on a public address. */
function assertAllowedPort(definition: ConnectorDefinition, url: URL): void {
	const port = url.port === '' ? 443 : Number(url.port);
	if (!definitionAllowedPorts(definition).includes(port)) {
		throw new CallRefusal('refused', 'egress-refused');
	}
}

/** Key order never changes the digest, so a retry of the same call matches. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const encoded = JSON.stringify(value);
		if (encoded === undefined)
			throw new CallRefusal('refused', 'invalid-input');
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(',')}}`;
}

function inputDigest(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Runs one operation of one instance. Every refusal and every failure lands in
 * the call log with its class, and no request or response body is ever stored.
 */
export class ConnectorCallService implements ConnectorCallCapability {
	readonly #options: ConnectorCallServiceOptions;
	readonly #now: () => number;
	readonly #tokens = new Map<string, CachedToken>();

	constructor(options: ConnectorCallServiceOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Drops every cached token of an instance after it or its credential changed.
	 * The scan is over a map bounded by MAX_CACHED_TOKENS and runs on a
	 * configuration change, never on the call path.
	 */
	forget(tenantId: string, instanceId: string): void {
		const prefix = tokenCachePrefix(tenantId, instanceId);
		for (const key of this.#tokens.keys()) {
			if (key.startsWith(prefix)) this.#tokens.delete(key);
		}
	}

	async consented(
		tenantId: string,
		instanceId: string,
		caller: ConnectorCaller,
	): Promise<boolean> {
		const instance = await this.#options.repository.findInstance(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(instanceId, 'instanceId', 1, 128),
		);
		return instance !== null && this.#admits(instance, caller);
	}

	async call(request: ConnectorCallRequest): Promise<ConnectorCallResult> {
		const tenantId = bounded(request.tenantId, 'tenantId', 1, 128);
		const instanceId = bounded(request.instanceId, 'instanceId', 1, 128);
		const caller = oneOf(request.caller, 'caller', CONNECTOR_CALLERS);
		const operationKey = bounded(request.operation, 'operation', 1, 64);
		const callerRef =
			request.callerRef === undefined || request.callerRef === ''
				? null
				: bounded(request.callerRef, 'callerRef', 1, 200);
		const idempotencyKey =
			request.idempotencyKey === undefined || request.idempotencyKey === ''
				? null
				: bounded(request.idempotencyKey, 'idempotencyKey', 8, 128);
		const instance = await this.#options.repository.findInstance(
			tenantId,
			instanceId,
		);
		if (!instance) {
			throw new ConnectorsServiceError(
				'INSTANCE_NOT_FOUND',
				'No connector instance with this id exists in the workspace.',
				404,
			);
		}
		const input =
			request.input && typeof request.input === 'object'
				? request.input
				: ({} as Record<string, unknown>);
		const started = this.#now();
		let requestBytes = 0;
		let claimed = false;
		let requestWritten = false;
		try {
			if (instance.status !== 'active') {
				throw new CallRefusal('refused', 'instance-disabled');
			}
			if (!this.#admits(instance, caller)) {
				throw new CallRefusal('refused', 'consent-missing');
			}
			const definition = this.#options
				.definitions()
				.get(instance.definitionKey);
			if (!definition) throw new CallRefusal('refused', 'definition-missing');
			const operation = definition.operations.find(
				(candidate) => candidate.key === operationKey,
			);
			if (!operation) throw new CallRefusal('refused', 'operation-unknown');
			const prepared = prepareRequest(instance.baseUrl, operation, input);
			requestBytes =
				prepared.body === null ? 0 : Buffer.byteLength(prepared.body, 'utf8');
			const addresses = await this.#assertReachable(
				instance,
				definition,
				prepared.target,
			);
			/* The credential is resolved first, token exchange included: that
			   exchange is an outbound call of its own that can be refused or fail,
			   and a key claimed before it would answer every later attempt with a
			   call the external system never saw. */
			const headers = await this.#headers(instance, definition);
			/* The last point before anything can leave, and after every refusal
			   that never reaches the network: a call stopped by consent, by the
			   egress rules, by a credential or by a bad input leaves the key free
			   for the retry that follows the fix. */
			if (idempotencyKey) {
				const replay = await this.#claim(
					tenantId,
					instanceId,
					operationKey,
					input,
					idempotencyKey,
				);
				if (replay) return replay;
				claimed = true;
			}
			const outcome = await this.#send(
				operation,
				prepared,
				headers,
				addresses,
				request.signal,
				() => {
					requestWritten = true;
				},
			);
			return await this.#record(claimed ? idempotencyKey : null, {
				tenantId,
				instanceId,
				operation: operationKey,
				caller,
				callerRef,
				outcome: outcome.outcome,
				status: outcome.status,
				errorClass: outcome.errorClass,
				durationMs: this.#now() - started,
				requestBytes,
				responseBytes: outcome.responseBytes,
				body: outcome.body,
				bodyPreview: outcome.bodyPreview,
			});
		} catch (error) {
			/* A ledger decision is the caller's answer, not the outcome of a call:
			   nothing reached the network, so it must not become a log row. */
			if (error instanceof ConnectorsServiceError) throw error;
			const refusal = transportFailure(error);
			/* The key stays bound only once the request is on the wire, because
			   from there an answer may have been lost rather than never given. A
			   refusal reaches no network at all, and a failure raised before the
			   request was written leaves the external system untouched: both free
			   the key for the retry that follows the fix. */
			const bindKey =
				claimed && requestWritten && refusal.outcome !== 'refused';
			return await this.#record(bindKey ? idempotencyKey : null, {
				tenantId,
				instanceId,
				operation: operationKey,
				caller,
				callerRef,
				outcome: refusal.outcome,
				status: refusal.status,
				errorClass: refusal.errorClass,
				durationMs: this.#now() - started,
				requestBytes,
				responseBytes: 0,
				body: null,
				bodyPreview: '',
			});
		}
	}

	/**
	 * Binds one idempotency key to one call before anything leaves the process.
	 * A repeat of a key that already produced a call answers that call instead of
	 * making a second one, so a workflow node replayed after a crash cannot hit
	 * the external system twice. A recorded failure counts as a call: a
	 * non-idempotent write whose answer was lost is never retried under its key.
	 */
	async #claim(
		tenantId: string,
		instanceId: string,
		operation: string,
		input: Readonly<Record<string, unknown>>,
		key: string,
	): Promise<ConnectorCallResult | null> {
		const now = this.#now();
		const claim = await this.#options.repository.claimCallKey(tenantId, key, {
			operationId: `${instanceId}:${operation}`,
			inputDigest: inputDigest(input),
			claimedAt: now,
			staleBefore: now - CALL_KEY_CLAIM_MS,
		});
		if (claim.state === 'claimed') return null;
		if (claim.state === 'conflict') {
			throw new ConnectorsServiceError(
				'CALL_IDEMPOTENCY_CONFLICT',
				'This idempotency key is already bound to another connector call.',
				409,
			);
		}
		if (claim.state === 'in-flight') {
			throw new ConnectorsServiceError(
				'CALL_IN_FLIGHT',
				'A connector call with this idempotency key is still running.',
				409,
			);
		}
		const recorded = await this.#options.repository.findCall(
			tenantId,
			claim.callId,
		);
		if (!recorded) {
			throw new ConnectorsServiceError(
				'CALL_NOT_FOUND',
				'The call this idempotency key is bound to is no longer in the log.',
				409,
			);
		}
		/* The log keeps no body, so a replay answers the recorded diagnosis and
		   says so rather than presenting an empty body as the call's own. */
		return {
			callId: recorded.id,
			outcome: recorded.outcome,
			status: recorded.status,
			errorClass: recorded.errorClass,
			durationMs: recorded.durationMs,
			requestBytes: recorded.requestBytes,
			responseBytes: recorded.responseBytes,
			body: null,
			bodyPreview: '',
			replayed: true,
		};
	}

	#admits(instance: StoredConnectorInstance, caller: ConnectorCaller): boolean {
		if (instance.status !== 'active') return false;
		if (caller === 'workflow') return instance.allowWorkflows;
		if (caller === 'agent') return instance.allowAgents;
		return true;
	}

	/**
	 * Scheme, port, allowlist and addresses, immediately before the socket. It
	 * answers the addresses it accepted so the connection can be pinned to them:
	 * nothing between this check and the request may resolve the name again.
	 */
	async #assertReachable(
		instance: StoredConnectorInstance,
		definition: ConnectorDefinition,
		url: URL,
	): Promise<readonly ResolvedAddress[]> {
		const policy = createConnectorEgressPolicy({
			allowlist: connectorHostAllowlist(instance.allowedHosts),
			resolve: this.#options.hostResolver,
		});
		policy.assertHttps(url);
		assertAllowedPort(definition, url);
		return policy.assertResolvable(normalizeHost(url.hostname));
	}

	#credentials(instance: StoredConnectorInstance): ConnectorCredentials {
		if (instance.authKind === 'none' || instance.credential === null) {
			return { kind: 'none' };
		}
		let opened: string;
		try {
			opened = this.#options.vault.open(
				instance.credential,
				credentialContext(instance.tenantId, instance.id),
			);
		} catch {
			throw new CallRefusal('failed', 'credential-unavailable');
		}
		try {
			return JSON.parse(opened) as ConnectorCredentials;
		} catch {
			throw new CallRefusal('failed', 'credential-unavailable');
		}
	}

	async #headers(
		instance: StoredConnectorInstance,
		definition: ConnectorDefinition,
	): Promise<Record<string, string>> {
		const credentials = this.#credentials(instance);
		if (credentials.kind === 'none') return {};
		if (credentials.kind === 'api-key') {
			return { [credentials.header]: credentials.value };
		}
		if (credentials.kind === 'bearer') {
			return { authorization: `Bearer ${credentials.token}` };
		}
		return {
			authorization: `Bearer ${await this.#accessToken(
				instance,
				definition,
				credentials,
			)}`,
		};
	}

	async #accessToken(
		instance: StoredConnectorInstance,
		definition: ConnectorDefinition,
		credentials: Extract<
			ConnectorCredentials,
			{ kind: 'oauth2-client-credentials' }
		>,
	): Promise<string> {
		const key = tokenCacheKey(
			instance.tenantId,
			instance.id,
			instance.credentialFingerprint,
		);
		const cached = this.#tokens.get(key);
		if (cached && cached.expiresAt > this.#now()) return cached.token;
		this.#tokens.delete(key);
		const tokenUrl = new URL(credentials.tokenUrl);
		/* The token endpoint is another outbound call of this instance: same
		   scheme, port, allowlist and address rules, and the same pinning. */
		const addresses = await this.#assertReachable(
			instance,
			definition,
			tokenUrl,
		);
		const body = new URLSearchParams({ grant_type: 'client_credentials' });
		if (credentials.scope) body.set('scope', credentials.scope);
		const authorization = Buffer.from(
			`${credentials.clientId}:${credentials.clientSecret}`,
			'utf8',
		).toString('base64');
		let payload: HttpExchange;
		try {
			payload = await sendPinned(tokenUrl, {
				method: 'POST',
				addresses: this.#dialable(addresses),
				cap: TOKEN_RESPONSE_CAP_BYTES,
				signal: AbortSignal.timeout(this.#options.limits().timeoutMs),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					accept: 'application/json',
					authorization: `Basic ${authorization}`,
				},
				body: body.toString(),
				...(this.#options.connect?.ca === undefined
					? {}
					: { ca: this.#options.connect.ca }),
			});
		} catch {
			throw new CallRefusal('failed', 'credential-unavailable');
		}
		if (payload.status < 200 || payload.status >= 300 || payload.exceeded) {
			throw new CallRefusal('failed', 'credential-unavailable');
		}
		const parsed = jsonBody(payload.text) as {
			readonly access_token?: unknown;
			readonly expires_in?: unknown;
		} | null;
		const token = parsed?.access_token;
		if (typeof token !== 'string' || token.length === 0) {
			throw new CallRefusal('failed', 'credential-unavailable');
		}
		const lifetime = Number(parsed?.expires_in);
		const expiresIn = Number.isFinite(lifetime)
			? Math.min(lifetime * 1_000, MAX_TOKEN_LIFETIME_MS)
			: TOKEN_EXPIRY_MARGIN_MS * 2;
		/* Insertion order is eviction order: one instance can never push the
		   cache past its bound. */
		if (this.#tokens.size >= MAX_CACHED_TOKENS) {
			const oldest = this.#tokens.keys().next();
			if (!oldest.done) this.#tokens.delete(oldest.value);
		}
		this.#tokens.set(key, {
			token,
			expiresAt:
				this.#now() + Math.max(expiresIn - TOKEN_EXPIRY_MARGIN_MS, 1_000),
		});
		return token;
	}

	/* The verified addresses as they are dialled. A deployment dials exactly what
	   it verified; the seam is what lets a test reach its own server. */
	#dialable(addresses: readonly ResolvedAddress[]): readonly ResolvedAddress[] {
		const dial = this.#options.connect?.dial;
		if (!dial) return addresses;
		return addresses.map((entry) => ({ address: dial(entry.address) }));
	}

	async #send(
		operation: ConnectorOperation,
		prepared: PreparedRequest,
		headers: Record<string, string>,
		addresses: readonly ResolvedAddress[],
		callerSignal: AbortSignal | undefined,
		onWritten: () => void,
	): Promise<{
		readonly outcome: ConnectorCallOutcome;
		readonly status: number;
		readonly errorClass: ConnectorErrorClass | null;
		readonly responseBytes: number;
		readonly body: ConnectorJsonValue | null;
		readonly bodyPreview: string;
	}> {
		const limits = this.#options.limits();
		const signals = [AbortSignal.timeout(limits.timeoutMs)];
		if (callerSignal) signals.push(callerSignal);
		let payload: HttpExchange;
		try {
			payload = await sendPinned(prepared.target, {
				method: operation.method,
				addresses: this.#dialable(addresses),
				cap: limits.maxResponseBytes,
				/* One deadline over the headers and the body, so a sender that
				   answers and then stalls mid-body is still bounded. */
				signal: AbortSignal.any(signals),
				headers: {
					accept: 'application/json',
					...(prepared.body === null
						? {}
						: { 'content-type': 'application/json' }),
					...headers,
				},
				body: prepared.body,
				onWritten,
				...(this.#options.connect?.ca === undefined
					? {}
					: { ca: this.#options.connect.ca }),
			});
		} catch (error) {
			throw transportFailure(error);
		}
		if (payload.exceeded) {
			return {
				outcome: 'failed',
				status: payload.status,
				errorClass: 'response-too-large',
				responseBytes: payload.bytes,
				body: null,
				bodyPreview: '',
			};
		}
		const status = payload.status;
		const errorClass: ConnectorErrorClass | null =
			status >= 200 && status < 300
				? null
				: status >= 500
					? 'response-5xx'
					: status >= 400
						? 'response-4xx'
						: 'egress-refused';
		return {
			outcome: errorClass === null ? 'succeeded' : 'failed',
			status,
			errorClass,
			responseBytes: payload.bytes,
			body: jsonBody(payload.text),
			bodyPreview: payload.text.slice(0, CALL_BODY_PREVIEW_BYTES),
		};
	}

	async #record(
		idempotencyKey: string | null,
		result: Omit<ConnectorCall, 'id' | 'occurredAt'> & {
			readonly body: ConnectorJsonValue | null;
			readonly bodyPreview: string;
		},
	): Promise<ConnectorCallResult> {
		const { body, bodyPreview, ...call } = result;
		const record: ConnectorCall = {
			...call,
			id: randomUUID(),
			occurredAt: this.#now(),
		};
		/* The claimed key is bound to this call in the same transaction, so a
		   retry either sees the binding or sees no call at all. */
		await this.#options.repository.recordCall(record, idempotencyKey);
		return {
			callId: record.id,
			outcome: record.outcome,
			status: record.status,
			errorClass: record.errorClass,
			durationMs: record.durationMs,
			requestBytes: record.requestBytes,
			responseBytes: record.responseBytes,
			body,
			bodyPreview,
			replayed: false,
		};
	}
}
