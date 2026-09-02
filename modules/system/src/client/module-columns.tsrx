import { Tag, type TableColumn } from '@coreloom/ui';
import { activeLocale, t } from '@coreloom/client';
import type { ModuleCatalogEntry } from './api.ts';

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
			width: '23%',
			cell: (module) => <span class="ui-cell">
				<b>{module.name}</b>
				<small class="ui-mono">{module.id}</small>
			</span>,
		},
		{
			key: 'version',
			header: t('system.table.version'),
			width: '13%',
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
			width: '30%',
			cell: (module) => <span class="ui-cell">
				<span>{surfaces(module)}</span>
				<small>{module.capabilities.join(', ')}</small>
			</span>,
		},
		{
			key: 'permissions',
			header: t('system.table.permissions'),
			width: '10%',
			numeric: true,
			cell: (module) => new Intl.NumberFormat(activeLocale()).format(
				module.permissions.length,
			),
		},
		{
			key: 'status',
			header: t('system.table.status'),
			width: '14%',
			cell: (module) => <Tag tone={module.enabled ? 'success' : 'neutral'} dot>
				{module.enabled
					? t('system.status.enabled')
					: t('system.status.available')}
			</Tag>,
		},
	];
}
