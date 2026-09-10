import type { VariableDefinition } from '@flowdular/contracts';

export interface ActiveQuery {
	readonly start: number;
	readonly query: string;
}

/* When the caret sits inside an unclosed {{ ... }} (the opener is not escaped
   and no brace stands between it and the caret), returns that opener offset and
   the typed text, so the caller can filter the menu and later replace the
   partial token. Returns null otherwise. */
export function activeQuery(value: string, caret: number): ActiveQuery | null {
	const before = value.slice(0, caret);
	const open = before.lastIndexOf('{{');
	if (open < 0) return null;
	if (open >= 1 && before[open - 1] === '\\') return null;
	const between = before.slice(open + 2);
	if (
		between.includes('}}') ||
		between.includes('{') ||
		between.includes('}')
	) {
		return null;
	}
	return { start: open, query: between.trim() };
}

export function filterVariables(
	variables: readonly VariableDefinition[],
	query: string,
): readonly VariableDefinition[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return variables;
	return variables.filter(
		(variable) =>
			variable.key.toLowerCase().includes(needle) ||
			variable.label.toLowerCase().includes(needle),
	);
}

export function previewValue(
	variable: VariableDefinition,
	sampleValues: Record<string, string> | undefined,
): string {
	const provided = sampleValues?.[variable.key];
	if (provided !== undefined && provided.length > 0) return provided;
	return variable.sample ?? '';
}

export function insertToken(
	value: string,
	start: number,
	end: number,
	key: string,
): { readonly value: string; readonly caret: number } {
	const token = `{{ ${key} }}`;
	return {
		value: value.slice(0, start) + token + value.slice(end),
		caret: start + token.length,
	};
}
