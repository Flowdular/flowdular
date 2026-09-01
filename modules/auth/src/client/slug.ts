/* Client-side mirror of the server workspace slug rules; the server stays
   the authority through /api/auth/workspace-availability and sign-up. */

export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/;

export function isValidWorkspaceSlug(slug: string): boolean {
	return (
		slug.length >= 3 &&
		slug.length <= 48 &&
		WORKSPACE_SLUG_PATTERN.test(slug) &&
		!slug.includes('--')
	);
}

export function slugifyWorkspaceName(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/ł/g, 'l')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+/, '')
		.slice(0, 48)
		.replace(/-+$/, '');
}
