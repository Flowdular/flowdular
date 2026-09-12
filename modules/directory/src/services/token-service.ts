import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from 'node:crypto';
import type { IssuedScimToken, ScimToken } from '../domain/types.ts';
import { DirectoryUniqueViolation } from './database-repository.ts';
import type { DirectoryRepository } from './repository.ts';
import { bounded, DirectoryServiceError } from './service-error.ts';

/** Distinct from the member API token prefix, so the two can never be confused. */
export const SCIM_TOKEN_PREFIX = 'fdscim_';

const SCIM_TOKEN_PATTERN = /^fdscim_[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_LENGTH = 32;
const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;
/** Bounds the write amplification of a busy provider to one row per minute. */
const TOUCH_INTERVAL_MS = 60_000;

export function hashScimToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function scimTokenFingerprint(token: string): string {
	return hashScimToken(token).slice(0, FINGERPRINT_LENGTH);
}

export interface CreateScimTokenInput {
	readonly label: string;
	readonly expiresAt: number | null;
}

export class ScimTokenService {
	/* Compared against when no row matched, so an unknown credential costs the
	   same comparison as a real one and cannot be timed apart. */
	readonly #decoyHash = randomBytes(32).toString('hex');

	constructor(
		private readonly repository: DirectoryRepository,
		private readonly now: () => number = Date.now,
	) {}

	list(tenantId: string): Promise<readonly ScimToken[]> {
		return this.repository.listTokens(tenantId);
	}

	async create(
		tenantId: string,
		createdBy: string,
		input: CreateScimTokenInput,
	): Promise<IssuedScimToken> {
		const label = bounded(input.label, 'label', 2, 120);
		const createdAt = this.now();
		const expiresAt = this.#expiry(input.expiresAt, createdAt);
		const token = mintToken();
		const record = {
			id: randomUUID(),
			tenantId,
			label,
			tokenFingerprint: scimTokenFingerprint(token),
			tokenHash: hashScimToken(token),
			status: 'active' as const,
			createdBy,
			createdAt,
			lastUsedAt: null,
			expiresAt,
			revokedAt: null,
		};
		try {
			await this.repository.insertToken(record);
		} catch (error) {
			/* The unique index is the only authority on the label: a pre-read would
			   answer from a state another request can move before the insert. */
			if (error instanceof DirectoryUniqueViolation) {
				throw new DirectoryServiceError(
					'TOKEN_LABEL_EXISTS',
					'A token with this label already exists in the workspace.',
					409,
				);
			}
			throw error;
		}
		const { tokenHash: _hash, ...visible } = record;
		return { record: visible, token };
	}

	/* Rotation keeps the label and the identity of the credential so the log
	   stays readable, and replaces the secret, which revokes the old value.
	   Revocation is terminal: rotating a revoked token would put a working
	   credential back on a label an owner already stopped. */
	async rotate(
		tenantId: string,
		id: string,
		expiresAt: number | null,
	): Promise<IssuedScimToken> {
		const current = await this.#require(tenantId, id);
		if (current.status !== 'active') throw this.#revoked();
		const token = mintToken();
		const replaced = await this.repository.replaceTokenSecret({
			tenantId,
			id: current.id,
			tokenFingerprint: scimTokenFingerprint(token),
			tokenHash: hashScimToken(token),
			expiresAt: this.#expiry(expiresAt, this.now()),
		});
		if (!replaced) {
			/* The statement writes only an active row, so a revoke that landed
			   between the read and the write answers the same refusal. */
			const stored = await this.repository.findTokenById(tenantId, current.id);
			throw stored && stored.status !== 'active'
				? this.#revoked()
				: this.#notFound();
		}
		const record = await this.repository.findTokenById(tenantId, current.id);
		if (!record) throw this.#notFound();
		return { record, token };
	}

	async revoke(tenantId: string, id: string): Promise<ScimToken> {
		const current = await this.#require(tenantId, id);
		if (current.status === 'revoked') return current;
		await this.repository.revokeToken(tenantId, current.id, this.now());
		return (await this.repository.findTokenById(tenantId, id)) ?? current;
	}

	/**
	 * Resolves a presented credential to the token that authorizes the request,
	 * or null. Every refusal answers the same way: the caller cannot tell an
	 * unknown token from a revoked, expired or foreign one.
	 */
	async authenticate(
		tenantId: string,
		presented: string,
	): Promise<ScimToken | null> {
		if (!SCIM_TOKEN_PATTERN.test(presented)) return null;
		const digest = hashScimToken(presented);
		const record = await this.repository.findTokenByFingerprint(
			tenantId,
			digest.slice(0, FINGERPRINT_LENGTH),
		);
		const matches = equalHex(record?.tokenHash ?? this.#decoyHash, digest);
		if (!record || !matches || record.status !== 'active') return null;
		const now = this.now();
		if (record.expiresAt !== null && record.expiresAt <= now) return null;
		if (
			record.lastUsedAt === null ||
			now - record.lastUsedAt > TOUCH_INTERVAL_MS
		) {
			await this.repository.touchToken(tenantId, record.id, now);
		}
		const { tokenHash: _hash, ...visible } = record;
		return visible;
	}

	async #require(tenantId: string, id: string): Promise<ScimToken> {
		const record = await this.repository.findTokenById(
			tenantId,
			bounded(id, 'id', 1, 128),
		);
		if (!record) throw this.#notFound();
		return record;
	}

	#notFound(): DirectoryServiceError {
		return new DirectoryServiceError(
			'TOKEN_NOT_FOUND',
			'The token does not exist in this workspace.',
			404,
		);
	}

	#revoked(): DirectoryServiceError {
		return new DirectoryServiceError(
			'TOKEN_REVOKED',
			'A revoked token cannot be rotated; create a new one instead.',
			409,
		);
	}

	#expiry(value: number | null, createdAt: number): number | null {
		if (value === null) return null;
		if (
			!Number.isSafeInteger(value) ||
			value <= createdAt ||
			value - createdAt > MAX_TOKEN_LIFETIME_MS
		) {
			throw new DirectoryServiceError(
				'INVALID_EXPIRY',
				'Token expiry must be a future timestamp within one year.',
			);
		}
		return value;
	}
}

function mintToken(): string {
	return SCIM_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

function equalHex(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
