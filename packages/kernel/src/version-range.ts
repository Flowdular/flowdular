/* The version and range arithmetic the module registry needs, written here
   rather than taken from `semver`: the kernel barrel is evaluated in the
   browser (see tests/browser-safe-barrel.test.ts), and that package is
   CommonJS, which a generated application cannot load through Vite without
   pre-bundling it by hand. Releases are stable `x.y.z` (the release workflow
   refuses a prerelease), so this carries no prerelease or build metadata. */

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

export type Version = readonly [number, number, number];

export function parseVersion(value: string): Version | null {
	const found = VERSION.exec(value.trim());
	return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}

/** Negative when left is older, 0 when equal, positive when left is newer. */
export function compareVersions(left: Version, right: Version): number {
	for (let part = 0; part < 3; part += 1) {
		if (left[part]! !== right[part]!) return left[part]! - right[part]!;
	}
	return 0;
}

/* `^1.2.3` keeps the leftmost non-zero part, so `^0.8.0` stops at 0.9.0 and
   `^0.0.3` at 0.0.4; `~1.2.3` always stops at the next minor. */
function upperBound(prefix: '^' | '~', version: Version): Version {
	const [major, minor] = version;
	if (prefix === '~') return [major, minor + 1, 0];
	if (major > 0) return [major + 1, 0, 0];
	if (minor > 0) return [major, minor + 1, 0];
	return [major, minor, version[2] + 1];
}

function comparatorMatches(version: Version, comparator: string): boolean {
	const found = COMPARATOR.exec(comparator);
	if (!found) return false;
	const operator = found[1] ?? '=';
	const bound = parseVersion(found[2]!);
	if (!bound) return false;
	const order = compareVersions(version, bound);
	switch (operator) {
		case '^':
		case '~':
			return (
				order >= 0 && compareVersions(version, upperBound(operator, bound)) < 0
			);
		case '>=':
			return order >= 0;
		case '<=':
			return order <= 0;
		case '>':
			return order > 0;
		case '<':
			return order < 0;
		default:
			return order === 0;
	}
}

function comparators(range: string): readonly (readonly string[])[] | null {
	const alternatives = range.split('||').map((part) => part.trim());
	const parsed: (readonly string[])[] = [];
	for (const alternative of alternatives) {
		if (alternative === '' || alternative === '*') {
			parsed.push([]);
			continue;
		}
		const terms = alternative.split(/\s+/);
		for (const term of terms) {
			const found = COMPARATOR.exec(term);
			if (!found || parseVersion(found[2]!) === null) return null;
		}
		parsed.push(terms);
	}
	return parsed;
}

/** Whether the range is one this platform accepts: `*`, an exact version, `^`, `~` or a comparator, joined by spaces and `||`. */
export function isValidRange(range: string): boolean {
	return comparators(range) !== null;
}

export function rangeSatisfies(version: string, range: string): boolean {
	const parsed = parseVersion(version);
	const alternatives = comparators(range);
	if (!parsed || !alternatives) return false;
	return alternatives.some((terms) =>
		terms.every((term) => comparatorMatches(parsed, term)),
	);
}

export function nextVersion(
	version: string,
	level: 'patch' | 'minor' | 'major',
): string | null {
	const parsed = parseVersion(version);
	if (!parsed) return null;
	const [major, minor, patch] = parsed;
	if (level === 'major') return `${major + 1}.0.0`;
	if (level === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}
