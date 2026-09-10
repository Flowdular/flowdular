import {
	activeLocale,
	registerModuleTranslations,
	restorePersistedLocale,
	setActiveLocale,
	SUPPORTED_LOCALES,
	t,
	useTranslation,
} from '@flowdular/client';
import en from './locales/en.json';
import pl from './locales/pl.json';

/** The standalone sandbox shares the platform translation runtime and keys. */
export function registerSandboxTranslations(): void {
	/* The translation runtime may be replaced independently by Vite HMR. The
	   catalog is the source of truth, so a stale local boolean must not suppress
	   recovery and expose raw keys in the workspace menu. */
	if (t('sandbox.workspace.language.en') !== 'sandbox.workspace.language.en')
		return;
	registerModuleTranslations([
		{
			moduleId: 'sandbox.app',
			translations: { en, pl },
		},
	]);
}

export function restoreSandboxLocale(): void {
	restorePersistedLocale();
}

export { activeLocale, setActiveLocale, SUPPORTED_LOCALES, t, useTranslation };
