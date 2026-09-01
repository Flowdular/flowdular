import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	Icon,
	PageHeader,
	SearchField,
} from '@coreloom/ui';
import { useValue } from 'segment-state';
import type {
	CreateAgentSkillInput,
	UpdateAgentSkillInput,
} from '../domain/types.ts';
import { createAgentSkill, loadAgents, updateAgentSkill } from './api.ts';
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
	const selected = skills.find((skill) => skill.id === selectedSkillId) ?? null;
	const active = skills.filter((skill) => skill.status === 'active');
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? skills
			: skills.filter(
					(skill) =>
						skill.name.toLocaleLowerCase('en-US').includes(term) ||
							skill.key.includes(term) ||
							skill.description.toLocaleLowerCase('en-US').includes(term),
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
					: 'Could not load skills.',
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
		setEditorOpen(true);
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
					: 'Could not save the skill.',
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Agentic core"
			title="Skills"
			description="Reusable procedures an agent can attach: instructions plus the tools the procedure needs."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					New skill
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Tenant skills
					<small>
						{active.length + ' active · ' + skills.length + ' defined'}
					</small>
				</span>
				<SearchField
					value={query}
					placeholder="Filter by name, key, or purpose"
					label="Filter skills"
					onInput={setQuery}
				/>
			</div>
			<AgentSkillList
				skills={visible}
				filtered={term !== ''}
				canManage={props.canManage}
				onSelect={open}
			/>
			<p class="ui-note">
				<Icon name="shield" size={14} />
				<span>
					A skill may only require tools this deployment registers. An agent has
					to hold every required tool before it can attach the skill.
				</span>
			</p>
		</section>
		<Drawer
			open={editorOpen}
			title={selected ? selected.name : 'New skill'}
			subtitle={selected
				? 'Revision ' + selected.revision + ' · ' + selected.key
				: 'Reusable procedure'}
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
	</div>
}
