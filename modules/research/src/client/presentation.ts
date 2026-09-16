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

/** The first twelve hex digits, enough to tell two digests apart on screen. */
export function shortDigest(value: string): string {
	return value.slice(0, 12);
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
