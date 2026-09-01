import { randomUUID } from 'node:crypto';
import {
	createVercelAiSdkProvider,
	probeVercelAiSdkProvider,
	type AgentProvider,
	type VercelAiProviderConfiguration,
} from '@coreloom/harness';
import { modelSupportsTemperature } from '@coreloom/harness/catalog';
import type {
	AgentModelReadiness,
	AgentProviderConnection,
	AgentProviderKind,
	AgentProviderModel,
	AgentProviderModelConfiguration,
	CreateAgentProviderInput,
	UpdateAgentProviderInput,
} from '../domain/types.ts';
import type { CredentialVault } from './credential-vault.ts';
import {
	assertPublicHost,
	createProviderFetch,
	type ProviderEgressError,
	validateCompatibleBaseUrl,
} from './outbound-policy.ts';
import {
	DuplicateProviderKeyError,
	type ProviderRepository,
	type StoredProviderConnection,
} from './provider-repository.ts';
import type { AgentRepository } from './repository.ts';

const LOCAL_PROVIDER_ID = 'local-simulation';
const LOCAL_MODEL_ID = 'deterministic-v1';

export class AgentProviderServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'AgentProviderServiceError';
	}
}

export interface AgentProviderServiceOptions {
	/* Functions are read per call so an admin change applies live. */
	readonly hostAllowlist: ReadonlySet<string> | (() => ReadonlySet<string>);
	readonly readinessTtlMs: number | (() => number);
	readonly readinessTimeoutMs: number;
	readonly readinessCooldownMs?: number;
	readonly now?: () => number;
	readonly probe?: typeof probeVercelAiSdkProvider;
}

const MIN_READINESS_TTL_MS = 10_000;
const MAX_READINESS_TTL_MS = 86_400_000;

function validReadinessTtl(value: number): boolean {
	return (
		Number.isSafeInteger(value) &&
		value >= MIN_READINESS_TTL_MS &&
		value <= MAX_READINESS_TTL_MS
	);
}

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (
		normalized.length < minimum ||
		normalized.length > maximum ||
		normalized.includes('\u0000')
	) {
		throw new AgentProviderServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	return normalized;
}

function providerKey(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized)) {
		throw new AgentProviderServiceError(
			'INVALID_PROVIDER_KEY',
			'key must contain 3 to 64 lowercase letters, numbers, or hyphens.',
		);
	}
	return normalized;
}

function providerKind(
	value: string,
): Exclude<AgentProviderKind, 'local-simulation'> {
	if (
		!['vercel', 'azure', 'openai', 'openai-compatible', 'anthropic'].includes(
			value,
		)
	) {
		throw new AgentProviderServiceError(
			'INVALID_PROVIDER_KIND',
			'Provider kind is not supported.',
		);
	}
	return value as Exclude<AgentProviderKind, 'local-simulation'>;
}

function optionalBounded(
	value: string | undefined,
	field: string,
	maximum: number,
): string | null {
	if (value === undefined || value.trim() === '') return null;
	return bounded(value, field, 1, maximum);
}

const UNPROVEN: AgentModelReadiness = {
	status: 'unknown',
	latencyMs: null,
	errorCode: null,
	checkedAt: null,
};

function providerModels(
	kind: AgentProviderKind,
	value: readonly AgentProviderModelConfiguration[],
): readonly AgentProviderModelConfiguration[] {
	if (value.length < 1 || value.length > 50) {
		throw new AgentProviderServiceError(
			'INVALID_PROVIDER_MODELS',
			'A provider must define between 1 and 50 models.',
		);
	}
	const seen = new Set<string>();
	return value.map((item) => {
		const id = bounded(item.id, 'model id', 1, 160);
		if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) {
			throw new AgentProviderServiceError(
				'INVALID_MODEL_ID',
				'Model IDs may contain letters, numbers, dots, underscores, colons, slashes, and hyphens.',
			);
		}
		if (seen.has(id)) {
			throw new AgentProviderServiceError(
				'DUPLICATE_MODEL_ID',
				`Model ${id} is configured more than once.`,
			);
		}
		seen.add(id);
		return {
			id,
			label: bounded(item.label, 'model label', 1, 120),
			enabled: Boolean(item.enabled),
			supportsTools: Boolean(item.supportsTools),
			supportsStreaming: Boolean(item.supportsStreaming),
			supportsWebSearch: Boolean(item.supportsWebSearch),
			supportsTemperature:
				item.supportsTemperature ??
				(kind === 'local-simulation' || modelSupportsTemperature(kind, id)),
		};
	});
}

