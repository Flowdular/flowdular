import { cell, createStore } from 'segment-state';
import type {
	AuditDataClass,
	AuditExportRun,
	AuditLegalHold,
	AuditSweepRun,
	ExportStatus,
	HoldScopeKind,
	HoldStatus,
	RetentionMode,
	SweepStatus,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export function createDataClassesClientState() {
	const store = createStore({
		classes: cell<readonly AuditDataClass[]>([]),
		/* Every composed module, including the ones holding no class, so the
		   screen can say so instead of leaving the reader guessing. */
		emptyModules: cell<readonly string[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		moduleFilter: '',
		filtersOpen: false,
		editing: cell<AuditDataClass | null>(null),
		formMode: cell<RetentionMode>('default'),
		formDays: '',
		formError: '',
	});
	return { store, state: store.state };
}

export function createSweepsClientState() {
	const store = createStore({
		sweeps: cell<readonly AuditSweepRun[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<SweepStatus | ''>(''),
		filtersOpen: false,
	});
	return { store, state: store.state };
}

export function createExportsClientState() {
	const store = createStore({
		exports: cell<readonly AuditExportRun[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<ExportStatus | ''>(''),
		filtersOpen: false,
	});
	return { store, state: store.state };
}

export function createHoldsClientState() {
	const store = createStore({
		holds: cell<readonly AuditLegalHold[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<HoldStatus | ''>(''),
		scopeFilter: cell<HoldScopeKind | ''>(''),
		filtersOpen: false,
		/* `place` opens the form for a new hold; a hold opens the lift form. */
		placing: false,
		lifting: cell<AuditLegalHold | null>(null),
		formScope: cell<HoldScopeKind>('account'),
		formAccountId: '',
		formClassId: '',
		formFrom: '',
		formTo: '',
		formReason: '',
		formError: '',
	});
	return { store, state: store.state };
}
