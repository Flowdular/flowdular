import { activeLocale } from '../i18n/runtime.ts';

export function initials(value: string): string {
	return (
		value
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toLocaleUpperCase(activeLocale()) ?? '')
			.join('') || 'AC'
	);
}
