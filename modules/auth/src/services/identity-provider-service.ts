import { randomUUID } from 'node:crypto';
import type { Actor } from '@flowdular/kernel';
import type {
	AuthActor,
	IdentityProviderStatus,
	IdentityProviderSummary,
} from '../domain/types.ts';
import type { OidcDiscovery } from '../server/oidc.ts';
import type { OidcProvider } from '../server/runtime.ts';
import { AuthServiceError } from './auth-service-error.ts';
import type { ProviderSecretVault } from './provider-secrets.ts';
import type {
	AuthRepository,
	IdentityProviderRecord,
	IdentityProviderPatch,
} from './repository.ts';
import { DuplicateProviderKeyError } from './repository.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const DOMAIN_PATTERN =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_LABEL = 120;
const MAX_ISSUER = 2_048;
const MAX_CLIENT_ID = 256;
const MAX_SECRET = 1_024;
const MAX_SCOPES = 16;
const MAX_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 253;
const MAX_ROLE_KEY = 64;
/* openid identifies the transaction and email is what bootstraps the first
   binding, so neither is optional however the administrator configures it. */
const REQUIRED_SCOPES = ['openid', 'email'] as const;

/** The provider discovery port; the server layer installs the HTTP adapter. */
export type OidcDiscoveryPort = (issuer: string) => Promise<OidcDiscovery>;

/**
 * What a create or an update carries. A create needs `label`, `issuer`,
 * `clientId` and `clientSecret`; an update is partial, and every field it
 * leaves out keeps the value the stored record already has.
 */
export interface IdentityProviderInput {
	readonly key?: string;
	readonly label?: string;
	readonly issuer?: string;
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly scopes?: readonly string[];
	readonly jitEnabled?: boolean;
	readonly allowedDomains?: readonly string[];
	readonly jitRole?: string;
}

/** Everything one sign-in through a tenant-owned provider needs. */
export interface TenantSignInProvider {
	readonly tenantId: string;
	readonly key: string;
	readonly oidc: OidcProvider;
	readonly jitEnabled: boolean;
	readonly allowedDomains: readonly string[];
	readonly jitRole: string;
	readonly scopes: readonly string[];
}

export interface IdentityProviderServiceOptions {
	readonly repository: AuthRepository;
	/** Built on first use so a deployment without the key still serves reads. */
	readonly vault: () => ProviderSecretVault;
	readonly now: () => number;
	readonly discover: OidcDiscoveryPort;
	/**
	 * Drops the ID token verifier's cached key set for one provider id, in the
	 * `tenantId:key` shape `resolveSignIn` publishes. A composition without a
	 * verifier installs a no-op.
	 */
	readonly forgetKeys?: (providerId: string) => void;
	readonly audit: (
		tenantId: string,
		actor: Actor,
		action: string,
		subjectType: string,
		subjectId: string,
		metadata?: Readonly<Record<string, unknown>>,
	) => Promise<void>;
}

export const PROVIDER_AUDIT_ACTIONS = Object.freeze({
	created: 'auth.provider.created',
	updated: 'auth.provider.updated',
	status: 'auth.provider.status',
	secretRotated: 'auth.provider.secret-rotated',
	deleted: 'auth.provider.deleted',
});

function invalid(message: string): AuthServiceError {
	return new AuthServiceError('INVALID_INPUT', message, 400);
}

function notFound(): AuthServiceError {
	/* A provider of another workspace and an id that never existed answer the
	   same way, so the response tells a caller nothing about other workspaces. */
	return new AuthServiceError(
		'PROVIDER_NOT_FOUND',
		'The identity provider does not exist in this workspace.',
		404,
	);
}

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > max) {
		throw invalid(`${field} must contain between 1 and ${max} characters.`);
	}
	return normalized;
}

function issuerUrl(value: unknown): string {
	const issuer = text(value, 'issuer', MAX_ISSUER);
	let url: URL;
	try {
		url = new URL(issuer);
	} catch {
		throw invalid('issuer must be an absolute HTTPS URL.');
	}
	if (url.protocol !== 'https:' || url.search || url.hash) {
		throw invalid('issuer must be an absolute HTTPS URL without a query.');
	}
	return issuer;
}

function providerScopes(value: unknown): readonly string[] {
	if (value === undefined) return [...REQUIRED_SCOPES];
	if (!Array.isArray(value) || value.length > MAX_SCOPES) {
		throw invalid(`scopes must be an array of at most ${MAX_SCOPES} entries.`);
	}
	for (const entry of value) {
		if (typeof entry !== 'string' || !SCOPE_PATTERN.test(entry)) {
			throw invalid('scopes must be provider scope identifiers.');
		}
	}
	return [...new Set([...REQUIRED_SCOPES, ...(value as readonly string[])])];
}

