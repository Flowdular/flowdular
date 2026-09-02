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
	CreateAgentProviderInput,
	UpdateAgentProviderInput,
} from '../domain/types.ts';
import {
	createAgentProvider,
	deleteAgentProvider,
	loadAgentProviders,
	testAgentProvider,
	updateAgentProvider,
} from './api.ts';
import { createAgentProviderClientState } from './state.ts';
import { ProviderConnectionForm } from './ProviderConnectionForm.tsrx';
import { ProviderConnectionList } from './ProviderConnectionList.tsrx';

export interface AgentProvidersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
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
	const [deleteOpen, setDeleteOpen] = useValue(client.state.deleteOpen);
	const [testingModel, setTestingModel] = useValue(client.state.testingModel);
	const [readinessTtlMs] = useValue(client.state.readinessTtlMs);
	const selected =
		providers.find((provider) => provider.id === selectedProviderId) ?? null;
	const enabled = providers.filter((provider) => provider.enabled);
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible =
		term === ''
			? providers
			: providers.filter(
					(provider) =>
						provider.name.toLocaleLowerCase(activeLocale()).includes(term) ||
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
					: t('agents.providers.error.load'),
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
					: t('agents.providers.error.save'),
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
					: t('agents.providers.error.test'),
			);
		} finally {
			setTestingModel('');
		}
	};

	const open = (id: string) => {
		setSelectedProviderId(id);
		if (props.canManage) setEditorOpen(true);
	};

	const remove = async () => {
		if (!selected || selected.kind === 'local-simulation') return;
		setStatus('submitting');
		setError('');
		try {
			await deleteAgentProvider(
				selected.id,
				selected.revision,
				props.csrfToken,
			);
			setDeleteOpen(false);
			setEditorOpen(false);
			setSelectedProviderId('');
			await refresh();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('agents.providers.error.delete'),
			);
			setDeleteOpen(false);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.providers.eyebrow')}
			title={t('agents.providers.title')}
			description={t('agents.providers.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('agents.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					{t('agents.providers.add')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<ProviderConnectionList
			providers={visible}
			readinessTtlMs={readinessTtlMs}
			filtered={term !== ''}
			loading={status === 'loading' && providers.length === 0}
			selectedId={selectedProviderId}
			query={query}
			enabledCount={enabled.length}
			canManage={props.canManage}
			onQuery={setQuery}
			onSelect={open}
			onDelete={(id) => {
				setSelectedProviderId(id);
				setDeleteOpen(true);
			}}
		/>
		<Drawer
			open={editorOpen}
			title={selected ? selected.name : t('agents.providers.add')}
			subtitle={selected
				? t('agents.providers.credentialRevision', {
						revision: selected.credentialRevision,
					})
				: t('agents.providers.drawer.subtitle')}
			width="lg"
			onClose={() => setEditorOpen(false)}
		>
			@if (selected?.kind === 'local-simulation') {
				<div class="ui-drawer__body">
					<div class="provider-local-note">
						<p>{t('agents.providers.localDescription')}</p>
						<Button onClick={() => open('')}>{t(
							'agents.providers.addConnection',
						)}</Button>
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
					onDelete={selected ? () => setDeleteOpen(true) : undefined}
					onSubmit={save}
					onTest={test}
				/>
			}
		</Drawer>
		<ConfirmDialog
			open={deleteOpen && selected !== null}
			title={t('agents.providers.delete.title')}
			confirmLabel={t('agents.providers.delete.confirm')}
			cancelLabel={t('agents.common.cancel')}
			busy={status === 'submitting'}
			onCancel={() => setDeleteOpen(false)}
			onConfirm={() => void remove()}
		>{t('agents.providers.delete.description', {
			name: selected?.name ?? '',
		})}</ConfirmDialog>
	</div>
}
