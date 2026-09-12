import type {
	CreateTenantMemberInput,
	CreateTenantMemberWithoutPasswordInput,
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

/* The address rule sign-up enforces, for a caller that holds only an address. */
export function validateEmailAddress(value: string): string {
	const email = normalizeEmail(value);
	validateEmail(email);
	return email;
}

/* The credentials that lead every published breach corpus: the hundred short
   ones first, then the long entries that clear an ordinary minimum length and
   would otherwise never reach this lookup. A fixed set, so the check is one
   lookup and the list can never grow into a download at request time. Entries
   are lowercase; the candidate is folded before the lookup. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
	'123456',
	'password',
	'123456789',
	'12345678',
	'12345',
	'qwerty',
	'1234567',
	'111111',
	'123123',
	'abc123',
	'1234567890',
	'1234',
	'iloveyou',
	'000000',
	'dragon',
	'monkey',
	'letmein',
	'sunshine',
	'princess',
	'football',
	'123321',
	'654321',
	'666666',
	'7777777',
	'121212',
	'qwertyuiop',
	'1q2w3e4r',
	'555555',
	'888888',
	'admin',
	'welcome',
	'login',
	'master',
	'passw0rd',
	'superman',
	'batman',
	'michael',
	'jennifer',
	'jordan',
	'hunter',
	'ranger',
	'harley',
	'shadow',
	'baseball',
	'soccer',
	'trustno1',
	'whatever',
	'charlie',
	'daniel',
	'jessica',
	'ashley',
	'thomas',
	'robert',
	'andrew',
	'matthew',
	'joshua',
	'hannah',
	'nicole',
	'amanda',
	'samantha',
	'buster',
	'tigger',
	'purple',
	'orange',
	'silver',
	'chelsea',
	'cheese',
	'banana',
	'zaq1zaq1',
	'qazwsx',
	'zxcvbnm',
	'asdfgh',
	'asdfghjkl',
	'qwe123',
	'123qwe',
	'1qaz2wsx',
	'password1',
	'password123',
	'pass123',
	'admin123',
	'root',
	'guest',
	'test',
	'changeme',
	'secret',
	'freedom',
	'killer',
	'summer',
	'maggie',
	'pepper',
	'ginger',
	'cookie',
	'flower',
	'hello',
	'starwars',
	'computer',
	'internet',
	'access',
	'mustang',
	'corvette',
	// Twelve characters and longer, sorted, so the list stays deduplicated.
	'1234567890123',
	'1qaz2wsx3edc',
	'administrator',
	'asdfghjkl123',
	'changeme1234',
	'iloveyou1234',
	'letmein12345',
	'password1234',
	'passwordpassword',
	'qazwsxedcrfv',
	'qwerty123456',
	'qwertyuiop12',
	'welcome12345',
	'zaq12wsxcde3',
]);

/* Below this an address fragment is too short to carry any of the address into
   the password, and the rule would reject unrelated passwords. */
const MIN_EMAIL_FRAGMENT_LENGTH = 3;

export function emailLocalPart(email: string): string {
	return normalizeEmail(email).split('@')[0] ?? '';
}

export function assertPasswordPolicy(
	password: string,
	minLength = DEFAULT_PASSWORD_MIN_LENGTH,
	email?: string,
): void {
	validatePassword(password, minLength, email);
}

function validatePassword(
	password: string,
	minLength: number,
	email?: string,
): void {
	if (Buffer.byteLength(password, 'utf8') > 1024) {
		throw new AuthServiceError('INVALID_INPUT', 'Password is too long.', 400);
	}
	/* Ahead of the length rule: a breached credential is refused on its own
	   code whether or not it also clears the configured minimum. */
	const folded = password.trim().normalize('NFKC').toLowerCase();
	if (COMMON_PASSWORDS.has(folded)) {
		throw new AuthServiceError(
			'PASSWORD_TOO_COMMON',
			'Choose a password that does not appear on the list of most common passwords.',
			400,
		);
	}
	if (password.length < minLength) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			`Password must contain at least ${minLength} characters.`,
			400,
		);
	}
	const localPart = email === undefined ? '' : emailLocalPart(email);
	if (
		localPart.length >= MIN_EMAIL_FRAGMENT_LENGTH &&
		folded.includes(localPart)
	) {
		throw new AuthServiceError(
			'PASSWORD_CONTAINS_EMAIL',
			'Password must not contain the local part of the email address.',
			400,
		);
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
	if (input.workspace === undefined) return { email, password: input.password };
	const workspace = input.workspace.trim();
	if (workspace.length === 0 || workspace.length > 128) {
		throw new AuthServiceError(
			'INVALID_INPUT',
			'Workspace reference is invalid.',
			400,
		);
	}
	return { email, password: input.password, workspace };
}

export function validateSignUp(
	input: SignUpInput,
	passwordMinLength = DEFAULT_PASSWORD_MIN_LENGTH,
): SignUpInput {
	const email = normalizeEmail(input.email);
	const displayName = validateDisplayName(input.displayName);
	const organizationSlug = validateWorkspaceSlug(input.organizationSlug);
	validateEmail(email);
	validatePassword(input.password, passwordMinLength, email);
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

/**
 * The same rules without the password one, for a member created with an
 * unusable credential. Nothing about the password policy applies: there is no
 * password to measure.
 */
export function validateCreateTenantMemberWithoutPassword(
	input: CreateTenantMemberWithoutPasswordInput,
): CreateTenantMemberWithoutPasswordInput {
	const email = normalizeEmail(input.email);
	validateEmail(email);
	if (!input.tenantId || input.tenantId.length > 128) {
		throw new AuthServiceError('INVALID_INPUT', 'Tenant is invalid.', 400);
	}
	return {
		tenantId: input.tenantId,
		email,
		displayName: validateDisplayName(input.displayName),
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
