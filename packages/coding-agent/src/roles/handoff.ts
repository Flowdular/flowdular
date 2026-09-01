export interface HandoffDeclaration {
	/* The role that should take the next turn, or null when the specialist
	   reports the work as finished. */
	readonly role: string | null;
	readonly reason: string;
}

const LINE = /^handoff\s*:\s*(.*)$/i;
const PARTS = /^([a-z][a-z0-9_ -]*?)(?:\s*(?:[:|\u2013\u2014]|\s-)\s*(.*))?$/i;
const DECORATION = /[`*_>#]/g;

/* Models write the role as an id, a display name, or with a trailing full
   stop. All of them name the same specialist, so the id is normalized before
   the orchestrator compares it with the registered roles. */
function normalizeRole(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
}

/* Every role ends its final message with one handoff line, so the orchestrator
   knows who continues without asking a model to summarize the state again. The
   last line wins: a specialist that quotes the format while explaining itself
   cannot redirect the routing. */
export function parseHandoff(text: string): HandoffDeclaration | null {
	const lines = text.split('\n');
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!.replace(DECORATION, '').trim();
		const match = LINE.exec(line);
		if (!match) continue;
		const parts = PARTS.exec(match[1]!.replace(/[.!]+$/, '').trim());
		if (!parts) continue;
		const role = normalizeRole(parts[1]!);
		return {
			role: role === 'none' ? null : role,
			reason: (parts[2] ?? '').trim().slice(0, 240),
		};
	}
	return null;
}
