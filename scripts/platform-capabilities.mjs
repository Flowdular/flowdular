import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The capability card is what an agent reads instead of scanning the repository,
   so every closed list in it has to be the code's list. This check compares the
   three lists that change on their own: the shared UI exports, the navigation
   groups and the workspace slots. */

const root = fileURLToPath(new URL('..', import.meta.url));
const cardPath = join(root, '.ai/platform-capabilities.md');
const uiIndexPath = join(root, 'packages/ui/src/index.ts');
const contributionsPath = join(root, 'packages/client/src/contributions.ts');

/* Names between <!-- capabilities:<id> --> and its closing marker, taken from
   the backticked tokens so Prettier may rewrap the block freely. */
function cardList(card, id) {
	const block = new RegExp(
		`<!-- capabilities:${id} -->([\\s\\S]*?)<!-- /capabilities:${id} -->`,
	).exec(card);
	if (!block) throw new Error(`The capability card has no ${id} block.`);
	const names = [...block[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
	if (names.length === 0)
		throw new Error(`The capability card ${id} block lists nothing.`);
	return names;
}

/* Value exports only: a type-only export is not a capability a module can use. */
function valueExports(source) {
	const names = [];
	for (const clause of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
		if (clause[1]) continue;
		for (const entry of clause[2].split(',')) {
			const name = entry
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (!name || name.startsWith('type ')) continue;
			names.push(name);
		}
	}
	if (names.length === 0)
		throw new Error(`No value exports found in ${uiIndexPath}.`);
	return names;
}

function stringArray(source, name) {
	const literal = new RegExp(
		`export const ${name} = \\[([\\s\\S]*?)\\] as const;`,
	).exec(source);
	if (!literal) throw new Error(`${name} is not an as-const array literal.`);
	return [...literal[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function stringUnion(source, name) {
	const declaration = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(
		source,
	);
	if (!declaration) throw new Error(`${name} is not an exported type alias.`);
	return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function compare(label, card, code) {
	const missing = code.filter((name) => !card.includes(name));
	const extra = card.filter((name) => !code.includes(name));
	const problems = [];
	if (missing.length > 0)
		problems.push(`missing from the card: ${missing.join(', ')}`);
	if (extra.length > 0)
		problems.push(`in the card but not in the code: ${extra.join(', ')}`);
	if (problems.length > 0)
		throw new Error(`${label} drifted (${problems.join('; ')}).`);
	return code.length;
}

if (!process.argv.includes('--check'))
	throw new Error('Use scripts/platform-capabilities.mjs --check.');

const [card, uiIndex, contributions] = await Promise.all([
	readFile(cardPath, 'utf8'),
	readFile(uiIndexPath, 'utf8'),
	readFile(contributionsPath, 'utf8'),
]);

const counts = [
	compare('The shared UI export list', cardList(card, 'ui-exports'), [
		...valueExports(uiIndex),
	]),
	compare(
		'The navigation group list',
		cardList(card, 'navigation-groups'),
		stringUnion(contributions, 'NavigationGroup'),
	),
	compare(
		'The workspace slot list',
		cardList(card, 'workspace-slots'),
		stringArray(contributions, 'WORKSPACE_SLOTS'),
	),
];

console.log(
	`Capability card matches the code: ${counts[0]} UI exports, ${counts[1]} navigation groups, ${counts[2]} workspace slots.`,
);
