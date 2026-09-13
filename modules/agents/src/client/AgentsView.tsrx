import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@flowdular/client';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	Icon,
	PageHeader,
	type TableSort,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import type {
	CreateAgentInput,
	UpdateAgentInput,
	UpdateModuleAgentBindingInput,
} from '../domain/types.ts';
import {
	archiveAgent,
	createAgent,
	deleteAgent,
	loadAgentContext,
	loadAgentsPage,
	updateAgent,
	updateModuleAgentBinding,
} from './api.ts';
import { AgentDefinitionForm } from './AgentDefinitionForm.tsrx';
import { AgentDefinitionList } from './AgentDefinitionList.tsrx';
import { ModuleAgentBindingForm } from './ModuleAgentBindingForm.tsrx';
import { ModuleAgentList } from './ModuleAgentList.tsrx';
import {
	agentSorting,
	createAgentClientState,
	FIRST_PAGE,
	moveToPage,
	PAGE_SIZE,
	pageCursor,
	pageLoaded,
} from './state.ts';

export interface AgentsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/* A search term waits for the reader to stop typing before it becomes a
   request; a sort or page change is one deliberate action and goes at once. */
const SEARCH_DEBOUNCE_MS = 250;

export function AgentsView(props: AgentsViewProps) @{
	const client = useMemo(() => createAgentClientState(), []);
	const [agents] = useValue(client.state.agents);
	const [moduleAgents] = useValue(client.state.moduleAgents);
	const [providers] = useValue(client.state.providers);
	const [tools] = useValue(client.state.tools);
	const [procedures] = useValue(client.state.procedures);
	const [selectedAgentId, setSelectedAgentId] = useValue(
		client.state.selectedAgentId,
	);
	const [selectedModuleAgentId, setSelectedModuleAgentId] = useValue(
		client.state.selectedModuleAgentId,
	);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query] = useValue(client.state.query);
	const [sorting] = useValue(client.state.sorting);
	const [page] = useValue(client.state.page);
	const [moduleQuery, setModuleQuery] = useValue(client.state.moduleQuery);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [moduleEditorOpen, setModuleEditorOpen] = useValue(
		client.state.moduleEditorOpen,
	);
	const [lifecycleAction, setLifecycleAction] = useValue(
		client.state.lifecycleAction,
	);
	const selected = agents.find((agent) => agent.id === selectedAgentId) ?? null;
	const selectedModuleAgent =
		moduleAgents.find((agent) => agent.id === selectedModuleAgentId) ?? null;
	const activeModuleAgents = moduleAgents.filter(
		(agent) => agent.status === 'active',
	);
	const term = query.trim();
	const sort = sorting[0] ?? { key: 'name', desc: false };
	const moduleTerm = moduleQuery.trim().toLocaleLowerCase(activeLocale());
	const visibleModuleAgents =
		moduleTerm === ''
			? moduleAgents
			: moduleAgents.filter(
					(agent) =>
						agent.name.toLocaleLowerCase(activeLocale()).includes(moduleTerm) ||
							agent.key.includes(moduleTerm) ||
							agent.ownership.moduleId.includes(moduleTerm) ||
							agent.description.toLocaleLowerCase(activeLocale()).includes(
								moduleTerm,
							),
				);

	const loadPage = async (isCurrent: () => boolean = () => true) => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgentsPage({
				limit: PAGE_SIZE,
				cursor: pageCursor(page),
				sort: sort.key === 'updatedAt' ? 'updatedAt' : 'name',
				direction: sort.desc ? 'desc' : 'asc',
				q: term,
			});
			if (!isCurrent()) return;
			client.store.act((transaction) => {
				transaction.set(client.state.agents, result.items);
				transaction.set(
					client.state.page,
					pageLoaded(page, result.page.nextCursor),
				);
			}, 'agents/page-loaded');
		} catch (loadError) {
			if (!isCurrent()) return;
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.definitions.error.load'),
			);
		} finally {
			if (isCurrent()) setStatus('idle');
		}
	};

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgentContext();
			client.store.act((transaction) => {
				transaction.set(client.state.moduleAgents, result.moduleAgents);
				transaction.set(client.state.providers, result.providers);
				transaction.set(client.state.tools, result.tools);
				transaction.set(client.state.procedures, result.procedures);
			}, 'agents/context-loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.definitions.error.load'),
			);
			setStatus('idle');
			return;
		}
		await loadPage();
	};

	/* Every change of the search, the sort or the page is one request for the
   page it names; the reset to page zero happens where the change is made. */
	const setQuery = (value: string) => client.store.act((transaction) => {
		transaction.set(client.state.query, value);
		transaction.set(client.state.page, FIRST_PAGE);
	}, 'agents/search');
	const setSorting = (sorts: readonly TableSort[]) => client.store.act((
		transaction,
	) => {
		transaction.set(client.state.sorting, agentSorting(sorts));
		transaction.set(client.state.page, FIRST_PAGE);
	}, 'agents/sort');
	const setPage = (pageIndex: number) => client.store.act(
		(transaction) => transaction.set(
			client.state.page,
			moveToPage(page, pageIndex),
		),
		'agents/page',
	);

	useEffect(() => {
		let current = true;
		const timer = setTimeout(
			() => void loadPage(() => current),
			term === '' ? 0 : SEARCH_DEBOUNCE_MS,
		);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [term, sort.key, sort.desc, page.pageIndex]);

	const openModuleAgent = (agentId: string) => {
		setSelectedModuleAgentId(agentId);
		if (props.canManage) setModuleEditorOpen(true);
	};

	const saveModuleAgent = async (input: UpdateModuleAgentBindingInput) => {
		setStatus('submitting');
		setError('');
		try {
			const saved = await updateModuleAgentBinding(input, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(
					client.state.moduleAgents,
					moduleAgents.map((agent) => agent.id === saved.id ? saved : agent),
				);
				transaction.set(client.state.moduleEditorOpen, false);
			}, 'agents/module-binding-saved');
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('agents.moduleAgents.error.save'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void loadAgentContext().then(
			(result) => client.store.act((transaction) => {
				transaction.set(client.state.moduleAgents, result.moduleAgents);
				transaction.set(client.state.providers, result.providers);
				transaction.set(client.state.tools, result.tools);
				transaction.set(client.state.procedures, result.procedures);
			}, 'agents/context-loaded'),
		).catch(
			(loadError: unknown) => setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.definitions.error.load'),
			),
		);
	}, []);

	const open = (agentId: string) => {
		setSelectedAgentId(agentId);
		if (props.canManage) setEditorOpen(true);
	};

	const save = async (input: CreateAgentInput | UpdateAgentInput) => {
		setStatus('submitting');
		setError('');
		try {
			const saved =
				selected && 'expectedRevision' in input
					? await updateAgent(selected.id, input, props.csrfToken)
					: await createAgent(input, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.selectedAgentId, saved.id);
				transaction.set(client.state.editorOpen, false);
			}, 'agents/saved');
			await loadPage();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('agents.definitions.error.save'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const lifecycleTarget =
		agents.find((agent) => agent.id === selectedAgentId) ?? null;
	const manageLifecycle = async () => {
		if (!lifecycleTarget || lifecycleAction === '') return;
		setStatus('submitting');
		setError('');
		try {
			if (lifecycleAction === 'archive') {
				const archived = await archiveAgent(
					lifecycleTarget.id,
					lifecycleTarget.revision,
					props.csrfToken,
				);
				client.store.act((transaction) => {
					transaction.set(
						client.state.agents,
						agents.map((agent) => agent.id === archived.id ? archived : agent),
					);
				}, 'agents/archived');
			} else {
				await deleteAgent(
					lifecycleTarget.id,
					lifecycleTarget.revision,
					props.csrfToken,
				);
				client.store.act((transaction) => {
					transaction.set(client.state.selectedAgentId, '');
				}, 'agents/deleted');
				await loadPage();
			}
			setLifecycleAction('');
		} catch (lifecycleError) {
			setError(
				lifecycleError instanceof Error
					? lifecycleError.message
					: t('agents.definitions.error.lifecycle'),
			);
			setLifecycleAction('');
		} finally {
			setStatus('idle');
		}
	};

	const beginLifecycle = (id: string, action: 'archive' | 'delete') => {
		setSelectedAgentId(id);
		setLifecycleAction(action);
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.common.core')}
			title={t('agents.definitions.title')}
			description={t('agents.definitions.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('agents.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					{t('agents.definitions.new')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<ModuleAgentList
			agents={visibleModuleAgents}
			status={status === 'loading' ? 'loading' : 'idle'}
			providers={providers}
			filtered={moduleTerm !== ''}
			canManage={props.canManage}
			query={moduleQuery}
			activeCount={activeModuleAgents.length}
			onQuery={setModuleQuery}
			onConfigure={openModuleAgent}
		/>
		<AgentDefinitionList
			agents={agents}
			status={status === 'loading' ? 'loading' : 'idle'}
			providers={providers}
			filtered={term !== ''}
			canManage={props.canManage}
			query={query}
			sorting={sorting}
			page={page}
			onQuery={setQuery}
			onSortingChange={setSorting}
			onPageChange={setPage}
			onSelect={open}
			onArchive={(id) => beginLifecycle(id, 'archive')}
			onDelete={(id) => beginLifecycle(id, 'delete')}
		/>
		<Drawer
			open={moduleEditorOpen && selectedModuleAgent !== null}
			title={selectedModuleAgent?.name ?? t('agents.moduleAgents.title')}
			subtitle={selectedModuleAgent
				? t('agents.moduleAgents.drawer.subtitle', {
						module: selectedModuleAgent.ownership.moduleId,
						revision: selectedModuleAgent.ownership.definitionRevision,
					})
				: ''}
			width="lg"
			onClose={() => setModuleEditorOpen(false)}
		>
			@if (selectedModuleAgent) {
				<ModuleAgentBindingForm
					key={selectedModuleAgent.id + ':' +
						String(selectedModuleAgent.bindingRevision ?? 0)}
					agent={selectedModuleAgent}
					providers={providers}
					busy={status === 'submitting'}
					onCancel={() => setModuleEditorOpen(false)}
					onSubmit={saveModuleAgent}
				/>
			}
		</Drawer>
		<Drawer
			open={editorOpen}
			title={selected ? selected.name : t('agents.definitions.new')}
			subtitle={selected
				? t('agents.definitions.drawer.revision', {
						revision: selected.revision,
						key: selected.key,
					})
				: t('agents.definitions.drawer.subtitle')}
			width="lg"
			onClose={() => setEditorOpen(false)}
		>
			<AgentDefinitionForm
				key={selected?.id ?? 'new-agent'}
				agent={selected}
				providers={providers}
				tools={tools}
				procedures={procedures}
				busy={status === 'submitting'}
				onCancel={() => setEditorOpen(false)}
				onSubmit={save}
			/>
		</Drawer>
		<ConfirmDialog
			open={lifecycleAction !== '' && lifecycleTarget !== null}
			title={t('agents.definitions.lifecycle.' + lifecycleAction + '.title')}
			confirmLabel={t(
				'agents.definitions.lifecycle.' + lifecycleAction + '.confirm',
			)}
			cancelLabel={t('agents.common.cancel')}
			tone={lifecycleAction === 'delete' ? 'danger' : 'primary'}
			busy={status === 'submitting'}
			onCancel={() => setLifecycleAction('')}
			onConfirm={() => void manageLifecycle()}
		>{t('agents.definitions.lifecycle.' + lifecycleAction + '.description', {
			name: lifecycleTarget?.name ?? '',
		})}</ConfirmDialog>
	</div>
}
