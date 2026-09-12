import { cell, createStore } from 'segment-state';
import type { ModuleCatalogEntry } from './api.ts';

export type ModulesStatus = 'loading' | 'idle' | 'denied' | 'error';
export type ModulesTab = 'catalog' | 'flags';

export function createModulesClientState() {
	const store = createStore({
		modules: cell<readonly ModuleCatalogEntry[]>([]),
		commands: cell<Readonly<Record<string, string>>>({}),
		status: cell<ModulesStatus>('loading'),
		error: '',
		query: '',
		selectedModuleId: cell<string | null>(null),
		tab: cell<ModulesTab>('catalog'),
	});
	return { store, state: store.state };
}
