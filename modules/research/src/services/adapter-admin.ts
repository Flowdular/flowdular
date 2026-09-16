import {
	FIRECRAWL_DEFAULT_BASE_URL,
	FIRECRAWL_DEFINITION_KEY,
	FIRECRAWL_INSTANCE_KEY,
} from '../adapters/firecrawl.ts';
import {
	SEARXNG_DEFINITION_KEY,
	SEARXNG_INSTANCE_KEY,
} from '../adapters/searxng.ts';
import {
	RESEARCH_ADAPTERS,
	RESEARCH_CHAIN_LIMITS,
	RESEARCH_FALLBACK_MODES,
	RESEARCH_FETCH_ADAPTERS,
	RESEARCH_LIMITS,
	RESEARCH_MODULE_ID,
	type ResearchAdapterHealth,
	type ResearchAdapterKey,
	type ResearchAdaptersOverview,
	type ResearchAdapterTestResult,
	type ResearchAdapterView,
	type ResearchChainAdapterKey,
	type ResearchSettings,
} from '../domain/types.ts';
import { adapterSettingPrefix } from '../settings.ts';
import type { ChainAttempt } from './adapter-chain.ts';
import type {
	ConnectorCalls,
	ConnectorEgress,
	ConnectorInstances,
	ConnectorModuleCredentials,
	ConnectorModuleInstance,
} from './capabilities.ts';
import type { ResearchService } from './research-service.ts';
import { ResearchServiceError } from './service-error.ts';

export type ResearchSettingWriter = (
	tenantId: string,
	key: string,
	value: string | number | boolean,
	actor: string,
) => Promise<void>;

export interface ResearchAdapterAdminOptions {
	readonly service: () => Promise<ResearchService>;
	readonly settings: (tenantId: string) => Promise<ResearchSettings>;
	readonly writeSetting?: ResearchSettingWriter | undefined;
	readonly instances: () => ConnectorInstances | undefined;
	readonly calls: () => ConnectorCalls | undefined;
	readonly egress: () => ConnectorEgress | undefined;
	readonly now?: () => number;
}

const MODULE_INSTANCES = {
	searxng: { key: SEARXNG_INSTANCE_KEY, definition: SEARXNG_DEFINITION_KEY },
	firecrawl: {
		key: FIRECRAWL_INSTANCE_KEY,
		definition: FIRECRAWL_DEFINITION_KEY,
	},
} as const;

type ModuleInstanceAdapter = keyof typeof MODULE_INSTANCES;

function invalid(message: string): ResearchServiceError {
	return new ResearchServiceError('INVALID_INPUT', message);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalid(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function integer(
	value: unknown,
	field: string,
	min: number,
	max: number,
): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	) {
		throw invalid(`${field} must be an integer between ${min} and ${max}.`);
	}
	return value;
}

function text(value: unknown, field: string, min: number, max: number) {
	if (typeof value !== 'string') throw invalid(`${field} must be text.`);
	const trimmed = value.trim();
	if (
		trimmed.length < min ||
		trimmed.length > max ||
		/[\u0000-\u001f\u007f]/.test(trimmed)
	) {
		throw invalid(`${field} must be between ${min} and ${max} characters.`);
	}
	return trimmed;
}

function order<Key extends string>(
	value: unknown,
	field: string,
	known: readonly Key[],
): readonly Key[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > known.length ||
		value.some((key) => !known.includes(key as Key)) ||
		new Set(value).size !== value.length
	) {
		throw invalid(
			`${field} must list between 1 and ${known.length} distinct keys of ${known.join(', ')}.`,
		);
	}
	return value as Key[];
}

/* The settings runtime and connectors.core answer their own stable codes; the
   route passes the code and the status on and never a value it was given. */
function passOn(error: unknown): never {
	if (error instanceof ResearchServiceError) throw error;
	const failure = error as {
		code?: unknown;
		status?: unknown;
		message?: unknown;
	};
	if (typeof failure?.code === 'string' && typeof failure.status === 'number') {
		throw new ResearchServiceError(
			failure.code,
			typeof failure.message === 'string' ? failure.message : failure.code,
			failure.status,
		);
	}
	throw error;
}