/* A probe proves that one model answers with this credential. Configuration
   edits keep that evidence; a rotated credential and a removed model do not. */
function withReadiness(
	models: readonly AgentProviderModelConfiguration[],
	previous: readonly AgentProviderModel[],
	keepEvidence: boolean,
): readonly AgentProviderModel[] {
	return models.map((model) => ({
		...model,
		supportsTemperature: model.supportsTemperature !== false,
		readiness:
			(keepEvidence
				? previous.find((item) => item.id === model.id)?.readiness
				: undefined) ?? UNPROVEN,
	}));
}

function resourceName(
	kind: AgentProviderKind,
	value: string | null,
): string | null {
	if (kind !== 'azure') return null;
	if (!value || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)) {
		throw new AgentProviderServiceError(
			'INVALID_AZURE_RESOURCE_NAME',
			'Azure resource name must contain 3 to 64 lowercase letters, numbers, or hyphens.',
		);
	}
	return value;
}

function credentialContext(connection: {
	readonly tenantId: string;
	readonly id: string;
	readonly kind: AgentProviderKind;
}): string {
	return `${connection.tenantId}:${connection.id}:${connection.kind}`;
}

function localConnection(tenantId: string): AgentProviderConnection {
	return {
		id: LOCAL_PROVIDER_ID,
		tenantId,
		key: LOCAL_PROVIDER_ID,
		name: 'Local simulation',
		kind: 'local-simulation',
		enabled: true,
		resourceName: null,
		baseURL: null,
		models: [
			{
				id: LOCAL_MODEL_ID,
				label: 'Deterministic local simulation',
				enabled: true,
				supportsTools: true,
				supportsStreaming: true,
				supportsWebSearch: false,
				supportsTemperature: true,
				readiness: {
					status: 'healthy',
					latencyMs: 0,
					errorCode: null,
					checkedAt: 0,
				},
			},
		],
		credentialConfigured: false,
		credentialRevision: 0,
		revision: 1,
		createdBy: 'system',
		createdAt: 0,
		updatedBy: 'system',
		updatedAt: 0,
	};
}

function removedModels(
	current: readonly AgentProviderModel[],
	next: readonly AgentProviderModelConfiguration[],
): readonly string[] {
	const kept = new Set(next.map((model) => model.id));
	return current
		.filter((model) => !kept.has(model.id))
		.map((model) => model.id);
}

function mapEgressError(error: unknown): never {
	const candidate = error as Partial<ProviderEgressError>;
	if (typeof candidate.code === 'string' && error instanceof Error) {
		throw new AgentProviderServiceError(candidate.code, error.message, 400);
	}
	throw error;
}

export class AgentProviderService {
	readonly #now: () => number;
	readonly #readinessCooldownMs: number;
	readonly #probe: typeof probeVercelAiSdkProvider;
	readonly #lastProbe = new Map<string, number>();
	readonly #probesInFlight = new Map<
		string,
		Promise<AgentProviderConnection>
	>();

	constructor(
		private readonly repository: ProviderRepository,
		private readonly credentials: CredentialVault,
		private readonly audit: AgentRepository,
		private readonly options: AgentProviderServiceOptions,
	) {
		this.#now = options.now ?? Date.now;
		this.#readinessCooldownMs = options.readinessCooldownMs ?? 10_000;
		this.#probe = options.probe ?? probeVercelAiSdkProvider;
		if (
			typeof options.readinessTtlMs === 'number' &&
			!validReadinessTtl(options.readinessTtlMs)
		) {
			throw new Error(
				'Provider readiness TTL must be between 10000 and 86400000 ms.',
			);
		}
	}

