import { t } from '@coreloom/client';
import { Tag, type TableColumn } from '@coreloom/ui';
import type { AuditRow } from './api.ts';
import { auditDetails, auditStamp, auditTone } from './audit-row.ts';

export function auditColumns(): readonly TableColumn<AuditRow>[] {
	return [
		{
			key: 'time',
			header: t('auth.audit.column.time'),
			width: '18%',
			cell: (row) => <span class="ui-mono">{auditStamp(row.occurredAt)}</span>,
		},
		{
			key: 'actor',
			header: t('auth.audit.column.actor'),
			width: '16%',
			cell: (row) => row.actor,
		},
		{
			key: 'action',
			header: t('auth.audit.column.action'),
			width: '18%',
			cell: (row) => <Tag tone={auditTone(row.action)} mono>{row.action}</Tag>,
		},
		{
			key: 'subject',
			header: t('auth.audit.column.subject'),
			width: '22%',
			cell: (row) => <span class="ui-cell">
				<span>{row.subjectType}</span>
				<small class="ui-mono">{row.subjectId}</small>
			</span>,
		},
		{
			key: 'details',
			header: t('auth.audit.column.details'),
			width: '26%',
			cell: (row) => {
				const text = auditDetails(row);
				return text
					? <small>{text}</small>
					: <span class="ui-cell__muted">{t('auth.common.none')}</span>;
			},
		},
	];
}
