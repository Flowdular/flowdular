import { createHash, randomUUID } from 'node:crypto';
import {
	definitionAllowedPorts,
	type ConnectorDefinitionRegistry,
} from '../domain/definitions.ts';
import type {
	ConnectorModuleInstance,
	ConnectorModuleInstanceInput,
} from '../domain/instances.ts';
import {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_CALL_OUTCOMES,
	CONNECTOR_INSTANCE_STATUSES,
	type ConnectorAuditEvent,
	type ConnectorAuthKind,
	type ConnectorCallListRow,
	type ConnectorCredentials,
	type ConnectorDefinition,
	type ConnectorInstance,
	type CreateConnectorInstanceInput,
	type ConnectorConsentInput,
	type UpdateConnectorInstanceInput,
} from '../domain/types.ts';
import {
	credentialContext,
	MAX_CREDENTIAL_CHARACTERS,
	type CredentialVault,
} from './credential-vault.ts';
import {
	connectorHostAllowlist,
	createConnectorEgressPolicy,
	ConnectorEgressError,
	normalizeHost,
	type HostAddressResolver,
} from './egress.ts';
import {
	DuplicateConnectorNameError,
	type ConnectorCallFilters,
	type ConnectorExportCursor,
	type ConnectorInstanceFilters,
	type ConnectorInstanceKeyset,
	type ConnectorListDirection,
	type ConnectorsRepository,
	type PendingConnectorAuditEvent,
	type StoredConnectorInstance,
} from './repository.ts';
import { bounded, ConnectorsServiceError, oneOf } from './service-error.ts';

export const MAX_ALLOWED_HOSTS = 32;
export const MAX_HOST_CHARACTERS = 253;
/** The default page of a list screen, and the ceiling it may ask for. */
export const DEFAULT_PAGE_LIMIT = 50;
export const LIST_PAGE_LIMIT = 200;
export const AUDIT_PAGE_LIMIT = 50;
export const MAX_SEARCH_CHARACTERS = 120;

/* Each key names a column an index on (tenant_id, column, id) carries; a sort
   key without one would page by a sequential scan. */
export const INSTANCE_SORT_KEYS = ['name'] as const;
export const CALL_SORT_KEYS = ['occurredAt'] as const;
export const LIST_DIRECTIONS = ['asc', 'desc'] as const;
export type ConnectorInstanceSort = (typeof INSTANCE_SORT_KEYS)[number];
export type ConnectorCallSort = (typeof CALL_SORT_KEYS)[number];

export interface ConnectorInstanceListQuery {
	readonly filters?: ConnectorInstanceFilters | undefined;
	readonly sort?: ConnectorInstanceSort | undefined;
	readonly direction?: ConnectorListDirection | undefined;
	readonly after?: ConnectorInstanceKeyset | null | undefined;
	/** Required, so no caller mistakes a page for the whole set. */
	readonly limit: number;
}

export interface ConnectorCallListQuery {
	readonly sort?: ConnectorCallSort | undefined;
	readonly direction?: ConnectorListDirection | undefined;
	readonly after?: ConnectorExportCursor | null | undefined;
	readonly limit: number;
}

const MODULE_INSTANCE_KEY = /^[a-z][a-z0-9-]{0,63}$/;

/* A digest of the workspace, the module and the key in UUID form (version 8),
   so one module key names one instance per workspace and no owner route, which
   mints random version 4 identifiers, can ever produce it. */
