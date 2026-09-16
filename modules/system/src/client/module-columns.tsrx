import {
	CellNumber,
	CellStack,
	CellTag,
	CellText,
	type TableColumn,
} from '@flowdular/ui';
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

/* The module and whether it runs stay on screen at any width. Version and
   dependents hide next, the platform surfaces and the permission count first;
   an expanded row lists whatever the width hides. */
export function moduleColumns(): readonly TableColumn<ModuleCatalogEntry>[] {
	return [
		{
			key: 'module',
			header: t('system.table.module'),
			width: 'auto',
			cell: (module) =>
				<CellStack primary={module.name} secondary={module.id} secondaryMono />,
		},
		{
			key: 'version',
			header: t('system.table.version'),
			width: '120px',
			priority: 2,
			cell: (module) =>
				<CellStack
					primary={module.version || t('system.value.na')}
					primaryMono
					secondary={module.specVersion && module.specVersion !== module.version
						? t('system.table.specVersion', { version: module.specVersion })
						: undefined}
				/>,
		},
		{
			key: 'platform',
			header: t('system.table.platform'),
			width: '200px',
			priority: 3,
			cell: (module) =>
				<CellStack
					primary={surfaces(module)}
					secondary={module.capabilities.join(', ')}
				/>,
		},
		{
			key: 'permissions',
			header: t('system.table.permissions'),
			width: '140px',
			numeric: true,
			priority: 3,
			cell: (module) => <CellNumber value={module.permissions.length} />,
		},
		{
			key: 'dependents',
			header: t('system.table.dependents'),
			width: '170px',
			priority: 2,
			cell: (module) =>
				<CellStack
					primary={<CellNumber value={module.dependents.length} />}
					secondary={module.dependents.length > 0
						? <CellText
								value={dependentsSummary(module.dependents, t, activeLocale())}
								title={module.dependents.join(', ')}
								mono
							/>
						: undefined}
				/>,
		},
		{
			key: 'status',
			header: t('system.table.status'),
			width: '130px',
			cell: (module) =>
				<CellTag
					tone={activationTone(module)}
					dot
					label={activationLabel(module)}
				/>,
		},
	];
}
