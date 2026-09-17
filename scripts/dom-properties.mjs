// Checks (or with --fix renames) DOM property names Octane expects in camelCase
// on host elements in the TSRX sources of packages, modules and the platform.
// Tests are skipped (they may build raw HTML strings), and so is the pinned
// catalog reference, which changes only with an official catalog release.
// Run: node scripts/dom-properties.mjs --check | --fix
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
	domPropertyMisspellings,
	fixDomPropertyMisspellings,
} from '../packages/cli/src/dom-properties.ts';

const root = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'dist', '.flowdular', '.git']);

async function tsrxFiles(directory) {
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
		if (entry.isDirectory()) files.push(...(await tsrxFiles(path)));
		else if (entry.name.endsWith('.tsrx')) files.push(path);
	}
	return files;
}

const fix = process.argv.includes('--fix');
const files = (
	await Promise.all(
		['packages', 'modules', 'platform'].map((directory) =>
			tsrxFiles(join(root, directory)),
		),
	)
)
	.flat()
	.filter((file) => relative(root, file).split('/').includes('src'));
const findings = [];
for (const file of files) {
	const source = await readFile(file, 'utf8');
	const misspelled = domPropertyMisspellings(source);
	if (misspelled.length === 0) continue;
	if (fix) await writeFile(file, fixDomPropertyMisspellings(source));
	for (const found of misspelled)
		findings.push(
			`${relative(root, file)}:${found.line} ${found.name} -> ${found.expected}`,
		);
}
if (findings.length > 0) {
	console.log(findings.join('\n'));
	if (!fix) {
		console.error(
			`${findings.length} DOM properties use a spelling Octane rejects. Run node scripts/dom-properties.mjs --fix.`,
		);
		process.exit(1);
	}
	console.log(`Renamed ${findings.length} DOM properties.`);
}
