import { activeLocale, t } from '@flowdular/client';
import type {
	AuditDataClass,
	AuditLegalHold,
	ExportStatus,
	HoldScopeKind,
	HoldStatus,
	SweepStatus,
} from '../domain/types.ts';

import type { TagTone } from '@flowdular/ui';

export function timestampLabel(value: number | null): string {
	if (value === null) return t('audit.common.never');
	return new Date(value).toLocaleString(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}

export function sweepStatusLabel(status: SweepStatus): string {
	return t(`audit.sweeps.status.${status}`);
}

export function sweepStatusTone(status: SweepStatus): TagTone {
	if (status === 'completed') return 'success';
	return status === 'partial' ? 'warning' : 'danger';
}

export function exportStatusLabel(status: ExportStatus): string {
	return t(`audit.exports.status.${status}`);
}

export function exportStatusTone(status: ExportStatus): TagTone {
	if (status === 'completed') return 'success';
	return status === 'started' ? 'info' : 'danger';
}

/** A ledger reason is a stable code; an unknown one is shown as it came. */
export function reasonLabel(reason: string | null): string {
	if (!reason) return '';
	const key = `audit.reason.${reason}`;
	const translated = t(key);
	return translated === key ? reason : translated;
}

export function retentionLabel(record: AuditDataClass): string {
	if (record.retentionMode === 'none') return t('audit.retention.kept');
	if (record.retentionMode === 'days') {
		return t('audit.retention.days', { days: record.retentionDays ?? 0 });
	}
	return record.defaultRetentionDays === null
		? t('audit.retention.defaultKept')
		: t('audit.retention.defaultDays', { days: record.defaultRetentionDays });
}

export function defaultRetentionLabel(record: AuditDataClass): string {
	return record.defaultRetentionDays === null
		? t('audit.retention.kept')
		: t('audit.retention.days', { days: record.defaultRetentionDays });
}

export function booleanLabel(value: boolean): string {
	return value ? t('audit.common.yes') : t('audit.common.no');
}

export function digestLabel(digest: string | null): string {
	return digest === null ? t('audit.common.none') : digest.slice(0, 16);
}

export function holdStatusLabel(status: HoldStatus): string {
	return t(`audit.holds.status.${status}`);
}

export function holdStatusTone(status: HoldStatus): TagTone {
	return status === 'active' ? 'warning' : 'neutral';
}

export function holdScopeLabel(scope: HoldScopeKind): string {
	return t(`audit.holds.scope.${scope}`);
}

/**
 * The date range a hold narrows to, or an empty string. The account and the
 * class have columns of their own on the Holds screen, so the scope cell shows
 * only what no other column carries.
 */
export function holdRangeDetail(hold: AuditLegalHold): string {
	if (hold.fromAt === null && hold.toAt === null) return '';
	return `${timestampLabel(hold.fromAt)} - ${timestampLabel(hold.toAt)}`;
}

/** What the hold narrows to, in one line, or a dash when it narrows nothing. */
export function holdScopeDetail(hold: AuditLegalHold): string {
	const parts = [
		hold.accountId,
		hold.classId,
		hold.fromAt === null && hold.toAt === null
			? null
			: `${timestampLabel(hold.fromAt)} - ${timestampLabel(hold.toAt)}`,
	].filter((part): part is string => typeof part === 'string');
	return parts.length === 0
		? t('audit.holds.scope.wholeWorkspace')
		: parts.join(' · ');
}
