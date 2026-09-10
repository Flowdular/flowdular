import {
	extractVariables,
	variableDefinitions,
	variablesForScopes,
	isVariableKey,
	resolveTemplate,
	validateTemplate,
	type VariableDefinition,
	type VariableSource,
} from '@flowdular/contracts';
import type { PlatformCapabilityRegistry } from './capability-registry.ts';
import { normalizeActor, type Actor } from './actor.ts';
import { RegistryError } from './errors.ts';

const MAX_CONTEXT_VALUE_LENGTH = 100_000;
const MAX_BINDING_VALUE_LENGTH = 256;
const MAX_RESOLVED_TEMPLATE_LENGTH = 250_000;

export const PLATFORM_VARIABLES_CAPABILITY = 'platform.variables';

export interface VariableResolutionRequest {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly permissionSnapshot: readonly string[];
	readonly signal: AbortSignal;
	/* Record identifiers and other source selectors are always explicit. A
	   source never guesses a record from ambient client or process state. */
	readonly bindings: Readonly<Record<string, string>>;
	/* Values owned by the consumer, such as form fields or the current date.
	   Cross-module values still have to come from a registered resolver. */
	readonly values?: Readonly<Record<string, string>>;
}

export interface VariableSourceResolutionContext
	extends Omit<VariableResolutionRequest, 'values'> {
	readonly keys: readonly string[];
}

export interface VariableSourceResolver {
	/* Bindings are declared per variable because one source may expose values
	   from different records. The registry refuses before invoking the source. */
	readonly requiredBindings?: Readonly<Record<string, readonly string[]>>;
	resolve(
		context: VariableSourceResolutionContext,
	): Promise<Readonly<Record<string, string | null | undefined>>>;
}

export class VariableResolutionError extends Error {
	constructor(
		readonly code:
			| 'INVALID_VARIABLE_CONTEXT'
			| 'UNKNOWN_TEMPLATE_VARIABLE'
			| 'FORBIDDEN_TEMPLATE_VARIABLE'
			| 'MISSING_VARIABLE_BINDING'
			| 'VARIABLE_VALUE_UNAVAILABLE'
			| 'VARIABLE_SOURCE_FAILED'
			| 'VARIABLE_RESOLUTION_ABORTED',
		message: string,
	) {
		super(message);
		this.name = 'VariableResolutionError';
	}
}

export interface PlatformVariableRegistry {
	register(source: VariableSource, resolver?: VariableSourceResolver): void;
	list(allowedScopes: readonly string[]): readonly VariableDefinition[];
	resolve(
		template: string,
		request: VariableResolutionRequest,
	): Promise<string>;
}

interface RegisteredSource {
	readonly source: VariableSource;
	readonly resolver?: VariableSourceResolver;
}

function boundedContext(value: string, field: string, maximum = 128): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > maximum) {
		throw new VariableResolutionError(
			'INVALID_VARIABLE_CONTEXT',
			`${field} is invalid.`,
		);
	}
	return normalized;
}

function abortIfNeeded(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new VariableResolutionError(
			'VARIABLE_RESOLUTION_ABORTED',
			'Variable resolution was aborted.',
		);
	}
}

function sourceFailure(error: unknown): never {
	if (error instanceof VariableResolutionError) {
		const messages: Record<VariableResolutionError['code'], string> = {
			INVALID_VARIABLE_CONTEXT: 'The variable source context is invalid.',
			UNKNOWN_TEMPLATE_VARIABLE: 'The variable source is unknown.',
			FORBIDDEN_TEMPLATE_VARIABLE:
				'The variable source is unavailable to this actor.',
			MISSING_VARIABLE_BINDING: 'A required variable binding is missing.',
			VARIABLE_VALUE_UNAVAILABLE: 'A variable value is unavailable.',
			VARIABLE_SOURCE_FAILED: 'The variable source could not be resolved.',
			VARIABLE_RESOLUTION_ABORTED: 'Variable resolution was aborted.',
		};
		throw new VariableResolutionError(error.code, messages[error.code]);
	}
	/* Source exceptions can include SQL, provider, or record details. The shared
	   boundary deliberately replaces them with one public error. */
	throw new VariableResolutionError(
		'VARIABLE_SOURCE_FAILED',
		'The variable source could not be resolved.',
	);
}

/* Sources register during module composition. Definitions and resolvers share
   one duplicate-key boundary, so a key can never silently change meaning. The
   registry validates scopes and bindings before any source executes. */
