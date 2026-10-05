import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

const script = new URL('../legacy-name.mjs', import.meta.url);
// Read from the script so this file does not need an allowlist entry.
const legacyName = /const LEGACY_NAME = '([^']+)'/.exec(
	readFileSync(script, 'utf8'),
)[1];

let workspace;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'flowdular-legacy-name-'));
	mkdirSync(join(workspace, 'scripts'));
	copyFileSync(script, join(workspace, 'scripts/legacy-name.mjs'));
	spawnSync('git', ['init', '-q'], { cwd: workspace });
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function write(path, content) {
	mkdirSync(dirname(join(workspace, path)), { recursive: true });
	writeFileSync(join(workspace, path), content);
}

function check() {
	const result = spawnSync(
		process.execPath,
		['scripts/legacy-name.mjs', '--check'],
		{ cwd: workspace, encoding: 'utf8' },
	);
	return { status: result.status, findings: result.stdout };
}

test('passes a workspace that never names the old product', () => {
	write('README.md', '# Flowdular\n');

	assert.equal(check().status, 0);
});

test('reports an untracked file that names the old product in any case', () => {
	write('docs/notes.md', `intro\nSET ${legacyName.toUpperCase()}.tenant_id\n`);

	const { status, findings } = check();
	assert.equal(status, 1);
	assert.match(findings, /^docs\/notes\.md:2: /m);
});

test('reports a path that carries the old name', () => {
	write(`docs/${legacyName}-notes.md`, 'renamed\n');

	const { status, findings } = check();
	assert.equal(status, 1);
	assert.ok(findings.includes(`docs/${legacyName}-notes.md: path`));
});

/* The old state directory holds keys. While .gitignore names it, nothing in
   it reaches a commit, so the check must not ask anyone to read it. */
test('accepts the ignore entry and skips the directory it ignores', () => {
	write('.gitignore', `.${legacyName}/\n`);
	write(`.${legacyName}/sandbox/secret.key`, `${legacyName}\n`);

	assert.equal(check().status, 0);
});