function displayOrder<Key extends string>(
	listed: readonly Key[],
	known: readonly Key[],
): readonly Key[] {
	return [...listed, ...known.filter((key) => !listed.includes(key))];
}

/**
 * The owner side of the adapter chain: the overview the Search adapters tab
 * reads, the chain settings, the per adapter configuration with its
 * module-owned connector instance, and the one-adapter test query.
 */
export class ResearchAdapterAdmin {
	readonly #options: ResearchAdapterAdminOptions;
	readonly #now: () => number;

	constructor(options: ResearchAdapterAdminOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	async overview(tenantId: string): Promise<ResearchAdaptersOverview> {
		const settings = await this.#options.settings(tenantId);
		const service = await this.#options.service();
		const health = new Map(
			(await service.adapterHealth(tenantId)).map((row) => [row.adapter, row]),
		);
		const instances = new Map<string, ConnectorModuleInstance | null>();
		for (const adapter of Object.keys(
			MODULE_INSTANCES,
		) as ModuleInstanceAdapter[]) {
			instances.set(adapter, await this.#describe(tenantId, adapter));
		}
		const legacy = settings.searchOrder.length === 0;
		const view = (key: ResearchChainAdapterKey, enabled: boolean) =>
			this.#view(key, enabled, settings, health.get(key), instances);
		return {
			search: displayOrder(
				legacy ? [settings.adapter] : settings.searchOrder,
				RESEARCH_ADAPTERS,
			).map((key) =>
				view(
					key,
					legacy
						? key === settings.adapter
						: settings.searchOrder.includes(key) &&
								settings.limits[key].enabled,
				),
			),
			fetch: displayOrder(settings.fetchOrder, RESEARCH_FETCH_ADAPTERS).map(
				(key) => view(key, settings.fetchOrder.includes(key)),
			),
			legacy,
			reliability: {
				fallback: settings.fallback,
				fallbackOnEmpty: settings.fallbackOnEmpty,
				retryBackoffMs: settings.retryBackoffMs,
				circuitFailureThreshold: settings.circuitFailureThreshold,
				circuitCooldownMs: settings.circuitCooldownMs,
			},
		};
	}

	/** Writes only the chain keys present in the body, after every one is validated. */
	async updateSettings(
		tenantId: string,
		actor: string,
		body: Readonly<Record<string, unknown>>,
	): Promise<ResearchAdaptersOverview> {
		const writes: [string, string | number | boolean][] = [];
		if (body.enabled !== undefined) {
			for (const [key, value] of Object.entries(
				record(body.enabled, 'enabled'),
			)) {
				if (!RESEARCH_ADAPTERS.includes(key as ResearchAdapterKey)) {
					throw invalid(
						`enabled names an unknown adapter ${key.slice(0, 40)}.`,
					);
				}
				if (typeof value !== 'boolean') {
					throw invalid(`enabled.${key} must be true or false.`);
				}
				writes.push([
					`${adapterSettingPrefix(key as ResearchAdapterKey)}Enabled`,
					value,
				]);
			}
		}
		/* The switches land before the order: a workspace leaving the single
		   adapter setting never runs a chain whose switches are still defaults. */
		if (body.searchOrder !== undefined) {
			writes.push([
				'searchOrder',
				order(body.searchOrder, 'searchOrder', RESEARCH_ADAPTERS).join(','),
			]);
		}
		if (body.fetchOrder !== undefined) {
			writes.push([
				'fetchOrder',
				order(body.fetchOrder, 'fetchOrder', RESEARCH_FETCH_ADAPTERS).join(','),
			]);
		}
		if (body.fallback !== undefined) {
			if (!RESEARCH_FALLBACK_MODES.includes(body.fallback as never)) {
				throw invalid('fallback must be next-adapter or fail.');
			}
			writes.push(['fallback', body.fallback as string]);
		}
		if (body.fallbackOnEmpty !== undefined) {
			if (typeof body.fallbackOnEmpty !== 'boolean') {
				throw invalid('fallbackOnEmpty must be true or false.');
			}
			writes.push(['fallbackOnEmpty', body.fallbackOnEmpty]);
		}
		const numbers = [
			['retryBackoffMs', 0, RESEARCH_CHAIN_LIMITS.backoffMaxMs],
			[
				'circuitFailureThreshold',
				RESEARCH_CHAIN_LIMITS.thresholdMin,
				RESEARCH_CHAIN_LIMITS.thresholdMax,
			],
			[
				'circuitCooldownMs',
				RESEARCH_CHAIN_LIMITS.cooldownMinMs,
				RESEARCH_CHAIN_LIMITS.cooldownMaxMs,
			],
		] as const;
		for (const [key, min, max] of numbers) {
			if (body[key] !== undefined) {
				writes.push([key, integer(body[key], key, min, max)]);
			}
		}
		await this.#write(tenantId, actor, writes);
		return this.overview(tenantId);
	}

	async configure(
		tenantId: string,
		actor: string,
		body: Readonly<Record<string, unknown>>,
	): Promise<ResearchAdaptersOverview> {
		const adapter = body.adapter;
		const known = [...RESEARCH_ADAPTERS, 'direct'] as const;
		if (!known.includes(adapter as never)) {
			throw invalid(`adapter must be one of ${known.join(', ')}.`);
		}
		const key = adapter as ResearchChainAdapterKey;
		const prefix = adapterSettingPrefix(key);
		const writes: [string, string | number | boolean][] = [];
		if (body.maxAttempts !== undefined) {
			writes.push([
				`${prefix}MaxAttempts`,
				integer(
					body.maxAttempts,
					'maxAttempts',
					RESEARCH_CHAIN_LIMITS.maxAttemptsMin,
					RESEARCH_CHAIN_LIMITS.maxAttemptsMax,
				),
			]);
		}
		if (body.timeoutMs !== undefined) {
			/* The direct reader keeps its page timeout and that setting's bounds. */
			writes.push(
				key === 'direct'
					? [
							'fetchTimeoutMs',
							integer(body.timeoutMs, 'timeoutMs', 1_000, 20_000),
						]
					: [
							`${prefix}TimeoutMs`,
							integer(
								body.timeoutMs,
								'timeoutMs',
								RESEARCH_CHAIN_LIMITS.timeoutMinMs,
								RESEARCH_CHAIN_LIMITS.timeoutMaxMs,
							),
						],
			);
		}
		if (key === 'connector' && body.connectorInstanceId !== undefined) {
			writes.push([
				'connectorInstanceId',
				body.connectorInstanceId === ''
					? ''
					: text(body.connectorInstanceId, 'connectorInstanceId', 1, 128),
			]);
		}
		if (key === 'recorded' && body.recordedFixturesPath !== undefined) {
			writes.push([
				'recordedFixturesPath',
				body.recordedFixturesPath === ''
					? ''
					: text(body.recordedFixturesPath, 'recordedFixturesPath', 1, 1_024),
			]);
		}
		if (key === 'searxng' || key === 'firecrawl') {
			await this.#upsertInstance(tenantId, actor, key, body);
		}
		await this.#write(tenantId, actor, writes);
		return this.overview(tenantId);
	}

	/** One query through one adapter alone, counted and kept like a member search. */
	async test(
		tenantId: string,
		actor: string,
		body: Readonly<Record<string, unknown>>,
	): Promise<ResearchAdapterTestResult> {
		if (!RESEARCH_ADAPTERS.includes(body.adapter as never)) {
			throw invalid(`adapter must be one of ${RESEARCH_ADAPTERS.join(', ')}.`);
		}
		const adapter = body.adapter as ResearchAdapterKey;
		const query = text(body.query, 'query', 1, RESEARCH_LIMITS.query);
		const attempts: ChainAttempt[] = [];
		const started = this.#now();
		const service = await this.#options.service();
		const summary = () =>
			attempts.map(
				({
					adapter: key,
					attempt,
					outcome,
					errorCode,
					durationMs,
					createdAt,
				}) => ({
					adapter: key,
					attempt,
					outcome,
					errorCode,
					durationMs,
					createdAt,
				}),
			);
		try {
			const answer = await service.search(
				{ tenantId, query, caller: 'member', callerRef: actor },
				actor,
				{ only: adapter, attempts },
			);
			return {
				adapter,
				outcome: answer.results.length === 0 ? 'empty' : 'ok',
				resultCount: answer.results.length,
				durationMs: Math.max(0, this.#now() - started),
				errorCode: null,
				message: null,
				attempts: summary(),
			};
		} catch (error) {
			if (!(error instanceof ResearchServiceError)) throw error;
			return {
				adapter,
				outcome: 'failed',
				resultCount: 0,
				durationMs: Math.max(0, this.#now() - started),
				errorCode: error.code,
				message: error.message,
				attempts: summary(),
			};
		}
	}

	/** Both consent flags of the module-owned instances follow allowAgents. */
	async syncConsent(tenantId: string, actor: string): Promise<void> {
		const registry = this.#options.instances();
		if (!registry) return;
		const allow = (await this.#options.settings(tenantId)).allowAgents;
		for (const adapter of Object.keys(
			MODULE_INSTANCES,
		) as ModuleInstanceAdapter[]) {
			const instance = await this.#describe(tenantId, adapter);
			if (
				!instance ||
				(instance.allowAgents === allow && instance.allowWorkflows === allow)
			) {
				continue;
			}
			await registry
				.upsertModuleInstance({
					tenantId,
					moduleId: RESEARCH_MODULE_ID,
					key: MODULE_INSTANCES[adapter].key,
					definition: MODULE_INSTANCES[adapter].definition,
					baseUrl: instance.baseUrl,
					allowedHosts: instance.allowedHosts,
					allowAgents: allow,
					allowWorkflows: allow,
					actor,
				})
				.catch(passOn);
		}
	}

	async #describe(
		tenantId: string,
		adapter: ModuleInstanceAdapter,
	): Promise<ConnectorModuleInstance | null> {
		const registry = this.#options.instances();
		if (!registry) return null;
		return registry.describeModuleInstance({
			tenantId,
			moduleId: RESEARCH_MODULE_ID,
			key: MODULE_INSTANCES[adapter].key,
		});
	}

	async #upsertInstance(
		tenantId: string,
		actor: string,
		adapter: ModuleInstanceAdapter,
		body: Readonly<Record<string, unknown>>,
	): Promise<void> {
		const registry = this.#options.instances();
		if (!registry) {
			throw new ResearchServiceError(
				'RESEARCH_ADAPTER_UNAVAILABLE',
				'connectors.core is not composed, so this adapter cannot be configured.',
				409,
			);
		}
		const existing = await this.#describe(tenantId, adapter);
		const baseUrl =
			body.baseUrl === undefined || body.baseUrl === ''
				? (existing?.baseUrl ??
					(adapter === 'firecrawl' ? FIRECRAWL_DEFAULT_BASE_URL : null))
				: text(body.baseUrl, 'baseUrl', 1, 2_048);
		if (baseUrl === null) throw invalid('baseUrl is required.');
		let host: string;
		try {
			host = new URL(baseUrl).hostname;
		} catch {
			throw invalid('baseUrl must be an absolute https URL.');
		}
		const credentials =
			body.credential === undefined
				? undefined
				: this.#credentials(adapter, record(body.credential, 'credential'));
		const allow = (await this.#options.settings(tenantId)).allowAgents;
		await registry
			.upsertModuleInstance({
				tenantId,
				moduleId: RESEARCH_MODULE_ID,
				key: MODULE_INSTANCES[adapter].key,
				definition: MODULE_INSTANCES[adapter].definition,
				baseUrl,
				...(credentials === undefined ? {} : { credentials }),
				allowedHosts: [host],
				allowAgents: allow,
				allowWorkflows: allow,
				actor,
			})
			.catch(passOn);
	}

	#credentials(
		adapter: ModuleInstanceAdapter,
		value: Record<string, unknown>,
	): ConnectorModuleCredentials {
		const kinds =
			adapter === 'searxng' ? ['none', 'bearer', 'basic'] : ['none', 'bearer'];
		if (!kinds.includes(value.kind as string)) {
			throw invalid(`credential.kind must be one of ${kinds.join(', ')}.`);
		}
		if (value.kind === 'none') return { kind: 'none' };
		if (value.kind === 'bearer') {
			return {
				kind: 'bearer',
				token: text(value.token, 'credential.token', 1, 4_000),
			};
		}
		const username = text(value.username, 'credential.username', 1, 256);
		if (username.includes(':')) {
			throw invalid('credential.username must not contain a colon.');
		}
		const password = value.password;
		if (
			typeof password !== 'string' ||
			password.length === 0 ||
			password.length > 1_024 ||
			/[\u0000-\u001f\u007f]/.test(password)
		) {
			throw invalid(
				'credential.password must be between 1 and 1024 characters.',
			);
		}
		return {
			kind: 'api-key',
			header: 'authorization',
			value: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
		};
	}

	async #write(
		tenantId: string,
		actor: string,
		writes: readonly (readonly [string, string | number | boolean])[],
	): Promise<void> {
		if (writes.length === 0) return;
		const writer = this.#options.writeSetting;
		if (!writer) {
			throw new ResearchServiceError(
				'RESEARCH_SETTINGS_UNAVAILABLE',
				'The settings runtime is not available here.',
				409,
			);
		}
		for (const [key, value] of writes) {
			await writer(tenantId, key, value, actor).catch(passOn);
		}
	}

	#view(
		key: ResearchChainAdapterKey,
		enabled: boolean,
		settings: ResearchSettings,
		health: ResearchAdapterHealth | undefined,
		instances: ReadonlyMap<string, ConnectorModuleInstance | null>,
	): ResearchAdapterView {
		const instance = instances.get(key) ?? null;
		const callsReady = this.#options.calls() !== undefined;
		const configured =
			key === 'searxng' || key === 'firecrawl'
				? callsReady && instance?.status === 'active'
				: key === 'connector'
					? callsReady && settings.connectorInstanceId.trim() !== ''
					: key === 'recorded'
						? settings.recordedFixturesPath.trim() !== ''
						: key === 'direct'
							? this.#options.egress() !== undefined
							: true;
		const openUntil = health?.openUntil ?? null;
		const status = !configured
			? 'not-configured'
			: health?.lastErrorCode === 'NATIVE_TOOL_UNSUPPORTED' &&
				  health.consecutiveFailures > 0
				? 'unsupported'
				: openUntil !== null && openUntil > this.#now()
					? 'circuit-open'
					: 'ready';
		return {
			key,
			enabled,
			maxAttempts: settings.limits[key].maxAttempts,
			timeoutMs: settings.limits[key].timeoutMs,
			status,
			openUntil,
			consecutiveFailures: health?.consecutiveFailures ?? 0,
			lastErrorCode: health?.lastErrorCode ?? null,
			lastSuccessAt: health?.lastSuccessAt ?? null,
			configuration: {
				baseUrl: instance?.baseUrl ?? null,
				authKind: instance?.authKind ?? null,
				hasCredentials: instance?.hasCredentials ?? false,
				instanceStatus: instance?.status ?? null,
				connectorInstanceId:
					key === 'connector' ? settings.connectorInstanceId : null,
				recordedFixturesPath:
					key === 'recorded' ? settings.recordedFixturesPath : null,
			},
		};
	}
}
