// Checks that every class name a screen or a design preview writes by hand is
// declared by a stylesheet in this workspace. A name nothing declares compiles,
// passes its tests and renders unstyled, so nothing else catches it.
// Run: node scripts/ui-classes.mjs --check
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import baseline from './ui-classes-baseline.json' with { type: 'json' };
import {
	declaredClassNames,
	unknownClassNames,
	usedClassNames,
} from '../packages/cli/src/ui-classes.ts';

const root = new URL('..', import.meta.url).pathname;
const SKIP = new Set([
	'node_modules',
	'dist',
	'.flowdular',
	'.coreloom',
	'.git',
	'.claude',
]);

async function filesUnder(directory, extensions) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const entry of entries) {
		if (SKIP.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory())
			files.push(...(await filesUnder(path, extensions)));
		else if (extensions.some((extension) => entry.name.endsWith(extension)))
			files.push(path);
	}
	return files;
}

const trees = ['packages', 'modules', 'platform'].map((directory) =>
	join(root, directory),
);
const stylesheets = (
	await Promise.all(trees.map((tree) => filesUnder(tree, ['.css'])))
).flat();
/* One set for the whole workspace. The question here is whether a name exists
   at all; which package may declare it is the design system's rule and a
   reviewer's call, not this check's. */
const declared = new Set();
for (const sheet of stylesheets) {
	for (const name of declaredClassNames(await readFile(sheet, 'utf8')))
		declared.add(name);
}

const sources = (
	await Promise.all([
		...trees.map((tree) => filesUnder(tree, ['.tsrx'])),
		filesUnder(join(root, 'modules'), ['.html']),
		filesUnder(join(root, '.ai'), ['.html']),
	])
).flat();

const findings = [];
const obsolete = [];
for (const file of sources) {
	const relativePath = relative(root, file);
	/* The pinned catalog reference changes only with an official release, and
	   the scaffold template ships without the workspace's stylesheets. */
	if (
		/* Tests build markup to drive a query, not to be looked at. */
		relativePath.includes('/tests/') ||
		relativePath.includes('.test.') ||
		relativePath.startsWith('.ai/references/') ||
		relativePath.includes('create-flowdular/template/') ||
		relativePath.includes('create-flowdular/agent-template/')
	)
		continue;
	const source = await readFile(file, 'utf8');
	const allowed = new Set(baseline[relativePath] ?? []);
	for (const found of unknownClassNames(usedClassNames(source), declared)) {
		if (allowed.delete(found.name)) continue;
		findings.push(`${relativePath}:${found.line} ${found.name}`);
	}
	/* The baseline shrinks as the markers it records are deleted or declared.
	   A line that no longer matches anything is reported so it cannot rot. */
	for (const stale of allowed) obsolete.push(`${relativePath} ${stale}`);
}

if (findings.length > 0) {
	console.log(findings.join('\n'));
	console.error(
		`${findings.length} class ${findings.length === 1 ? 'name is' : 'names are'} declared by no stylesheet. Use a primitive from packages/ui, or declare the class in the module's own CSS.`,
	);
	process.exit(1);
}
if (obsolete.length > 0) {
	console.log(obsolete.join('\n'));
	console.error(
		`${obsolete.length} baseline ${obsolete.length === 1 ? 'entry names a class' : 'entries name classes'} the source no longer writes. Delete the ${obsolete.length === 1 ? 'line' : 'lines'} from scripts/ui-classes-baseline.json.`,
	);
	process.exit(1);
}
const recorded = Object.values(baseline).reduce(
	(total, names) => total + names.length,
	0,
);
console.log(
	`Every hand-written class is declared: ${declared.size} classes across ${stylesheets.length} stylesheets, with ${recorded} unstyled markers held in the baseline.`,
);
