/* npm's published package name rules, implemented here so the scaffolder stays
   dependency free and starts instantly under npx. */

const MAX_LENGTH = 214;
const NAME_PATTERN =
	/^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const RESERVED = new Set(['node_modules', 'favicon.ico']);

export interface NameCheck {
	readonly valid: boolean;
	readonly reason?: string;
}

export function checkProjectName(name: string): NameCheck {
	if (name.length === 0) return { valid: false, reason: 'name is empty' };
	if (name.trim() !== name) {
		return { valid: false, reason: 'name has leading or trailing whitespace' };
	}
	if (name.length > MAX_LENGTH) {
		return {
			valid: false,
			reason: `name is longer than ${String(MAX_LENGTH)} characters`,
		};
	}
	if (name.startsWith('.') || name.startsWith('_')) {
		return { valid: false, reason: 'name starts with a dot or an underscore' };
	}
	if (name !== name.toLowerCase()) {
		return { valid: false, reason: 'name contains uppercase letters' };
	}
	if (RESERVED.has(name)) {
		return { valid: false, reason: `"${name}" is a reserved npm name` };
	}
	if (!NAME_PATTERN.test(name)) {
		return {
			valid: false,
			reason:
				'name may contain only lowercase letters, digits, and the characters - . _ ~',
		};
	}
	return { valid: true };
}

/* A platform spec id accepts only lowercase letters, digits and hyphens inside
   a dotted segment, while an npm name may also carry ".", "_" and "~" and may
   start with a digit. */
export function applicationSlug(name: string): string {
	const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (slug.length === 0) return 'app';
	return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

/* The positional argument is a directory, so a nested path is legitimate while
   an upward segment is not: the scaffolder never writes above the invocation. */
export function checkTargetPath(target: string): NameCheck {
	if (target.length === 0) return { valid: false, reason: 'path is empty' };
	if (target.trim() !== target) {
		return { valid: false, reason: 'path has leading or trailing whitespace' };
	}
	const segments = target.split(/[\\/]+/);
	if (segments.includes('..')) {
		return { valid: false, reason: 'path escapes the current directory' };
	}
	if (target.includes('\0')) {
		return { valid: false, reason: 'path contains a null byte' };
	}
	return { valid: true };
}
