#!/usr/bin/env node
/* The module-rules gate measures a module an agent wrote against the
   specification it was built from. A check that fires on the platform's own
   twenty-two modules is a broken gate: it would train every author to ignore
   it, which is the failure mode the evaluation suite's own comment warns about.

   This runs the same conformance checks over modules/ so a new rule cannot
   reach a session until it holds for the code that already ships. Wired into
   verify:static next to reference:check and capabilities:check. */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	CONFORMANCE_CHECKS,
	PROVISIONAL_CHECKS,
	runChecks,
} from '../packages/sandbox/src/evals/checks.ts';

const MINIMUM_MODULES = 20;
const TEXT = /\.(ts|tsrx|mts|cts|sql|json|yaml|yml|md)$/;
const IGNORED = new Set(['node_modules', 'dist', '.turbo', '.git', 'coverage']);

/* The same read the gate performs. Inlined rather than imported so this script
   depends only on checks.ts, which has no imports of its own. */
async function moduleFiles(modulePath) {
	const files = new Map();
	const walk = async (directory) => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (IGNORED.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile() || !TEXT.test(entry.name)) continue;
			try {
				files.set(
					path
						.slice(modulePath.length + 1)
						.split('\\')
						.join('/'),
					await readFile(path, 'utf8'),
				);
			} catch {
				/* A file that cannot be read is left out, as the gate leaves it. */
			}
		}
	};
	await walk(modulePath);
	return files;
}

const root = resolve(process.argv[2] ?? process.cwd());
const modulesRoot = join(root, 'modules');
const entries = await readdir(modulesRoot, { withFileTypes: true });
const failures = [];
const provisional = [];
let measured = 0;

for (const entry of entries) {
	if (!entry.isDirectory()) continue;
	const modulePath = join(modulesRoot, entry.name);
	let spec;
	try {
		spec = await readFile(join(modulePath, 'spec', 'module.yaml'), 'utf8');
	} catch {
		continue;
	}
	measured += 1;
	const context = { files: await moduleFiles(modulePath), spec };
	for (const outcome of runChecks(CONFORMANCE_CHECKS, context)) {
		if (!outcome.passed)
			failures.push(`${entry.name}\n  ${outcome.id}: ${outcome.detail}`);
	}
	for (const outcome of runChecks(PROVISIONAL_CHECKS, context)) {
		if (!outcome.passed) provisional.push(`${entry.name}: ${outcome.id}`);
	}
}

if (measured < MINIMUM_MODULES) {
	console.error(
		`Expected at least ${MINIMUM_MODULES} modules under modules/, measured ${measured}.`,
	);
	process.exit(1);
}

if (failures.length > 0) {
	console.error(
		`${failures.length} module-rule check(s) fail on the shipped modules.\n` +
			"A rule that rejects the platform's own code is not ready to gate a session.\n\n" +
			`${failures.join('\n')}\n`,
	);
	process.exit(1);
}

console.log(
	`Conformance checks hold for all ${measured} shipped modules: ${CONFORMANCE_CHECKS.join(', ')}.`,
);
if (provisional.length > 0) {
	/* Reported, not fatal: these compare a specification id against whatever the
	   implementer called the thing, so a miss is a naming gap rather than proof
	   the promise was not kept. They are listed so the gap stays visible. */
	console.log(
		`Name-matching checks still disagree with shipped naming in ${provisional.length} place(s):`,
	);
	for (const entry of provisional) console.log(`  ${entry}`);
}
