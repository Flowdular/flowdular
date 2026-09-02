import { cell, createStore } from 'segment-state';
import type {
	WorkflowDefinition,
	WorkflowDefinitionDetail,
	WorkflowDryRunResponseV1,
	WorkflowGraphV1,
	WorkflowRunDetail,
	WorkflowRunSummary,
} from '../domain/types.ts';
import type {
	WorkflowActionCatalogItem,
	WorkflowAgentCatalogItem,
} from './api.ts';

export function createWorkflowsClientState() {
	const store = createStore({
		definitions: cell<readonly WorkflowDefinition[]>([]),
		runs: cell<readonly WorkflowRunSummary[]>([]),
		detail: cell<WorkflowDefinitionDetail | null>(null),
		graph: cell<WorkflowGraphV1 | null>(null),
		selectedNodeId: '',
		selectedEdgeId: '',
		connectionSource: cell<{
			readonly nodeId: string;
			readonly port: string;
		} | null>(null),
		selectedRun: cell<WorkflowRunDetail | null>(null),
		agents: cell<readonly WorkflowAgentCatalogItem[]>([]),
		actions: cell<readonly WorkflowActionCatalogItem[]>([]),
		validation: cell<WorkflowDryRunResponseV1 | null>(null),
		liveValidation: cell<WorkflowDryRunResponseV1 | null>(null),
		validating: false,
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		notice: '',
		dirty: false,
		saving: false,
		query: '',
		statusFilter: '',
		filtersOpen: false,
		runQuery: '',
		runStatusFilter: '',
		runFiltersOpen: false,
		createOpen: false,
		fixturesOpen: false,
		liveConfirmOpen: false,
		deleteConfirmOpen: false,
		lifecycleTarget: cell<WorkflowDefinition | null>(null),
		inputText: '{}',
		fixturesText: '[]',
		editorName: '',
		editorDescription: '',
		editorMode: cell<'catalog' | 'editor'>('catalog'),
		panel: cell<'inspector' | 'validation' | 'test' | 'history'>('inspector'),
	});
	return { store, state: store.state };
}
