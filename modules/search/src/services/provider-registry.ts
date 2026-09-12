import {
	SEARCH_PROVIDER_LIMITS,
	type SearchProvider,
	type SearchProviderRegistry,
} from '../domain/providers.ts';
import { SearchServiceError } from './service-error.ts';

const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PROVIDER_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const PERMISSION_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export interface RegisteredSearchProvider extends SearchProvider {
	readonly moduleId: string;
	/** Registration order. The merge is provider-major in exactly this order. */
	readonly order: number;
}

export interface MutableSearchProviderRegistry extends SearchProviderRegistry {
	/** Closes registration. Every later call answers `PROVIDER_REGISTRY_SEALED`. */
	seal(): void;
	list(): readonly RegisteredSearchProvider[];
}

function refuse(code: string, message: string): never {
	throw new SearchServiceError(code, message, 500);
}

function text(
	value: unknown,
	field: string,
	maximum: number,
	pattern?: RegExp,
): string {
	if (typeof value !== 'string' || value.length === 0) {
		refuse('PROVIDER_INVALID', `A search provider ${field} must be text.`);
	}
	if (value.length > maximum) {
		refuse(
			'PROVIDER_INVALID',
			`A search provider ${field} is at most ${maximum} characters.`,
		);
	}
	if (pattern && !pattern.test(value)) {
		refuse(
			'PROVIDER_INVALID',
			`Search provider ${field} "${value}" is not valid.`,
		);
	}
	return value;
}

/**
 * The providers of one process. Registration happens while modules compose and
 * closes before the first request, so every request reads the same list in the
 * same order and a lookup is an array walk over at most
 * `SEARCH_PROVIDER_LIMITS.providers` entries.
 */
export function createSearchProviderRegistry(): MutableSearchProviderRegistry {
	const providers: RegisteredSearchProvider[] = [];
	const keys = new Set<string>();
	let sealed: readonly RegisteredSearchProvider[] | null = null;

	return {
		register(moduleId, entries) {
			if (sealed) {
				refuse(
					'PROVIDER_REGISTRY_SEALED',
					`${String(moduleId)} registers a search provider after search.core started.`,
				);
			}
			text(moduleId, 'module id', SEARCH_PROVIDER_LIMITS.moduleId, MODULE_ID);
			if (!Array.isArray(entries)) {
				refuse(
					'PROVIDER_INVALID',
					`${moduleId} must register a list of search providers.`,
				);
			}
			if (
				providers.length + entries.length >
				SEARCH_PROVIDER_LIMITS.providers
			) {
				refuse(
					'PROVIDER_LIMIT_EXCEEDED',
					`A deployment registers at most ${SEARCH_PROVIDER_LIMITS.providers} search providers.`,
				);
			}
			/* Validated in full before anything is kept, so a bad entry in the
			   middle of a module's list cannot leave half of it registered. */
			const accepted: RegisteredSearchProvider[] = [];
			const pending = new Set<string>();
			for (const provider of entries) {
				const key = text(
					provider?.key,
					'key',
					SEARCH_PROVIDER_LIMITS.key,
					PROVIDER_KEY,
				);
				if (keys.has(key) || pending.has(key)) {
					refuse(
						'PROVIDER_DUPLICATE',
						`Search provider "${key}" is already registered.`,
					);
				}
				pending.add(key);
				accepted.push({
					key,
					moduleId,
					label: text(provider.label, 'label', SEARCH_PROVIDER_LIMITS.label),
					permission: text(
						provider.permission,
						'permission',
						SEARCH_PROVIDER_LIMITS.permission,
						PERMISSION_ID,
					),
					search:
						typeof provider.search === 'function'
							? provider.search.bind(provider)
							: refuse(
									'PROVIDER_INVALID',
									`Search provider "${key}" has no search operation.`,
								),
					order: providers.length + accepted.length,
				});
			}
			for (const provider of accepted) {
				keys.add(provider.key);
				providers.push(provider);
			}
		},
		seal() {
			sealed ??= [...providers];
		},
		list() {
			return sealed ?? providers;
		},
	};
}
