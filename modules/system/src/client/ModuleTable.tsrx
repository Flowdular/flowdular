import { Button, Tag } from '@coreloom/ui';
import type { ModuleCatalogEntry } from './api.ts';

export interface ModuleTableProps {
	readonly modules: readonly ModuleCatalogEntry[];
	readonly onSelect: (moduleId: string) => void;
}

export function surfaces(module: ModuleCatalogEntry): string {
	const parts = [
		module.platform.server && 'server',
		module.platform.client && 'client',
	].filter(Boolean);
	return parts.length > 0 ? parts.join(' + ') : 'none';
}

export function ModuleTable(props: ModuleTableProps) @{
	<div class="ui-table-wrap">
		<table class="ui-table" aria-label="Modules">
			<thead>
				<tr>
					<th>Module</th>
					<th>Version</th>
					<th>Platform</th>
					<th class="num">Permissions</th>
					<th>Status</th>
					<th class="ui-table__actions"></th>
				</tr>
			</thead>
			<tbody>
				@for (const module of props.modules; key module.id) {
					<tr class="is-clickable" onClick={() => props.onSelect(module.id)}>
						<td>
							<span class="ui-cell">
								<b>{module.name}</b>
								<small class="ui-mono">{module.id}</small>
							</span>
						</td>
						<td>
							<span class="ui-cell">
								<span class="ui-mono">{module.version || 'n/a'}</span>
								@if (module.specVersion) {
									<small>{'spec ' + module.specVersion}</small>
								}
							</span>
						</td>
						<td>
							<span class="ui-cell">
								<span>{surfaces(module)}</span>
								<small>{module.capabilities.join(', ')}</small>
							</span>
						</td>
						<td class="num">{String(module.permissions.length)}</td>
						<td>
							<Tag tone={module.enabled ? 'success' : 'neutral'} dot>
								{module.enabled ? 'Enabled' : 'Available'}
							</Tag>
						</td>
						<td class="ui-table__actions">
							<Button size="sm" onClick={() => props.onSelect(module.id)}>
								Open
							</Button>
						</td>
					</tr>
				}
			</tbody>
		</table>
	</div>
}
