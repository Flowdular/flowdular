import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePreviewArguments } from '../../packages/cli/src/ui-preview-args.ts';

test('a fragment on its own is the whole call', () => {
	const invocation = parsePreviewArguments(['modules/x/design/list.html']);
	assert.equal(invocation.fragment, 'modules/x/design/list.html');
	assert.equal(invocation.refusal, null);
	assert.equal(invocation.shot, null);
	assert.equal(invocation.open, false);
	assert.equal(invocation.scaffold, false);
});

test('the value of --shot is a file, never the fragment', () => {
	const invocation = parsePreviewArguments([
		'modules/x/design/list.html',
		'--shot',
		'out/list.png',
	]);
	assert.equal(invocation.fragment, 'modules/x/design/list.html');
	assert.equal(invocation.shot, 'out/list.png');
});

test('--shot after the flags still finds the fragment before them', () => {
	const invocation = parsePreviewArguments([
		'--open',
		'modules/x/design/list.html',
		'--shot',
		'out/list.png',
	]);
	assert.equal(invocation.fragment, 'modules/x/design/list.html');
	assert.equal(invocation.shot, 'out/list.png');
	assert.equal(invocation.open, true);
});

test('--scaffold names the fragment it writes', () => {
	const invocation = parsePreviewArguments([
		'--scaffold',
		'modules/x/design/list.html',
	]);
	assert.equal(invocation.scaffold, true);
	assert.equal(invocation.fragment, 'modules/x/design/list.html');
	assert.equal(invocation.refusal, null);
});

test('a call that names no fragment is refused rather than guessed', () => {
	assert.equal(
		parsePreviewArguments([]).refusal,
		'Name the fragment to render.',
	);
	assert.equal(
		parsePreviewArguments(['--open']).refusal,
		'Name the fragment to render.',
	);
});

test('--shot without a file is refused, and so is a flag in its place', () => {
	assert.equal(
		parsePreviewArguments(['a.html', '--shot']).refusal,
		'--shot needs a file to write.',
	);
	assert.equal(
		parsePreviewArguments(['a.html', '--shot', '--open']).refusal,
		'--shot needs a file to write.',
	);
});

test('scaffolding writes a file and renders nothing, so the two do not mix', () => {
	assert.match(
		parsePreviewArguments(['--scaffold', 'a.html', '--open']).refusal ?? '',
		/render it in a second call/,
	);
});
