/* Mirrors the first entry of `locales` in flowdular.json: the locale every
   bundle is guaranteed to carry, and the last step before a key is shown raw. */
export const FALLBACK_LOCALE = 'en';

export interface LocaleResolution {
	/** The signed-in browser's own choice, persisted per user. */
	readonly stored?: string | null | undefined;
	/** The auth.core `defaultLocale` tenant setting from the session payload. */
	readonly tenantDefault?: string | null | undefined;
	readonly supported: readonly string[];
}

/**
 * The account's own choice wins over the workspace default, which wins over the
 * fallback locale. A locale nothing ships strings for is ignored at every step.
 */
export function resolveLocale(input: LocaleResolution): string {
	const supported = input.supported;
	if (input.stored && supported.includes(input.stored)) return input.stored;
	if (input.tenantDefault && supported.includes(input.tenantDefault)) {
		return input.tenantDefault;
	}
	if (supported.includes(FALLBACK_LOCALE)) return FALLBACK_LOCALE;
	return supported[0] ?? FALLBACK_LOCALE;
}
