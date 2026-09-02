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
	CreateAgentSkillInput,
	UpdateAgentSkillInput,
} from '../domain/types.ts';
import {
	archiveAgentSkill,
	createAgentSkill,
	deleteAgentSkill,
	loadAgents,
	updateAgentSkill,
} from './api.ts';
import { AgentSkillForm } from './AgentSkillForm.tsrx';
import { AgentSkillList } from './AgentSkillList.tsrx';
import { createAgentSkillClientState } from './state.ts';

export interface AgentSkillsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

export function AgentSkillsView(props: AgentSkillsViewProps) @{
	const client = useMemo(() => createAgentSkillClientState(), []);
	const [skills] = useValue(client.state.skills);
	const [tools] = useValue(client.state.tools);
	const [selectedSkillId, setSelectedSkillId] = useValue(
		client.state.selectedSkillId,
	);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [lifecycleAction, setLifecycleAction] = useValue(
		client.state.lifecycleAction,
	);
	const selected = skills.find((skill) => skill.id === selectedSkillId) ?? null;
	const active = skills.filter((skill) => skill.status === 'active');
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible =
		term === ''
			? skills
			: skills.filter(
					(skill) =>
						skill.name.toLocaleLowerCase(activeLocale()).includes(term) ||
							skill.key.includes(term) ||
							skill.description.toLocaleLowerCase(activeLocale()).includes(
								term,
							),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgents();
			client.store.act((transaction) => {
				transaction.set(client.state.skills, result.skills);
				transaction.set(client.state.tools, result.tools);
			}, 'agent-skills/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.skills.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const open = (skillId: string) => {
		setSelectedSkillId(skillId);
		if (props.canManage) setEditorOpen(true);
	};

	const save = async (input: CreateAgentSkillInput | UpdateAgentSkillInput) => {
		setStatus('submitting');
		setError('');
		try {
			const saved =
				selected && 'expectedRevision' in input
					? await updateAgentSkill(selected.id, input, props.csrfToken)
					: await createAgentSkill(input, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(
					client.state.skills,
					[...skills.filter((skill) => skill.id !== saved.id), saved].sort(
						(left, right) => left.name.localeCompare(right.name),
					),
				);
				transaction.set(client.state.selectedSkillId, saved.id);
				transaction.set(client.state.editorOpen, false);
			}, 'agent-skills/saved');
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('agents.skills.error.save'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const lifecycleTarget =
		skills.find((skill) => skill.id === selectedSkillId) ?? null;
	const manageLifecycle = async () => {
		if (!lifecycleTarget || lifecycleAction === '') return;
		setStatus('submitting');
		setError('');
		try {
			if (lifecycleAction === 'archive') {
				const archived = await archiveAgentSkill(
					lifecycleTarget.id,
					lifecycleTarget.revision,
					props.csrfToken,
				);
				client.store.act((transaction) => {
					transaction.set(
						client.state.skills,
						skills.map((skill) => skill.id === archived.id ? archived : skill),
					);
				}, 'agent-skills/archived');
			} else {
				await deleteAgentSkill(
					lifecycleTarget.id,
					lifecycleTarget.revision,
					props.csrfToken,
				);
				client.store.act((transaction) => {
					transaction.set(
						client.state.skills,
						skills.filter((skill) => skill.id !== lifecycleTarget.id),
					);
					transaction.set(client.state.selectedSkillId, '');
				}, 'agent-skills/deleted');
			}
			setLifecycleAction('');
		} catch (lifecycleError) {
			setError(
				lifecycleError instanceof Error
					? lifecycleError.message
					: t('agents.skills.error.lifecycle'),
			);
			setLifecycleAction('');
		} finally {
			setStatus('idle');
		}
	};

	const beginLifecycle = (id: string, action: 'archive' | 'delete') => {
		setSelectedSkillId(id);
		setLifecycleAction(action);
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.common.core')}
			title={t('agents.skills.title')}
			description={t('agents.skills.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('agents.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					{t('agents.skills.new')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<AgentSkillList
			skills={visible}
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
			title={selected ? selected.name : t('agents.skills.new')}
			subtitle={selected
				? t('agents.skills.drawer.revision', {
						revision: selected.revision,
						key: selected.key,
					})
				: t('agents.skills.drawer.subtitle')}
			width="lg"
			onClose={() => setEditorOpen(false)}
		>
			<AgentSkillForm
				key={selected?.id ?? 'new-skill'}
				skill={selected}
				tools={tools}
				busy={status === 'submitting'}
				onCancel={() => setEditorOpen(false)}
				onSubmit={save}
			/>
		</Drawer>
		<ConfirmDialog
			open={lifecycleAction !== '' && lifecycleTarget !== null}
			title={t('agents.skills.lifecycle.' + lifecycleAction + '.title')}
			confirmLabel={t(
				'agents.skills.lifecycle.' + lifecycleAction + '.confirm',
			)}
			cancelLabel={t('agents.common.cancel')}
			tone={lifecycleAction === 'delete' ? 'danger' : 'primary'}
			busy={status === 'submitting'}
			onCancel={() => setLifecycleAction('')}
			onConfirm={() => void manageLifecycle()}
		>{t('agents.skills.lifecycle.' + lifecycleAction + '.description', {
			name: lifecycleTarget?.name ?? '',
		})}</ConfirmDialog>
	</div>
}
