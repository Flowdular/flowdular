import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@coreloom/client';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	Icon,
	PageHeader,
} from '@coreloom/ui';
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
	loadAgents,
	updateAgent,
	updateModuleAgentBinding,
} from './api.ts';
import { AgentDefinitionForm } from './AgentDefinitionForm.tsrx';
import { AgentDefinitionList } from './AgentDefinitionList.tsrx';
import { ModuleAgentBindingForm } from './ModuleAgentBindingForm.tsrx';
import { ModuleAgentList } from './ModuleAgentList.tsrx';
import { createAgentClientState } from './state.ts';

export interface AgentsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

export function AgentsView(props: AgentsViewProps) @{
	const client = useMemo(() => createAgentClientState(), []);
	const [agents] = useValue(client.state.agents);
	const [moduleAgents] = useValue(client.state.moduleAgents);
	const [providers] = useValue(client.state.providers);
	const [tools] = useValue(client.state.tools);
	const [skills] = useValue(client.state.skills);
	const [selectedAgentId, setSelectedAgentId] = useValue(
		client.state.selectedAgentId,
	);
	const [selectedModuleAgentId, setSelectedModuleAgentId] = useValue(
		client.state.selectedModuleAgentId,
	);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
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
	const active = agents.filter((agent) => agent.status === 'active');
	const activeModuleAgents = moduleAgents.filter(
		(agent) => agent.status === 'active',
	);
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible =
		term === ''
			? agents
			: agents.filter(
					(agent) =>
						agent.name.toLocaleLowerCase(activeLocale()).includes(term) ||
							agent.key.includes(term) ||
							agent.description.toLocaleLowerCase(activeLocale()).includes(
								term,
							),
				);
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

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgents();
			client.store.act((transaction) => {
				transaction.set(client.state.agents, result.agents);
				transaction.set(client.state.moduleAgents, result.moduleAgents);
				transaction.set(client.state.providers, result.providers);
				transaction.set(client.state.tools, result.tools);
				transaction.set(client.state.skills, result.skills);
			}, 'agents/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.definitions.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

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
		void refresh();
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
				transaction.set(
					client.state.agents,
					[...agents.filter((agent) => agent.id !== saved.id), saved].sort(
						(left, right) => left.name.localeCompare(right.name),
					),
				);
				transaction.set(client.state.selectedAgentId, saved.id);
				transaction.set(client.state.editorOpen, false);
			}, 'agents/saved');
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
					transaction.set(
						client.state.agents,
						agents.filter((agent) => agent.id !== lifecycleTarget.id),
					);
					transaction.set(client.state.selectedAgentId, '');
				}, 'agents/deleted');
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
			agents={visible}
			status={status === 'loading' ? 'loading' : 'idle'}
			providers={providers}
			filtered={term !== ''}
			canManage={props.canManage}
			query={query}
			activeCount={active.length}
			onQuery={setQuery}
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
				skills={skills}
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
