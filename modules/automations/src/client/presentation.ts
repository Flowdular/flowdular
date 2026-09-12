import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import {
	cadenceKind,
	cadenceMinutes,
	cronExpression,
} from '../domain/cadence.ts';

export function cadenceLabel(cadence: string): string {
	if (cadenceKind(cadence) === 'cron') {
		return t('automations.cadence.cron', {
			expression: cronExpression(cadence),
		});
	}
	return intervalLabel(cadenceMinutes(cadence));
}

function intervalLabel(minutes: number): string {
	if (minutes < 60) {
		return t('automations.cadence.minutes', { count: minutes });
	}
	if (minutes % 1_440 === 0) {
		const days = minutes / 1_440;
		return t(
			days === 1 ? 'automations.cadence.day' : 'automations.cadence.days',
			{ count: days },
		);
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return t(
			hours === 1 ? 'automations.cadence.hour' : 'automations.cadence.hours',
			{ count: hours },
		);
	}
	return t('automations.cadence.hoursMinutes', {
		hours: Math.floor(minutes / 60),
		minutes: minutes % 60,
	});
}

export function timestampLabel(
	value: number | null,
	timeZone?: string,
): string {
	if (value === null) return t('automations.common.notYet');
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
		...(timeZone ? { timeZone } : {}),
	}).format(value);
}

export function automationTone(enabled: boolean): TagTone {
	return enabled ? 'success' : 'neutral';
}
