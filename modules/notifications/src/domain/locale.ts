import { MAIL_LIMITS } from '@flowdular/server';
import type { ModuleSettingsRuntime } from '@flowdular/kernel';

/* Declared and owned by auth.core as a shared tenant setting. This module reads
   it through the settings runtime, never through auth.core storage. */
export const TENANT_LOCALE_MODULE_ID = 'auth.core';
export const TENANT_LOCALE_KEY = 'defaultLocale';
export const DEFAULT_MAIL_LOCALE = 'en';

/* Mirrors the tag the mail port accepts, whose length bound is MAIL_LIMITS. A
   workspace whose stored value is not one must still be mailable: the port
   refuses such a message on every attempt, which would dead-letter every
   notification the workspace sends. */
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * The language one workspace's messages say they are written in. A workspace
 * that set nothing, a deployment without auth.core, and a stored value the mail
 * port would refuse all resolve to English.
 */
export function tenantMailLocale(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): string {
	let stored: string;
	try {
		stored = settings
			.get<string>(tenantId, TENANT_LOCALE_MODULE_ID, TENANT_LOCALE_KEY)
			.trim();
	} catch {
		return DEFAULT_MAIL_LOCALE;
	}
	return stored.length <= MAIL_LIMITS.locale && LOCALE_PATTERN.test(stored)
		? stored
		: DEFAULT_MAIL_LOCALE;
}
