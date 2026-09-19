import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	RELEASE_VERSION_SITES,
	ROOT_VERSION_SITE,
	releaseVersionDrift,
} from '../../packages/cli/src/release-versions.ts';

const root = new URL('../../', import.meta.url);

function workspaceSources() {
	const sources = new Map();
	for (const site of RELEASE_VERSION_SITES) {
		sources.set(site.path, readFileSync(new URL(site.path, root), 'utf8'));
	}
	return sources;
}

function workspaceVersion() {
	const source = readFileSync(new URL(ROOT_VERSION_SITE.path, root), 'utf8');
	const version = ROOT_VERSION_SITE.pattern.exec(source)?.[1];
	assert.ok(version, 'the workspace names no version');
	return version;
}

test('every site this table names carries the workspace version', () => {
	assert.deepEqual(
		releaseVersionDrift(workspaceVersion(), workspaceSources()),
		[],
	);
});

test('every pattern still finds a version in the file it names', () => {
	/* A file that changed shape leaves its pattern matching nothing, which is
	   how a pin stops being watched without anyone noticing. */
	const impossible = releaseVersionDrift(
		'0.0.0-not-a-version',
		workspaceSources(),
	);
	assert.equal(impossible.length, RELEASE_VERSION_SITES.length);
	for (const finding of impossible) {
		assert.match(
			finding.message,
			/ is \S+, and the workspace is at /,
			`${finding.path} matched nothing, so its pattern no longer fits the file`,
		);
	}
});

test('a pin left behind is named with what it is and what it should be', () => {
	const [site] = RELEASE_VERSION_SITES;
	const findings = releaseVersionDrift(
		'0.5.0',
		new Map([[site.path, '{ "version": "0.4.2" }']]),
		[site],
	);
	assert.equal(findings.length, 1);
	assert.match(
		findings[0].message,
		/is 0\.4\.2, and the workspace is at 0\.5\.0/,
	);
});

test('a file whose shape moved on is a finding, not a silent pass', () => {
	const [site] = RELEASE_VERSION_SITES;
	const findings = releaseVersionDrift(
		'0.5.0',
		new Map([[site.path, '{ "name": "sdk" }']]),
		[site],
	);
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /was not found/);
});

test('a file that cannot be read is a finding too', () => {
	const [site] = RELEASE_VERSION_SITES;
	const findings = releaseVersionDrift('0.5.0', new Map(), [site]);
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /was not read/);
});
