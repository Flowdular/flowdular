import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from 'node:crypto';
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';

const GRANT_ISSUER = 'coreloom-control-plane';
const GRANT_AUDIENCE = 'agent-provider-broker';

export interface AgentRunGrantClaims {
	readonly version: 1;
	readonly issuer: typeof GRANT_ISSUER;
	readonly audience: typeof GRANT_AUDIENCE;
	readonly grantId: string;
	readonly tenantId: string;
	readonly runId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly workerId: string;
	readonly attempt: number;
	readonly permissionDigest: string;
	readonly toolGrantDigest: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
}

export interface IssuedAgentRunGrant {
	readonly token: string;
	readonly claims: AgentRunGrantClaims;
}

export interface IssueAgentRunGrantInput {
	readonly tenantId: string;
	readonly runId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly workerId: string;
	readonly attempt: number;
	readonly permissions: readonly string[];
	readonly toolGrants: readonly string[];
	readonly leaseExpiresAt: number;
}

export class AgentRunGrantError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AgentRunGrantError';
	}
}

function digest(values: readonly string[]): string {
	return createHash('sha256')
		.update(JSON.stringify([...new Set(values)].sort()), 'utf8')
		.digest('base64url');
}

function grantKey(value: string): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== 32) {
		key.fill(0);
		throw new Error(
			'CL_AGENT_RUN_GRANT_KEY must be a base64-encoded 32-byte key.',
		);
	}
	return key;
}