function allowedDomains(
	value: unknown,
	jitEnabled: boolean,
): readonly string[] {
	if (value === undefined) {
		if (jitEnabled) {
			throw invalid(
				'allowedDomains must list at least one domain when JIT is enabled.',
			);
		}
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_DOMAINS) {
		throw invalid(
			`allowedDomains must be an array of at most ${MAX_DOMAINS} domains.`,
		);
	}
	const domains = value.map((entry) => {
		if (typeof entry !== 'string')
			throw invalid('allowedDomains must be text.');
		const domain = entry.trim().toLowerCase();
		if (domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) {
			throw invalid(`allowedDomains contains an invalid domain: ${entry}`);
		}
		return domain;
	});
	const unique = [...new Set(domains)];
	if (jitEnabled && unique.length === 0) {
		throw invalid(
			'allowedDomains must list at least one domain when JIT is enabled.',
		);
	}
	return unique;
}

/**
 * The tenant-owned identity providers of one workspace. Reads never carry a
 * secret: the row holds the sealed envelope, the administrator sees only the
 * fingerprint, and the plaintext is opened for exactly one thing, the
 * authorization transaction the provider takes part in.
 */
export class IdentityProviderService {
	readonly #repository: AuthRepository;
	readonly #vault: () => ProviderSecretVault;
	readonly #now: () => number;
	readonly #discover: OidcDiscoveryPort;
	readonly #forgetKeys: (providerId: string) => void;
	readonly #audit: IdentityProviderServiceOptions['audit'];

	constructor(options: IdentityProviderServiceOptions) {
		this.#repository = options.repository;
		this.#vault = options.vault;
		this.#now = options.now;
		this.#discover = options.discover;
		this.#forgetKeys = options.forgetKeys ?? (() => undefined);
		this.#audit = options.audit;
	}

