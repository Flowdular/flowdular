import { t } from '@flowdular/client';
import {
	CellCode,
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	type TableColumn,
} from '@flowdular/ui';
import type { AuditRow } from './api.ts';
import { auditDetails, auditTone } from './audit-row.ts';

/* Who did what and when stays on screen at any width; the subject hides next
   and the metadata first, both still listed in the expanded row. */
export function auditColumns(): readonly TableColumn<AuditRow>[] {
	return [
		{
			key: 'time',
			header: t('auth.audit.column.time'),
			width: '170px',
			cell: (row) => <CellTime value={row.occurredAt} />,
		},
		{
			key: 'actor',
			header: t('auth.audit.column.actor'),
			width: 'auto',
			cell: (row) => <CellText value={row.actor} />,
		},
		{
			key: 'action',
			header: t('auth.audit.column.action'),
			width: '220px',
			cell: (row) =>
				<CellTag tone={auditTone(row.action)} mono label={row.action} />,
		},
		{
			key: 'subject',
			header: t('auth.audit.column.subject'),
			width: '200px',
			priority: 2,
			cell: (row) =>
				<CellStack
					primary={row.subjectType}
					secondary={<CellCode value={row.subjectId} />}
				/>,
		},
		{
			key: 'details',
			header: t('auth.audit.column.details'),
			width: 'auto',
			priority: 3,
			cell: (row) => {
				const text = auditDetails(row);
				return text
					? <CellText value={text} wrap />
					: <CellMuted>{t('auth.common.none')}</CellMuted>;
			},
		},
	];
}
