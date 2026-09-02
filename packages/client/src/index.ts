export { ApplicationShell } from './ApplicationShell.tsrx';
export {
	createClientContributionRegistry,
	WORKSPACE_SLOTS,
} from './contributions.ts';
export type {
	AccountMenuContribution,
	ClientContributionRegistry,
	ClientViewContribution,
	ModuleClientContext,
	ModuleClientInitializationContext,
	ModuleClientContribution,
	NavigationContribution,
	NavigationGroup,
	WidgetContribution,
	WorkspaceSlot,
} from './contributions.ts';
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
