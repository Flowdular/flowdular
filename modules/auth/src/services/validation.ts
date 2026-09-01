import type {
	CreateTenantMemberInput,
	SignInInput,
	SignUpInput,
} from '../domain/types.ts';
import { DEFAULT_PASSWORD_MIN_LENGTH } from '../settings.ts';
import { AuthServiceError } from './auth-service-error.ts';

export function normalizeEmail(value: string): string {
	return value.trim().normalize('NFKC').toLowerCase();
}

export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/;
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function normalizeWorkspaceSlug(value: string): string {
	return value.trim().normalize('NFKC').toLowerCase();
}

export function validateWorkspaceSlug(value: string): string {
	const slug = normalizeWorkspaceSlug(value);
	if (
		slug.length < 3 ||
		slug.length > 48 ||
		!WORKSPACE_SLUG_PATTERN.test(slug) ||
		slug.includes('--')
	) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Workspace id must contain 3 to 48 lowercase letters, digits, or single hyphens, and must start and end with a letter or digit.',
			400,
		);
	}
	return slug;
}

function validateEmail(email: string): void {
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Enter a valid email address.',
			400,
		);
	}
}

export function assertPasswordPolicy(
	password: string,
	minLength = DEFAULT_PASSWORD_MIN_LENGTH,
): void {
	validatePassword(password, minLength);
}

function validatePassword(password: string, minLength: number): void {
	const bytes = Buffer.byteLength(password, 'utf8');
	if (password.length < minLength) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			`Password must contain at least ${minLength} characters.`,
			400,
		);
	}
	if (bytes > 1024) {
		throw new AuthServiceError('INVALID_INPUT', 'Password is too long.', 400);
	}
}

export function validateDisplayName(value: string): string {
	const displayName = value.trim();
	if (displayName.length < 2 || displayName.length > 80) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Display name must contain 2 to 80 characters.',
			400,
		);
	}
	return displayName;
}

export function validateWorkspaceName(value: string): string {
	const name = value.trim();
	if (name.length < 2 || name.length > 120) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Workspace name must contain 2 to 120 characters.',
			400,
		);
	}
	return name;
}

export function validateSignIn(input: SignInInput): SignInInput {
	const email = normalizeEmail(input.email);
	validateEmail(email);
	if (!input.password)
		throw new AuthServiceError('INVALID_INPUT', 'Password is required.', 400);
	return { email, password: input.password };
}

export function validateSignUp(
	input: SignUpInput,
	passwordMinLength = DEFAULT_PASSWORD_MIN_LENGTH,
): SignUpInput {
	const email = normalizeEmail(input.email);
	const displayName = validateDisplayName(input.displayName);
	const organizationSlug = validateWorkspaceSlug(input.organizationSlug);
	validateEmail(email);
	validatePassword(input.password, passwordMinLength);
	const organizationName = validateWorkspaceName(input.organizationName);
	return {
		email,
		password: input.password,
		displayName,
		organizationName,
		organizationSlug,
	};
}

export function validateCreateTenantMember(
	input: CreateTenantMemberInput,
	passwordMinLength = DEFAULT_PASSWORD_MIN_LENGTH,
): CreateTenantMemberInput {
	const validated = validateSignUp(
		{
			email: input.email,
			password: input.password,
			displayName: input.displayName,
			organizationName: 'Current tenant',
			organizationSlug: 'current-tenant',
		},
		passwordMinLength,
	);
	if (!input.tenantId || input.tenantId.length > 128) {
		throw new AuthServiceError('INVALID_INPUT', 'Tenant is invalid.', 400);
	}
	return {
		tenantId: input.tenantId,
		email: validated.email,
		password: validated.password,
		displayName: validated.displayName,
		role: validateRoleKey(input.role),
	};
}

export function validateRoleKey(value: string): string {
	const key = value.trim();
	if (!ROLE_KEY_PATTERN.test(key)) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Role key must contain 2 to 32 lowercase letters, digits, or hyphens and start with a letter.',
			400,
		);
	}
	return key;
}

export function validateRoleName(value: string): string {
	const name = value.trim();
	if (name.length < 2 || name.length > 60) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Role name must contain 2 to 60 characters.',
			400,
		);
	}
	return name;
}

export function validateRoleDescription(value: string): string {
	const description = value.trim();
	if (description.length > 240) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Role description must contain at most 240 characters.',
			400,
		);
	}
	return description;
}
