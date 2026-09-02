/* The landing carries its own two-locale store. It never imports the shell
   i18n runtime: the marketing copy is a pair of plain objects, and the choice
   only has to survive a reload in one browser. */

export const LANDING_LOCALES = ['en', 'pl'] as const;

export type LandingLocale = (typeof LANDING_LOCALES)[number];

export const FALLBACK_LOCALE: LandingLocale = 'en';

const STORAGE_KEY = 'coreloom.landing.locale';

export function isLandingLocale(value: string): value is LandingLocale {
	return (LANDING_LOCALES as readonly string[]).includes(value);
}

/** The stored choice, then the browser languages, then English. */
export function preferredLocale(): LandingLocale {
	if (typeof window === 'undefined') return FALLBACK_LOCALE;
	const stored = readStored();
	if (stored) return stored;
	for (const language of window.navigator.languages ?? []) {
		const candidate = language.split('-')[0]?.toLowerCase() ?? '';
		if (isLandingLocale(candidate)) return candidate;
	}
	return FALLBACK_LOCALE;
}

export function persistLocale(locale: LandingLocale): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(STORAGE_KEY, locale);
	} catch {
		/* Private browsing and blocked storage keep the session choice only. */
	}
}

function readStored(): LandingLocale | null {
	try {
		const value = window.localStorage.getItem(STORAGE_KEY);
		return value && isLandingLocale(value) ? value : null;
	} catch {
		return null;
	}
}
