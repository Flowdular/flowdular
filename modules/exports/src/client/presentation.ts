import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type { ExportJobStatus } from '../domain/types.ts';

/** Epoch milliseconds as the reader's local date and time. */
export function timestampLabel(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

export function countLabel(value: number): string {
	return new Intl.NumberFormat(activeLocale()).format(value);
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB'] as const;

/** Decimal units, the way a file manager shows a download. */
export function byteLabel(value: number): string {
	let size = value;
	let unit = 0;
	while (size >= 1000 && unit < BYTE_UNITS.length - 1) {
		size /= 1000;
		unit += 1;
	}
	const formatted = new Intl.NumberFormat(activeLocale(), {
		maximumFractionDigits: unit === 0 ? 0 : 1,
	}).format(size);
	return `${formatted} ${BYTE_UNITS[unit]}`;
}

export function statusLabel(status: ExportJobStatus): string {
	return t('exports.status.' + status);
}

export function statusTone(status: ExportJobStatus): TagTone {
	if (status === 'completed') return 'success';
	if (status === 'failed') return 'danger';
	return status === 'running' ? 'warning' : 'info';
}

/**
 * A job's failure code is a stable code this module or a registered list
 * produced. A code with a sentence of its own reads that; anything else is
 * shown as it was recorded rather than hidden behind a generic line.
 */
export function failureLabel(code: string | null): string {
	if (!code) return '';
	const key = 'exports.error.code.' + code;
	const translated = t(key);
	return translated === key ? code : translated;
}
