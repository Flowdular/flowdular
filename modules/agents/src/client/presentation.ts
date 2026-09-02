import type { TagTone } from '@coreloom/ui';
import { activeLocale, t } from '@coreloom/client/i18n';
import type {
	AgentModelReadiness,
	AgentRun,
	AgentRunTrigger,
} from '../domain/types.ts';

const TONES: Readonly<Record<string, TagTone>> = {
	active: 'success',
	succeeded: 'success',
	queued: 'info',
	running: 'info',
	unconfigured: 'warning',
	unavailable: 'danger',
	failed: 'danger',
	cancelled: 'danger',
};

export function stateTone(state: string): TagTone {
	return TONES[state] ?? 'neutral';
}

export type ModelReadinessState = 'ready' | 'stale' | 'failing' | 'untested';

/* Evidence expires. A tag that still says ready after the window closed is the
   reason a run gets rejected with nothing on screen to explain it. */
export function modelReadinessState(
	readiness: AgentModelReadiness,
	ttlMs: number,
	now = Date.now(),
): ModelReadinessState {
	if (readiness.status === 'unhealthy') return 'failing';
	if (readiness.status !== 'healthy' || readiness.checkedAt === null) {
		return 'untested';
	}
	return now - readiness.checkedAt <= ttlMs ? 'ready' : 'stale';
}

export function readinessTone(state: ModelReadinessState): TagTone {
	if (state === 'ready') return 'success';
	return state === 'untested' ? 'neutral' : 'warning';
}

export function cadenceLabel(minutes: number): string {
	if (minutes < 60) {
		return t('agents.cadence.minutes', { count: minutes });
	}
	if (minutes % 1_440 === 0) {
		const days = minutes / 1_440;
		return t(days === 1 ? 'agents.cadence.day' : 'agents.cadence.days', {
			count: days,
		});
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return t(hours === 1 ? 'agents.cadence.hour' : 'agents.cadence.hours', {
			count: hours,
		});
	}
	return t('agents.cadence.hoursMinutes', {
		hours: Math.floor(minutes / 60),
		minutes: minutes % 60,
	});
}

export function timestampLabel(value: number | null): string {
	if (value === null) return '—';
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

export function dayLabel(value: string): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeZone: 'UTC',
	}).format(new Date(value + 'T00:00:00Z'));
}

/* Costs are stored in micro-USD so a rollup stays integral; the screen is the
   only place that turns them back into money. */
export function costLabel(microUsd: number): string {
	const usd = microUsd / 1_000_000;
	const format = new Intl.NumberFormat(activeLocale(), {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	if (usd === 0) return format.format(0);
	return usd < 0.01 ? '<' + format.format(0.01) : format.format(usd);
}

export function tokenLabel(tokens: number): string {
	return new Intl.NumberFormat(activeLocale(), {
		notation: tokens >= 1_000 ? 'compact' : 'standard',
		maximumFractionDigits: tokens >= 1_000_000 ? 2 : 1,
	}).format(tokens);
}

/* The stored trigger names the code path; an operator asks what started the
   run. Only the webhook trigger service ever writes `workflow`. */
export function triggerLabel(trigger: AgentRunTrigger): string {
	return t('agents.trigger.' + trigger);
}

export const RUN_TRIGGERS: readonly AgentRunTrigger[] = [
	'playground',
	'schedule',
	'workflow',
	'service',
];

export const RUN_STATUSES: readonly AgentRun['status'][] = [
	'queued',
	'running',
	'succeeded',
	'failed',
	'cancelled',
];

/* Elapsed since start; live while the run has no end, blank before it starts. */
export function durationLabel(run: AgentRun, now: number): string {
	if (run.startedAt === null) return '';
	const seconds = Math.max(
		0,
		((run.completedAt ?? now) - run.startedAt) / 1000,
	);
	if (seconds < 60) {
		return t('agents.duration.seconds', {
			count: new Intl.NumberFormat(activeLocale(), {
				maximumFractionDigits: seconds < 10 ? 1 : 0,
			}).format(seconds),
		});
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return t('agents.duration.minutes', {
			minutes,
			seconds: Math.round(seconds % 60),
		});
	}
	return t('agents.duration.hours', {
		hours: Math.floor(minutes / 60),
		minutes: minutes % 60,
	});
}

export function clockLabel(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).format(value);
}

/* Character counts run into the tens of thousands, so they are grouped. */
export function countLabel(value: number): string {
	return new Intl.NumberFormat(activeLocale()).format(value);
}
