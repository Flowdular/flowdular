import type {
	Profile,
	ProfileLanguagePreference,
	UpdateProfileInput,
	UpdateProfileLanguageInput,
} from '../domain/types.ts';
import type { ProfileRepository } from './repository.ts';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SUPPORTED_PROFILE_LOCALES = new Set(['en', 'pl']);

export class ProfileServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ProfileServiceError';
	}
}

function identifier(value: string, field: string): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (!IDENTIFIER_PATTERN.test(normalized)) {
		throw new ProfileServiceError(
			'INVALID_IDENTIFIER',
			field + ' must be a valid identifier containing at most 128 characters.',
		);
	}
	return normalized;
}

function displayName(value: string): string {
	if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) {
		throw new ProfileServiceError(
			'INVALID_DISPLAY_NAME',
			'displayName must not contain control characters.',
		);
	}
	const normalized = value.trim();
	if (normalized.length < 2 || normalized.length > 120) {
		throw new ProfileServiceError(
			'INVALID_DISPLAY_NAME_LENGTH',
			'displayName must contain between 2 and 120 characters.',
		);
	}
	return normalized;
}

function locale(value: string): string {
	const normalized =
		typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (!SUPPORTED_PROFILE_LOCALES.has(normalized)) {
		throw new ProfileServiceError(
			'UNSUPPORTED_PROFILE_LOCALE',
			'locale must be one of the supported interface languages.',
		);
	}
	return normalized;
}

export class ProfileService {
	constructor(private readonly repository: ProfileRepository) {}

	async read(tenantId: string, accountId: string): Promise<Profile | null> {
		return this.repository.find(
			identifier(tenantId, 'tenantId'),
			identifier(accountId, 'accountId'),
		);
	}

	async update(
		tenantId: string,
		accountId: string,
		input: UpdateProfileInput,
	): Promise<Profile> {
		const profile: Profile = {
			tenantId: identifier(tenantId, 'tenantId'),
			accountId: identifier(accountId, 'accountId'),
			displayName: displayName(input.displayName),
			updatedAt: Date.now(),
		};
		return this.repository.save(profile);
	}

	async readLanguage(
		tenantId: string,
		accountId: string,
	): Promise<string | null> {
		return (
			(
				await this.repository.findLanguage(
					identifier(tenantId, 'tenantId'),
					identifier(accountId, 'accountId'),
				)
			)?.locale ?? null
		);
	}

	async updateLanguage(
		tenantId: string,
		accountId: string,
		input: UpdateProfileLanguageInput,
	): Promise<ProfileLanguagePreference> {
		return this.repository.saveLanguage({
			tenantId: identifier(tenantId, 'tenantId'),
			accountId: identifier(accountId, 'accountId'),
			locale: locale(input.locale),
			updatedAt: Date.now(),
		});
	}
}
