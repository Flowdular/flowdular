import { activeLocale, t } from '@flowdular/client/i18n';
import type { ScreenStatus } from './state.ts';

/**
 * What a screen puts under its header. A failed load answers `error` and
 * nothing else, so the table's empty copy never claims the workspace holds
 * nothing when the read failed.
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

export function timestampLabel(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

export function adapterLabel(adapter: string): string {
	const key = 'research.adapter.' + adapter;
	const translated = t(key);
	return translated === key ? adapter : translated;
}

export function callerLabel(caller: string): string {
	const key = 'research.caller.' + caller;
	const translated = t(key);
	return translated === key ? caller : translated;
}

export function adapterStatusTone(
	status: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
	if (status === 'ready') return 'success';
	if (status === 'circuit-open') return 'danger';
	return status === 'unsupported' ? 'warning' : 'neutral';
}

export function adapterStatusLabel(
	status: string,
	openUntil: number | null,
): string {
	if (status === 'circuit-open' && openUntil !== null) {
		return t('research.adapters.status.circuit-open', {
			time: timestampLabel(openUntil),
		});
	}
	const key = 'research.adapters.status.' + status;
	const translated = t(key);
	return translated === key ? status : translated;
}

/** A stored error code in the reader's words, or the code itself. */
export function errorCodeLabel(code: string): string {
	const key = 'research.error.code.' + code;
	const translated = t(key);
	return translated === key ? code : translated;
}

export function attemptOutcomeLabel(outcome: string): string {
	const key = 'research.attempts.outcome.' + outcome;
	const translated = t(key);
	return translated === key ? outcome : translated;
}

export function attemptOutcomeTone(
	outcome: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
	if (outcome === 'ok') return 'success';
	if (outcome === 'retryable' || outcome === 'empty') return 'warning';
	return outcome === 'permanent' ? 'danger' : 'neutral';
}

export function durationLabel(milliseconds: number): string {
	return t('research.common.milliseconds', {
		value: numberLabel(milliseconds),
	});
}
