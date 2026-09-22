// Launches the evaluation suite under the workspace TypeScript runner. The
// suite reaches the sandbox server graph, which spans several workspace
// packages, and Node's own strip-only mode refuses syntax some of them use, so
// the entry point runs through tsx exactly as the CLI's own dev script does.
//
// Run: node scripts/eval.mjs [--case <id>] [--json]
//      node scripts/eval.mjs --approve <id> --apply --confirm approve-<id>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(join(root, 'packages', 'cli', 'index.js'));
const entry = join(root, 'packages', 'sandbox', 'src', 'evals', 'cli.ts');

const child = spawn(
	process.execPath,
	[require.resolve('tsx/cli'), entry, ...process.argv.slice(2)],
	{ stdio: 'inherit', cwd: process.cwd() },
);
child.once('close', (code) => process.exit(code ?? 1));
