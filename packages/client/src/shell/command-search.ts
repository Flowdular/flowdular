import type {
	CommandSearchContribution,
	CommandSearchHit,
} from '../contributions.ts';

/** A query shorter than this asks nobody; the palette shows navigation only. */
export const COMMAND_SEARCH_MINIMUM = 2;
/** Idle time after the last keystroke before a contribution is asked. */
export const COMMAND_SEARCH_DEBOUNCE_MS = 200;
/** Hits one group shows, so a talkative provider cannot bury the others. */
export const COMMAND_SEARCH_GROUP_LIMIT = 5;

export interface CommandSearchGroup {
	readonly provider: string;
	readonly label: string;
	readonly hits: readonly CommandSearchHit[];
}

export function commandSearchReady(query: string): boolean {
	return query.trim().length >= COMMAND_SEARCH_MINIMUM;
}

/**
 * Groups by provider in first-seen order and caps each group. The order the
 * hits arrive in is the answer's own ranking, so grouping never reorders
 * within a provider and never compares scores across providers.
 */
export function groupCommandSearchHits(
	hits: readonly CommandSearchHit[],
): readonly CommandSearchGroup[] {
	const groups = new Map<string, CommandSearchHit[]>();
	const labels = new Map<string, string>();
	for (const hit of hits) {
		const group = groups.get(hit.provider);
		if (group) {
			if (group.length < COMMAND_SEARCH_GROUP_LIMIT) group.push(hit);
			continue;
		}
		groups.set(hit.provider, [hit]);
		labels.set(hit.provider, hit.providerLabel);
	}
	return [...groups].map(([provider, entries]) => ({
		provider,
		label: labels.get(provider) ?? provider,
		hits: entries,
	}));
}

export interface CommandSearchAnswer {
	readonly hits: readonly CommandSearchHit[];
	/** Ids of the contributions that answered nothing the palette can list. */
	readonly failed: readonly string[];
}

/* Which contribution answered with a hit, so opening one reaches its author and
   nobody else. Weakly keyed by the hit: an answer the palette replaced takes its
   entries with it, so nothing is pruned and nothing is held alive. */
const hitOrigin = new WeakMap<CommandSearchHit, CommandSearchContribution>();

/**
 * Tells the contribution that answered with this hit that the member opened it.
 * Fire and forget on the navigation path: the answer is never awaited and a
 * contribution that throws or rejects is isolated here, so whatever it does the
 * record still opens. A hit from no known answer reaches nobody.
 */
export function commandSearchHitOpened(hit: CommandSearchHit): void {
	const contribution = hitOrigin.get(hit);
	if (!contribution?.onOpen) return;
	try {
		void Promise.resolve(contribution.onOpen(hit)).catch(() => undefined);
	} catch {
		/* A contribution that throws before it returns a promise is the same
		   failure as one that rejects, and costs the member the same nothing. */
	}
}

/**
 * Asks every contribution in parallel and keeps their declared order. A
 * contribution is foreign code on the shell's critical path: one that rejects
 * or answers with something unreadable contributes nothing, so the palette
 * keeps listing navigation entries whatever a module does. It is named in
 * `failed` instead, because a member who is shown three groups out of four has
 * to be told the fourth is missing rather than read the list as complete. An
 * empty list is an answer, not a failure.
 */
export async function runCommandSearch(
	contributions: readonly CommandSearchContribution[],
	query: string,
	signal: AbortSignal,
): Promise<CommandSearchAnswer> {
	const answers = await Promise.allSettled(
		/* `async` so a contribution that throws before it returns a promise is
		   isolated by the same settlement as one that rejects. */
		contributions.map(async (contribution) =>
			contribution.search({ query, signal }),
		),
	);
	const hits: CommandSearchHit[] = [];
	const failed: string[] = [];
	for (const [index, answer] of answers.entries()) {
		if (answer.status !== 'fulfilled' || !Array.isArray(answer.value)) {
			failed.push(contributions[index]!.id);
			continue;
		}
		for (const hit of answer.value) {
			if (hit && typeof hit.id === 'string' && typeof hit.title === 'string') {
				hits.push(hit);
				hitOrigin.set(hit, contributions[index]!);
			}
		}
	}
	return { hits, failed };
}

/**
 * What the palette says about its record section. Every asked contribution
 * failing is a failure the member has to see in place of the hits; some of them
 * failing still lists what came back, under a notice that it is incomplete.
 */
export function commandSearchOutcome(
	asked: number,
	failed: number,
): 'ready' | 'partial' | 'error' {
	if (asked > 0 && failed >= asked) return 'error';
	return failed > 0 ? 'partial' : 'ready';
}
