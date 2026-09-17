/* The DOM property names Octane expects in camelCase on a host element, as
   listed by octane's host-property-diagnostics (KNOWN_CAMELCASE_PROPERTIES and
   the HTML attribute aliases). A lowercase spelling such as `maxlength` still
   sets the attribute, but a dynamic value logs "Invalid DOM property" in every
   development session, so the source keeps Octane's spelling. */
export const DOM_PROPERTY_SPELLINGS = [
	'acceptCharset',
	'allowFullScreen',
	'autoCapitalize',
	'autoComplete',
	'autoCorrect',
	'autoFocus',
	'autoPlay',
	'charSet',
	'contentEditable',
	'crossOrigin',
	'defaultChecked',
	'defaultValue',
	'disablePictureInPicture',
	'disableRemotePlayback',
	'encType',
	'fetchPriority',
	'formAction',
	'formEncType',
	'formMethod',
	'formNoValidate',
	'formTarget',
	'httpEquiv',
	'imageSizes',
	'imageSrcSet',
	'inputMode',
	'itemID',
	'itemProp',
	'itemRef',
	'itemScope',
	'itemType',
	'maxLength',
	'noModule',
	'noValidate',
	'playsInline',
	'readOnly',
	'referrerPolicy',
	'spellCheck',
	'srcDoc',
	'srcLang',
	'srcSet',
	'tabIndex',
	'viewBox',
] as const;

const SPELLINGS = new Map<string, string>(
	DOM_PROPERTY_SPELLINGS.map((name) => [name.toLowerCase(), name]),
);

export interface DomPropertyMisspelling {
	readonly name: string;
	readonly expected: string;
	readonly line: number;
	readonly index: number;
}

/* The attribute text of every host element tag (`<input`, `<div`, never a
   `<Component`), with the contents of `{}` expressions and quoted values blanked
   so an arrow function or a string cannot end the tag or look like an
   attribute. Offsets stay those of the source. */
function hostTagAttributes(source: string): { start: number; text: string }[] {
	const tags: { start: number; text: string }[] = [];
	for (const match of source.matchAll(/<[a-z][a-z0-9-]*/g)) {
		const start = match.index + match[0].length;
		let depth = 0;
		let quote = '';
		let text = '';
		let end = start;
		for (; end < source.length; end += 1) {
			const character = source[end]!;
			if (quote !== '') {
				if (character === quote) quote = '';
				text += ' ';
				continue;
			}
			if (depth > 0) {
				if (character === '{') depth += 1;
				else if (character === '}') depth -= 1;
				text += depth === 0 ? character : ' ';
				continue;
			}
			if (character === '{') {
				depth = 1;
				text += character;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				text += character;
				continue;
			}
			if (character === '>') break;
			text += character;
		}
		tags.push({ start, text });
	}
	return tags;
}

/** Host element attributes spelled in a case Octane rejects, in source order. */
export function domPropertyMisspellings(
	source: string,
): readonly DomPropertyMisspelling[] {
	const found: DomPropertyMisspelling[] = [];
	for (const tag of hostTagAttributes(source)) {
		for (const attribute of tag.text.matchAll(
			/(?<=\s)([A-Za-z][A-Za-z-]*)=/g,
		)) {
			const name = attribute[1]!;
			const expected = SPELLINGS.get(name.toLowerCase());
			if (expected === undefined || expected === name) continue;
			const index = tag.start + attribute.index;
			found.push({
				name,
				expected,
				index,
				line: source.slice(0, index).split('\n').length,
			});
		}
	}
	return found.sort((left, right) => left.index - right.index);
}

/** The source with every misspelled host attribute renamed to Octane's spelling. */
export function fixDomPropertyMisspellings(source: string): string {
	let fixed = source;
	for (const found of [...domPropertyMisspellings(source)].reverse()) {
		fixed =
			fixed.slice(0, found.index) +
			found.expected +
			fixed.slice(found.index + found.name.length);
	}
	return fixed;
}
