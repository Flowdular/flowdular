import type { ModuleClientContribution } from '@coreloom/client';

export interface DraftModuleEntry {
	readonly createClientContribution?: (context: {
		readonly csrfToken: string;
		readonly scopes: readonly string[];
	}) => ModuleClientContribution;
}

/* The draft module lives in a session workspace outside this app, so its entry
   is resolved at runtime. The ignore comment stays in this plain module: the
   TSRX compiler drops comments from call arguments, which would make Vite warn
   about an unanalyzable import on every preview load. */
export function importDraftModule(entry: string): Promise<DraftModuleEntry> {
	return import(/* @vite-ignore */ entry) as Promise<DraftModuleEntry>;
}