	/** The id `resolveSignIn` publishes to the verifier for one provider row. */
	#verifierId(record: { readonly tenantId: string; readonly key: string }) {
		return `${record.tenantId}:${record.key}`;
	}

	async list(tenantId: string): Promise<readonly IdentityProviderSummary[]> {
		return (await this.#repository.listIdentityProviders(tenantId)).map(
			summarize,
		);
	}

	async create(
		actor: AuthActor,
		raw: IdentityProviderInput,
	): Promise<IdentityProviderSummary> {
		const key = text(raw.key, 'key', 64).toLowerCase();
		if (!KEY_PATTERN.test(key)) {
			throw invalid(
				'key must start with a letter and contain lower-case letters, digits and hyphens.',
			);
		}
		const secret = text(raw.clientSecret, 'clientSecret', MAX_SECRET);
		const id = randomUUID();
		const shape = await this.#shape(actor.tenantId, id, raw, secret);
		const now = this.#now();
		let record: IdentityProviderRecord;
		try {
			record = await this.#repository.createIdentityProvider({
				id,
				tenantId: actor.tenantId,
				key,
				createdAt: now,
				updatedAt: now,
				...shape,
			});
		} catch (error) {
			if (error instanceof DuplicateProviderKeyError) {
				throw new AuthServiceError('PROVIDER_KEY_TAKEN', error.message, 409);
			}
			throw error;
		}
		await this.#audit(
			actor.tenantId,
			userActorOf(actor),
			PROVIDER_AUDIT_ACTIONS.created,
			'identity-provider',
			record.id,
			{ key: record.key, issuer: record.issuer },
		);
		return summarize(record);
	}

	async update(
		actor: AuthActor,
		id: string,
		raw: IdentityProviderInput,
	): Promise<IdentityProviderSummary> {
		const current = await this.#require(actor.tenantId, id);
		const shape = await this.#shape(
			actor.tenantId,
			current.id,
			raw,
			raw.clientSecret === undefined
				? null
				: text(raw.clientSecret, 'clientSecret', MAX_SECRET),
			current,
		);
		const updated = await this.#repository.updateIdentityProvider(
			actor.tenantId,
			current.id,
			{ ...shape, status: current.status },
			this.#now(),
		);
		if (!updated) throw notFound();
		/* The issuer may have moved, so the key set cached for this provider is
		   no longer the one it publishes. */
		this.#forgetKeys(this.#verifierId(updated));
		await this.#audit(
			actor.tenantId,
			userActorOf(actor),
			PROVIDER_AUDIT_ACTIONS.updated,
			'identity-provider',
			updated.id,
			{
				key: updated.key,
				issuer: updated.issuer,
				jitEnabled: updated.jitEnabled,
			},
		);
		return summarize(updated);
	}

	async rotateSecret(
		actor: AuthActor,
		id: string,
		rawSecret: unknown,
	): Promise<IdentityProviderSummary> {
		const current = await this.#require(actor.tenantId, id);
		const secret = text(rawSecret, 'clientSecret', MAX_SECRET);
		const vault = this.#vault();
		const sealed = vault.seal(
			{ tenantId: current.tenantId, providerId: current.id },
			secret,
		);
		const updated = await this.#repository.updateIdentityProvider(
			actor.tenantId,
			current.id,
			{
				...patchOf(current),
				secretCiphertext: sealed.ciphertext,
				secretKeyId: sealed.keyId,
				secretFingerprint: vault.fingerprint(secret),
			},
			this.#now(),
		);
		if (!updated) throw notFound();
		await this.#audit(
			actor.tenantId,
			userActorOf(actor),
			PROVIDER_AUDIT_ACTIONS.secretRotated,
			'identity-provider',
			updated.id,
			{ key: updated.key, fingerprint: updated.secretFingerprint },
		);
		return summarize(updated);
	}

	async setStatus(
		actor: AuthActor,
		id: string,
		status: IdentityProviderStatus,
	): Promise<IdentityProviderSummary> {
		const current = await this.#require(actor.tenantId, id);
		const updated = await this.#repository.updateIdentityProvider(
			actor.tenantId,
			current.id,
			{ ...patchOf(current), status },
			this.#now(),
		);
		if (!updated) throw notFound();
		await this.#audit(
			actor.tenantId,
			userActorOf(actor),
			PROVIDER_AUDIT_ACTIONS.status,
			'identity-provider',
			updated.id,
			{ key: updated.key, status },
		);
		return summarize(updated);
	}

	/* Deleting an offered provider would take a sign-in path away from the
	   people using it without warning, so it is disabled first and deleted
	   after. Its bindings go with it; the accounts and every other way in stay. */
	async remove(actor: AuthActor, id: string): Promise<void> {
		const current = await this.#require(actor.tenantId, id);
		if (current.status !== 'disabled') {
			throw new AuthServiceError(
				'PROVIDER_ACTIVE',
				'Disable the provider before deleting it.',
				409,
			);
		}
		await this.#repository.deleteExternalIdentitiesOfProvider(
			actor.tenantId,
			current.key,
		);
		if (!(await this.#repository.deleteIdentityProvider(actor.tenantId, id))) {
			throw notFound();
		}
		this.#forgetKeys(this.#verifierId(current));
		await this.#audit(
			actor.tenantId,
			userActorOf(actor),
			PROVIDER_AUDIT_ACTIONS.deleted,
			'identity-provider',
			current.id,
			{ key: current.key },
		);
	}

	/** The enabled providers a workspace offers on its sign-in screen. */
	async listEnabled(
		tenantId: string,
	): Promise<readonly IdentityProviderRecord[]> {
		return (await this.#repository.listIdentityProviders(tenantId)).filter(
			(record) => record.status === 'active',
		);
	}

	/**
	 * Opens one enabled provider for an authorization transaction. A disabled or
	 * unknown key resolves to nothing, so a sign-in cannot start on either.
	 */
	async resolveSignIn(
		tenantId: string,
		key: string,
	): Promise<TenantSignInProvider | null> {
		const record = await this.#repository.findIdentityProviderByKey(
			tenantId,
			key,
		);
		if (!record || record.status !== 'active') return null;
		const clientSecret = this.#vault().open(
			{ tenantId: record.tenantId, providerId: record.id },
			record.secretCiphertext,
			record.secretKeyId,
		);
		return {
			tenantId: record.tenantId,
			key: record.key,
			oidc: {
				/* The verifier caches key sets by this id, so it carries the
				   workspace: two workspaces may configure the same issuer. */
				id: this.#verifierId(record),
				issuer: record.issuer,
				authorizationEndpoint: record.authorizationEndpoint,
				tokenEndpoint: record.tokenEndpoint,
				userInfoEndpoint: record.userInfoEndpoint,
				clientId: record.clientId,
				clientSecret,
			},
			jitEnabled: record.jitEnabled,
			allowedDomains: record.allowedDomains,
			jitRole: record.jitRole,
			scopes: record.scopes,
		};
	}

	async #require(
		tenantId: string,
		id: string,
	): Promise<IdentityProviderRecord> {
		const record = await this.#repository.findIdentityProvider(
			tenantId,
			text(id, 'id', 128),
		);
		if (!record) throw notFound();
		return record;
	}

	/* The validated columns of a create or an update. An update merges: a field
	   the caller left out keeps the stored value, and the merged result is
	   validated as a whole, so turning JIT on without sending domains is refused
	   when the stored list is empty. A changed issuer is verified through
	   discovery again, and the endpoints are whatever that document published. */
	async #shape(
		tenantId: string,
		providerId: string,
		raw: IdentityProviderInput,
		secret: string | null,
		current?: IdentityProviderRecord,
	): Promise<IdentityProviderPatch> {
		const label =
			raw.label === undefined && current
				? current.label
				: text(raw.label, 'label', MAX_LABEL);
		const issuer =
			raw.issuer === undefined && current
				? current.issuer
				: issuerUrl(raw.issuer);
		const clientId =
			raw.clientId === undefined && current
				? current.clientId
				: text(raw.clientId, 'clientId', MAX_CLIENT_ID);
		const jitEnabled =
			raw.jitEnabled === undefined
				? (current?.jitEnabled ?? false)
				: raw.jitEnabled === true;
		const domains = allowedDomains(
			raw.allowedDomains ?? current?.allowedDomains,
			jitEnabled,
		);
		const jitRole =
			raw.jitRole === undefined
				? (current?.jitRole ?? 'member')
				: text(raw.jitRole, 'jitRole', MAX_ROLE_KEY);
		if (!(await this.#repository.findRoleByKey(tenantId, jitRole))) {
			throw new AuthServiceError(
				'ROLE_NOT_FOUND',
				'The role does not exist in this workspace.',
				404,
			);
		}
		const endpoints =
			current && current.issuer === issuer
				? {
						authorizationEndpoint: current.authorizationEndpoint,
						tokenEndpoint: current.tokenEndpoint,
						userInfoEndpoint: current.userInfoEndpoint,
					}
				: await this.#discover(issuer);
		let secretCiphertext: string;
		let secretKeyId: string;
		let secretFingerprint: string;
		if (secret !== null) {
			const vault = this.#vault();
			const sealed = vault.seal({ tenantId, providerId }, secret);
			secretCiphertext = sealed.ciphertext;
			secretKeyId = sealed.keyId;
			secretFingerprint = vault.fingerprint(secret);
		} else if (current) {
			secretCiphertext = current.secretCiphertext;
			secretKeyId = current.secretKeyId;
			secretFingerprint = current.secretFingerprint;
		} else {
			throw invalid('clientSecret must be a string.');
		}
		return {
			label,
			issuer,
			...endpoints,
			clientId,
			secretCiphertext,
			secretKeyId,
			secretFingerprint,
			scopes: providerScopes(raw.scopes ?? current?.scopes),
			jitEnabled,
			allowedDomains: domains,
			jitRole,
			status: current?.status ?? 'active',
		};
	}
}

