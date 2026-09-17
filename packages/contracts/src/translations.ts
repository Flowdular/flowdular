/* A plural family is a set of `<key>.<category>` entries next to `<key>.other`;
   `t(key, { count })` picks the member Intl.PluralRules selects for the count.
   These category names are reserved as the last segment of a translation key. */
export const PLURAL_CATEGORIES: readonly Intl.LDMLPluralRule[] = [
	'zero',
	'one',
	'two',
	'few',
	'many',
	'other',
];

export type TranslationBundleKeys = Readonly<Record<string, string>>;

/* Every rule CLDR ships for whole numbers is decided by the last two digits or
   by a power of ten (French `many` at a million), so these samples reach every
   category an integer count can select. */
const WHOLE_NUMBER_SAMPLES: readonly number[] = [
	...Array.from({ length: 200 }, (_, index) => index),
	1e3,
	1e4,
	1e5,
	1e6,
	1e7,
	1e8,
	1e9,
];

/** The categories a family must carry in `locale`: `other` and every category a whole number selects. */
export function requiredPluralCategories(
	locale: string,
): readonly Intl.LDMLPluralRule[] {
	const rules = new Intl.PluralRules(locale);
	const selected = new Set<Intl.LDMLPluralRule>(['other']);
	for (const sample of WHOLE_NUMBER_SAMPLES) selected.add(rules.select(sample));
	return PLURAL_CATEGORIES.filter((category) => selected.has(category));
}

function pluralMember(
	bundle: TranslationBundleKeys,
	key: string,
): { readonly base: string; readonly category: string } | null {
	const dot = key.lastIndexOf('.');
	if (dot <= 0) return null;
	const category = key.slice(dot + 1);
	if (!(PLURAL_CATEGORIES as readonly string[]).includes(category)) return null;
	const base = key.slice(0, dot);
	return Object.hasOwn(bundle, base + '.other') ? { base, category } : null;
}

/** A bundle's keys, sorted, with each plural family folded into its base key so locales with different plural rules compare equal. */
export function translationKeys(
	bundle: TranslationBundleKeys,
): readonly string[] {
	const keys = new Set<string>();
	for (const key of Object.keys(bundle)) {
		keys.add(pluralMember(bundle, key)?.base ?? key);
	}
	return [...keys].sort();
}

/** Plural families in one locale's bundle that lack a category the locale needs or carry one it never selects. */
export function pluralFamilyIssues(
	bundle: TranslationBundleKeys,
	locale: string,
): readonly string[] {
	const families = new Map<string, Set<string>>();
	for (const key of Object.keys(bundle)) {
		const member = pluralMember(bundle, key);
		if (member === null) continue;
		const categories = families.get(member.base) ?? new Set<string>();
		categories.add(member.category);
		families.set(member.base, categories);
	}
	const required = requiredPluralCategories(locale);
	const known: readonly string[] = new Intl.PluralRules(
		locale,
	).resolvedOptions().pluralCategories;
	const issues: string[] = [];
	for (const base of [...families.keys()].sort()) {
		const categories = families.get(base)!;
		const missing = required.filter((category) => !categories.has(category));
		if (missing.length > 0) {
			issues.push(
				`${base} lacks ${missing.map((category) => base + '.' + category).join(', ')} for ${locale}`,
			);
		}
		for (const category of categories) {
			if (!known.includes(category)) {
				issues.push(`${base}.${category} is never selected for ${locale}`);
			}
		}
	}
	return issues;
}
