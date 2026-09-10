import { cell, createStore, useValue } from 'segment-state';
import { FALLBACK_LOCALE, resolveLocale } from './locale.ts';
import {
	createTranslationCatalog,
	translateFrom,
	type LocaleBundles,
	type TranslationCatalog,
	type TranslationParams,
	type TranslationSource,
} from './translations.ts';
import shellEn from './locales/en.json';
import shellPl from './locales/pl.json';

const SHELL_NAMESPACE = 'shell';
const LOCALE_STORAGE_KEY = 'flowdular.locale';
const ACCOUNT_LOCALE_STORAGE_PREFIX = 'flowdular.locale.account';

const SHELL_BUNDLES: LocaleBundles = { en: shellEn, pl: shellPl };

/* The shell bundle is the only one guaranteed complete, so the locales it
   ships are the locales the language switch offers. */
export const SUPPORTED_LOCALES: readonly string[] = Object.keys(SHELL_BUNDLES);

const store = createStore({ locale: cell<string>(FALLBACK_LOCALE) });

let sources: readonly TranslationSource[] = [
	{ namespace: SHELL_NAMESPACE, bundles: SHELL_BUNDLES },
];
let catalog: TranslationCatalog = createTranslationCatalog(
	sources,
	FALLBACK_LOCALE,
	FALLBACK_LOCALE,
);
let tenantDefaultLocale: string | null = null;
let storedLocale: string | null = null;
let accountLocaleScope: string | null = null;
let cachedAccountLocale: string | null = null;
let serverAccountLocale: string | null | undefined;
let previewLocale: string | null = null;

function rebuild(locale: string): void {
	catalog = createTranslationCatalog(sources, locale, FALLBACK_LOCALE);
	if (store.get(store.state.locale) !== locale) {
		store.set(store.state.locale, locale, 'shell/locale');
	}
	if (typeof document !== 'undefined') {
		document.documentElement.lang = locale;
	}
}

function reresolve(): void {
	const personalLocale =
		previewLocale ??
		(serverAccountLocale !== undefined
			? serverAccountLocale
			: accountLocaleScope
				? cachedAccountLocale
				: storedLocale);
	rebuild(
		resolveLocale({
			stored: personalLocale,
			tenantDefault: tenantDefaultLocale,
			supported: SUPPORTED_LOCALES,
		}),
	);
}

function safeStorageRead(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeStorageWrite(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Storage is only a cache. The server preference remains authoritative.
	}
}

function accountStorageKey(accountId: string, tenantId: string): string {
	return [
		ACCOUNT_LOCALE_STORAGE_PREFIX,
		encodeURIComponent(accountId),
		encodeURIComponent(tenantId),
	].join('.');
}

/**
 * Replace the module bundles the shell composes, namespaced by the first
 * segment of the module id (`catalog.core` owns every `catalog.*` key). Called
 * once per contribution set, before any screen renders.
 */
export function registerModuleTranslations(
	modules: readonly {
		readonly moduleId: string;
		readonly translations?: LocaleBundles | undefined;
	}[],
): void {
	sources = [
		{ namespace: SHELL_NAMESPACE, bundles: SHELL_BUNDLES },
		...modules.flatMap((module) =>
			module.translations === undefined
				? []
				: [
						{
							namespace: module.moduleId.split('.')[0] ?? module.moduleId,
							bundles: module.translations,
						},
					],
		),
	];
	rebuild(catalog.locale);
}

/** The auth.core `defaultLocale` tenant setting, published on every session. */
export function setTenantDefaultLocale(locale: string | null): void {
	tenantDefaultLocale = locale;
	reresolve();
}

/** Browser-only choice for anonymous screens, or a preview while signed in. */
export function setActiveLocale(locale: string): void {
	if (accountLocaleScope) {
		previewLocale = locale;
		reresolve();
		return;
	}
	storedLocale = locale;
	safeStorageWrite(LOCALE_STORAGE_KEY, locale);
	reresolve();
}

/**
 * Select the signed-in account and workspace whose preference is being loaded.
 * The scoped browser value is only a cache until the server responds.
 */
export function restoreAccountLocaleCache(
	accountId: string,
	tenantId: string,
): void {
	accountLocaleScope = accountStorageKey(accountId, tenantId);
	cachedAccountLocale = safeStorageRead(accountLocaleScope);
	serverAccountLocale = undefined;
	previewLocale = null;
	reresolve();
}

/** Commit the value returned by profile.core and refresh its scoped cache. */
export function setServerAccountLocale(locale: string | null): void {
	serverAccountLocale = locale;
	previewLocale = null;
	if (accountLocaleScope) {
		cachedAccountLocale = locale;
		safeStorageWrite(accountLocaleScope, locale);
	}
	reresolve();
}

/** Apply a pending selection before profile.core confirms the mutation. */
export function previewActiveLocale(locale: string): void {
	previewLocale = locale;
	reresolve();
}

/** Revert a pending selection to the last server value or safe cache. */
export function cancelActiveLocalePreview(): void {
	previewLocale = null;
	reresolve();
}

/* Runs from the client entry, never during server rendering, so a stored
   choice can never leak from one request into another. */
export function restorePersistedLocale(): void {
	storedLocale = safeStorageRead(LOCALE_STORAGE_KEY);
	reresolve();
}

export function activeLocale(): string {
	return catalog.locale;
}

/** Stable identity: the catalog moves underneath it, the function does not. */
export function t(key: string, params?: TranslationParams): string {
	return translateFrom(catalog, key, params);
}

export interface TranslationView {
	readonly locale: string;
	readonly t: typeof t;
}

/** Subscribes the calling component to language changes. */
export function useTranslation(): TranslationView {
	const [locale] = useValue(store.state.locale);
	return { locale, t };
}
