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
import type { CreateAgentInput, UpdateAgentInput } from '../domain/types.ts';
import { createAgent, loadAgents, updateAgent } from './api.ts';
import { AgentDefinitionForm } from './AgentDefinitionForm.tsrx';
import { AgentDefinitionList } from './AgentDefinitionList.tsrx';
import { createAgentClientState } from './state.ts';

export interface AgentsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

export function AgentsView(props: AgentsViewProps) @{
	const client = useMemo(() => createAgentClientState(), []);
	const [agents] = useValue(client.state.agents);
	const [providers] = useValue(client.state.providers);
	const [tools] = useValue(client.state.tools);
	const [skills] = useValue(client.state.skills);
	const [selectedAgentId, setSelectedAgentId] = useValue(
		client.state.selectedAgentId,
	);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const selected = agents.find((agent) => agent.id === selectedAgentId) ?? null;
	const active = agents.filter((agent) => agent.status === 'active');
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? agents
			: agents.filter(
					(agent) =>
						agent.name.toLocaleLowerCase('en-US').includes(term) ||
							agent.key.includes(term) ||
							agent.description.toLocaleLowerCase('en-US').includes(term),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgents();
			client.store.act((transaction) => {
				transaction.set(client.state.agents, result.agents);
				transaction.set(client.state.providers, result.providers);
				transaction.set(client.state.tools, result.tools);
				transaction.set(client.state.skills, result.skills);
			}, 'agents/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load agents.',
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
					: 'Could not save the agent.',
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Agentic core"
			title="Agents"
			description="Reusable workers for service, logistics, workflows, and other tenant-owned operations."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					New agent
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Tenant agents
					<small>
						{active.length + ' active · ' + agents.length + ' defined'}
					</small>
				</span>
				<SearchField
					value={query}
					placeholder="Filter by name, key, or description"
					label="Filter agents"
					onInput={setQuery}
				/>
			</div>
			<AgentDefinitionList
				agents={visible}
				providers={providers}
				filtered={term !== ''}
				canManage={props.canManage}
				onSelect={open}
			/>
			<p class="ui-note">
				<Icon name="shield" size={14} />
				<span>
					An agent reaches ERP data only through the tools granted here. Direct
					database access is unavailable.
				</span>
			</p>
		</section>
		<Drawer
			open={editorOpen}
			title={selected ? selected.name : 'New agent'}
			subtitle={selected
				? 'Revision ' + selected.revision + ' · ' + selected.key
				: 'Bounded worker definition'}
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
	</div>
}
