export { ApplicationShell } from './ApplicationShell.tsrx';
export {
	applicationPath,
	configureApplicationRouting,
	workspaceViewHref,
} from './routing.ts';
export {
	applicationBranding,
	configureApplicationBranding,
	configureBrandingFromPage,
} from './branding.ts';
/* The application entry renders the head from these; re-exported here so it
   reads the branding through the package it already composes the shell from. */
export {
	brandingTitleSuffix,
	DEFAULT_APPLICATION_BRANDING,
} from '@flowdular/contracts';
export type { ApplicationBranding } from '@flowdular/contracts';
export { loadWebPage, webPageData } from './web.ts';
export {
	createClientContributionRegistry,
	WORKSPACE_SLOTS,
} from './contributions.ts';
export type {
	AccountMenuContribution,
	ClientContributionRegistry,
	ClientViewContribution,
	CommandSearchContribution,
	CommandSearchHit,
	CommandSearchRequest,
	ModuleClientContext,
	ModuleClientInitializationContext,
	ModuleClientContribution,
	NavigationContribution,
	NavigationGroup,
	NavigationSection,
	WidgetContribution,
	WorkspaceSlot,
} from './contributions.ts';
export { openCommandPalette } from './shell/command.ts';
export {
	contributionsForActiveModules,
	loadActiveModules,
} from './shell/modules.ts';
export type { ActiveModulesLoader } from './shell/modules.ts';
export {
	COMMAND_SEARCH_DEBOUNCE_MS,
	COMMAND_SEARCH_MINIMUM,
} from './shell/command-search.ts';
export { FALLBACK_LOCALE, resolveLocale } from './i18n/locale.ts';
export type { LocaleResolution } from './i18n/locale.ts';
export {
	activeLocale,
	cancelActiveLocalePreview,
	previewActiveLocale,
	registerModuleTranslations,
	restoreAccountLocaleCache,
	restorePersistedLocale,
	setActiveLocale,
	setServerAccountLocale,
	setTenantDefaultLocale,
	SUPPORTED_LOCALES,
	t,
	useTranslation,
} from './i18n/runtime.ts';
export type { TranslationView } from './i18n/runtime.ts';
export {
	createTranslationCatalog,
	interpolate,
	translateFrom,
} from './i18n/translations.ts';
export type {
	LocaleBundles,
	Translate,
	TranslationBundle,
	TranslationCatalog,
	TranslationParams,
	TranslationSource,
} from './i18n/translations.ts';
export {
	createShellState,
	shellLocationFromUrl,
	shellViewFromUrl,
} from './state.ts';
export type { ShellLocation, ShellState, ShellView } from './state.ts';
