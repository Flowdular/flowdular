import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@flowdular/client';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	Icon,
	PageHeader,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import type {
	CreateAgentProcedureInput,
	UpdateAgentProcedureInput,
} from '../domain/types.ts';
import {
	archiveAgentProcedure,
	createAgentProcedure,
	deleteAgentProcedure,
	loadAgents,
	updateAgentProcedure,
} from './api.ts';
import { AgentProcedureForm } from './AgentProcedureForm.tsrx';
import { AgentProcedureList } from './AgentProcedureList.tsrx';
import { createAgentProcedureClientState } from './state.ts';

export interface AgentProceduresViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

export function AgentProceduresView(props: AgentProceduresViewProps) @{
	const client = useMemo(() => createAgentProcedureClientState(), []);
	const [procedures] = useValue(client.state.procedures);
	const [tools] = useValue(client.state.tools);
	const [selectedProcedureId, setSelectedProcedureId] = useValue(
		client.state.selectedProcedureId,
	);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [lifecycleAction, setLifecycleAction] = useValue(
		client.state.lifecycleAction,
	);
	const selected =
		procedures.find(
			(procedure) => procedure.id === selectedProcedureId,
		) ?? null;
	const active = procedures.filter(
		(procedure) => procedure.status === 'active',
	);
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible =
		term === ''
			? procedures
			: procedures.filter(
					(procedure) =>
						procedure.name.toLocaleLowerCase(activeLocale()).includes(term) ||
							procedure.key.includes(term) ||
							procedure.description.toLocaleLowerCase(activeLocale()).includes(
								term,
							),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgents();
			client.store.act((transaction) => {
				transaction.set(client.state.procedures, result.procedures);
				transaction.set(client.state.tools, result.tools);
			}, 'agent-procedures/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.procedures.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const open = (procedureId: string) => {
		setSelectedProcedureId(procedureId);
		if (props.canManage) setEditorOpen(true);
	};

	const save = async (
		input: CreateAgentProcedureInput | UpdateAgentProcedureInput,
	) => {
		setStatus('submitting');
		setError('');
		try {
			const saved =
				selected && 'expectedRevision' in input
					? await updateAgentProcedure(selected.id, input, props.csrfToken)
					: await createAgentProcedure(input, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(
					client.state.procedures,
					[
						...procedures.filter((procedure) => procedure.id !== saved.id),
						saved,
					].sort((left, right) => left.name.localeCompare(right.name)),
				);
				transaction.set(client.state.selectedProcedureId, saved.id);
				transaction.set(client.state.editorOpen, false);
			}, 'agent-procedures/saved');
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('agents.procedures.error.save'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const lifecycleTarget =
		procedures.find(
			(procedure) => procedure.id === selectedProcedureId,
		) ?? null;
	const manageLifecycle = async () => {
		if (!lifecycleTarget || lifecycleAction === '') return;
		setStatus('submitting');
		setError('');
		try {
			if (lifecycleAction === 'archive') {
				const archived = await archiveAgentProcedure(
					lifecycleTarget.id,
					lifecycleTarget.revision,
					props.csrfToken,
				);
				client.store.act((transaction) => {
					transaction.set(
						client.state.procedures,
						procedures.map(
							(procedure) => procedure.id === archived.id
								? archived
								: procedure,
						),
					);
				}, 'agent-procedures/archived');
			} else {
				await deleteAgentProcedure(
					lifecycleTarget.id,
					lifecycleTarget.revision,
					props.csrfToken,
				);
				client.store.act((transaction) => {
					transaction.set(
						client.state.procedures,
						procedures.filter(
							(procedure) => procedure.id !== lifecycleTarget.id,
						),
					);
					transaction.set(client.state.selectedProcedureId, '');
				}, 'agent-procedures/deleted');
			}
			setLifecycleAction('');
		} catch (lifecycleError) {
			setError(
				lifecycleError instanceof Error
					? lifecycleError.message
					: t('agents.procedures.error.lifecycle'),
			);
			setLifecycleAction('');
		} finally {
			setStatus('idle');
		}
	};

	const beginLifecycle = (id: string, action: 'archive' | 'delete') => {
		setSelectedProcedureId(id);
		setLifecycleAction(action);
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.common.core')}
			title={t('agents.procedures.title')}
			description={t('agents.procedures.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('agents.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					{t('agents.procedures.new')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<AgentProcedureList
			procedures={visible}
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
			open={editorOpen}
			title={selected ? selected.name : t('agents.procedures.new')}
			subtitle={selected
				? t('agents.procedures.drawer.revision', {
						revision: selected.revision,
						key: selected.key,
					})
				: t('agents.procedures.drawer.subtitle')}
			width="lg"
			onClose={() => setEditorOpen(false)}
		>
			<AgentProcedureForm
				key={selected?.id ?? 'new-procedure'}
				procedure={selected}
				tools={tools}
				busy={status === 'submitting'}
				onCancel={() => setEditorOpen(false)}
				onSubmit={save}
			/>
		</Drawer>
		<ConfirmDialog
			open={lifecycleAction !== '' && lifecycleTarget !== null}
			title={t('agents.procedures.lifecycle.' + lifecycleAction + '.title')}
			confirmLabel={t(
				'agents.procedures.lifecycle.' + lifecycleAction + '.confirm',
			)}
			cancelLabel={t('agents.common.cancel')}
			tone={lifecycleAction === 'delete' ? 'danger' : 'primary'}
			busy={status === 'submitting'}
			onCancel={() => setLifecycleAction('')}
			onConfirm={() => void manageLifecycle()}
		>{t('agents.procedures.lifecycle.' + lifecycleAction + '.description', {
			name: lifecycleTarget?.name ?? '',
		})}</ConfirmDialog>
	</div>
}
