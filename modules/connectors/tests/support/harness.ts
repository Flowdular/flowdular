import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import { createConnectorDefinitionRegistry } from '../../src/domain/definitions.ts';
import { HTTP_JSON_DEFINITION } from '../../src/domain/http-json.ts';
import type {
	ConnectorAuthKind,
	ConnectorCredentials,
	ConnectorDefinition,
} from '../../src/domain/types.ts';
import {
	ConnectorCallService,
	type ConnectorCallLimits,
	type ConnectorConnectSeam,
} from '../../src/services/call-service.ts';
import { ConnectorsService } from '../../src/services/connectors-service.ts';
import {
	AesGcmCredentialVault,
	credentialContext,
} from '../../src/services/credential-vault.ts';
import type { HostAddressResolver } from '../../src/services/egress.ts';
import type {
	ConnectorsRepository,
	StoredConnectorInstance,
} from '../../src/services/repository.ts';
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from './tls.ts';

export const TEST_LIMITS: ConnectorCallLimits = {
	timeoutMs: 2_000,
	maxResponseBytes: 64 * 1_024,
};

/** The name every test instance points at; the fixture certificate covers it. */
export const TEST_HOST = 'connector.example.test';
/** What the injected resolver answers for it: a public address, as a real one. */
export const TEST_PUBLIC_ADDRESS = '93.184.216.34';

/**
 * Ports the test definition accepts. A server listens on an ephemeral port and
 * the definition's port rule is real, so the harness declares the ports its own
 * servers opened instead of relaxing the rule.
 */
const TEST_PORTS = new Set<number>();

export function testVault(): AesGcmCredentialVault {
	return new AesGcmCredentialVault(Buffer.alloc(32, 0x43));
}

/**
 * A definition that accepts the ports the harness opened, for a test that runs
 * on the real runtime registry rather than building its own. It is a second
 * definition, exactly as a module shipping a connector for a service on another
 * port would declare one; the shipped generic definition keeps its 443 rule.
 */
export const TEST_DEFINITION_KEY = 'http-json-ported';

export function portedTestDefinition(): ConnectorDefinition {
	return {
		...HTTP_JSON_DEFINITION,
		key: TEST_DEFINITION_KEY,
		allowedPorts: [443, ...TEST_PORTS],
	};
}

export function testDefinitions() {
	const registry = createConnectorDefinitionRegistry();
	registry.register({
		...HTTP_JSON_DEFINITION,
		allowedPorts: [443, ...TEST_PORTS],
	});
	return registry;
}

/**
 * Maps the names a test uses onto public addresses. The address block itself is
 * never weakened: a loopback server is reached because the resolver says the
 * name is public, exactly as a deployment would resolve a real host.
 */
export function publicResolver(
	map: Readonly<Record<string, string>>,
): HostAddressResolver {
	return async (hostname) => {
		const address = map[hostname];
		if (!address) throw new Error(`Unmapped host ${hostname}`);
		return [{ address }];
	};
}

/** The resolver every call test runs under: the test host answers publicly. */
export function testResolver(): HostAddressResolver {
	return publicResolver({ [TEST_HOST]: TEST_PUBLIC_ADDRESS });
}

/**
 * The connect seam a call test runs under. The policy verifies a public
 * address exactly as a deployment would, and the socket goes to the loopback
 * port the test server listens on; `dialled` records what the call path asked
 * to reach, which is how a pinned address is observed.
 */
export function testConnect(dialled?: string[]): ConnectorConnectSeam {
	return {
		dial: (address) => {
			dialled?.push(address);
			return '127.0.0.1';
		},
		ca: TEST_CERTIFICATE,
	};
}

export interface RecordedRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

export interface TestServer {
	readonly port: number;
	readonly requests: readonly RecordedRequest[];
	close(): Promise<void>;
}

export type TestServerHandler = (request: RecordedRequest) => {
	readonly status?: number;
	readonly body?: string;
	readonly contentType?: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** Chunks written one event-loop turn apart, so the reader sees a stream. */
	readonly chunks?: readonly string[];
	/** Holds the socket open: with `chunks`, after writing them. */
	readonly stall?: boolean;
};