export function moduleInstanceId(
	tenantId: string,
	moduleId: string,
	key: string,
): string {
	const hex = createHash('sha256')
		.update(
			`connectors-module-instance\u0000${tenantId}\u0000${moduleId}\u0000${key}`,
		)
		.digest('hex');
	const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function textInput(
	value: unknown,
	field: string,
	minimum: number,
	maximum: number,
): string {
	if (typeof value !== 'string') {
		throw new ConnectorsServiceError('INVALID_INPUT', `${field} must be text.`);
	}
	return bounded(value, field, minimum, maximum);
}

function moduleInstanceOf(
	instance: ConnectorInstance,
	moduleId: string,
	key: string,
): ConnectorModuleInstance {
	return {
		id: instance.id,
		moduleId,
		key,
		definition: instance.definitionKey,
		name: instance.name,
		baseUrl: instance.baseUrl,
		authKind: instance.authKind,
		hasCredentials: instance.credentialFingerprint !== null,
		allowedHosts: instance.allowedHosts,
		allowAgents: instance.allowAgents,
		allowWorkflows: instance.allowWorkflows,
		status: instance.status,
		updatedAt: instance.updatedAt,
	};
}

const HOST_PATTERN =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export interface ConnectorsServiceOptions {
	readonly repository: ConnectorsRepository;
	readonly vault: CredentialVault;
	readonly definitions: () => ConnectorDefinitionRegistry;
	/** Test seam for the address check; never reachable from configuration. */
	readonly hostResolver?: HostAddressResolver | undefined;
	/** Drops anything the call path cached for an instance that just changed. */
	readonly invalidate?: (tenantId: string, instanceId: string) => void;
	readonly now?: () => number;
}

function pageLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > LIST_PAGE_LIMIT) {
		throw new ConnectorsServiceError(
			'INVALID_INPUT',
			`limit must be an integer between 1 and ${LIST_PAGE_LIMIT}.`,
		);
	}
	return value;
}

function searchTerm(value: string | undefined): string | undefined {
	return value === undefined || value.trim() === ''
		? undefined
		: bounded(value, 'q', 1, MAX_SEARCH_CHARACTERS);
}

function egressFailure(error: unknown): never {
	if (error instanceof ConnectorEgressError) {
		throw new ConnectorsServiceError('EGRESS_REFUSED', error.message);
	}
	throw error;
}

function host(value: string, field: string): string {
	const normalized = bounded(value, field, 1, MAX_HOST_CHARACTERS)
		.toLowerCase()
		.trim();
	if (!HOST_PATTERN.test(normalized)) {
		throw new ConnectorsServiceError(
			'INVALID_INPUT',
			`${field} must be a host name without a scheme or a path.`,
		);
	}
	return normalized;
}

function allowedHostList(
	value: readonly string[],
	baseHost: string,
): readonly string[] {
	if (value.length > MAX_ALLOWED_HOSTS) {
		throw new ConnectorsServiceError(
			'INVALID_INPUT',
			`allowedHosts accepts at most ${MAX_ALLOWED_HOSTS} entries.`,
		);
	}
	/* An empty list would be an instance without a bound, so the base URL host
	   is the default rather than "any host the egress policy tolerates". */
	const hosts = new Set(
		value.map((entry, index) => host(entry, `allowedHosts[${index}]`)),
	);
	if (hosts.size === 0) hosts.add(baseHost);
	if (!hosts.has(baseHost)) {
		throw new ConnectorsServiceError(
			'HOST_NOT_ALLOWLISTED',
			'The base URL host must be on the instance host allowlist.',
		);
	}
	return [...hosts].sort();
}

