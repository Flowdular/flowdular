#!/usr/bin/env node
/* Several task skills and examples cite an invariant by its number in AGENTS.md.
   The numbers were wrong once already: an example about tenant identity pointed
   at rule 6, which is background work, when the rule is 4. A citation that names
   a rule which no longer exists, or which is out of range, sends a reviewer or
   an author to the wrong instruction. This checks that every cited number is a
   rule the current list actually has. */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const rulesPath = join(root, '.ai', 'rules', 'flowdular.md');

const rules = await readFile(rulesPath, 'utf8');
const declared = new Set(
	[...rules.matchAll(/^(\d+)\.\s/gm)].map((match) => Number(match[1])),
);
if (declared.size === 0) {
	console.error(
		`${rulesPath} lists no numbered rules; the citation check cannot run.`,
	);
	process.exit(1);
}

async function* filesUnder(directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* filesUnder(path);
		else if (entry.isFile() && entry.name.endsWith('.md')) yield path;
	}
}

const CITATION = /AGENTS\.md`?\s+(\d+)/g;
const problems = [];
let citations = 0;

for await (const path of filesUnder(join(root, '.ai'))) {
	const text = await readFile(path, 'utf8');
	for (const match of text.matchAll(CITATION)) {
		citations += 1;
		const number = Number(match[1]);
		if (!declared.has(number)) {
			const line = text.slice(0, match.index).split('\n').length;
			problems.push(
				`${path.slice(root.length + 1)}:${line} cites rule ${number}, which the current list does not have`,
			);
		}
	}
}

if (problems.length > 0) {
	console.error(
		`${problems.length} rule citation(s) point at an invariant that does not exist:\n` +
			`${problems.map((line) => `  ${line}`).join('\n')}\n` +
			`The list in ${rulesPath.slice(root.length + 1)} numbers rules 1 to ${Math.max(...declared)}.\n`,
	);
	process.exit(1);
}

console.log(
	citations === 0
		? 'No rule citations to check.'
		: `All ${citations} AGENTS.md rule citations name a rule that exists (1 to ${Math.max(...declared)}).`,
);
