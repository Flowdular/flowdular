import { cell, createStore } from 'segment-state';
import type { ModuleCatalogEntry } from './api.ts';

export type ModulesStatus = 'loading' | 'idle' | 'denied' | 'error';
export type ModulesTab = 'catalog' | 'flags';

/** The activation change waiting for the owner's confirmation. */
export interface PendingActivation {
	readonly moduleId: string;
	readonly active: boolean;
}

export function createModulesClientState() {
	const store = createStore({
		modules: cell<readonly ModuleCatalogEntry[]>([]),
		commands: cell<Readonly<Record<string, string>>>({}),
		status: cell<ModulesStatus>('loading'),
		error: '',
		query: '',
		selectedModuleId: cell<string | null>(null),
		tab: cell<ModulesTab>('catalog'),
		pending: cell<PendingActivation | null>(null),
		busyModuleId: cell<string | null>(null),
		activationError: '',
	});
	return { store, state: store.state };
}

/** Why the row action is refused before the server is asked, else null. */
export function activationRefusal(
	module: ModuleCatalogEntry,
	canManage: boolean,
	translate: (key: string, params?: Record<string, string>) => string,
): string | null {
	if (!module.enabled) return translate('system.activation.notComposed');
	if (!canManage) return translate('system.activation.deniedManage');
	if (!module.optional) return translate('system.activation.required');
	if (module.active && module.dependents.length > 0) {
		return translate('system.activation.dependents', {
			modules: module.dependents.join(', '),
		});
	}
	return null;
}
