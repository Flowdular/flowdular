import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type { ImportJobStatus, ImportRowOutcome } from '../domain/types.ts';

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

export function statusLabel(status: ImportJobStatus): string {
	return t('import.status.' + status);
}

export function statusTone(status: ImportJobStatus): TagTone {
	if (status === 'completed') return 'success';
	if (status === 'failed') return 'danger';
	if (status === 'cancelled') return 'neutral';
	return status === 'validated' ? 'info' : 'warning';
}

export function outcomeLabel(outcome: ImportRowOutcome): string {
	return t('import.outcome.' + outcome);
}

export function outcomeTone(outcome: ImportRowOutcome): TagTone {
	if (outcome === 'created' || outcome === 'updated') return 'success';
	if (outcome === 'invalid' || outcome === 'failed') return 'danger';
	return outcome === 'valid' ? 'info' : 'neutral';
}

export function modeLabel(mode: string): string {
	return t('import.mode.' + mode);
}

/**
 * A row reason and a job's failure code are stable codes the port or this module
 * produced. A code with a reason of its own reads that; a code this module also
 * refuses requests with falls back to that one sentence rather than carrying a
 * second copy of it; anything else is shown as the port wrote it rather than
 * hidden behind a generic line.
 */
export function reasonLabel(reason: string | null): string {
	if (!reason) return '';
	for (const key of [
		'import.reason.' + reason,
		'import.error.code.' + reason,
	]) {
		const translated = t(key);
		if (translated !== key) return translated;
	}
	return reason;
}
