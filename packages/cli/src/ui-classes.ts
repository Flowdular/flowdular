/**
 * Class names a screen writes by hand, checked against the stylesheets that
 * define them.
 *
 * A typecheck says nothing about `class="ui-stak"`: the screen compiles, the
 * tests pass and the element renders unstyled. The only authority is the CSS,
 * so this reads both sides and reports a name nothing declares.
 */

/* A class a screen writes by hand is namespaced: `ui-view`, `ui-form__section`,
   `run-entry--tool`, `token-presets`. Requiring the separator is what keeps the
   operands of a condition in the same expression, such as the 'sm' of
   `props.size === 'sm' && 'ui-btn--sm'`, from reading as class names. A
   single-word typo is the price, and the review rule that a module writes
   namespaced classes is what covers it. */
const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:[-_]{1,2}[a-z0-9]+)+$/;
const COMPARISON = /(===|!==|==|!=)\s*(['"])(?:\\.|(?!\2)[^\\])*\2/g;
const COMPARED = /(['"])(?:\\.|(?!\1)[^\\])*\1(\s*(?:===|!==|==|!=))/g;

export interface UsedClassName {
	readonly name: string;
	readonly line: number;
}

/**
 * Every class a stylesheet declares. Declaration blocks are removed first, so
 * a file path inside `url(./sprite.png)` cannot be mistaken for a selector.
 */
export function declaredClassNames(css: string): ReadonlySet<string> {
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
	let selectors = withoutComments;
	for (;;) {
		const stripped = selectors.replace(/\{[^{}]*\}/g, ' ');
		if (stripped === selectors) break;
		selectors = stripped;
	}
	const names = new Set<string>();
	for (const match of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
		names.add(match[1]!);
	}
	return names;
}

/* The value of a class attribute, whether it is a literal or an expression:
   "a b", {['a', flag && 'b']}, {'a-' + kind}. Only the literals are knowable
   here, which is what a typo is made of. */
function classAttributeValues(source: string): { value: string; at: number }[] {
	const values: { value: string; at: number }[] = [];
	const attribute = /\bclass\s*=\s*/g;
	for (const match of source.matchAll(attribute)) {
		const start = match.index + match[0].length;
		const opener = source[start];
		if (opener === '"' || opener === "'") {
			const end = source.indexOf(opener, start + 1);
			if (end === -1) continue;
			values.push({ value: source.slice(start + 1, end), at: start });
			continue;
		}
		if (opener !== '{') continue;
		let depth = 0;
		let quote = '';
		let index = start;
		for (; index < source.length; index += 1) {
			const character = source[index]!;
			if (quote) {
				if (character === '\\') index += 1;
				else if (character === quote) quote = '';
				continue;
			}
			if (character === '"' || character === "'" || character === '`') {
				quote = character;
				continue;
			}
			if (character === '{') depth += 1;
			else if (character === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		/* A compared value is not a class, however it is spelled, so it leaves
		   the expression before the literals are read. */
		const expression = source
			.slice(start, index + 1)
			.replace(
				COMPARISON,
				(whole, operator) =>
					operator + ' '.repeat(whole.length - operator.length),
			)
			.replace(
				COMPARED,
				(whole, _quote, operator) =>
					' '.repeat(whole.length - operator.length) + operator,
			);
		for (const literal of expression.matchAll(
			/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
		)) {
			values.push({
				value: literal[2]!,
				at: start + (literal.index ?? 0),
			});
		}
	}
	return values;
}

/**
 * The class names a source writes as literals. A fragment of a name, such as
 * the `ui-alert--` of `'ui-alert--' + tone`, is not one: it names no class on
 * its own and the suffix is only known at run time.
 */
export function usedClassNames(source: string): readonly UsedClassName[] {
	const used: UsedClassName[] = [];
	for (const { value, at } of classAttributeValues(source)) {
		if (value.includes('${')) continue;
		const line = source.slice(0, at).split('\n').length;
		for (const token of value.split(/\s+/)) {
			if (!token || token.endsWith('-') || !CLASS_TOKEN.test(token)) continue;
			used.push({ name: token, line });
		}
	}
	return used;
}

/** The used names no stylesheet declares, in the order they appear, once each. */
export function unknownClassNames(
	used: readonly UsedClassName[],
	declared: ReadonlySet<string>,
): readonly UsedClassName[] {
	const unknown: UsedClassName[] = [];
	const seen = new Set<string>();
	for (const entry of used) {
		if (declared.has(entry.name)) continue;
		const key = `${entry.name}:${entry.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unknown.push(entry);
	}
	return unknown;
}
