import { CellStack, CellTag, CellText, type TableColumn } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { ApiOperation } from './api-docs.ts';

export function methodTone(
	method: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
	if (method === 'GET' || method === 'HEAD') return 'success';
	if (method === 'DELETE') return 'danger';
	return 'warning';
}

/* The operation and its address stay on screen at any width; the module and
   the permission hide first, and an expanded row shows what the width hid. */
export function apiOperationColumns(): readonly TableColumn<ApiOperation>[] {
	return [
		{
			key: 'operation',
			header: t('system.api.table.operation'),
			width: 'auto',
			cell: (operation) =>
				<CellStack
					primary={operation.summary}
					secondary={operation.method + ' ' + operation.path}
					secondaryMono
				/>,
		},
		{
			key: 'method',
			header: t('system.api.table.method'),
			width: '110px',
			cell: (operation) =>
				<CellTag
					tone={methodTone(operation.method)}
					label={operation.method}
				/>,
		},
		{
			key: 'module',
			header: t('system.api.table.module'),
			width: '170px',
			priority: 2,
			cell: (operation) => <CellText value={operation.moduleId} mono />,
		},
		{
			key: 'access',
			header: t('system.api.table.access'),
			width: '220px',
			priority: 2,
			cell: (operation) =>
				<CellStack
					primary={operation.permission ?? t('system.api.access.public')}
					primaryMono={operation.permission !== null}
					secondary={operation.needsWriteToken
						? t('system.api.access.writeToken')
						: t('system.api.access.readToken')}
				/>,
		},
	];
}
