import { t } from '@flowdular/client';
import {
	CellStack,
	CellTag,
	CellTime,
	SearchField,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import type { AgentProviderConnection } from '../domain/types.ts';
import { modelReadinessState } from './presentation.ts';

export interface ProviderConnectionListProps {
	readonly providers: readonly AgentProviderConnection[];
	readonly readinessTtlMs: number;
	readonly filtered: boolean;
	readonly loading: boolean;
	readonly selectedId: string;
	readonly query: string;
	readonly enabledCount: number;
	readonly canManage: boolean;
	readonly onQuery: (value: string) => void;
	readonly onSelect: (id: string) => void;
	readonly onDelete: (id: string) => void;
}

function readyModels(provider: AgentProviderConnection, ttlMs: number): number {
	return provider.models.filter(
		(model) =>
			model.enabled && modelReadinessState(model.readiness, ttlMs) === 'ready',
	).length;
}

function statusKey(provider: AgentProviderConnection, ttlMs: number): string {
	if (!provider.enabled) return 'disabled';
	if (readyModels(provider, ttlMs) > 0) return 'ready';
	return provider.models.some(
		(model) => modelReadinessState(model.readiness, ttlMs) === 'stale',
	)
		? 'stale'
		: 'untested';
}

function statusTone(
	provider: AgentProviderConnection,
	ttlMs: number,
): 'success' | 'warning' | 'neutral' {
	if (!provider.enabled) return 'neutral';
	if (readyModels(provider, ttlMs) > 0) return 'success';
	return provider.models.some(
		(model) => ['stale', 'failing'].includes(
			modelReadinessState(model.readiness, ttlMs),
		),
	)
		? 'warning'
		: 'neutral';
}

function providerKind(provider: AgentProviderConnection): string {
	return t('agents.providers.kind.' + provider.kind);
}

function connectionDetail(provider: AgentProviderConnection): string {
	return provider.resourceName ?? provider.baseURL ?? provider.key;
}

function ProviderIdentity(props: {
	readonly provider: AgentProviderConnection;
}) @{
	<CellStack
		primary={props.provider.name}
		secondary={props.provider.key}
		secondaryMono
	/>
}

function ProviderType(props: { readonly provider: AgentProviderConnection }) @{
	<CellStack
		primary={providerKind(props.provider)}
		secondary={connectionDetail(props.provider)}
	/>
}

function ProviderModels(props: {
	readonly provider: AgentProviderConnection;
}) @{
	const enabled = props.provider.models.filter((model) => model.enabled);
	<CellStack
		primary={t('agents.providers.models.count', {
			enabled: enabled.length,
			total: props.provider.models.length,
		})}
		secondary={enabled.length > 0
			? enabled.map((model) => model.label).join(', ')
			: t('agents.providers.models.none')}
	/>
}

function ProviderReadiness(props: {
	readonly provider: AgentProviderConnection;
	readonly ttlMs: number;
}) @{
	const enabled = props.provider.models.filter((model) => model.enabled).length;
	const state = statusKey(props.provider, props.ttlMs);
	<CellStack
		primary={<CellTag
			tone={statusTone(props.provider, props.ttlMs)}
			dot
			label={t('agents.providers.status.' + state)}
		/>}
		secondary={enabled === 0
			? t('agents.providers.models.unavailable')
			: t('agents.providers.models.proven', {
					ready: readyModels(props.provider, props.ttlMs),
					total: enabled,
				})}
	/>
}

function ProviderUpdated(props: {
	readonly provider: AgentProviderConnection;
}) @{
	<CellStack
		primary={props.provider.kind === 'local-simulation'
			? t('agents.providers.builtIn')
			: <CellTime value={props.provider.updatedAt} kind="date" />}
		secondary={t('agents.providers.credentialRevision', {
			revision: props.provider.credentialRevision,
		})}
	/>
}

function providerColumns(
	readinessTtlMs: number,
): readonly TableColumn<AgentProviderConnection>[] {
	return [
		{
			key: 'connection',
			header: t('agents.providers.column.connection'),
			width: 'auto',
			cell: (provider) => <ProviderIdentity provider={provider} />,
		},
		{
			key: 'type',
			header: t('agents.providers.column.type'),
			width: '180px',
			priority: 3,
			cell: (provider) => <ProviderType provider={provider} />,
		},
		{
			key: 'models',
			header: t('agents.providers.column.models'),
			width: '200px',
			priority: 2,
			cell: (provider) => <ProviderModels provider={provider} />,
		},
		{
			key: 'readiness',
			header: t('agents.providers.column.readiness'),
			width: '200px',
			cell: (provider) =>
				<ProviderReadiness provider={provider} ttlMs={readinessTtlMs} />,
		},
		{
			key: 'updated',
			header: t('agents.providers.column.updated'),
			width: '160px',
			priority: 2,
			cell: (provider) => <ProviderUpdated provider={provider} />,
		},
	];
}

export function ProviderConnectionList(props: ProviderConnectionListProps) @{
	<TableCard
		title={t('agents.providers.table.title')}
		count={t('agents.providers.table.count', {
			enabled: props.enabledCount,
			total: props.providers.length,
		})}
		search={<SearchField
			value={props.query}
			placeholder={t('agents.providers.search.placeholder')}
			label={t('agents.providers.search.label')}
			onInput={props.onQuery}
		/>}
		columns={providerColumns(props.readinessTtlMs)}
		rows={props.providers}
		rowKey={(provider) => provider.id}
		status={props.loading ? 'loading' : 'idle'}
		loadingLabel={t('agents.providers.loading')}
		filtered={props.filtered}
		empty={{
			icon: 'plug',
			title: t('agents.providers.empty.title'),
			hint: t('agents.providers.empty.hint'),
		}}
		emptyFiltered={{
			icon: 'search',
			title: t('agents.providers.empty.filteredTitle'),
			hint: t('agents.providers.empty.filteredHint'),
		}}
		actionsLabel={t('agents.common.actions')}
		actionsWidth="280px"
		actions={props.canManage
			? (provider) => [
					{
						id: 'open',
						label: provider.kind === 'local-simulation'
							? t('agents.common.view')
							: t('agents.common.edit'),
						onSelect: () => props.onSelect(provider.id),
					},
					...(provider.kind === 'local-simulation'
						? []
						: [
								{
									id: 'delete',
									label: t('agents.common.delete'),
									tone: 'danger' as const,
									onSelect: () => props.onDelete(provider.id),
								},
							]),
				]
			: undefined}
		onSelect={props.canManage
			? (provider) => props.onSelect(provider.id)
			: undefined}
		selectedKey={props.canManage ? props.selectedId : undefined}
		caption={t('agents.providers.table.caption')}
		note={t('agents.providers.note')}
		noteIcon="shield"
	/>
}
