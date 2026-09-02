export type VariableKind = 'text' | 'number' | 'date' | 'money' | 'identifier';

export interface VariableDefinition {
	readonly key: string;
	readonly label: string;
	readonly kind: VariableKind;
	/** The permission required to read the source. Absent means always readable. */
	readonly scope?: string;
	readonly sample?: string;
	readonly description?: string;
}

/* A source groups the variables that come from one bounded context or public
   service. Consumers register sources, then filter the flattened definitions
   against the requesting principal's scopes before offering them to the UI or
   resolving a template. */
export interface VariableSource {
	readonly id: string;
	readonly variables: readonly VariableDefinition[];
}

/* A dot-separated identifier. Each segment starts with a lowercase letter and
   may continue with letters or digits, so camelCase paths such as
   context.user.displayName are valid while keeping the leading-lowercase rule. */
export const VARIABLE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

/* Matches a token or an escaped opener. The escape branch has no capture group,
   so a matched group tells a token (group defined) from an escape (undefined).
   The inner class forbids braces, so a token never spans another token's
   braces: nested-looking input resolves the innermost token only. */
const TOKEN_PATTERN = /\\\{\{|\{\{([^{}]*)\}\}/g;

export type TemplateSegment =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'variable'; readonly key: string; readonly text: string };

export interface TemplateValidation {
	readonly unknown: readonly string[];
	readonly forbidden: readonly string[];
}

export interface ResolveTemplateOptions {
	/** keep (default) leaves an unresolved token verbatim; blank removes it. */
	readonly onMissing?: 'keep' | 'blank';
}

export function variableDefinitions(
	sources: readonly VariableSource[],
): readonly VariableDefinition[] {
	return sources.flatMap((source) => source.variables);
}

export function variablesForScopes(
	available: readonly VariableDefinition[],
	allowedScopes: readonly string[],
): readonly VariableDefinition[] {
	return available.filter(
		(variable) =>
			variable.scope === undefined || allowedScopes.includes(variable.scope),
	);
}

export function isVariableKey(key: string): boolean {
	return VARIABLE_KEY_PATTERN.test(key);
}

/* Splits a template into verbatim text and variable spans whose text fields
   concatenate back to the exact input, so a highlight overlay can wrap the
   token ranges without shifting any character. */
export function tokenizeTemplate(template: string): readonly TemplateSegment[] {
	const segments: TemplateSegment[] = [];
	let text = '';
	let lastIndex = 0;
	TOKEN_PATTERN.lastIndex = 0;
	for (
		let match = TOKEN_PATTERN.exec(template);
		match !== null;
		match = TOKEN_PATTERN.exec(template)
	) {
		text += template.slice(lastIndex, match.index);
		lastIndex = match.index + match[0].length;
		if (match[1] === undefined) {
			text += match[0];
			continue;
		}
		if (text.length > 0) {
			segments.push({ kind: 'text', text });
			text = '';
		}
		segments.push({ kind: 'variable', key: match[1].trim(), text: match[0] });
	}
	text += template.slice(lastIndex);
	if (text.length > 0) segments.push({ kind: 'text', text });
	return segments;
}

/* The distinct {{ key }} tokens a template uses, trimmed, in first-seen order.
   Empty tokens are ignored; escaped openers are not tokens. */
export function extractVariables(template: string): readonly string[] {
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const segment of tokenizeTemplate(template)) {
		if (segment.kind !== 'variable' || segment.key.length === 0) continue;
		if (seen.has(segment.key)) continue;
		seen.add(segment.key);
		keys.push(segment.key);
	}
	return keys;
}

export function validateTemplate(
	template: string,
	available: readonly VariableDefinition[],
	allowedScopes?: readonly string[],
): TemplateValidation {
	const byKey = new Map(
		available.map((definition) => [definition.key, definition]),
	);
	const unknown: string[] = [];
	const forbidden: string[] = [];
	for (const key of extractVariables(template)) {
		const definition = byKey.get(key);
		if (!definition) {
			unknown.push(key);
			continue;
		}
		if (
			definition.scope !== undefined &&
			allowedScopes !== undefined &&
			!allowedScopes.includes(definition.scope)
		) {
			forbidden.push(key);
		}
	}
	return { unknown, forbidden };
}

/* Substitutes each {{ key }} with values[key]. Substitution is a single pass:
   a value that itself looks like a token is emitted verbatim, never re-scanned.
   Only own, string keys resolve, so prototype keys can never be reached. */
export function resolveTemplate(
	template: string,
	values: Record<string, string>,
	options: ResolveTemplateOptions = {},
): string {
	const onMissing = options.onMissing ?? 'keep';
	return template.replace(TOKEN_PATTERN, (match, inner: string | undefined) => {
		if (inner === undefined) return '{{';
		const key = inner.trim();
		if (Object.prototype.hasOwnProperty.call(values, key)) {
			const value = values[key];
			if (typeof value === 'string') return value;
		}
		return onMissing === 'blank' ? '' : match;
	});
}
