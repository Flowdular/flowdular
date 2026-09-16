import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type { AdapterRowOutcome, AdapterRunStatus } from '../domain/types.ts';

export function timestampLabel(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

export function countLabel(value: number): string {
	return new Intl.NumberFormat(activeLocale()).format(value);
}

export function statusLabel(status: AdapterRunStatus): string {
	return t('adapters.status.' + status);
}

export function statusTone(status: AdapterRunStatus): TagTone {
	if (status === 'succeeded') return 'success';
	if (status === 'failed') return 'danger';
	if (status === 'cancelled') return 'neutral';
	return status === 'running' ? 'info' : 'warning';
}

export function outcomeLabel(outcome: AdapterRowOutcome | 'valid'): string {
	return t('adapters.outcome.' + outcome);
}

export function outcomeTone(outcome: AdapterRowOutcome | 'valid'): TagTone {
	if (outcome === 'created' || outcome === 'updated' || outcome === 'pushed') {
		return 'success';
	}
	if (outcome === 'valid') return 'info';
	return outcome === 'skipped' ? 'neutral' : 'danger';
}

/**
 * A code this module or a port produced. A known code reads its sentence; a
 * port's own reason is shown as the port wrote it rather than hidden.
 */
export function codeLabel(code: string | null): string {
	if (!code) return '';
	const key = 'adapters.error.code.' + code;
	const translated = t(key);
	return translated === key ? code : translated;
}
