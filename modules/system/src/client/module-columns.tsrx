import { Tag, type TableColumn } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import type { ModuleCatalogEntry } from './api.ts';
import { dependentsSummary } from './module-dependents.ts';

export function activationTone(
	module: ModuleCatalogEntry,
): 'success' | 'warning' | 'ink' | 'neutral' {
	if (!module.enabled) return 'neutral';
	if (!module.optional) return 'ink';
	return module.active ? 'success' : 'warning';
}

export function activationLabel(module: ModuleCatalogEntry): string {
	if (!module.enabled) return t('system.status.available');
	if (!module.optional) return t('system.status.required');
	return module.active
		? t('system.status.active')
		: t('system.status.inactive');
}

export function surfaces(module: ModuleCatalogEntry): string {
	const parts = [
		module.platform.server && 'server',
		module.platform.client && 'client',
	].filter(Boolean);
	return parts.length > 0 ? parts.join(' + ') : t('system.value.none');
}

export function moduleColumns(): readonly TableColumn<ModuleCatalogEntry>[] {
	return [
		{
			key: 'module',
			header: t('system.table.module'),
			width: '22%',
			cell: (module) => <span class="ui-cell">
				<b>{module.name}</b>
				<small class="ui-mono">{module.id}</small>
			</span>,
		},
		{
			key: 'version',
			header: t('system.table.version'),
			width: '11%',
			cell: (module) => <span class="ui-cell">
				<span class="ui-mono">{module.version || t('system.value.na')}</span>
				{module.specVersion
					? <small>{t('system.table.specVersion', {
							version: module.specVersion,
						})}</small>
					: null}
			</span>,
		},
		{
			key: 'platform',
			header: t('system.table.platform'),
			width: '19%',
			cell: (module) => <span class="ui-cell ui-cell--nowrap">
				<span>{surfaces(module)}</span>
				<small title={module.capabilities.join(', ')}>{module.capabilities.join(
					', ',
				)}</small>
			</span>,
		},
		{
			key: 'permissions',
			header: t('system.table.permissions'),
			width: '9%',
			numeric: true,
			cell: (module) => new Intl.NumberFormat(activeLocale()).format(
				module.permissions.length,
			),
		},
		{
			key: 'dependents',
			header: t('system.table.dependents'),
			width: '13%',
			cell: (module) => <span class="ui-cell ui-cell--nowrap">
				<span>{new Intl.NumberFormat(activeLocale()).format(
					module.dependents.length,
				)}</span>
				{module.dependents.length > 0
					? <small
							class="ui-mono"
							title={module.dependents.join(', ')}
						>{dependentsSummary(module.dependents, t, activeLocale())}</small>
					: null}
			</span>,
		},
		{
			key: 'status',
			header: t('system.table.status'),
			width: '10%',
			cell: (module) =>
				<Tag tone={activationTone(module)} dot>{activationLabel(module)}</Tag>,
		},
	];
}
