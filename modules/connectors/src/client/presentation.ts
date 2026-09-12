import { activeLocale, t } from '@flowdular/client';
import type {
	ConnectorCallOutcome,
	ConnectorInstanceStatus,
} from '../domain/types.ts';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function instanceStatusLabel(status: ConnectorInstanceStatus): string {
	return t('connectors.status.' + status);
}

export function instanceStatusTone(status: ConnectorInstanceStatus): Tone {
	return status === 'active' ? 'success' : 'neutral';
}

export function outcomeLabel(outcome: ConnectorCallOutcome): string {
	return t('connectors.outcome.' + outcome);
}

export function outcomeTone(outcome: ConnectorCallOutcome): Tone {
	if (outcome === 'succeeded') return 'success';
	return outcome === 'refused' ? 'warning' : 'danger';
}

export function consentLabel(granted: boolean): string {
	return t(granted ? 'connectors.consent.on' : 'connectors.consent.off');
}

/** A timestamp the reader's locale formats, or a dash when there is none. */
export function timestampLabel(value: number | null): string {
	if (value === null || value === 0) return t('connectors.common.never');
	return new Date(value).toLocaleString(activeLocale());
}

export function durationLabel(milliseconds: number): string {
	return t('connectors.calls.duration', { value: milliseconds });
}