function credentialText(
	value: Record<string, unknown>,
	key: string,
	max: number,
): string {
	const entry = value[key];
	if (typeof entry !== 'string' || entry.trim().length === 0) {
		throw new ConnectorsServiceError(
			'CREDENTIAL_INVALID',
			`credentials.${key} is required for this authentication kind.`,
		);
	}
	const normalized = entry.trim();
	if (normalized.length > max) {
		throw new ConnectorsServiceError(
			'CREDENTIAL_INVALID',
			`credentials.${key} must contain at most ${max} characters.`,
		);
	}
	/* A control character in a credential is a header or a form-body injection
	   once the call path puts it on the wire, so it is refused at the door. */
	if (/[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new ConnectorsServiceError(
			'CREDENTIAL_INVALID',
			`credentials.${key} must not contain control characters.`,
		);
	}
	return normalized;
}

export class ConnectorsService {
	readonly #options: ConnectorsServiceOptions;
	readonly #now: () => number;

	constructor(options: ConnectorsServiceOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	definitions(): readonly ConnectorDefinition[] {
		return this.#options.definitions().list();
	}

	list(
		tenantId: string,
		query: ConnectorInstanceListQuery,
	): Promise<readonly ConnectorInstance[]> {
		const filters = query.filters ?? {};
		oneOf(query.sort ?? 'name', 'sort', INSTANCE_SORT_KEYS);
		return this.#options.repository.listInstances(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				status: filters.status
					? oneOf(filters.status, 'status', CONNECTOR_INSTANCE_STATUSES)
					: undefined,
				definitionKey: filters.definitionKey
					? bounded(filters.definitionKey, 'definition', 1, 96)
					: undefined,
				search: searchTerm(filters.search),
			},
			{
				direction: oneOf(
					query.direction ?? 'asc',
					'direction',
					LIST_DIRECTIONS,
				),
				after:
					query.after === undefined || query.after === null
						? null
						: {
								name: bounded(query.after.name, 'cursor', 1, 120),
								id: bounded(query.after.id, 'cursor', 1, 128),
							},
				limit: pageLimit(query.limit),
			},
		);
	}

	listCalls(
		tenantId: string,
		filters: ConnectorCallFilters,
		query: ConnectorCallListQuery,
	): Promise<readonly ConnectorCallListRow[]> {
		oneOf(query.sort ?? 'occurredAt', 'sort', CALL_SORT_KEYS);
		return this.#options.repository.listCalls(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				outcome: filters.outcome
					? oneOf(filters.outcome, 'outcome', CONNECTOR_CALL_OUTCOMES)
					: undefined,
				instanceId: filters.instanceId
					? bounded(filters.instanceId, 'instanceId', 1, 128)
					: undefined,
				search: searchTerm(filters.search),
			},
			{
				direction: oneOf(
					query.direction ?? 'desc',
					'direction',
					LIST_DIRECTIONS,
				),
				after:
					query.after === undefined || query.after === null
						? null
						: {
								occurredAt: query.after.occurredAt,
								id: bounded(query.after.id, 'cursor', 1, 128),
							},
				limit: pageLimit(query.limit),
			},
		);
	}

	listAudit(
		tenantId: string,
		instanceId: string,
	): Promise<readonly ConnectorAuditEvent[]> {
		return this.#options.repository.listAudit(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(instanceId, 'instanceId', 1, 128),
			AUDIT_PAGE_LIMIT,
		);
	}

	async create(
		tenantId: string,
		actorId: string,
		input: CreateConnectorInstanceInput,
	): Promise<ConnectorInstance> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const definition = this.#definition(input.definitionKey);
		const name = bounded(input.name, 'name', 1, 120);
		const authKind = oneOf(input.authKind, 'authKind', CONNECTOR_AUTH_KINDS);
		if (!definition.authKinds.includes(authKind)) {
			throw new ConnectorsServiceError(
				'AUTH_KIND_UNSUPPORTED',
				`Definition ${definition.key} does not support ${authKind}.`,
			);
		}
		const url = this.#assertBaseUrl(definition, input.baseUrl);
		const allowedHosts = allowedHostList(
			input.allowedHosts,
			normalizeHost(url.hostname),
		);
		const credentials = this.#credentials(authKind, input.credentials, {
			allowedHosts,
			definition,
		});
		const id = randomUUID();
		const timestamp = this.#now();
		const sealed = this.#seal(tenant, id, credentials);
		const record: StoredConnectorInstance = {
			id,
			tenantId: tenant,
			definitionKey: definition.key,
			name,
			baseUrl: url.href,
			authKind,
			credentialFingerprint: sealed.fingerprint,
			allowedHosts,
			allowWorkflows: false,
			allowAgents: false,
			status: 'active',
			lastCallAt: null,
			createdAt: timestamp,
			updatedAt: timestamp,
			credential: sealed.envelope,
		};
		return this.#write(() =>
			this.#options.repository.createInstance(
				record,
				this.#audit(tenant, actor, 'instance.created', id, timestamp, {
					definitionKey: definition.key,
					authKind,
				}),
			),
		);
	}

	async update(
		tenantId: string,
		actorId: string,
		instanceId: string,
		input: UpdateConnectorInstanceInput,
	): Promise<ConnectorInstance> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const existing = await this.#require(tenant, instanceId);
		const definition = this.#definition(existing.definitionKey);
		const name = bounded(input.name, 'name', 1, 120);
		const url = this.#assertBaseUrl(definition, input.baseUrl);
		const allowedHosts = allowedHostList(
			input.allowedHosts,
			normalizeHost(url.hostname),
		);
		const timestamp = this.#now();
		const replaced =
			input.credentials === undefined
				? null
				: this.#seal(
						tenant,
						existing.id,
						this.#credentials(existing.authKind, input.credentials, {
							allowedHosts,
							definition,
						}),
					);
		const record: StoredConnectorInstance = {
			...existing,
			name,
			baseUrl: url.href,
			allowedHosts,
			updatedAt: timestamp,
			credentialFingerprint:
				replaced?.fingerprint ?? existing.credentialFingerprint,
			credential: replaced?.envelope ?? existing.credential,
		};
		const updated = await this.#write(() =>
			this.#options.repository.updateInstance(
				record,
				this.#audit(tenant, actor, 'instance.updated', existing.id, timestamp, {
					credentialChanged: replaced !== null,
				}),
			),
		);
		this.#options.invalidate?.(tenant, existing.id);
		return updated;
	}

	async consent(
		tenantId: string,
		actorId: string,
		instanceId: string,
		input: ConnectorConsentInput,
	): Promise<ConnectorInstance> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const id = bounded(instanceId, 'instanceId', 1, 128);
		/* Consent raises what an unattended caller may do, so it is recorded only
		   with the owner's explicit confirmation of this exact change. */
		if (input.confirmed !== true) {
			throw new ConnectorsServiceError(
				'CONSENT_NOT_CONFIRMED',
				'A consent change requires an explicit confirmation.',
			);
		}
		const timestamp = this.#now();
		const updated = await this.#options.repository.setConsent(
			tenant,
			id,
			{
				allowWorkflows: input.allowWorkflows === true,
				allowAgents: input.allowAgents === true,
				updatedAt: timestamp,
			},
			this.#audit(tenant, actor, 'instance.consent-changed', id, timestamp, {
				allowWorkflows: input.allowWorkflows === true,
				allowAgents: input.allowAgents === true,
			}),
		);
		if (!updated) throw this.#missing();
		this.#options.invalidate?.(tenant, id);
		return updated;
	}

	enable(
		tenantId: string,
		actorId: string,
		instanceId: string,
	): Promise<ConnectorInstance> {
		return this.#status(tenantId, actorId, instanceId, 'active');
	}

	disable(
		tenantId: string,
		actorId: string,
		instanceId: string,
	): Promise<ConnectorInstance> {
		return this.#status(tenantId, actorId, instanceId, 'disabled');
	}

	async remove(
		tenantId: string,
		actorId: string,
		instanceId: string,
	): Promise<void> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const existing = await this.#require(tenant, instanceId);
		if (existing.status !== 'disabled') {
			throw new ConnectorsServiceError(
				'INSTANCE_ACTIVE',
				'Disable the instance before deleting it.',
				409,
			);
		}
		const timestamp = this.#now();
		const removed = await this.#options.repository.deleteInstance(
			tenant,
			existing.id,
			this.#audit(
				tenant,
				actor,
				'instance.deleted',
				existing.id,
				timestamp,
				{},
			),
		);
		if (!removed) throw this.#missing();
		this.#options.invalidate?.(tenant, existing.id);
	}

	/**
	 * Creates or updates the one instance a module keeps under a key, through
	 * the same validation, sealing and audit as the owner routes. The consent
	 * flags take the values given and a disabled instance stays disabled.
	 */
	async upsertModuleInstance(
		input: ConnectorModuleInstanceInput,
	): Promise<ConnectorModuleInstance> {
		const tenant = textInput(input.tenantId, 'tenantId', 1, 128);
		const moduleId = textInput(input.moduleId, 'moduleId', 1, 64);
		const key = textInput(input.key, 'key', 1, 64);
		if (!MODULE_INSTANCE_KEY.test(key)) {
			throw new ConnectorsServiceError(
				'INVALID_INPUT',
				'key must be a lowercase identifier of at most 64 characters.',
			);
		}
		const actor = textInput(input.actor, 'actor', 1, 128);
		const definition = this.#definition(
			textInput(input.definition, 'definition', 1, 96),
		);
		if (definition.moduleId !== moduleId) throw this.#foreign(definition.key);
		const id = moduleInstanceId(tenant, moduleId, key);
		const existing = await this.#options.repository.findInstance(tenant, id);
		if (existing && existing.definitionKey !== definition.key) {
			throw this.#foreign(existing.definitionKey);
		}
		const url = this.#assertBaseUrl(
			definition,
			textInput(input.baseUrl, 'baseUrl', 1, 2_048),
		);
		if (!Array.isArray(input.allowedHosts)) {
			throw new ConnectorsServiceError(
				'INVALID_INPUT',
				'allowedHosts must be a list of host names.',
			);
		}
		const allowedHosts = allowedHostList(
			input.allowedHosts.map((entry, index) =>
				textInput(entry, `allowedHosts[${index}]`, 1, MAX_HOST_CHARACTERS),
			),
			normalizeHost(url.hostname),
		);
		const supplied = input.credentials;
		const authKind =
			supplied === undefined
				? (existing?.authKind ?? 'none')
				: oneOf(
						typeof supplied?.kind === 'string' ? supplied.kind : '',
						'credentials.kind',
						CONNECTOR_AUTH_KINDS,
					);
		if (
			(supplied !== undefined || !existing) &&
			!definition.authKinds.includes(authKind)
		) {
			throw new ConnectorsServiceError(
				'AUTH_KIND_UNSUPPORTED',
				`Definition ${definition.key} does not support ${authKind}.`,
			);
		}
		const sealed =
			supplied === undefined
				? null
				: this.#seal(
						tenant,
						id,
						this.#credentials(authKind, supplied, {
							allowedHosts,
							definition,
						}),
					);
		const allowWorkflows = input.allowWorkflows === true;
		const allowAgents = input.allowAgents === true;
		const timestamp = this.#now();
		if (!existing) {
			await this.#write(() =>
				this.#options.repository.createInstance(
					{
						id,
						tenantId: tenant,
						definitionKey: definition.key,
						name: `${definition.label} (${moduleId})`.slice(0, 120).trim(),
						baseUrl: url.href,
						authKind,
						credentialFingerprint: sealed?.fingerprint ?? null,
						allowedHosts,
						allowWorkflows: false,
						allowAgents: false,
						status: 'active',
						lastCallAt: null,
						createdAt: timestamp,
						updatedAt: timestamp,
						credential: sealed?.envelope ?? null,
					},
					this.#audit(tenant, actor, 'instance.created', id, timestamp, {
						definitionKey: definition.key,
						authKind,
						moduleId,
					}),
				),
			);
		} else {
			await this.#write(() =>
				this.#options.repository.updateInstance(
					{
						...existing,
						baseUrl: url.href,
						authKind,
						allowedHosts,
						updatedAt: timestamp,
						credentialFingerprint:
							sealed === null
								? existing.credentialFingerprint
								: sealed.fingerprint,
						credential: sealed === null ? existing.credential : sealed.envelope,
					},
					this.#audit(tenant, actor, 'instance.updated', id, timestamp, {
						credentialChanged: sealed !== null,
						moduleId,
					}),
				),
			);
			this.#options.invalidate?.(tenant, id);
		}
		const flagsBefore = existing ?? {
			allowWorkflows: false,
			allowAgents: false,
		};
		if (
			flagsBefore.allowWorkflows !== allowWorkflows ||
			flagsBefore.allowAgents !== allowAgents
		) {
			const consentedAt = this.#now();
			await this.#options.repository.setConsent(
				tenant,
				id,
				{ allowWorkflows, allowAgents, updatedAt: consentedAt },
				this.#audit(
					tenant,
					actor,
					'instance.consent-changed',
					id,
					consentedAt,
					{
						allowWorkflows,
						allowAgents,
						moduleId,
					},
				),
			);
			this.#options.invalidate?.(tenant, id);
		}
		const stored = await this.#options.repository.findInstance(tenant, id);
		if (!stored) throw this.#missing();
		return moduleInstanceOf(stored, moduleId, key);
	}

	async describeModuleInstance(input: {
		readonly tenantId: string;
		readonly moduleId: string;
		readonly key: string;
	}): Promise<ConnectorModuleInstance | null> {
		const tenant = textInput(input.tenantId, 'tenantId', 1, 128);
		const moduleId = textInput(input.moduleId, 'moduleId', 1, 64);
		const key = textInput(input.key, 'key', 1, 64);
		const found = await this.#options.repository.findInstance(
			tenant,
			moduleInstanceId(tenant, moduleId, key),
		);
		return found ? moduleInstanceOf(found, moduleId, key) : null;
	}

	#foreign(definitionKey: string): ConnectorsServiceError {
		return new ConnectorsServiceError(
			'DEFINITION_FOREIGN',
			`Definition ${definitionKey} does not belong to the calling module.`,
			403,
		);
	}

	async #status(
		tenantId: string,
		actorId: string,
		instanceId: string,
		status: 'active' | 'disabled',
	): Promise<ConnectorInstance> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const id = bounded(instanceId, 'instanceId', 1, 128);
		const timestamp = this.#now();
		const updated = await this.#options.repository.setStatus(
			tenant,
			id,
			status,
			timestamp,
			this.#audit(
				tenant,
				actor,
				status === 'active' ? 'instance.enabled' : 'instance.disabled',
				id,
				timestamp,
				{},
			),
		);
		if (!updated) throw this.#missing();
		this.#options.invalidate?.(tenant, id);
		return updated;
	}

	#definition(key: string): ConnectorDefinition {
		const definition = this.#options
			.definitions()
			.get(bounded(key, 'definitionKey', 1, 96));
		if (!definition) {
			throw new ConnectorsServiceError(
				'DEFINITION_UNKNOWN',
				'No connector definition is registered under this key.',
			);
		}
		return definition;
	}

	/* Save time refuses the scheme, the shape and any host the definition does
	   not name. Every call repeats the address check against the instance list. */
	#assertBaseUrl(definition: ConnectorDefinition, value: string): URL {
		const url = bounded(value, 'baseUrl', 1, 2_048);
		let parsed: URL;
		try {
			parsed = createConnectorEgressPolicy({
				allowlist: connectorHostAllowlist(definition.defaultAllowedHosts),
				resolve: this.#options.hostResolver,
			}).assertUrl(url);
		} catch (error) {
			return egressFailure(error);
		}
		const ports = definitionAllowedPorts(definition);
		const port = parsed.port === '' ? 443 : Number(parsed.port);
		if (!ports.includes(port)) {
			throw new ConnectorsServiceError(
				'PORT_NOT_ALLOWED',
				`Definition ${definition.key} accepts port ${ports.join(', ')} only.`,
			);
		}
		return parsed;
	}

	#credentials(
		authKind: ConnectorAuthKind,
		value: Record<string, unknown>,
		bounds: {
			readonly allowedHosts: readonly string[];
			readonly definition: ConnectorDefinition;
		},
	): ConnectorCredentials {
		if (authKind === 'none') return { kind: 'none' };
		if (authKind === 'api-key') {
			const header = credentialText(value, 'header', 64);
			if (!/^[A-Za-z0-9-]+$/.test(header)) {
				throw new ConnectorsServiceError(
					'CREDENTIAL_INVALID',
					'credentials.header must be a header name.',
				);
			}
			return {
				kind: 'api-key',
				header: header.toLowerCase(),
				value: credentialText(value, 'value', 4_096),
			};
		}
		if (authKind === 'bearer') {
			return { kind: 'bearer', token: credentialText(value, 'token', 4_096) };
		}
		/* The token endpoint is another outbound call of this instance, so it
		   passes the same egress policy and the same host allowlist. */
		const tokenUrl = this.#assertBaseUrl(
			bounds.definition,
			credentialText(value, 'tokenUrl', 2_048),
		);
		if (!bounds.allowedHosts.includes(normalizeHost(tokenUrl.hostname))) {
			throw new ConnectorsServiceError(
				'HOST_NOT_ALLOWLISTED',
				'The token URL host must be on the instance host allowlist.',
			);
		}
		const scope = value.scope;
		return {
			kind: 'oauth2-client-credentials',
			tokenUrl: tokenUrl.href,
			clientId: credentialText(value, 'clientId', 256),
			clientSecret: credentialText(value, 'clientSecret', 4_096),
			scope:
				typeof scope === 'string' && scope.trim().length > 0
					? bounded(scope, 'credentials.scope', 1, 512)
					: null,
		};
	}

	#seal(
		tenantId: string,
		instanceId: string,
		credentials: ConnectorCredentials,
	): {
		readonly envelope: StoredConnectorInstance['credential'];
		readonly fingerprint: string | null;
	} {
		if (credentials.kind === 'none') {
			return { envelope: null, fingerprint: null };
		}
		const plaintext = JSON.stringify(credentials);
		if (plaintext.length > MAX_CREDENTIAL_CHARACTERS) {
			throw new ConnectorsServiceError(
				'CREDENTIAL_INVALID',
				'The credential is too large to seal.',
			);
		}
		const context = credentialContext(tenantId, instanceId);
		return {
			envelope: this.#options.vault.seal(plaintext, context),
			fingerprint: this.#options.vault.fingerprint(plaintext, context),
		};
	}

	async #require(
		tenantId: string,
		instanceId: string,
	): Promise<StoredConnectorInstance> {
		const found = await this.#options.repository.findInstance(
			tenantId,
			bounded(instanceId, 'instanceId', 1, 128),
		);
		if (!found) throw this.#missing();
		return found;
	}

	#missing(): ConnectorsServiceError {
		return new ConnectorsServiceError(
			'INSTANCE_NOT_FOUND',
			'No connector instance with this id exists in the workspace.',
			404,
		);
	}

	#audit(
		tenantId: string,
		actorId: string,
		action: ConnectorAuditEvent['action'],
		instanceId: string,
		occurredAt: number,
		metadata: Readonly<Record<string, string | number | boolean>>,
	): PendingConnectorAuditEvent {
		return { tenantId, actorId, action, instanceId, metadata, occurredAt };
	}

	async #write<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof DuplicateConnectorNameError) {
				throw new ConnectorsServiceError(
					'INSTANCE_NAME_TAKEN',
					error.message,
					409,
				);
			}
			throw error;
		}
	}
}
