/** One locale's copy for one namespace: flat keys, no nesting, no plural rules. */
export type TranslationBundle = Readonly<Record<string, string>>;

/** Every locale a namespace ships, keyed by locale code (`en`, `pl`). */
export type LocaleBundles = Readonly<Record<string, TranslationBundle>>;

export type TranslationParams = Readonly<Record<string, string | number>>;

export type Translate = (key: string, params?: TranslationParams) => string;

/** A namespace and its bundles. The namespace prefixes every key it owns. */
export interface TranslationSource {
	readonly namespace: string;
	readonly bundles: LocaleBundles;
}

/** Two flat lookups, the active locale over the fallback locale. */
export interface TranslationCatalog {
	readonly locale: string;
	readonly fallbackLocale: string;
	readonly active: ReadonlyMap<string, string>;
	readonly fallback: ReadonlyMap<string, string>;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/* An unknown placeholder is left in the output rather than blanked, so a
   missing parameter is visible in the browser instead of silently swallowed. */
export function interpolate(
	template: string,
	params: TranslationParams | undefined,
): string {
	if (params === undefined) return template;
	return template.replace(PLACEHOLDER, (match, name: string) => {
		const value = params[name];
		return value === undefined ? match : String(value);
	});
}

function collect(
	sources: readonly TranslationSource[],
	locale: string,
): Map<string, string> {
	const strings = new Map<string, string>();
	for (const source of sources) {
		const bundle = source.bundles[locale];
		if (bundle === undefined) continue;
		for (const key of Object.keys(bundle)) {
			strings.set(source.namespace + '.' + key, bundle[key]!);
		}
	}
	return strings;
}

/**
 * Merge every namespace into one lookup for the active locale and one for the
 * fallback locale. O(total keys) once per locale change; every later lookup is
 * O(1).
 */
export function createTranslationCatalog(
	sources: readonly TranslationSource[],
	locale: string,
	fallbackLocale: string,
): TranslationCatalog {
	return {
		locale,
		fallbackLocale,
		active: collect(sources, locale),
		fallback:
			locale === fallbackLocale
				? new Map<string, string>()
				: collect(sources, fallbackLocale),
	};
}

/**
 * Resolve a fully qualified key (`catalog.list.title`) through the fallback
 * chain: the active locale, then the fallback locale, then the key itself so a
 * missing string shows up on screen instead of rendering blank.
 */
export function translateFrom(
	catalog: TranslationCatalog,
	key: string,
	params?: TranslationParams,
): string {
	const template = catalog.active.get(key) ?? catalog.fallback.get(key) ?? key;
	return interpolate(template, params);
}
