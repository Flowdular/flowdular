import { t } from '@flowdular/client/i18n';
import type { AuditRow } from './api.ts';

export type AuditTone = 'danger' | 'warning' | 'neutral' | 'info';

export function auditTone(action: string): AuditTone {
	if (action.includes('failed') || action.includes('locked')) return 'danger';
	if (action.includes('removed') || action.includes('deleted'))
		return 'warning';
	if (action.includes('sign-in') || action.includes('sign-out')) return 'info';
	return 'neutral';
}

export function auditDetails(row: AuditRow): string {
	const entries = Object.entries(row.metadata);
	if (entries.length === 0) return '';
	return entries
		.map(
			([key, value]) =>
				`${key}: ${
					Array.isArray(value)
						? t('auth.audit.items', { count: value.length })
						: String(value)
				}`,
		)
		.join(' · ');
}