function readOrCreateDevelopmentKey(path: string): Buffer {
	try {
		return grantKey(readFileSync(path, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, 'wx', 0o600);
	try {
		const encoded = randomBytes(32).toString('base64');
		writeFileSync(descriptor, encoded, { encoding: 'utf8' });
		return grantKey(encoded);
	} finally {
		closeSync(descriptor);
	}
}

function stringClaim(value: unknown, field: string, maximum = 256): string {
	if (
		typeof value !== 'string' ||
		value.length < 1 ||
		value.length > maximum ||
		value.includes('\u0000')
	) {
		throw new AgentRunGrantError(
			'RUN_GRANT_INVALID',
			`Run grant ${field} is invalid.`,
		);
	}
	return value;
}

function numberClaim(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new AgentRunGrantError(
			'RUN_GRANT_INVALID',
			`Run grant ${field} is invalid.`,
		);
	}
	return value as number;
}

export class AgentRunGrantAuthority {
	readonly #key: Buffer;
	readonly #now: () => number;

	constructor(
		key: Buffer,
		private readonly ttlMs = 30_000,
		now: () => number = Date.now,
	) {
		if (key.byteLength !== 32) {
			throw new Error('Run grant signing requires a 32-byte key.');
		}
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) {
			throw new Error('Run grant TTL must be between 1000 and 300000 ms.');
		}
		this.#key = Buffer.from(key);
		this.#now = now;
	}

	issue(input: IssueAgentRunGrantInput): IssuedAgentRunGrant {
		const issuedAt = this.#now();
		const expiresAt = Math.min(issuedAt + this.ttlMs, input.leaseExpiresAt);
		if (expiresAt - issuedAt < 500) {
			throw new AgentRunGrantError(
				'RUN_GRANT_LEASE_TOO_SHORT',
				'The worker lease is too short to issue a run grant.',
			);
		}
		const claims: AgentRunGrantClaims = {
			version: 1,
			issuer: GRANT_ISSUER,
			audience: GRANT_AUDIENCE,
			grantId: randomUUID(),
			tenantId: stringClaim(input.tenantId, 'tenantId'),
			runId: stringClaim(input.runId, 'runId'),
			providerId: stringClaim(input.providerId, 'providerId'),
			modelId: stringClaim(input.modelId, 'modelId'),
			workerId: stringClaim(input.workerId, 'workerId'),
			attempt: numberClaim(input.attempt, 'attempt'),
			permissionDigest: digest(input.permissions),
			toolGrantDigest: digest(input.toolGrants),
			issuedAt,
			expiresAt,
		};
		const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
			'base64url',
		);
		const signed = `v1.${payload}`;
		const signature = createHmac('sha256', this.#key)
			.update(signed, 'utf8')
			.digest('base64url');
		return { token: `${signed}.${signature}`, claims };
	}

	verify(token: string): AgentRunGrantClaims {
		if (token.length < 64 || token.length > 8_192) {
			throw new AgentRunGrantError(
				'RUN_GRANT_INVALID',
				'Run grant is invalid.',
			);
		}
		const [version, payload, signature, extra] = token.split('.');
		if (version !== 'v1' || !payload || !signature || extra !== undefined) {
			throw new AgentRunGrantError(
				'RUN_GRANT_INVALID',
				'Run grant is invalid.',
			);
		}
		const expected = createHmac('sha256', this.#key)
			.update(`${version}.${payload}`, 'utf8')
			.digest();
		let supplied: Buffer;
		try {
			supplied = Buffer.from(signature, 'base64url');
		} catch {
			throw new AgentRunGrantError(
				'RUN_GRANT_INVALID',
				'Run grant is invalid.',
			);
		}
		if (
			supplied.byteLength !== expected.byteLength ||
			!timingSafeEqual(supplied, expected)
		) {
			throw new AgentRunGrantError(
				'RUN_GRANT_SIGNATURE_INVALID',
				'Run grant signature is invalid.',
			);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		} catch {
			throw new AgentRunGrantError(
				'RUN_GRANT_INVALID',
				'Run grant payload is invalid.',
			);
		}
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new AgentRunGrantError(
				'RUN_GRANT_INVALID',
				'Run grant payload is invalid.',
			);
		}
		const value = raw as Record<string, unknown>;
		if (
			value.version !== 1 ||
			value.issuer !== GRANT_ISSUER ||
			value.audience !== GRANT_AUDIENCE
		) {
			throw new AgentRunGrantError(
				'RUN_GRANT_BOUNDARY_INVALID',
				'Run grant issuer or audience is invalid.',
			);
		}
		const claims: AgentRunGrantClaims = {
			version: 1,
			issuer: GRANT_ISSUER,
			audience: GRANT_AUDIENCE,
			grantId: stringClaim(value.grantId, 'grantId'),
			tenantId: stringClaim(value.tenantId, 'tenantId'),
			runId: stringClaim(value.runId, 'runId'),
			providerId: stringClaim(value.providerId, 'providerId'),
			modelId: stringClaim(value.modelId, 'modelId'),
			workerId: stringClaim(value.workerId, 'workerId'),
			attempt: numberClaim(value.attempt, 'attempt'),
			permissionDigest: stringClaim(
				value.permissionDigest,
				'permissionDigest',
				64,
			),
			toolGrantDigest: stringClaim(
				value.toolGrantDigest,
				'toolGrantDigest',
				64,
			),
			issuedAt: numberClaim(value.issuedAt, 'issuedAt'),
			expiresAt: numberClaim(value.expiresAt, 'expiresAt'),
		};
		const now = this.#now();
		if (
			claims.issuedAt > now + 5_000 ||
			claims.expiresAt <= now ||
			claims.expiresAt - claims.issuedAt > this.ttlMs
		) {
			throw new AgentRunGrantError(
				'RUN_GRANT_EXPIRED',
				'Run grant is expired or outside its allowed lifetime.',
			);
		}
		return claims;
	}

	tokenHash(token: string): string {
		return createHash('sha256').update(token, 'utf8').digest('base64url');
	}
}

export function runGrantAuthorityFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
	ttlMs = 30_000,
): AgentRunGrantAuthority {
	const configured = environment.CL_AGENT_RUN_GRANT_KEY;
	if (configured)
		return new AgentRunGrantAuthority(grantKey(configured), ttlMs);
	if (environment.NODE_ENV === 'production') {
		throw new Error(
			'CL_AGENT_RUN_GRANT_KEY is required in production before agent runs can execute.',
		);
	}
	if (environment.NODE_ENV === 'test') {
		return new AgentRunGrantAuthority(Buffer.alloc(32, 0x47), ttlMs);
	}
	return new AgentRunGrantAuthority(
		readOrCreateDevelopmentKey(
			coreloomLocalDataPath(workspaceRoot, 'agent-run-grant.key'),
		),
		ttlMs,
	);
}
