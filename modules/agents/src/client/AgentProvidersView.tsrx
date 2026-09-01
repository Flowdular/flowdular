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
	CreateAgentProviderInput,
	UpdateAgentProviderInput,
} from '../domain/types.ts';
import {
	createAgentProvider,
	loadAgentProviders,
	testAgentProvider,
	updateAgentProvider,
} from './api.ts';
import { createAgentProviderClientState } from './state.ts';
import { ProviderConnectionForm } from './ProviderConnectionForm.tsrx';
import { ProviderConnectionList } from './ProviderConnectionList.tsrx';

export interface AgentProvidersViewProps {
	readonly csrfToken: string;
}

export function AgentProvidersView(props: AgentProvidersViewProps) @{
	const client = useMemo(() => createAgentProviderClientState(), []);
	const [providers] = useValue(client.state.providers);
	const [selectedProviderId, setSelectedProviderId] = useValue(
		client.state.selectedProviderId,
	);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [testingModel, setTestingModel] = useValue(client.state.testingModel);
	const [readinessTtlMs] = useValue(client.state.readinessTtlMs);
	const selected =
		providers.find((provider) => provider.id === selectedProviderId) ?? null;
	const enabled = providers.filter((provider) => provider.enabled);
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? providers
			: providers.filter(
					(provider) =>
						provider.name.toLocaleLowerCase('en-US').includes(term) ||
							provider.key.includes(term) ||
							provider.kind.includes(term),
				);

	const replace = (provider: (typeof providers)[number]) => {
		client.store.act((transaction) => {
			transaction.set(
				client.state.providers,
				[
					...providers.filter((item) => item.id !== provider.id),
					provider,
				].sort((left, right) => left.name.localeCompare(right.name)),
			);
			transaction.set(client.state.selectedProviderId, provider.id);
		}, 'agent-providers/updated');
	};

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAgentProviders();
			client.store.act((transaction) => {
				transaction.set(client.state.providers, result.providers);
				transaction.set(client.state.readinessTtlMs, result.readinessTtlMs);
			}, 'agent-providers/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load provider connections.',
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const save = async (
		input: CreateAgentProviderInput | UpdateAgentProviderInput,
	) => {
		setStatus('submitting');
		setError('');
		try {
			const provider =
				'id' in input
					? await updateAgentProvider(input, props.csrfToken)
					: await createAgentProvider(input, props.csrfToken);
			replace(provider);
			setEditorOpen(false);
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: 'Could not save the provider connection.',
			);
		} finally {
			setStatus('idle');
		}
	};

	const test = async (id: string, model: string) => {
		setTestingModel(model);
		setError('');
		try {
			replace(await testAgentProvider(id, model, props.csrfToken));
		} catch (testError) {
			setError(
				testError instanceof Error
					? testError.message
					: 'Could not test the model.',
			);
		} finally {
			setTestingModel('');
		}
	};

	const open = (id: string) => {
		setSelectedProviderId(id);
		setEditorOpen(true);
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Agent infrastructure"
			title="Providers"
			description="Tenant-owned model connections. Credentials are encrypted server-side and readiness is proven per model."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			<Button size="sm" variant="primary" onClick={() => open('')}>
				<Icon name="plus" size={14} />
				Add provider
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Connections
					<small>
						{enabled.length + ' enabled · ' + providers.length + ' total'}
					</small>
				</span>
				<SearchField
					value={query}
					placeholder="Filter by name, key, or type"
					label="Filter provider connections"
					onInput={setQuery}
				/>
			</div>
			<ProviderConnectionList
				providers={visible}
				readinessTtlMs={readinessTtlMs}
				filtered={term !== ''}
				onSelect={open}
			/>
			<p class="ui-note">
				<Icon name="shield" size={14} />
				<span>
					Provider secrets never leave the server. They are absent from this
					page, run snapshots, logs, and harness events.
				</span>
			</p>
		</section>
		<Drawer
			open={editorOpen}
			title={selected ? selected.name : 'Add provider'}
			subtitle={selected
				? 'Credential revision ' + selected.credentialRevision
				: 'Encrypted tenant connection'}
			width="lg"
			onClose={() => setEditorOpen(false)}
		>
			@if (selected?.kind === 'local-simulation') {
				<div class="ui-drawer__body">
					<div class="provider-local-note">
						<p>
							This built-in provider stores no credential and never sends data
							outside the process. It is suitable for local validation, not
							production work.
						</p>
						<Button onClick={() => open('')}>Add provider connection</Button>
					</div>
				</div>
			} @else {
				<ProviderConnectionForm
					key={selected?.id ?? 'new-provider'}
					provider={selected}
					busy={status === 'submitting'}
					readinessTtlMs={readinessTtlMs}
					testingModel={testingModel}
					onCancel={() => setEditorOpen(false)}
					onSubmit={save}
					onTest={test}
				/>
			}
		</Drawer>
	</div>
}