export function createPlatformVariableRegistry(): PlatformVariableRegistry {
	const sources: RegisteredSource[] = [];
	const byKey = new Map<string, RegisteredSource>();
	return {
		register(source, resolver) {
			if (source.id.trim().length === 0) {
				throw new RegistryError(
					'INVALID_VARIABLE_SOURCE',
					'Variable source id is required.',
				);
			}
			const sourceKeys = new Set<string>();
			for (const variable of source.variables) {
				if (!isVariableKey(variable.key)) {
					throw new RegistryError(
						'INVALID_VARIABLE_KEY',
						`Variable key ${variable.key} is invalid.`,
					);
				}
				if (byKey.has(variable.key) || sourceKeys.has(variable.key)) {
					throw new RegistryError(
						'DUPLICATE_VARIABLE_KEY',
						`Variable key ${variable.key} is already registered.`,
					);
				}
				sourceKeys.add(variable.key);
			}
			for (const [key, bindings] of Object.entries(
				resolver?.requiredBindings ?? {},
			)) {
				if (!sourceKeys.has(key)) {
					throw new RegistryError(
						'INVALID_VARIABLE_BINDING',
						`Variable binding declaration ${key} is not part of source ${source.id}.`,
					);
				}
				for (const binding of bindings) {
					if (!isVariableKey(binding)) {
						throw new RegistryError(
							'INVALID_VARIABLE_BINDING',
							`Variable binding ${binding} is invalid.`,
						);
					}
				}
			}
			const entry: RegisteredSource = Object.freeze({
				source: Object.freeze({
					...source,
					variables: [...source.variables],
				}),
				...(resolver === undefined ? {} : { resolver }),
			});
			for (const variable of source.variables) byKey.set(variable.key, entry);
			sources.push(entry);
		},
		list(allowedScopes) {
			const available = variableDefinitions(
				sources.map((entry) => entry.source),
			);
			return variablesForScopes(available, allowedScopes);
		},
		async resolve(template, request) {
			abortIfNeeded(request.signal);
			if (template.length > MAX_CONTEXT_VALUE_LENGTH) {
				throw new VariableResolutionError(
					'INVALID_VARIABLE_CONTEXT',
					'The variable template is too large.',
				);
			}
			boundedContext(request.tenantId, 'tenantId');
			const actor = normalizeActor(request.actor);
			if (!actor) {
				throw new VariableResolutionError(
					'INVALID_VARIABLE_CONTEXT',
					'actor is invalid.',
				);
			}
			const available = variableDefinitions(
				sources.map((entry) => entry.source),
			);
			const report = validateTemplate(
				template,
				available,
				request.permissionSnapshot,
			);
			if (report.unknown.length > 0) {
				throw new VariableResolutionError(
					'UNKNOWN_TEMPLATE_VARIABLE',
					'The template contains an unknown variable.',
				);
			}
			if (report.forbidden.length > 0) {
				throw new VariableResolutionError(
					'FORBIDDEN_TEMPLATE_VARIABLE',
					'The template contains a variable unavailable to this actor.',
				);
			}

			const values: Record<string, string> = Object.create(null);
			for (const key of extractVariables(template)) {
				const entry = byKey.get(key)!;
				/* A caller may supply only values owned by a local, resolver-less
				   source. A value for party.name or another resolved key never skips
				   the owning capability, even if the caller tries to spoof it. */
				const local =
					entry.resolver === undefined &&
					Object.prototype.hasOwnProperty.call(request.values ?? {}, key)
						? request.values?.[key]
						: undefined;
				if (typeof local === 'string') {
					if (local.length > MAX_CONTEXT_VALUE_LENGTH) {
						throw new VariableResolutionError(
							'INVALID_VARIABLE_CONTEXT',
							'A variable value is too large.',
						);
					}
					values[key] = local;
				}
			}

			const requestedBySource = new Map<RegisteredSource, string[]>();
			for (const key of extractVariables(template)) {
				if (Object.prototype.hasOwnProperty.call(values, key)) continue;
				const entry = byKey.get(key)!;
				const keys = requestedBySource.get(entry) ?? [];
				keys.push(key);
				requestedBySource.set(entry, keys);
			}

			for (const [entry, keys] of requestedBySource) {
				abortIfNeeded(request.signal);
				if (!entry.resolver) {
					throw new VariableResolutionError(
						'VARIABLE_VALUE_UNAVAILABLE',
						'A variable value is unavailable.',
					);
				}
				for (const key of keys) {
					for (const binding of entry.resolver.requiredBindings?.[key] ?? []) {
						const value = Object.prototype.hasOwnProperty.call(
							request.bindings,
							binding,
						)
							? request.bindings[binding]
							: undefined;
						if (
							typeof value !== 'string' ||
							value.trim().length === 0 ||
							value.length > MAX_BINDING_VALUE_LENGTH
						) {
							throw new VariableResolutionError(
								'MISSING_VARIABLE_BINDING',
								'A required variable binding is missing.',
							);
						}
					}
				}
				let resolved: Readonly<Record<string, string | null | undefined>>;
				try {
					resolved = await entry.resolver.resolve({
						tenantId: request.tenantId,
						actor,
						permissionSnapshot: request.permissionSnapshot,
						signal: request.signal,
						bindings: request.bindings,
						keys,
					});
				} catch (error) {
					sourceFailure(error);
				}
				abortIfNeeded(request.signal);
				for (const key of keys) {
					const value = Object.prototype.hasOwnProperty.call(resolved, key)
						? resolved[key]
						: undefined;
					if (typeof value !== 'string') {
						throw new VariableResolutionError(
							'VARIABLE_VALUE_UNAVAILABLE',
							'A variable value is unavailable.',
						);
					}
					if (value.length > MAX_CONTEXT_VALUE_LENGTH) {
						throw new VariableResolutionError(
							'VARIABLE_SOURCE_FAILED',
							'The variable source could not be resolved.',
						);
					}
					values[key] = value;
				}
			}
			const output = resolveTemplate(template, values);
			if (output.length > MAX_RESOLVED_TEMPLATE_LENGTH) {
				throw new VariableResolutionError(
					'VARIABLE_SOURCE_FAILED',
					'The resolved template is too large.',
				);
			}
			return output;
		},
	};
}

/* The shared registry is itself a core capability. Modules can register or
   resolve sources through the existing composition context without adding a
   second global context member or depending on another module's internals. */
export function platformVariableRegistry(
	capabilities: PlatformCapabilityRegistry,
): PlatformVariableRegistry {
	const existing = capabilities.get<PlatformVariableRegistry>(
		PLATFORM_VARIABLES_CAPABILITY,
	);
	if (existing) return existing;
	const registry = createPlatformVariableRegistry();
	capabilities.register(PLATFORM_VARIABLES_CAPABILITY, registry);
	return registry;
}
