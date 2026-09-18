import { cell, createStore } from 'segment-state';
import type { WorkspaceSlot } from '@flowdular/client';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import type {
	AssistantConversation,
	AssistantReadiness,
	AssistantThread,
} from '../domain/types.ts';

/* The entry sits beside the other topbar actions rather than inside a view:
   the assistant is reachable from every screen or it is not general. */
export const ASSISTANT_TOPBAR_WIDGET: {
	readonly id: string;
	readonly slot: WorkspaceSlot;
	readonly scope: string;
	readonly order: number;
} = {
	id: 'agents.topbar.assistant',
	slot: 'topbar.actions',
	scope: AGENT_PERMISSIONS.assistantUse,
	order: 20,
};

export const THREAD_PAGE_SIZE = 20;

/* A pending turn settles when its run reaches a terminal state, and the read
   endpoint is what settles it, so the open conversation polls while it waits.
   The interval is slow enough to cost a workspace little and quick enough to
   read as an answer arriving. */
export const TURN_POLL_MS = 1_500;

/* A run that never settles must not poll for the rest of the session. */
export const TURN_POLL_LIMIT = 240;

export type AssistantPanelStatus = 'idle' | 'loading' | 'sending';

export function createAssistantState() {
	const store = createStore({
		open: false,
		historyOpen: false,
		readiness: cell<AssistantReadiness | null>(null),
		conversation: cell<AssistantConversation | null>(null),
		threads: cell<readonly AssistantThread[]>([]),
		draft: '',
		status: cell<AssistantPanelStatus>('idle'),
		error: '',
	});
	return { store, state: store.state };
}

export function pendingTurn(
	conversation: AssistantConversation | null,
): boolean {
	return conversation?.turns.some((turn) => turn.status === 'pending') === true;
}

/* The launcher shows what the assistant is doing without a word: locked until
   it can answer, working while a turn is out, ready otherwise. */
export function launcherState(
	readiness: AssistantReadiness | null,
	working: boolean,
): 'locked' | 'working' | 'ready' {
	if (readiness === null || !readiness.ready) return 'locked';
	return working ? 'working' : 'ready';
}
