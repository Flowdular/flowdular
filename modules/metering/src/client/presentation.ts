import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type { MeterKind, MeterUsage } from '../domain/types.ts';
import type { ScreenStatus } from './state.ts';

/**
 * What a screen puts under its header. A failed load answers `error` and
 * nothing else: the table's own empty copy would otherwise sit under the alert
 * and tell the reader this workspace has no meters, which is not what happened.
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
	if (value === null) return t('metering.common.notYet');
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

export function kindLabel(kind: MeterKind): string {
	return t('metering.kind.' + kind);
}

/** Whole percent of the limit a month's usage has reached, or null. */
export function usageShare(entry: MeterUsage): number | null {
	if (entry.limit === null) return null;
	/* A limit of zero allows nothing, so it is reached whatever the usage is.
	   Reading it as "no share" would paint a meter the workspace cannot use at
	   all in the same neutral tone as an unlimited one. */
	if (entry.limit === 0) return 100;
	return Math.floor((entry.used / entry.limit) * 100);
}

export function usageLabel(entry: MeterUsage): string {
	if (entry.limit === null) {
		return t('metering.usage.unlimited', { used: numberLabel(entry.used) });
	}
	return t('metering.usage.ofLimit', {
		used: numberLabel(entry.used),
		limit: numberLabel(entry.limit),
	});
}

/* The warning share comes from the server with the meters, so the colour on
   the screen and the notification in the inbox never disagree about what a
   workspace has reached. */
export function usageTone(entry: MeterUsage, warningPercent: number): TagTone {
	const share = usageShare(entry);
	if (share === null) return 'neutral';
	if (share >= 100) return 'danger';
	return share >= warningPercent ? 'warning' : 'success';
}
