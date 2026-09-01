import {
	defineModuleSettings,
	type ModuleSettingsDeclaration,
} from '@coreloom/kernel';

export const PROVIDER_LIST_PATTERN =
	'|[a-z][a-z0-9-]{1,30}(,[a-z][a-z0-9-]{1,30})*';

export const DEFAULT_SESSION_TTL_HOURS = 12;
export const DEFAULT_SESSION_IDLE_MINUTES = 120;
export const DEFAULT_PASSWORD_MIN_LENGTH = 12;

export interface AuthSettingDefaults {
	readonly allowSignUp?: boolean;
	readonly emailConfirmation?: boolean;
	readonly sessionTtlHours?: number;
	readonly sessionIdleMinutes?: number;
	readonly passwordMinLength?: number;
	readonly signInProviders?: readonly string[];
	/** Locales offered as a tenant default; from coreloom.json when known. */
	readonly locales?: readonly string[];
}

/* Deployment defaults come from the environment; stored values set through the
   Settings screen take precedence at read time. */
export function createAuthModuleSettings(
	defaults: AuthSettingDefaults = {},
): ModuleSettingsDeclaration {
	const locales = defaults.locales?.length ? defaults.locales : ['en', 'pl'];
	return defineModuleSettings({
		moduleId: 'auth.core',
		settings: {
			allowSignUp: {
				type: 'boolean',
				defaultValue: defaults.allowSignUp ?? true,
				visibility: 'shared',
				client: true,
				scope: 'platform',
				label: 'Allow sign-up',
				description:
					'Visitors can create a new workspace from the public sign-up screen.',
			},
			emailConfirmation: {
				type: 'boolean',
				defaultValue: defaults.emailConfirmation ?? false,
				visibility: 'shared',
				client: true,
				scope: 'platform',
				label: 'Email confirmation',
				description:
					'Hold new accounts until the address is confirmed. Requires a composed mail transport.',
			},
			sessionTtlHours: {
				type: 'number',
				defaultValue: defaults.sessionTtlHours ?? DEFAULT_SESSION_TTL_HOURS,
				visibility: 'private',
				client: false,
				scope: 'platform',
				label: 'Session lifetime (hours)',
				description: 'Absolute lifetime of a browser session.',
				min: 1,
				max: 168,
			},
			sessionIdleMinutes: {
				type: 'number',
				defaultValue:
					defaults.sessionIdleMinutes ?? DEFAULT_SESSION_IDLE_MINUTES,
				visibility: 'private',
				client: false,
				scope: 'platform',
				label: 'Idle timeout (minutes)',
				description: 'A session ends after this long without a request.',
				min: 5,
				max: 1440,
			},
			passwordMinLength: {
				type: 'number',
				defaultValue: defaults.passwordMinLength ?? DEFAULT_PASSWORD_MIN_LENGTH,
				visibility: 'shared',
				client: true,
				scope: 'platform',
				label: 'Minimum password length',
				description:
					'Applies to sign-up, member creation, and password changes.',
				min: 8,
				max: 128,
			},
			signInProviders: {
				type: 'string',
				defaultValue: (defaults.signInProviders ?? []).join(','),
				visibility: 'shared',
				client: true,
				scope: 'platform',
				label: 'Sign-in providers',
				description:
					'Comma-separated external provider ids shown on the sign-in screen.',
				max: 200,
				pattern: PROVIDER_LIST_PATTERN,
			},
			defaultLocale: {
				type: 'string',
				defaultValue: locales[0]!,
				visibility: 'shared',
				client: true,
				scope: 'tenant',
				label: 'Default locale',
				description: 'Language offered to new members of this workspace.',
				enum: locales,
			},
		},
	});
}

export const AUTH_MODULE_SETTINGS = createAuthModuleSettings();

export interface AuthSettings {
	readonly allowSignUp: boolean;
	/** Requires a mail transport; keep disabled until one is composed in. */
	readonly emailConfirmation: boolean;
	/** External sign-in providers surfaced on the sign-in screen. */
	readonly signInProviders: readonly string[];
	readonly sessionTtlMs: number;
	readonly sessionIdleMs: number;
	readonly passwordMinLength: number;
}

export function parseProviderList(value: string): readonly string[] {
	return [
		...new Set(
			value
				.split(',')
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}
