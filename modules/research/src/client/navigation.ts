import type { NavigationContribution } from '@flowdular/client';
import { t } from '@flowdular/client/i18n';
import { RESEARCH_PERMISSIONS } from '../acl/permissions.ts';

/**
 * `research-evidence` is the address another module links to for one piece of
 * evidence: `workspaceViewHref(RESEARCH_VIEWS.evidence) + '?id=' + id` opens
 * the Research screen with that evidence in the drawer.
 */
export const RESEARCH_VIEWS = {
	research: 'research',
	evidence: 'research-evidence',
} as const;

/* Labels are read every render so a locale change reaches an entry the shell
   built once. */
export const researchNavigation: readonly NavigationContribution[] = [
	{
		id: 'research.navigation.research',
		viewId: RESEARCH_VIEWS.research,
		group: 'Administration',
		section: 'compliance',
		get label() {
			return t('research.navigation.research');
		},
		glyph: 'globe',
		get description() {
			return t('research.navigation.researchDescription');
		},
		scope: RESEARCH_PERMISSIONS.read,
		order: 75,
	},
];

/** The evidence id the address carries, or null outside a browser. */
export function evidenceIdFromLocation(
	search: string = typeof window === 'undefined' ? '' : window.location.search,
): string | null {
	const id = new URLSearchParams(search).get('id');
	return id !== null && id.length > 0 && id.length <= 64 ? id : null;
}
