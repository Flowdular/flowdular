import { cell, createStore } from 'segment-state';
import type {
	AutomationSchedule,
	AutomationTargetOption,
	AutomationTrigger,
} from '../domain/types.ts';
import type { VariableDefinition } from '@flowdular/contracts';

export function createAutomationScheduleClientState() {
	const store = createStore({
		schedules: cell<readonly AutomationSchedule[]>([]),
		targets: cell<readonly AutomationTargetOption[]>([]),
		variables: cell<readonly VariableDefinition[]>([]),
		selectedScheduleId: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		notice: '',
		query: '',
		enabledOnly: false,
		filtersOpen: false,
		editorOpen: false,
	});
	return { store, state: store.state };
}

export function createAutomationTriggerClientState() {
	const store = createStore({
		triggers: cell<readonly AutomationTrigger[]>([]),
		targets: cell<readonly AutomationTargetOption[]>([]),
		selectedTriggerId: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		enabledOnly: false,
		filtersOpen: false,
		editorOpen: false,
		revealedSecret: '',
	});
	return { store, state: store.state };
}