/** A real TLS socket on 127.0.0.1, reached through the injected resolver. */
export async function startTestServer(
	handler: TestServerHandler,
): Promise<TestServer> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(
		{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
		(incoming: IncomingMessage, response) => {
			const chunks: Buffer[] = [];
			incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
			incoming.on('end', () => {
				const recorded: RecordedRequest = {
					method: incoming.method ?? 'GET',
					url: incoming.url ?? '/',
					headers: Object.fromEntries(
						Object.entries(incoming.headers).map(([key, value]) => [
							key,
							Array.isArray(value) ? value.join(',') : (value ?? ''),
						]),
					),
					body: Buffer.concat(chunks).toString('utf8'),
				};
				requests.push(recorded);
				const reply = handler(recorded);
				if (reply.stall === true && reply.chunks === undefined) return;
				response.writeHead(reply.status ?? 200, {
					'content-type': reply.contentType ?? 'application/json',
					...(reply.headers ?? {}),
				});
				if (reply.chunks === undefined) {
					response.end(reply.body ?? '{"ok":true}');
					return;
				}
				let index = 0;
				const push = () => {
					if (index < reply.chunks!.length) {
						response.write(reply.chunks![index++]);
						setTimeout(push, 5);
						return;
					}
					if (reply.stall !== true) response.end();
				};
				push();
			});
		},
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	TEST_PORTS.add(port);
	return {
		port,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** The https base URL of a test server, as an instance would hold it. */
export function testBaseUrl(server: TestServer, path = ''): string {
	return `https://${TEST_HOST}:${server.port}${path}`;
}

export interface SeedOptions {
	readonly tenantId: string;
	readonly baseUrl: string;
	readonly definitionKey?: string;
	readonly name?: string;
	readonly authKind?: ConnectorAuthKind;
	readonly credentials?: ConnectorCredentials;
	readonly allowedHosts?: readonly string[];
	readonly allowWorkflows?: boolean;
	readonly allowAgents?: boolean;
	readonly status?: 'active' | 'disabled';
}

/**
 * Writes an instance straight through the repository. Save-time egress rules
 * refuse a loopback URL by design, so a call test seeds the row the same way a
 * deployment would hold a public one and exercises the call path itself.
 */
export async function seedInstance(
	repository: ConnectorsRepository,
	vault: AesGcmCredentialVault,
	options: SeedOptions,
): Promise<StoredConnectorInstance> {
	const id = randomUUID();
	const credentials = options.credentials ?? { kind: 'none' };
	const plaintext = JSON.stringify(credentials);
	const context = credentialContext(options.tenantId, id);
	const sealed =
		credentials.kind === 'none' ? null : vault.seal(plaintext, context);
	const record: StoredConnectorInstance = {
		id,
		tenantId: options.tenantId,
		definitionKey: options.definitionKey ?? HTTP_JSON_DEFINITION.key,
		name: options.name ?? `connector-${id.slice(0, 8)}`,
		baseUrl: options.baseUrl,
		authKind: options.authKind ?? credentials.kind,
		credentialFingerprint:
			sealed === null ? null : vault.fingerprint(plaintext, context),
		allowedHosts: options.allowedHosts ?? [TEST_HOST],
		allowWorkflows: options.allowWorkflows ?? false,
		allowAgents: options.allowAgents ?? false,
		status: options.status ?? 'active',
		lastCallAt: null,
		createdAt: 1,
		updatedAt: 1,
		credential: sealed,
	};
	await repository.createInstance(record, {
		tenantId: options.tenantId,
		actorId: 'account-seed',
		action: 'instance.created',
		instanceId: id,
		metadata: {},
		occurredAt: 1,
	});
	return record;
}

export function callService(
	repository: ConnectorsRepository,
	vault: AesGcmCredentialVault,
	resolver: HostAddressResolver,
	limits: ConnectorCallLimits = TEST_LIMITS,
	connect: ConnectorConnectSeam = testConnect(),
): ConnectorCallService {
	return new ConnectorCallService({
		repository,
		vault,
		definitions: testDefinitions,
		limits: () => limits,
		hostResolver: resolver,
		connect,
	});
}

export function instanceService(
	repository: ConnectorsRepository,
	vault: AesGcmCredentialVault,
	invalidate?: (tenantId: string, instanceId: string) => void,
): ConnectorsService {
	return new ConnectorsService({
		repository,
		vault,
		definitions: testDefinitions,
		...(invalidate ? { invalidate } : {}),
	});
}
