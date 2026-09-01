import type { TagTone } from '@coreloom/ui';
import type { AgentModelReadiness } from '../domain/types.ts';

const TONES: Readonly<Record<string, TagTone>> = {
	active: 'success',
	succeeded: 'success',
	queued: 'info',
	running: 'info',
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
