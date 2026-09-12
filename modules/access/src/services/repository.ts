import type {
	AccessAttestation,
	AttestationPosition,
} from '../domain/types.ts';

export interface AttestationQuery {
	readonly limit: number;
	/** Keyset of the last row of the previous page, newest first. */
	readonly after: AttestationPosition | null;
}

/**
 * The attestation ledger, and nothing else: memberships, roles, tokens,
 * providers and the audit trail belong to auth.core and are read through the
 * directory port instead. There is no update and no delete, because the ledger
 * is append-only.
 */
export interface AccessRepository {
	append(record: AccessAttestation): Promise<AccessAttestation>;
	list(
		tenantId: string,
		query: AttestationQuery,
	): Promise<readonly AccessAttestation[]>;
	/** Oldest first, for the data class export walk. */
	exportPage(
		tenantId: string,
		after: AttestationPosition | null,
		limit: number,
	): Promise<readonly AccessAttestation[]>;
}
