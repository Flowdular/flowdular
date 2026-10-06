import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { migrationIdentifierIssues } from '@flowdular/database';
import {
	CONFORMANCE_CHECKS,
	runChecks,
	type CheckId,
} from '../evals/checks.ts';
import type { GateIssue } from './gates.ts';

/* The deterministic rules that used to exist only inside the evaluation suite.
   They were written, reviewed and cheap, and ran nowhere on the delivery path,
   which left the exact defects they describe reachable at eject.

   The second group is conformance. A specification is called a contract only if
   something checks the build against it, and until now nothing did: the gates
   measured types and tests, never the promises the operator approved. */
const CHECKS: readonly CheckId[] = [
	'permissions-declared',
	'endpoints-declare-permission',
	'tenant-not-from-request',
	'rls-forced',
	'migrations-mirrored',
	'locales-complete',
	'no-sql-interpolation',
	...CONFORMANCE_CHECKS,
];

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 2_000_000;
const SOURCE = /\.(ts|tsrx|mts|cts|sql|json|yaml|yml|md)$/;
const IGNORED_DIRECTORIES = new Set([
	'node_modules',
	'dist',
	'.turbo',
	'.git',
	'coverage',
]);

interface RuleOutcome {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
	readonly paths?: readonly string[];
}

/* A migration copied from an older release names a role or tenant setting the
   platform no longer creates: it fails on apply, or its policy sees no tenant.
   It runs here rather than among the evaluation checks, which stay free of
   imports for the conformance script. */
function migrationIdentifiers(files: ReadonlyMap<string, string>): RuleOutcome {
	const findings: string[] = [];
	const paths = new Set<string>();
	for (const [path, text] of files) {
		if (!path.includes('migrations/') || !path.endsWith('.up.sql')) continue;
		for (const issue of migrationIdentifierIssues(text)) {
			findings.push(`${path}: ${issue.message}`);
			paths.add(path);
		}
	}
	return {
		id: 'migration-identifiers',
		passed: findings.length === 0,
		detail:
			findings.length === 0
				? 'Migrations name only the flowdular roles and tenant setting.'
				: findings.join(' '),
		...(paths.size > 0 ? { paths: [...paths] } : {}),
	};
}

export interface ModuleRulesReport {
	readonly passed: boolean;
	readonly output: string;
	/* One error per failed rule, at the first file its fix goes in, so a
	   repair reaches a role that may write that file. */
	readonly issues: readonly GateIssue[];
}

async function collectFiles(
	directory: string,
	root: string,
	found: Map<string, string>,
): Promise<void> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (found.size >= MAX_FILES) return;
		if (IGNORED_DIRECTORIES.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(path, root, found);
			continue;
		}
		if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
		const info = await stat(path);
		if (info.size > MAX_FILE_BYTES) continue;
		try {
			found.set(
				path
					.slice(root.length + 1)
					.split(/[\\/]/)
					.join('/'),
				await readFile(path, 'utf8'),
			);
		} catch {
			/* A file that cannot be read is left out rather than failing the gate
			   on a permission problem the agent did not cause. */
		}
	}
}

/* Reads the module the way the checks expect, then reports every rule that
   failed. A check that abstains says so in its detail and is not a failure, so
   a headless module is not told to grow an endpoint. */
export async function checkModuleRules(input: {
	readonly modulePath: string;
	readonly spec: string;
}): Promise<ModuleRulesReport> {
	const files = new Map<string, string>();
	await collectFiles(input.modulePath, input.modulePath, files);
	const outcomes: readonly RuleOutcome[] = [
		...runChecks(CHECKS, { files, spec: input.spec }),
		migrationIdentifiers(files),
	];
	const failures = outcomes.filter((outcome) => !outcome.passed);
	const lines = outcomes.map(
		(outcome) =>
			`${outcome.passed ? 'pass' : 'FAIL'} ${outcome.id}: ${outcome.detail}`,
	);
	return {
		passed: failures.length === 0,
		output: [
			failures.length === 0
				? `All ${outcomes.length} module rules hold.`
				: `${failures.length} of ${outcomes.length} module rules failed.`,
			...lines,
		].join('\n'),
		issues: failures.map((outcome) => ({
			code: outcome.id,
			...(outcome.paths?.[0] ? { path: outcome.paths[0] } : {}),
			message: outcome.detail.slice(0, 500),
		})),
	};
}