	/* How long a probe result stays valid. Clients show staleness with it. */
	get readinessTtlMs(): number {
		const value =
			typeof this.options.readinessTtlMs === 'function'
				? this.options.readinessTtlMs()
				: this.options.readinessTtlMs;
		return validReadinessTtl(value) ? value : MAX_READINESS_TTL_MS;
	}

	#hostAllowlist(): ReadonlySet<string> {
		return typeof this.options.hostAllowlist === 'function'
			? this.options.hostAllowlist()
			: this.options.hostAllowlist;
	}

	list(tenantId: string): readonly AgentProviderConnection[] {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		return [
			localConnection(trustedTenantId),
			...this.repository.list(trustedTenantId),
		];
	}

	get(tenantId: string, id: string): AgentProviderConnection | null {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		if (id === LOCAL_PROVIDER_ID) return localConnection(trustedTenantId);
		return (
			this.repository.get(trustedTenantId, bounded(id, 'provider id', 1, 128))
				?.connection ?? null
		);
	}

	create(
		tenantId: string,
		actorId: string,
		input: CreateAgentProviderInput,
	): AgentProviderConnection {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const kind = providerKind(input.kind);
		const compatibleBaseUrl = optionalBounded(input.baseURL, 'baseURL', 2_048);
		let baseURL: string | null = null;
		if (kind === 'openai-compatible') {
			if (!compatibleBaseUrl) {
				throw new AgentProviderServiceError(
					'PROVIDER_BASE_URL_REQUIRED',
					'OpenAI-compatible providers require a base URL.',
				);
			}
			try {
				baseURL = validateCompatibleBaseUrl(
					compatibleBaseUrl,
					this.#hostAllowlist(),
				).href.replace(/\/$/, '');
			} catch (error) {
				mapEgressError(error);
			}
		}
		const now = this.#now();
		const id = `provider.${randomUUID().replaceAll('-', '')}`;
		const connection: AgentProviderConnection = {
			id,
			tenantId: trustedTenantId,
			key: providerKey(input.key),
			name: bounded(input.name, 'name', 2, 120),
			kind,
			enabled: false,
			resourceName: resourceName(
				kind,
				optionalBounded(input.resourceName, 'resourceName', 120),
			),
			baseURL,
			models: withReadiness(providerModels(kind, input.models), [], false),
			credentialConfigured: true,
			credentialRevision: 1,
			revision: 1,
			createdBy: actor,
			createdAt: now,
			updatedBy: actor,
			updatedAt: now,
		};
		try {
			const created = this.repository.create({
				connection,
				credential: this.credentials.encrypt(
					bounded(input.credential, 'credential', 8, 16_384),
					credentialContext(connection),
				),
			});
			this.audit.appendAuditEvent({
				tenantId: trustedTenantId,
				actorId: actor,
				action: 'agent-provider.created',
				subjectType: 'agent-provider',
				subjectId: created.id,
				metadata: { kind: created.kind, key: created.key, revision: 1 },
				occurredAt: now,
			});
			return created;
		} catch (error) {
			if (error instanceof DuplicateProviderKeyError) {
				throw new AgentProviderServiceError(
					'DUPLICATE_PROVIDER_KEY',
					error.message,
					409,
				);
			}
			throw error;
		}
	}

	update(
		tenantId: string,
		actorId: string,
		input: UpdateAgentProviderInput,
	): AgentProviderConnection {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const stored = this.repository.get(
			trustedTenantId,
			bounded(input.id, 'provider id', 1, 128),
		);
		if (!stored) {
			throw new AgentProviderServiceError(
				'PROVIDER_NOT_FOUND',
				'Provider connection not found.',
				404,
			);
		}
		if (stored.connection.revision !== input.expectedRevision) {
			throw new AgentProviderServiceError(
				'PROVIDER_REVISION_CONFLICT',
				'The provider was changed by another request. Reload before saving.',
				409,
			);
		}
		let baseURL: string | null = null;
		if (stored.connection.kind === 'openai-compatible') {
			const value = optionalBounded(input.baseURL, 'baseURL', 2_048);
			if (!value) {
				throw new AgentProviderServiceError(
					'PROVIDER_BASE_URL_REQUIRED',
					'OpenAI-compatible providers require a base URL.',
				);
			}
			try {
				baseURL = validateCompatibleBaseUrl(
					value,
					this.#hostAllowlist(),
				).href.replace(/\/$/, '');
			} catch (error) {
				mapEgressError(error);
			}
		}
		const nextConfiguration = {
			resourceName: resourceName(
				stored.connection.kind,
				optionalBounded(input.resourceName, 'resourceName', 120),
			),
			baseURL,
			models: providerModels(stored.connection.kind, input.models),
		};
		const credentialChanged = input.credential !== undefined;
		const models = withReadiness(
			nextConfiguration.models,
			stored.connection.models,
			!credentialChanged,
		);
		/* Enabling asks whether at least one model was proven, not whether the
		   connection is already usable: the stored one is disabled by
		   definition here. */
		if (input.enabled) this.assertProvenModel(models);
		const now = this.#now();
		const connection: AgentProviderConnection = {
			...stored.connection,
			name: bounded(input.name, 'name', 2, 120),
			enabled: Boolean(input.enabled),
			...nextConfiguration,
			models,
			credentialRevision:
				stored.connection.credentialRevision + (credentialChanged ? 1 : 0),
			revision: stored.connection.revision + 1,
			updatedBy: actor,
			updatedAt: now,
		};
		const credential = credentialChanged
			? this.credentials.encrypt(
					bounded(input.credential!, 'credential', 8, 16_384),
					credentialContext(connection),
				)
			: stored.credential;
		const updated = this.repository.update({ connection, credential });
		/* Evidence that no longer describes anything reachable. */
		if (credentialChanged) {
			this.repository.clearReadiness(trustedTenantId, connection.id, null);
		} else {
			const dropped = removedModels(
				stored.connection.models,
				nextConfiguration.models,
			);
			if (dropped.length > 0) {
				this.repository.clearReadiness(trustedTenantId, connection.id, dropped);
			}
		}
		this.audit.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: actor,
			action: credentialChanged
				? 'agent-provider.credential-rotated'
				: 'agent-provider.updated',
			subjectType: 'agent-provider',
			subjectId: updated.id,
			metadata: {
				enabled: updated.enabled,
				revision: updated.revision,
				credentialRevision: updated.credentialRevision,
			},
			occurredAt: now,
		});
		return updated;
	}

	async test(
		tenantId: string,
		providerId: string,
		modelId: string,
		actorId: string,
	): Promise<AgentProviderConnection> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const id = bounded(providerId, 'provider id', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		if (id === LOCAL_PROVIDER_ID) return localConnection(trustedTenantId);
		const stored = this.repository.get(trustedTenantId, id);
		if (!stored) {
			throw new AgentProviderServiceError(
				'PROVIDER_NOT_FOUND',
				'Provider connection not found.',
				404,
			);
		}
		const model = this.model(stored.connection, modelId, true);
		if (this.#withinCooldown(this.#probeKey(trustedTenantId, id, model.id))) {
			throw new AgentProviderServiceError(
				'PROVIDER_READINESS_RATE_LIMITED',
				'Wait before testing this model again.',
				429,
			);
		}
		return this.#probeModel(trustedTenantId, stored, model, actor);
	}

	#probeKey(tenantId: string, providerId: string, modelId: string): string {
		return `${tenantId}:${providerId}:${modelId}`;
	}

	#withinCooldown(probeKey: string): boolean {
		const previousProbe = this.#lastProbe.get(probeKey);
		return (
			previousProbe !== undefined &&
			this.#now() - previousProbe < this.#readinessCooldownMs
		);
	}

	async #probeModel(
		trustedTenantId: string,
		stored: StoredProviderConnection,
		model: AgentProviderModel,
		actor: string,
	): Promise<AgentProviderConnection> {
		const id = stored.connection.id;
		this.#lastProbe.set(
			this.#probeKey(trustedTenantId, id, model.id),
			this.#now(),
		);
		const configuration = await this.configuration(stored, model.id);
		const result = await this.#probe(
			configuration,
			this.options.readinessTimeoutMs,
		);
		/* The stored code is stable and coarse. The provider's own reason is
		   redacted of credentials and stays in the server log, which is the only
		   place a failed probe can be diagnosed. */
		if (!result.healthy) {
			console.error(
				`[agents.core] readiness failed for provider ${id} on ${model.id}: ${result.errorCode}`,
				result.detail ?? '',
			);
		}
		const checkedAt = this.#now();
		const updated = this.repository.recordReadiness(
			trustedTenantId,
			id,
			model.id,
			{
				status: result.healthy ? 'healthy' : 'unhealthy',
				latencyMs: result.latencyMs,
				errorCode: result.errorCode,
				checkedAt,
			},
			actor,
			checkedAt,
		);
		this.audit.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: actor,
			action: 'agent-provider.readiness-tested',
			subjectType: 'agent-provider',
			subjectId: id,
			metadata: {
				status: result.healthy ? 'healthy' : 'unhealthy',
				model: model.id,
				latencyMs: result.latencyMs,
				...(result.errorCode ? { errorCode: result.errorCode } : {}),
			},
			occurredAt: checkedAt,
		});
		return updated;
	}

	assertUsable(tenantId: string, providerId: string, modelId: string): void {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		if (providerId === LOCAL_PROVIDER_ID) {
			if (modelId !== LOCAL_MODEL_ID) {
				throw new AgentProviderServiceError(
					'MODEL_NOT_CONFIGURED',
					'Model is not configured for the selected provider.',
					409,
				);
			}
			return;
		}
		const stored = this.repository.get(
			trustedTenantId,
			bounded(providerId, 'provider id', 1, 128),
		);
		if (!stored) {
			throw new AgentProviderServiceError(
				'PROVIDER_NOT_FOUND',
				'Provider connection not found.',
				404,
			);
		}
		this.model(stored.connection, modelId, true);
		this.assertUsableConnection(stored.connection, modelId);
	}

	/* Like assertUsable, except expired evidence triggers one automatic
	   re-test on behalf of the actor. Concurrent callers share that probe. */
	async ensureUsable(
		tenantId: string,
		providerId: string,
		modelId: string,
		actorId: string,
	): Promise<void> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		if (providerId === LOCAL_PROVIDER_ID) {
			this.assertUsable(trustedTenantId, providerId, modelId);
			return;
		}
		const stored = this.repository.get(
			trustedTenantId,
			bounded(providerId, 'provider id', 1, 128),
		);
		if (!stored) {
			throw new AgentProviderServiceError(
				'PROVIDER_NOT_FOUND',
				'Provider connection not found.',
				404,
			);
		}
		const model = this.model(stored.connection, modelId, true);
		if (!stored.connection.enabled) {
			throw new AgentProviderServiceError(
				'PROVIDER_DISABLED',
				'Provider connection is disabled.',
				409,
			);
		}
		if (this.proven(model)) return;
		if (model.readiness.status !== 'healthy') {
			this.assertUsableConnection(stored.connection, model.id);
			return;
		}
		const refreshed = await this.#reprobe(
			trustedTenantId,
			stored,
			model,
			bounded(actorId, 'actorId', 1, 128),
		);
		if (!this.proven(this.model(refreshed, model.id, true))) {
			throw new AgentProviderServiceError(
				'PROVIDER_READINESS_REQUIRED',
				'Readiness for this model expired and the automatic re-test failed. Test it again.',
				409,
			);
		}
	}

	#reprobe(
		trustedTenantId: string,
		stored: StoredProviderConnection,
		model: AgentProviderModel,
		actor: string,
	): Promise<AgentProviderConnection> {
		const key = this.#probeKey(trustedTenantId, stored.connection.id, model.id);
		const inFlight = this.#probesInFlight.get(key);
		if (inFlight) return inFlight;
		if (this.#withinCooldown(key)) {
			throw new AgentProviderServiceError(
				'PROVIDER_READINESS_REQUIRED',
				'Readiness for this model expired and a re-test just failed. Test it again.',
				409,
			);
		}
		const pending = this.#probeModel(
			trustedTenantId,
			stored,
			model,
			actor,
		).finally(() => this.#probesInFlight.delete(key));
		this.#probesInFlight.set(key, pending);
		return pending;
	}

	/* A completed run proves the model as well as a probe does, and it did so
	   more recently. Local simulation needs no evidence. */
	recordRunSuccess(
		tenantId: string,
		providerId: string,
		modelId: string,
		completedAt: number,
		durationMs: number,
	): void {
		if (providerId === LOCAL_PROVIDER_ID) return;
		this.repository.refreshReadiness(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(providerId, 'provider id', 1, 128),
			bounded(modelId, 'model', 1, 160),
			{
				status: 'healthy',
				latencyMs: Math.max(0, Math.trunc(durationMs)),
				errorCode: null,
				checkedAt: completedAt,
			},
		);
	}

	async resolve(
		tenantId: string,
		providerId: string,
		modelId: string,
	): Promise<AgentProvider | null> {
		if (providerId === LOCAL_PROVIDER_ID) return null;
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const stored = this.repository.get(
			trustedTenantId,
			bounded(providerId, 'provider id', 1, 128),
		);
		if (!stored) {
			throw new AgentProviderServiceError(
				'PROVIDER_NOT_FOUND',
				'Provider connection not found.',
				404,
			);
		}
		this.model(stored.connection, modelId, true);
		this.assertUsableConnection(stored.connection, modelId);
		return createVercelAiSdkProvider(await this.configuration(stored, modelId));
	}

	private model(
		connection: AgentProviderConnection,
		modelId: string,
		requireEnabled: boolean,
	): AgentProviderModel {
		const id = bounded(modelId, 'model', 1, 160);
		const model = connection.models.find((item) => item.id === id);
		if (!model || (requireEnabled && !model.enabled)) {
			throw new AgentProviderServiceError(
				'MODEL_NOT_CONFIGURED',
				'Model is not enabled for the selected provider.',
				409,
			);
		}
		return model;
	}

	private assertUsableConnection(
		connection: AgentProviderConnection,
		modelId: string,
	): void {
		if (!connection.enabled) {
			throw new AgentProviderServiceError(
				'PROVIDER_DISABLED',
				'Provider connection is disabled.',
				409,
			);
		}
		const model = connection.models.find((item) => item.id === modelId);
		if (!model || this.proven(model)) return;
		throw new AgentProviderServiceError(
			'PROVIDER_READINESS_REQUIRED',
			model.readiness.status === 'healthy'
				? 'Readiness for this model expired. Test it again.'
				: 'This model was never proven. Test it first.',
			409,
		);
	}

	/* A connection may be enabled once any model an agent could pick answers. */
	private assertProvenModel(models: readonly AgentProviderModel[]): void {
		if (!models.some((model) => model.enabled && this.proven(model))) {
			throw new AgentProviderServiceError(
				'PROVIDER_READINESS_REQUIRED',
				'Test at least one enabled model before enabling the connection.',
				409,
			);
		}
	}

	private proven(model: AgentProviderModel): boolean {
		const { readiness } = model;
		return (
			readiness.status === 'healthy' &&
			readiness.checkedAt !== null &&
			this.#now() - readiness.checkedAt <= this.readinessTtlMs
		);
	}

	private async configuration(
		stored: StoredProviderConnection,
		model: string,
	): Promise<VercelAiProviderConfiguration> {
		const connection = stored.connection;
		if (connection.kind === 'local-simulation') {
			throw new AgentProviderServiceError(
				'INVALID_PROVIDER_CONFIGURATION',
				'Local simulation does not use a stored provider connection.',
			);
		}
		const credential = this.credentials.decrypt(
			stored.credential,
			credentialContext(connection),
		);
		const base = {
			id: connection.id,
			kind: connection.kind,
			model,
			credential,
			supportsTemperature:
				connection.models.find((item) => item.id === model)
					?.supportsTemperature !== false,
		};
		if (connection.kind === 'azure') {
			return {
				...base,
				resourceName: connection.resourceName ?? '',
			};
		}
		if (connection.kind === 'openai-compatible') {
			try {
				const baseURL = validateCompatibleBaseUrl(
					connection.baseURL ?? '',
					this.#hostAllowlist(),
				);
				await assertPublicHost(baseURL.hostname);
				return {
					...base,
					baseURL: baseURL.href.replace(/\/$/, ''),
					fetch: createProviderFetch(baseURL),
				};
			} catch (error) {
				mapEgressError(error);
			}
		}
		return base;
	}
}
