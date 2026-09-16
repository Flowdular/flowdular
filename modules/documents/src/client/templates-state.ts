import { cell, createStore } from 'segment-state';
import type { ScreenStatus } from './state.ts';
import type { TemplateListItem } from './templates-api.ts';

export function createTemplatesClientState() {
	const store = createStore({
		templates: cell<readonly TemplateListItem[]>([]),
		status: cell<ScreenStatus>('loading'),
		error: '',
		query: '',
		/* The template whose editor drawer is open. */
		openKey: cell<string | null>(null),
	});
	return { store, state: store.state };
}

/**
 * The templates a term matches by key, title or owner module. The catalogue is
 * what the deployment registered, at most a few hundred entries answered at
 * once, so it is narrowed here rather than paged by the server.
 */
export function matchingTemplates(
	templates: readonly TemplateListItem[],
	query: string,
): readonly TemplateListItem[] {
	const term = query.trim().toLocaleLowerCase();
	if (term === '') return templates;
	return templates.filter((template) =>
		[template.key, template.title, template.ownerModule].some((value) =>
			value.toLocaleLowerCase().includes(term),
		),
	);
}
