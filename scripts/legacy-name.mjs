// Flowdular 0.6 renamed every identifier that still carried the pre-rename
// product name: database roles, the tenant setting, the migration ledger and
// cookies. A name that creeps back in is either a stale document or a database
// identifier the platform no longer creates. Only the files below may keep it.
// Run: node scripts/legacy-name.mjs --check
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const LEGACY_NAME = 'coreloom';
const ALLOWED = [
	// The refused pre-0.6 ledger and the tests that prove the refusal.
	'packages/database/src/migrations.ts',
	'packages/database-testing/tests/pglite-migrations.test.ts',
	'packages/cli/tests/legacy-database.test.ts',
	'packages/cli/tests/vercel-launch.test.ts',
	'docs/flowdular-rename.md',
	'scripts/legacy-name.mjs',
	// Pre-0.6 state in the old directory holds keys, so Git, Docker and
	// Vercel ignore it.
	'.gitignore',
	'.dockerignore',
	'.vercelignore',
];
const ALLOWED_TREES = ['docs/reviews/'];

function allowed(path) {
	return (
		ALLOWED.includes(path) ||
		ALLOWED_TREES.some((prefix) => path.startsWith(prefix))
	);
}

function git(args) {
	try {
		return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	} catch (error) {
		// git grep exits 1 when nothing matches.
		if (error.status === 1 && !error.stderr) return '';
		throw new Error(
			`The legacy name check needs a git checkout: ${error.message}`,
		);
	}
}

const findings = [];
for (const line of git([
	'grep',
	'-n',
	'-i',
	'-a',
	'-o',
	'-P',
	'--untracked',
	'-e',
	`[\\w.-]*${LEGACY_NAME}[\\w.-]*`,
]).split('\n')) {
	const match = /^(.*?):(\d+):(.*)$/.exec(line);
	if (!match || allowed(match[1])) continue;
	findings.push(`${match[1]}:${match[2]}: ${match[3]}`);
}
for (const path of git([
	'ls-files',
	'--cached',
	'--others',
	'--exclude-standard',
]).split('\n')) {
	if (path.toLowerCase().includes(LEGACY_NAME) && !allowed(path))
		findings.push(`${path}: path`);
}

if (findings.length > 0) {
	console.log(findings.join('\n'));
	console.error(
		`The pre-rename name appears ${findings.length} ${findings.length === 1 ? 'time' : 'times'} outside its allowlist. Use the flowdular identifiers; see docs/flowdular-rename.md.`,
	);
	process.exit(1);
}
console.log('The pre-rename name appears only in its allowlisted files.');
