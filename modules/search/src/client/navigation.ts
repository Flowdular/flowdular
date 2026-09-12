import type {
	CommandSearchContribution,
	CommandSearchHit,
	NavigationContribution,
} from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { SEARCH_PERMISSIONS } from '../acl/permissions.ts';
import { SEARCH_LIMITS } from '../domain/types.ts';
import { rememberQuery, searchRecords } from './api.ts';

export const SEARCH_VIEWS = { search: 'search' } as const;

/**
 * A workspace-relative route as a shell href. The shell owns the slug, so it is
 * read back from the address bar rather than threaded through every component.
 */
export function workspaceRouteHref(
	route: string,
	pathname: string,
	basePath: string,
): string {
	const segments = pathname.split('/').filter(Boolean);
	const inWorkspace =
		segments[0] === basePath.slice(1) ? segments.slice(1) : [];
	const workspaceSlug = inWorkspace.length > 1 ? inWorkspace[0] : null;
	const safe = route.startsWith('/') && !route.startsWith('//') ? route : '/';
	return workspaceSlug === null
		? basePath + safe
		: basePath + '/' + workspaceSlug + safe;
}

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const searchNavigation: readonly NavigationContribution[] = [
	{
		id: 'search.navigation',
		viewId: SEARCH_VIEWS.search,
		group: 'Workspace',
		get label() {
			return t('search.navigation.label');
		},
		glyph: 'search',
		get description() {
			return t('search.navigation.description');
		},
		scope: SEARCH_PERMISSIONS.read,
		order: 15,
	},
];

/** Hits the palette asks for in one pass; it groups and caps them per provider. */
const PALETTE_LIMIT = 20;

/**
 * The palette's record hits. The shell debounces and aborts, so the search stays
 * a plain request: one page, mapped into the shell's own hit shape.
 *
 * Opening one of them is the member saying the query was the right one, exactly
 * as on the search screen, so it is kept in recall by the same keepalive write
 * the browser finishes while the shell is already navigating. The query is read
 * back from the answer the opened hit belongs to, not from whatever the palette
 * box holds by then, and an answer the palette replaced takes its queries with
 * it, so recall never keeps a term that found nothing.
 */
export function createSearchCommandContribution(
	csrfToken: string,
): CommandSearchContribution {
	let answered = new Map<string, string>();
	return {
		id: 'search.core.records',
		scope: SEARCH_PERMISSIONS.read,
		order: 10,
		search: async ({ query, signal }): Promise<readonly CommandSearchHit[]> => {
			const page = await searchRecords({ query, limit: PALETTE_LIMIT, signal });
			const labels = new Map(
				page.providers.map((provider) => [provider.key, provider.label]),
			);
			const hits = page.hits.map((hit) => ({
				id: hit.provider + ':' + hit.ref,
				provider: hit.provider,
				providerLabel: labels.get(hit.provider) ?? hit.provider,
				title: hit.title,
				snippet: hit.snippet,
				viewId: hit.viewId,
				route: hit.route,
			}));
			answered = new Map(hits.map((hit) => [hit.id, query.trim()]));
			return hits;
		},
		onOpen: async (hit): Promise<void> => {
			const term = answered.get(hit.id);
			if (term === undefined || term.length < SEARCH_LIMITS.queryMinimum)
				return;
			await rememberQuery(term, csrfToken);
		},
	};
}