function userActorOf(actor: AuthActor): Actor {
	return { kind: 'user', id: actor.accountId, label: actor.email };
}

function patchOf(record: IdentityProviderRecord): IdentityProviderPatch {
	return {
		label: record.label,
		issuer: record.issuer,
		authorizationEndpoint: record.authorizationEndpoint,
		tokenEndpoint: record.tokenEndpoint,
		userInfoEndpoint: record.userInfoEndpoint,
		clientId: record.clientId,
		secretCiphertext: record.secretCiphertext,
		secretKeyId: record.secretKeyId,
		secretFingerprint: record.secretFingerprint,
		scopes: record.scopes,
		jitEnabled: record.jitEnabled,
		allowedDomains: record.allowedDomains,
		jitRole: record.jitRole,
		status: record.status,
	};
}

/** The administrator's view of a workspace provider row. */
export function summarize(
	record: IdentityProviderRecord,
): IdentityProviderSummary {
	return {
		id: record.id,
		key: record.key,
		label: record.label,
		issuer: record.issuer,
		clientId: record.clientId,
		scopes: record.scopes,
		jitEnabled: record.jitEnabled,
		allowedDomains: record.allowedDomains,
		jitRole: record.jitRole,
		status: record.status,
		secretFingerprint: record.secretFingerprint,
		scope: 'tenant',
		updatedAt: record.updatedAt,
	};
}
