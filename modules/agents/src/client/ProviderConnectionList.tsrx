import { Button, EmptyState, Tag } from '@coreloom/ui';
import type { AgentProviderConnection } from '../domain/types.ts';
import { modelReadinessState } from './presentation.ts';

export interface ProviderConnectionListProps {
	readonly providers: readonly AgentProviderConnection[];
	readonly readinessTtlMs: number;
	readonly filtered: boolean;
	readonly onSelect: (id: string) => void;
}

/* One status per connection: what an agent gets if it picks this connection
   right now. Each model proves itself, and that proof expires. */
function readyModels(provider: AgentProviderConnection, ttlMs: number): number {
	return provider.models.filter(
		(model) =>
			model.enabled && modelReadinessState(model.readiness, ttlMs) === 'ready',
	).length;
}

function statusLabel(provider: AgentProviderConnection, ttlMs: number): string {
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

function statusNote(provider: AgentProviderConnection, ttlMs: number): string {
	const enabled = provider.models.filter((model) => model.enabled).length;
	if (enabled === 0) return 'No model available';
	return readyModels(provider, ttlMs) + ' of ' + enabled + ' models proven';
}

function identity(provider: AgentProviderConnection): string {
	return provider.key === provider.kind
		? provider.key
		: provider.key + ' · ' + provider.kind;
}

function modelCount(provider: AgentProviderConnection): string {
	const count = provider.models.length;
	return count + (count === 1 ? ' model' : ' models');
}

export function ProviderConnectionList(props: ProviderConnectionListProps) @{
	<div>
		@if (props.providers.length === 0) {
			<EmptyState
				icon="plug"
				title={props.filtered
					? 'No matching connections'
					: 'No provider connections'}
			>
				{props.filtered
					? 'No connection in this workspace matches the current filter.'
					: 'Add a tenant-owned connection before activating a production agent.'}
			</EmptyState>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="Provider connections">
					<thead>
						<tr>
							<th>Connection</th>
							<th class="num">Models</th>
							<th>Status</th>
							<th class="ui-table__actions"></th>
						</tr>
					</thead>
					<tbody>
						@for (const provider of props.providers; key provider.id) {
							<tr
								class="is-clickable"
								onClick={() => props.onSelect(provider.id)}
							>
								<td>
									<span class="ui-cell">
										<b>{provider.name}</b>
										<small class="ui-mono">{identity(provider)}</small>
									</span>
								</td>
								<td class="num">{modelCount(provider)}</td>
								<td>
									<span class="ui-table__state">
										<Tag
											tone={statusTone(provider, props.readinessTtlMs)}
											dot
										>{statusLabel(provider, props.readinessTtlMs)}</Tag>
										<small>{statusNote(provider, props.readinessTtlMs)}</small>
									</span>
								</td>
								<td class="ui-table__actions">
									<Button size="sm" onClick={() => props.onSelect(provider.id)}>
										{provider.kind === 'local-simulation' ? 'View' : 'Edit'}
									</Button>
								</td>
							</tr>
						}
					</tbody>
				</table>
			</div>
		}
	</div>
}
