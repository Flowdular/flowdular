import type { TableEmpty, TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type { DocumentAttachment } from '../domain/attachments.ts';
import type { DocumentScan } from '../domain/types.ts';
import type { ScreenStatus } from './state.ts';

const BYTE_UNITS = ['bytes', 'kb', 'mb', 'gb'] as const;

/** Epoch milliseconds as the reader's local date and time. */
export function timestampLabel(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

/**
 * A size a person reads, in the reader's locale. The unit stops at gigabytes
 * because the object limit is 25 MB and a workspace quota is counted in GB.
 */
export function byteLabel(value: number): string {
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return t('documents.unit.' + BYTE_UNITS[unit], {
		value: new Intl.NumberFormat(activeLocale(), {
			maximumFractionDigits: unit === 0 ? 0 : 1,
		}).format(size),
	});
}

export function scanLabel(scan: DocumentScan): string {
	return t('documents.scan.' + scan);
}

export function scanTone(scan: DocumentScan): TagTone {
	if (scan === 'clean') return 'success';
	return scan === 'infected' ? 'danger' : 'warning';
}

/**
 * Why this file cannot be uploaded, or empty when it can. The storage port
 * applies the same ceiling to the bytes it receives; checking it here spends a
 * comparison instead of the upload. A screen that could not read the limits
 * offers the upload and lets the server answer.
 */
export function uploadRefusal(
	bytes: number,
	maxObjectBytes: number | null,
): string {
	if (maxObjectBytes === null || bytes <= maxObjectBytes) return '';
	return t('documents.upload.form.tooLarge', {
		limit: byteLabel(maxObjectBytes),
	});
}

/**
 * Why a row cannot be downloaded, or empty when it can. An infected object was
 * deleted at once and a deleted one is gone, so the action carries the reason
 * in its own label: a disabled row action has nowhere else to put it.
 */
export function downloadRefusal(record: DocumentAttachment): string {
	if (record.scan === 'infected') return t('documents.action.downloadInfected');
	if (record.status === 'deleted') return t('documents.action.downloadDeleted');
	return '';
}

/**
 * What the table renders in place of its rows. A load that failed must never
 * answer with the empty state: "no documents yet" is a statement about the
 * workspace, and a failed request read nothing to make it from.
 */
export function tableEmpty(
	status: ScreenStatus,
	populated: TableEmpty,
): TableEmpty {
	if (status !== 'error') return populated;
	return {
		icon: 'alert',
		title: t('documents.loadFailed.title'),
		hint: t('documents.loadFailed.hint'),
	};
}
