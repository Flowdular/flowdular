import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type { AccessChangeCategory } from '../domain/types.ts';
import type { ScreenStatus } from './state.ts';

/**
 * What a screen puts under its header. A failed load answers `error` and
 * nothing else: the table's own empty copy would otherwise sit under the alert
 * and tell the reader this workspace holds nothing, which is not what
 * happened.
 */
export function screenSurface(
	status: ScreenStatus,
): 'denied' | 'error' | 'records' {
	if (status === 'denied') return 'denied';
	return status === 'error' ? 'error' : 'records';
}

export function numberLabel(value: number): string {
	return new Intl.NumberFormat(activeLocale()).format(value);
}

/** Epoch milliseconds as the reader's local date and time. */
export function timestampLabel(value: number | null): string {
	if (value === null) return t('access.common.never');
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

/** An ISO instant as the reader's local date, for a period boundary. */
export function dateLabel(value: string): string {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return value;
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
	}).format(parsed);
}

export function categoryLabel(category: AccessChangeCategory): string {
	return t('access.category.' + category);
}

/** The workspace's own status decides the tone; the account block outranks it. */
export function memberTone(
	accountStatus: string,
	membershipStatus: string,
): TagTone {
	return accountStatus === 'active' && membershipStatus === 'active'
		? 'success'
		: 'warning';
}

export function statusLabel(status: string): string {
	const key = 'access.status.' + status;
	const translated = t(key);
	return translated === key ? status : translated;
}

/** Today in UTC as a calendar date, the form both report ranges take. */
export function todayIso(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** The same date shifted by whole days, for the default range of a report. */
export function isoDaysBefore(days: number, now = Date.now()): string {
	return todayIso(now - days * 86_400_000);
}
