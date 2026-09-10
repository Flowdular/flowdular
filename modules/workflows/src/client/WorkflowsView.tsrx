import { activeLocale, t } from '@flowdular/client';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { useEffect, useMemo } from 'octane';
import { useValue } from 'segment-state';
import type {
	CreateWorkflowDefinitionInput,
	WorkflowDefinition,
	WorkflowGraphV1,
	WorkflowNodeV1,
	WorkflowRunDetail,
	WorkflowRunSummary,
	WorkflowRunStatus,
	WorkflowSimulationFixture,
} from '../domain/types.ts';
import {
	archiveWorkflow,
	cancelWorkflowRun,
	createWorkflowDefinition,
	deleteWorkflow,
	enqueueWorkflow,
	loadWorkflowCatalog,
	loadWorkflowDefinitions,
	loadWorkflowDetail,
	loadWorkflowRunDetail,
	loadWorkflowRuns,
	observeWorkflowRun,
	parseJsonInput,
	publishWorkflow,
	retryWorkflowRun,
	simulateWorkflow,
	updateWorkflowDraft,
	validateWorkflowGraph,
} from './api.ts';
import {
	addWorkflowNode,
	connectWorkflowNodes,
	moveWorkflowNode,
	proposeWorkflowConnection,
	removeWorkflowEdge,
	removeWorkflowNode,
	replaceWorkflowNode,
	simulationFixtures,
	workflowOverlay,
	type WorkflowNodeType,
} from './canvas-model.ts';
import { dateTime } from './presentation.ts';
import { runActions } from './run-actions.ts';
import { repairCanvasIdentifiers } from './draft-repair.ts';
import {
	addConnectedNode,
	type ConnectedNodeRequest,
} from './connected-node.ts';
import { createWorkflowsClientState } from './state.ts';
import { WorkflowCreateForm } from './WorkflowCreateForm.tsrx';
import { WorkflowEditor } from './WorkflowEditor.tsrx';
import { WorkflowExecutionHistory } from './WorkflowExecutionHistory.tsrx';
import { WorkflowFixtureDrawer } from './WorkflowFixtureDrawer.tsrx';
import { WorkflowLiveConfirmation } from './WorkflowLiveConfirmation.tsrx';

export interface WorkflowsViewProps {
	readonly csrfToken: string;
	readonly canRead: boolean;
	readonly canManage: boolean;
	readonly canPublish: boolean;
	readonly canReadRuns: boolean;
	readonly canExecute: boolean;
	readonly canCancel: boolean;
}

function definitionColumns(): readonly TableColumn<WorkflowDefinition>[] {
	return [
		{
			key: 'workflow',
			header: t('workflows.table.column.workflow'),
			width: '42%',
			cell: (record) => <span class="ui-cell">
				<b>{record.name}</b>
				<small class="ui-mono">{record.key}</small>
			</span>,
		},
		{
			key: 'draft',
			header: t('workflows.table.column.draft'),
			width: '14%',
			numeric: true,
			cell: (record) => t('workflows.table.revision', {
				revision: record.currentDraftRevision,
			}),
		},
		{
			key: 'published',
			header: t('workflows.table.column.published'),
			width: '14%',
			numeric: true,
			cell: (record) => record.publishedRevision === null
				? t('workflows.table.notPublished')
				: t('workflows.table.revision', { revision: record.publishedRevision }),
		},
		{
			key: 'updated',
			header: t('workflows.table.column.updated'),
			width: '18%',
			cell: (record) => dateTime(record.updatedAt),
		},
		{
			key: 'status',
			header: t('workflows.table.column.status'),
			width: '12%',
			cell: (record) =>
				<Tag tone={record.status === 'active' ? 'success' : 'neutral'} dot>{t(
					'workflows.status.' + record.status,
				)}</Tag>,
		},
	];
}

const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
	'succeeded',
	'failed',
	'refused',
	'cancelled',
];

