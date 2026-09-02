import { registerModuleTranslations, t } from '@coreloom/client/i18n';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';

export const AUTH_TRANSLATIONS = {
	en: translationsEn,
	pl: translationsPl,
} as const;

/**
 * Public authentication renders before the composed application shell, so it
 * must install its own bundle before its first translation lookup.
 */
export function registerPublicAuthTranslations(): void {
	/* Do not keep a module-local one-shot flag here. During development Vite may
	   rebuild the shared runtime while preserving this module, which empties the
	   catalog but leaves such a flag set. Checking the catalog itself also makes
	   the registration idempotent in production. */
	if (t('auth.common.login') !== 'auth.common.login') return;
	registerModuleTranslations([
		{ moduleId: 'auth.core', translations: AUTH_TRANSLATIONS },
	]);
}
