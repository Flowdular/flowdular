/*
 * robots.txt as RFC 9309 reads it: the groups naming this product token, or
 * the wildcard group when none does; the longest matching rule decides, and an
 * allow rule wins a tie. Patterns are matched by a two-pointer wildcard walk
 * instead of a regular expression, and one decision spends at most
 * MATCH_BUDGET comparisons over every rule: a hostile file that exhausts it
 * refuses the path rather than holding the event loop.
 */

export interface RobotsRule {
	readonly allow: boolean;
	readonly pattern: string;
}

export interface RobotsRules {
	readonly rules: readonly RobotsRule[];
}

export const ADMIT_ALL: RobotsRules = { rules: [] };

const MAX_RULES = 500;
const MAX_PATTERN = 512;
const MATCH_BUDGET = 1_000_000;

export function parseRobots(text: string, token: string): RobotsRules {
	const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
	let current: { agents: string[]; rules: RobotsRule[] } | null = null;
	let collectingAgents = false;
	for (const rawLine of text.split(/\r\n|\r|\n/)) {
		const line = rawLine.replace(/#.*$/, '').trim();
		const separator = line.indexOf(':');
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key === 'user-agent') {
			if (!collectingAgents || current === null) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			collectingAgents = true;
			continue;
		}
		if (key !== 'allow' && key !== 'disallow') continue;
		collectingAgents = false;
		if (current === null || value === '' || value.length > MAX_PATTERN)
			continue;
		current.rules.push({ allow: key === 'allow', pattern: value });
	}
	const named = groups.filter((group) =>
		group.agents.some((agent) => agent === token),
	);
	const chosen =
		named.length > 0
			? named
			: groups.filter((group) => group.agents.includes('*'));
	return {
		rules: chosen.flatMap((group) => group.rules).slice(0, MAX_RULES),
	};
}

/** Answers null once the shared budget is spent. */
function ruleMatches(
	pattern: string,
	path: string,
	budget: { remaining: number },
): boolean | null {
	const anchored = pattern.endsWith('$');
	const body = anchored ? pattern.slice(0, -1) : pattern;
	let at = 0;
	let position = 0;
	let star = -1;
	let resume = 0;
	for (;;) {
		budget.remaining -= 1;
		if (budget.remaining < 0) return null;
		if (position === body.length) {
			if (!anchored || at === path.length) return true;
		} else if (body[position] === '*') {
			star = position;
			resume = at;
			position += 1;
			continue;
		} else if (at < path.length && body[position] === path[at]) {
			at += 1;
			position += 1;
			continue;
		}
		if (star < 0) return false;
		resume += 1;
		if (resume > path.length) return false;
		at = resume;
		position = star + 1;
	}
}

export function robotsAllows(rules: RobotsRules, path: string): boolean {
	if (path === '/robots.txt') return true;
	let best: RobotsRule | null = null;
	const budget = { remaining: MATCH_BUDGET };
	for (const rule of rules.rules) {
		const matched = ruleMatches(rule.pattern, path, budget);
		if (matched === null) return false;
		if (!matched) continue;
		if (
			best === null ||
			rule.pattern.length > best.pattern.length ||
			(rule.pattern.length === best.pattern.length && rule.allow)
		) {
			best = rule;
		}
	}
	return best === null || best.allow;
}

/** Per host, bounded, oldest entry evicted first; a read past the TTL is a miss. */
export class RobotsCache {
	readonly #entries = new Map<
		string,
		{ readonly rules: RobotsRules; readonly expiresAt: number }
	>();

	constructor(
		readonly limit: number,
		readonly ttlMs: number,
	) {}

	get(host: string, now: number): RobotsRules | null {
		const entry = this.#entries.get(host);
		if (!entry) return null;
		if (entry.expiresAt <= now) {
			this.#entries.delete(host);
			return null;
		}
		return entry.rules;
	}

	set(host: string, rules: RobotsRules, now: number): void {
		this.#entries.delete(host);
		if (this.#entries.size >= this.limit) {
			const oldest = this.#entries.keys().next();
			if (!oldest.done) this.#entries.delete(oldest.value);
		}
		this.#entries.set(host, { rules, expiresAt: now + this.ttlMs });
	}
}