export function WorkflowsView(props: WorkflowsViewProps) @{
	const client = useMemo(() => createWorkflowsClientState(), []);
	const [definitions] = useValue(client.state.definitions);
	const [runs] = useValue(client.state.runs);
	const [detail, setDetail] = useValue(client.state.detail);
	const [graph, setGraph] = useValue(client.state.graph);
	const [selectedNodeId, setSelectedNodeId] = useValue(
		client.state.selectedNodeId,
	);
	const [selectedEdgeId, setSelectedEdgeId] = useValue(
		client.state.selectedEdgeId,
	);
	const [connectionSource, setConnectionSource] = useValue(
		client.state.connectionSource,
	);
	const [selectedRun, setSelectedRun] = useValue(client.state.selectedRun);
	const [agents] = useValue(client.state.agents);
	const [actions] = useValue(client.state.actions);
	const [validation, setValidation] = useValue(client.state.validation);
	const [liveValidation, setLiveValidation] = useValue(
		client.state.liveValidation,
	);
	const [validating, setValidating] = useValue(client.state.validating);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [notice, setNotice] = useValue(client.state.notice);
	const [dirty, setDirty] = useValue(client.state.dirty);
	const [saving, setSaving] = useValue(client.state.saving);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [runQuery, setRunQuery] = useValue(client.state.runQuery);
	const [runStatusFilter, setRunStatusFilter] = useValue(
		client.state.runStatusFilter,
	);
	const [runFiltersOpen, setRunFiltersOpen] = useValue(
		client.state.runFiltersOpen,
	);
	const [createOpen, setCreateOpen] = useValue(client.state.createOpen);
	const [fixturesOpen, setFixturesOpen] = useValue(client.state.fixturesOpen);
	const [liveConfirmOpen, setLiveConfirmOpen] = useValue(
		client.state.liveConfirmOpen,
	);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useValue(
		client.state.deleteConfirmOpen,
	);
	const [lifecycleTarget, setLifecycleTarget] = useValue(
		client.state.lifecycleTarget,
	);
	const [inputText, setInputText] = useValue(client.state.inputText);
	const [fixturesText, setFixturesText] = useValue(client.state.fixturesText);
	const [editorName, setEditorName] = useValue(client.state.editorName);
	const [editorDescription, setEditorDescription] = useValue(
		client.state.editorDescription,
	);
	const [editorMode, setEditorMode] = useValue(client.state.editorMode);
	const runCursor = useMemo(() => ({ value: null as string | null }), []);
	const editVersion = useMemo(() => ({ value: 0 }), []);
	const failedSaveVersion = useMemo(() => ({ value: -1 }), []);
	const createSession = useMemo(() => ({ value: 0 }), []);

	const refresh = async () => {
		if (!props.canRead) return;
		setStatus('loading');
		setError('');
		try {
			const [loadedDefinitions, runPage] = await Promise.all([
				loadWorkflowDefinitions(),
				props.canReadRuns
					? loadWorkflowRuns({
							limit: 50,
							...(runStatusFilter
								? { status: runStatusFilter as WorkflowRunStatus }
								: {}),
						})
					: Promise.resolve({
							runs: [],
							nextCursor: null,
						}),
			]);
			client.store.act((transaction) => {
				transaction.set(client.state.definitions, loadedDefinitions);
				transaction.set(client.state.runs, runPage.runs);
			}, 'workflows/loaded');
			runCursor.value = runPage.nextCursor;
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('workflows.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, [props.canRead]);

	useEffect(() => {
		if (!detail || !graph || !dirty || saving || !props.canManage) return;
		if (
			detail.definition.status === 'archived' ||
				failedSaveVersion.value === editVersion.value
		) return;
		const timer = setTimeout(() => {
			const scheduledVersion = editVersion.value;
			setSaving(true);
			setError('');
			void updateWorkflowDraft(
				{
					workflowId: detail.definition.id,
					expectedRevision: detail.draft.revision,
					name: editorName,
					description: editorDescription,
					graph,
				},
				props.csrfToken,
			).then((saved) => {
				setDetail(saved);
				if (editVersion.value === scheduledVersion) setDirty(false);
				setSaving(false);
			}).catch((saveError: unknown) => {
				failedSaveVersion.value = scheduledVersion;
				setSaving(false);
				setError(
					saveError instanceof Error
						? saveError.message
						: t('workflows.error.save'),
				);
			});
		}, 700);
		return () => clearTimeout(timer);
	}, [detail?.definition.id, graph, editorName, editorDescription, dirty, saving]);

	const changeGraph = (next: WorkflowGraphV1) => {
		editVersion.value += 1;
		setGraph(next);
		setDirty(true);
		setValidation(null);
	};

	const openEditor = async (definition: WorkflowDefinition) => {
		editVersion.value += 1;
		setStatus('loading');
		setError('');
		try {
			const [loaded, catalog, runPage] = await Promise.all([
				loadWorkflowDetail(definition.id),
				loadWorkflowCatalog(),
				props.canReadRuns
					? loadWorkflowRuns({
							workflowId: definition.id,
							limit: 50,
							...(runStatusFilter
								? { status: runStatusFilter as WorkflowRunStatus }
								: {}),
						})
					: Promise.resolve({ runs: [], nextCursor: null }),
			]);
			const editableGraph =
				props.canManage && loaded.definition.status !== 'archived'
					? repairCanvasIdentifiers(loaded.draft.graph)
					: loaded.draft.graph;
			client.store.act((transaction) => {
				transaction.set(client.state.detail, loaded);
				transaction.set(client.state.graph, editableGraph);
				transaction.set(client.state.editorName, loaded.definition.name);
				transaction.set(
					client.state.editorDescription,
					loaded.definition.description,
				);
				transaction.set(client.state.agents, catalog.agents);
				transaction.set(client.state.actions, catalog.actions);
				transaction.set(client.state.runs, runPage.runs);
				transaction.set(client.state.validation, null);
				transaction.set(client.state.liveValidation, null);
				transaction.set(client.state.selectedRun, null);
				transaction.set(client.state.selectedNodeId, '');
				transaction.set(client.state.selectedEdgeId, '');
				transaction.set(
					client.state.dirty,
					editableGraph !== loaded.draft.graph,
				);
				transaction.set(client.state.editorMode, 'editor');
				transaction.set(client.state.inputText, '{}');
				transaction.set(client.state.notice, '');
				transaction.set(client.state.connectionSource, null);
			}, 'workflows/editor-opened');
			setFixturesText(
				JSON.stringify(simulationFixtures(editableGraph), null, 2),
			);
			runCursor.value = runPage.nextCursor;
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('workflows.error.loadOne'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const create = async (input: CreateWorkflowDefinitionInput) => {
		setStatus('submitting');
		setError('');
		try {
			const definition = await createWorkflowDefinition(input, props.csrfToken);
			setCreateOpen(false);
			await openEditor(definition);
		} catch (createError) {
			setError(
				createError instanceof Error
					? createError.message
					: t('workflows.error.create'),
			);
			setStatus('idle');
		}
	};

	const addNode = (type: WorkflowNodeType, request?: ConnectedNodeRequest) => {
		if (!graph) return;
		const added =
			request
				? addConnectedNode(
						graph,
						type,
						t('workflows.nodeType.' + type),
						request,
					)
				: addWorkflowNode(graph, type, t('workflows.nodeType.' + type));
		if (!added) return;
		changeGraph(added.graph);
		setSelectedNodeId(added.nodeId);
		setSelectedEdgeId('');
	};

	const finishConnection = (nodeId: string, port: string) => {
		if (!graph || !connectionSource) {
			setNotice(t('workflows.canvas.chooseOutputFirst'));
			return;
		}
		const proposal = proposeWorkflowConnection(
			graph,
			connectionSource.nodeId,
			connectionSource.port,
			nodeId,
			port,
		);
		if (!proposal.valid) {
			setError(t('workflows.connectionError.' + proposal.code));
			return;
		}
		changeGraph(
			connectWorkflowNodes(
				graph,
				connectionSource.nodeId,
				connectionSource.port,
				nodeId,
				port,
			),
		);
		setConnectionSource(null);
		setNotice(t('workflows.canvas.connected'));
	};

	const dryRun = async () => {
		if (!graph) return;
		setStatus('submitting');
		setValidating(true);
		setError('');
		try {
			parseJsonInput(inputText);
			setValidation(await validateWorkflowGraph(graph, props.csrfToken));
		} catch (dryRunError) {
			setError(
				dryRunError instanceof Error
					? dryRunError.message
					: t('workflows.error.validate'),
			);
		} finally {
			setValidating(false);
			setStatus('idle');
		}
	};

	const selectRun = async (run: WorkflowRunSummary) => {
		setError('');
		try {
			if (dirty || saving) {
				setError(t('workflows.test.saveFirst'));
				return;
			}
			if (
				!detail || detail.definition.id !== run.workflowId ||
					editorMode !== 'editor'
			) {
				const definition =
					definitions.find((entry) => entry.id === run.workflowId) ??
						(await loadWorkflowDetail(run.workflowId)).definition;
				await openEditor(definition);
			}
			const loaded = await loadWorkflowRunDetail(run.id);
			setSelectedRun(loaded);
			setSelectedNodeId(loaded.compiledOrder[0] ?? '');
			setSelectedEdgeId('');
		} catch (runError) {
			setError(
				runError instanceof Error ? runError.message : t('workflows.error.run'),
			);
		}
	};

	const simulate = async () => {
		if (!detail) return;
		if (dirty || saving) {
			setError(t('workflows.test.saveFirst'));
			return;
		}
		setStatus('submitting');
		setError('');
		try {
			const fixtures = JSON.parse(
				inputFixtures(fixturesText),
			) as WorkflowSimulationFixture[];
			const run = await simulateWorkflow(
				{
					workflowId: detail.definition.id,
					input: parseJsonInput(inputText),
					fixtures,
				},
				props.csrfToken,
			);
			setSelectedRun(run);
			setNotice(t('workflows.test.simulationCreated'));
			await refreshRuns(detail.definition.id);
		} catch (simulationError) {
			setError(
				simulationError instanceof Error
					? simulationError.message
					: t('workflows.error.simulate'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const refreshRuns = async (
		workflowId?: string,
		statusValue = runStatusFilter,
	) => {
		if (!props.canReadRuns) return;
		const page = await loadWorkflowRuns({
			...(workflowId ? { workflowId } : {}),
			...(statusValue ? { status: statusValue as WorkflowRunStatus } : {}),
			limit: 50,
		});
		client.store.act(
			(transaction) => transaction.set(client.state.runs, page.runs),
			'workflows/runs-refreshed',
		);
		runCursor.value = page.nextCursor;
	};

	const confirmLive = async () => {
		if (!detail || !liveValidation?.valid) return;
		setLiveConfirmOpen(false);
		setStatus('submitting');
		setError('');
		try {
			const accepted = await enqueueWorkflow(
				{
					workflowKey: detail.definition.key,
					input: parseJsonInput(inputText),
					idempotencyKey: crypto.randomUUID(),
				},
				props.csrfToken,
			);
			setNotice(t('workflows.test.liveQueued', { id: accepted.runId }));
			await refreshRuns(detail.definition.id);
			setSelectedRun(await loadWorkflowRunDetail(accepted.runId));
		} catch (liveError) {
			setError(
				liveError instanceof Error
					? liveError.message
					: t('workflows.error.live'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const prepareLiveRun = async () => {
		if (!detail || detail.definition.publishedRevision === null) return;
		const published = detail.revisions.find(
			(revision) => revision.revision === detail.definition.publishedRevision,
		);
		if (!published) {
			setError(t('workflows.error.publishedRevision'));
			return;
		}
		setStatus('submitting');
		setError('');
		try {
			const report = await validateWorkflowGraph(
				published.graph,
				props.csrfToken,
			);
			setLiveValidation(report);
			if (!report.valid) {
				setError(t('workflows.error.liveInvalid'));
				return;
			}
			setLiveConfirmOpen(true);
		} catch (validationError) {
			setError(
				validationError instanceof Error
					? validationError.message
					: t('workflows.error.validate'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		if (
			!selectedRun || TERMINAL_RUN_STATUSES.includes(selectedRun.run.status)
		) return;
		const sequence = selectedRun.events.at(-1)?.sequence ?? 0;
		return observeWorkflowRun(
			selectedRun.run.id,
			sequence,
			() => {
				void loadWorkflowRunDetail(selectedRun.run.id).then(setSelectedRun);
			},
			() => {
				void loadWorkflowRunDetail(selectedRun.run.id).then(setSelectedRun);
			},
		);
	}, [selectedRun?.run.id, selectedRun?.run.status, selectedRun?.events.length]);

	const publish = async () => {
		if (!detail || !graph) return;
		if (dirty || saving) {
			setError(t('workflows.error.saveBeforePublish'));
			return;
		}
		setStatus('submitting');
		setError('');
		try {
			if (props.canExecute) {
				setValidating(true);
				const report = await validateWorkflowGraph(graph, props.csrfToken);
				setValidating(false);
				setValidation(report);
				if (!report.valid) {
					setError(t('workflows.error.publishInvalid'));
					return;
				}
			}
			const published = await publishWorkflow(
				detail.definition.id,
				detail.draft.revision,
				props.csrfToken,
			);
			setDetail(published);
			setNotice(
				t('workflows.editor.published', {
					revision: published.definition.publishedRevision ??
						published.draft.revision,
				}),
			);
		} catch (publishError) {
			setValidating(false);
			setError(
				publishError instanceof Error
					? publishError.message
					: t('workflows.error.publish'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const removeDefinition = async () => {
		if (!lifecycleTarget) return;
		setStatus('submitting');
		try {
			await deleteWorkflow(lifecycleTarget.id, props.csrfToken);
			setDeleteConfirmOpen(false);
			setLifecycleTarget(null);
			await refresh();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('workflows.error.delete'),
			);
			setStatus('idle');
		}
	};

	const archive = async (definition: WorkflowDefinition) => {
		setStatus('submitting');
		setError('');
		try {
			await archiveWorkflow(definition.id, props.csrfToken);
			await refresh();
		} catch (archiveError) {
			setError(
				archiveError instanceof Error
					? archiveError.message
					: t('workflows.error.archive'),
			);
			setStatus('idle');
		}
	};

	const loadMoreRuns = async () => {
		if (!runCursor.value) return;
		setStatus('loading');
		try {
			const page = await loadWorkflowRuns({
				...(detail ? { workflowId: detail.definition.id } : {}),
				...(runStatusFilter
					? { status: runStatusFilter as WorkflowRunStatus }
					: {}),
				limit: 50,
				cursor: runCursor.value,
			});
			client.store.act(
				(transaction) => transaction.set(client.state.runs, [
					...runs,
					...page.runs,
				]),
				'workflows/runs-paged',
			);
			runCursor.value = page.nextCursor;
		} catch (pageError) {
			setError(
				pageError instanceof Error
					? pageError.message
					: t('workflows.error.run'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const cancelRun = async () => {
		if (!selectedRun || !runActions(selectedRun.run, {
					execute: props.canExecute,
					cancel: props.canCancel,
				}).cancel) return;
		setStatus('submitting');
		try {
			await cancelWorkflowRun(selectedRun.run.id, props.csrfToken);
			setSelectedRun(await loadWorkflowRunDetail(selectedRun.run.id));
		} catch (cancelError) {
			setError(
				cancelError instanceof Error
					? cancelError.message
					: t('workflows.error.cancel'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const retryRun = async () => {
		if (!selectedRun || !runActions(selectedRun.run, {
					execute: props.canExecute,
					cancel: props.canCancel,
				}).retry) return;
		setStatus('submitting');
		try {
			const accepted = await retryWorkflowRun(
				selectedRun.run.id,
				props.csrfToken,
			);
			setSelectedRun(await loadWorkflowRunDetail(accepted.runId));
			await refreshRuns(detail?.definition.id);
		} catch (retryError) {
			setError(
				retryError instanceof Error
					? retryError.message
					: t('workflows.error.retry'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visibleDefinitions = definitions.filter(
		(definition) =>
			(term === '' ||
				definition.name.toLocaleLowerCase(locale).includes(term) ||
				definition.key.toLocaleLowerCase(locale).includes(term)) &&
				(statusFilter === '' || definition.status === statusFilter),
	);
	const displayedGraph = selectedRun?.graph ?? graph;
	const selectedNode =
		displayedGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null;
	const selectedEdge =
		displayedGraph?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
	const history =
		props.canReadRuns
			? <WorkflowExecutionHistory
					runs={runs}
					query={runQuery}
					statusFilter={runStatusFilter}
					filtersOpen={runFiltersOpen}
					loading={status === 'loading'}
					hasMore={runCursor.value !== null}
					selectedRunId={selectedRun?.run.id ?? ''}
					onQuery={setRunQuery}
					onStatusFilter={(value) => {
						setRunStatusFilter(value);
						void refreshRuns(detail?.definition.id, value);
					}}
					onToggleFilters={() => setRunFiltersOpen(!runFiltersOpen)}
					onSelect={(run) => void selectRun(run)}
					onLoadMore={() => void loadMoreRuns()}
				/>
			: null;

	<>
		@if (!props.canRead) {
			<div class="ui-view">
				<EmptyState icon="shield" title={t('workflows.denied.title')}>{t(
					'workflows.denied.hint',
				)}</EmptyState>
			</div>
		} @else if (editorMode === 'editor' && detail && graph) {
			<>
				<WorkflowEditor
					key={detail.definition.id}
					detail={detail}
					graph={graph}
					name={editorName}
					description={editorDescription}
					selectedNode={selectedNode}
					selectedEdge={selectedEdge}
					connectionSource={connectionSource}
					validation={validation}
					validating={validating}
					selectedRun={selectedRun}
					overlay={selectedRun
						? workflowOverlay(selectedRun.nodes, selectedRun.edges)
						: null}
					agents={agents}
					actions={actions}
					inputText={inputText}
					error={error}
					notice={notice}
					busy={status === 'submitting'}
					saving={saving}
					dirty={dirty}
					history={history}
					canManage={props.canManage && detail.definition.status === 'active'}
					canPublish={props.canPublish && detail.definition.status === 'active'}
					canExecute={props.canExecute}
					canCancel={props.canCancel}
					onBack={() => {
						if (dirty || saving) return;
						setEditorMode('catalog');
						setSelectedRun(null);
						setDetail(null);
						void refresh();
					}}
					onName={(value) => {
						editVersion.value += 1;
						setEditorName(value);
						setDirty(true);
					}}
					onDescription={(value) => {
						editVersion.value += 1;
						setEditorDescription(value);
						setDirty(true);
					}}
					onAddNode={addNode}
					onReplaceGraph={changeGraph}
					onSelectNode={(nodeId) => {
						setSelectedNodeId(nodeId);
						setSelectedEdgeId('');
					}}
					onSelectEdge={(edgeId) => {
						setSelectedEdgeId(edgeId);
						if (edgeId) setSelectedNodeId('');
					}}
					onStartConnection={(nodeId, port) => {
						setConnectionSource({ nodeId, port });
						setNotice('');
					}}
					onFinishConnection={finishConnection}
					onCancelConnection={() => {
						setConnectionSource(null);
						setNotice('');
					}}
					onMoveNode={(nodeId, x, y) => changeGraph(
						moveWorkflowNode(graph, nodeId, x, y),
					)}
					onReplaceNode={(node: WorkflowNodeV1) => changeGraph(
						replaceWorkflowNode(graph, node),
					)}
					onRemoveNode={(nodeId) => {
						changeGraph(removeWorkflowNode(graph, nodeId));
						setSelectedNodeId('');
					}}
					onRemoveEdge={(edgeId) => {
						changeGraph(removeWorkflowEdge(graph, edgeId));
						setSelectedEdgeId('');
					}}
					onDryRun={() => void dryRun()}
					onSimulate={() => void simulate()}
					onRunLive={() => void prepareLiveRun()}
					onPublish={() => void publish()}
					onInput={setInputText}
					onOpenFixtures={() => setFixturesOpen(true)}
					onCloseRun={() => {
						setSelectedRun(null);
						setSelectedNodeId('');
						setSelectedEdgeId('');
					}}
					onCancelRun={() => void cancelRun()}
					onRetryRun={() => void retryRun()}
				/>
			</>
		} @else {
			<div class="ui-view">
				<PageHeader
					eyebrow={t('workflows.page.eyebrow')}
					title={t('workflows.page.title')}
					description={t('workflows.page.description')}
				>
					<Button size="sm" onClick={() => void refresh()}>
						<Icon name="refresh" size={14} />
						{status === 'loading'
							? t('workflows.common.refreshing')
							: t('workflows.action.refresh')}
					</Button>
					@if (props.canManage) {
						<Button
							size="sm"
							variant="primary"
							onClick={() => {
								createSession.value += 1;
								setError('');
								setCreateOpen(true);
							}}
						>
							<Icon name="plus" size={14} />
							{t('workflows.action.new')}
						</Button>
					}
				</PageHeader>
				@if (error && !createOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('workflows.table.title')}
					count={t('workflows.table.count', { count: definitions.length })}
					search={<SearchField
						value={query}
						placeholder={t('workflows.table.searchPlaceholder')}
						label={t('workflows.table.searchLabel')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={statusFilter ? 1 : 0}
						label={t('workflows.common.filters')}
					>
						<label>
							<span class="ui-label">{t('workflows.table.statusFilter')}</span>
							<select
								class="ui-select"
								value={statusFilter}
								onInput={(event) => setStatusFilter(event.currentTarget.value)}
							>
								<option value="">{t('workflows.table.allStatuses')}</option>
								<option value="active">{t('workflows.status.active')}</option>
								<option value="archived">{t(
									'workflows.status.archived',
								)}</option>
							</select>
						</label>
					</Filters>}
					caption={t('workflows.table.caption')}
					columns={definitionColumns()}
					rows={visibleDefinitions}
					rowKey={(record) => record.id}
					status={status === 'loading' && definitions.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('workflows.table.loading')}
					filtered={term !== '' || statusFilter !== ''}
					empty={{
						icon: 'modules',
						title: t('workflows.table.emptyTitle'),
						hint: t('workflows.table.emptyHint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('workflows.table.filteredTitle'),
						hint: t('workflows.table.filteredHint'),
					}}
					actions={props.canManage
						? (record) => [
								{
									id: 'open',
									label: t('workflows.action.open'),
									icon: 'external',
									onSelect: () => void openEditor(record),
								},
								...(record.status === 'active'
									? [
											{
												id: 'archive',
												label: t('workflows.action.archive'),
												onSelect: () => void archive(record),
											},
										]
									: []),
								...(record.publishedRevision === null
									? [
											{
												id: 'delete',
												label: t('workflows.action.delete'),
												icon: 'x' as const,
												tone: 'danger' as const,
												onSelect: () => {
													setLifecycleTarget(record);
													setDeleteConfirmOpen(true);
												},
											},
										]
									: []),
							]
						: (record) => [
								{
									id: 'open',
									label: t('workflows.action.open'),
									icon: 'external',
									onSelect: () => void openEditor(record),
								},
							]}
					actionsLabel={t('workflows.table.actions')}
					actionsWidth="320px"
				/>
				{history}
			</div>
		}
		<Drawer
			open={createOpen}
			title={t('workflows.create.title')}
			subtitle={t('workflows.create.subtitle')}
			onClose={() => {
				if (status !== 'submitting') setCreateOpen(false);
			}}
		>
			<WorkflowCreateForm
				key={'workflow-create-' + createSession.value}
				busy={status === 'submitting'}
				error={error}
				onCancel={() => setCreateOpen(false)}
				onSubmit={(input) => void create(input)}
			/>
		</Drawer>
		<WorkflowFixtureDrawer
			open={fixturesOpen}
			graph={graph}
			value={fixturesText}
			onChange={setFixturesText}
			onClose={() => setFixturesOpen(false)}
		/>
		<ConfirmDialog
			open={liveConfirmOpen}
			title={t('workflows.liveConfirm.title')}
			confirmLabel={t('workflows.liveConfirm.confirm')}
			cancelLabel={t('workflows.common.cancel')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void confirmLive()}
			onCancel={() => setLiveConfirmOpen(false)}
		>
			<WorkflowLiveConfirmation
				graph={detail?.revisions.find(
					(revision) =>
						revision.revision === detail.definition.publishedRevision,
				)?.graph ?? null}
				report={liveValidation}
				agents={agents}
				actions={actions}
			/>
		</ConfirmDialog>
		<ConfirmDialog
			open={deleteConfirmOpen}
			title={t('workflows.delete.title')}
			confirmLabel={t('workflows.delete.confirm')}
			cancelLabel={t('workflows.common.cancel')}
			busy={status === 'submitting'}
			onConfirm={() => void removeDefinition()}
			onCancel={() => {
				setDeleteConfirmOpen(false);
				setLifecycleTarget(null);
			}}
		>{t('workflows.delete.description')}</ConfirmDialog>
	</>
}

function inputFixtures(value: string): string {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) throw new Error(t(
		'workflows.test.fixturesInvalid',
	));
	return value;
}
