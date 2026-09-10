import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	prepareRelease,
	preflight,
	publishRelease,
	validateVersion,
	verifyDirectory,
} from '../platform-release.mjs';

async function fixture(t, tagged = true) {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-release-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args) =>
		execFileSync('git', args, {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	git('init', '-b', 'main');
	git('config', 'user.name', 'Release test');
	git('config', 'user.email', 'release@example.invalid');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'tag.gpgsign', 'false');
	await mkdir(join(root, 'scripts'));
	await writeFile(join(root, '.gitignore'), 'release-artifacts/\n');
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ version: '0.1.0' }),
	);
	await writeFile(
		join(root, 'scripts/sdk-packages.json'),
		JSON.stringify(['flowdular']),
	);
	git('add', '.');
	git('commit', '-m', 'Initial foundation');
	if (tagged) git('tag', 'v0.1.0');
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ version: '0.2.0' }),
	);
	git('add', '.');
	git(
		'commit',
		'-m',
		'Release <ready>',
		'-m',
		'Complete details\n\nSecond paragraph with [brackets].',
	);
	const sdkDir = join(root, 'release-artifacts/sdk');
	await mkdir(join(sdkDir, 'package'), { recursive: true });
	await writeFile(
		join(sdkDir, 'package/package.json'),
		JSON.stringify({ name: 'flowdular', version: '0.2.0' }),
	);
	execFileSync('tar', ['-czf', 'flowdular-0.2.0.tgz', 'package'], {
		cwd: sdkDir,
	});
	await rm(join(sdkDir, 'package'), { recursive: true });
	const sdk = {
		schemaVersion: 1,
		packages: [
			{
				name: 'flowdular',
				version: '0.2.0',
				file: 'flowdular-0.2.0.tgz',
				sha256: createHash('sha256')
					.update(await readFile(join(sdkDir, 'flowdular-0.2.0.tgz')))
					.digest('hex'),
			},
		],
	};
	const saveSdk = () =>
		writeFile(join(sdkDir, 'sdk.json'), JSON.stringify(sdk));
	await saveSdk();
	const options = {
		root,
		version: '0.2.0',
		repository: 'Flowdular/flowdular',
		commit: git('rev-parse', 'HEAD'),
	};
	const output = join(root, 'release-artifacts/platform');
	return { root, git, sdk, sdkDir, saveSdk, options, output };
}

test('stable version input rejects flags, paths and prereleases', () => {
	for (const value of [
		'v0.2.0',
		'../0.2.0',
		'0.2.0-rc.1',
		'01.2.0',
		'--help',
		'0.2.0\n',
		undefined,
	])
		assert.throws(() => validateVersion(value));
	assert.equal(validateVersion('0.2.0'), '0.2.0');
});

test('release preserves full commit bodies, selected range and exact source', async (t) => {
	const f = await fixture(t);
	const release = await prepareRelease(f.options);
	assert.equal(release.previousTag, 'v0.1.0');
	await verifyDirectory(f.output, f.options);
	const changelog = await readFile(join(f.output, 'CHANGELOG.md'), 'utf8');
	assert.match(changelog, /Complete details/);
	assert.match(changelog, /Second paragraph/);
	assert.match(changelog, /Release &lt;ready&gt;/);
	assert.doesNotMatch(changelog, /Initial foundation/);
	const archived = execFileSync(
		'tar',
		[
			'-xOf',
			join(f.output, 'flowdular-0.2.0-source.tar.gz'),
			'flowdular-0.2.0/package.json',
		],
		{ encoding: 'utf8' },
	);
	assert.equal(JSON.parse(archived).version, '0.2.0');
	await assert.rejects(prepareRelease(f.options), /EEXIST/);
});

test('first release includes the entire history', async (t) => {
	const f = await fixture(t, false);
	await prepareRelease(f.options);
	assert.match(
		await readFile(join(f.output, 'CHANGELOG.md'), 'utf8'),
		/Initial foundation/,
	);
});

test('wrong version, dirty source, existing tag and invalid base are rejected', async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		preflight(f.root, '0.3.0'),
		/Commit the requested version/,
	);
	await assert.rejects(preflight(f.root, '0.2.0', 'v0.0.1'), /reachable/);
	await assert.rejects(
		prepareRelease({ ...f.options, commit: '0'.repeat(40) }),
		/checkout commit/,
	);
	await writeFile(join(f.root, 'uncommitted'), 'dirty');
	await assert.rejects(preflight(f.root, '0.2.0'), /clean committed/);
	await rm(join(f.root, 'uncommitted'));
	f.git('tag', 'v0.2.0');
	await assert.rejects(preflight(f.root, '0.2.0'), /already exists/);
});

test('altered packed bytes cannot be released', async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.sdkDir, f.sdk.packages[0].file), 'tampered');
	await assert.rejects(prepareRelease(f.options), /Package bytes changed/);
});

test('package identity and version must match the declared release', async (t) => {
	const f = await fixture(t);
	f.sdk.packages[0].version = '0.2.0-rc.1';
	await f.saveSdk();
	await assert.rejects(prepareRelease(f.options), /stable SemVer/);
	f.sdk.packages[0].version = '0.2.0';
	f.sdk.packages[0].name = 'unexpected';
	await f.saveSdk();
	await assert.rejects(prepareRelease(f.options), /public package set/);
});

test('path traversal and symbolic links are rejected', async (t) => {
	const f = await fixture(t);
	f.sdk.packages[0].file = '../outside.tgz';
	await f.saveSdk();
	await assert.rejects(prepareRelease(f.options), /Unsafe release filename/);
	f.sdk.packages[0].file = 'link.tgz';
	await f.saveSdk();
	await symlink('flowdular-0.2.0.tgz', join(f.sdkDir, 'link.tgz'));
	await assert.rejects(prepareRelease(f.options), /not a regular file/);
});

test('verification rejects tampering, extra files and a different source SHA', async (t) => {
	const f = await fixture(t);
	await prepareRelease(f.options);
	await assert.rejects(
		verifyDirectory(f.output, { ...f.options, commit: '0'.repeat(40) }),
		/selected source/,
	);
	await writeFile(join(f.output, 'extra.txt'), 'extra');
	await assert.rejects(
		verifyDirectory(f.output, f.options),
		/Unexpected release asset/,
	);
	await rm(join(f.output, 'extra.txt'));
	await writeFile(join(f.output, 'CHANGELOG.md'), 'tampered');
	await assert.rejects(
		verifyDirectory(f.output, f.options),
		/Checksum mismatch/,
	);
});

async function signedFixture(t) {
	const f = await fixture(t);
	await prepareRelease(f.options);
	// Transport tests only; the workflow cryptographically verifies the real bundle.
	await writeFile(join(f.output, 'SHA256SUMS.sigstore.json'), '{}');
	return f;
}

test('publication uploads into a draft before making the release public', async (t) => {
	const f = await signedFixture(t),
		calls = [];
	await publishRelease(f.output, f.options, (args) => calls.push(args));
	assert.deepEqual(
		calls.map((args) => args.slice(0, 2)),
		[
			['api', 'repos/Flowdular/flowdular/git/refs'],
			['release', 'create'],
			['release', 'upload'],
			['release', 'edit'],
		],
	);
	assert.ok(calls[1].includes('--draft'));
	assert.ok(
		calls[2].some((value) => value.endsWith('/SHA256SUMS.sigstore.json')),
	);
	assert.ok(calls[3].includes('--draft=false'));
});

test('draft selection never publishes', async (t) => {
	const f = await signedFixture(t),
		calls = [];
	await publishRelease(f.output, { ...f.options, draft: true }, (args) =>
		calls.push(args),
	);
	assert.equal(calls.length, 3);
	assert.equal(calls.at(-1)[1], 'upload');
});

test('failed upload leaves a draft, existing ref stops before release creation', async (t) => {
	const f = await signedFixture(t),
		calls = [];
	await assert.rejects(
		publishRelease(f.output, f.options, (args) => {
			calls.push(args);
			if (args[1] === 'upload') throw new Error('Upload failed');
		}),
		/Upload failed/,
	);
	assert.equal(calls.length, 3);
	calls.length = 0;
	await assert.rejects(
		publishRelease(f.output, f.options, (args) => {
			calls.push(args);
			throw new Error('Ref already exists');
		}),
		/Ref already exists/,
	);
	assert.equal(calls.length, 1);
});

test('missing signature prevents all remote writes', async (t) => {
	const f = await fixture(t);
	await prepareRelease(f.options);
	let writes = 0;
	await assert.rejects(
		publishRelease(f.output, f.options, () => writes++),
		/ENOENT/,
	);
	assert.equal(writes, 0);
});

test('a matching manifest hash cannot hide a different packed package identity', async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.sdkDir, 'package'));
	await writeFile(
		join(f.sdkDir, 'package/package.json'),
		JSON.stringify({ name: 'another-package', version: '0.2.0' }),
	);
	execFileSync('tar', ['-czf', f.sdk.packages[0].file, 'package'], {
		cwd: f.sdkDir,
	});
	f.sdk.packages[0].sha256 = createHash('sha256')
		.update(await readFile(join(f.sdkDir, f.sdk.packages[0].file)))
		.digest('hex');
	await f.saveSdk();
	await assert.rejects(prepareRelease(f.options), /Packed identity mismatch/);
});

test('removing a required asset from checksums is rejected', async (t) => {
	const f = await fixture(t);
	await prepareRelease(f.options);
	const path = join(f.output, 'SHA256SUMS');
	const sums = await readFile(path, 'utf8');
	await writeFile(
		path,
		sums
			.split('\n')
			.filter((line) => !line.endsWith('  CHANGELOG.md'))
			.join('\n'),
	);
	await assert.rejects(
		verifyDirectory(f.output, f.options),
		/Unsigned asset: CHANGELOG.md/,
	);
});

test('independently versioned companion packages retain their exact version', async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.sdkDir, 'package'));
	await writeFile(
		join(f.sdkDir, 'package/package.json'),
		JSON.stringify({ name: 'flowdular', version: '0.2.1' }),
	);
	execFileSync('tar', ['-czf', f.sdk.packages[0].file, 'package'], {
		cwd: f.sdkDir,
	});
	f.sdk.packages[0].version = '0.2.1';
	f.sdk.packages[0].sha256 = createHash('sha256')
		.update(await readFile(join(f.sdkDir, f.sdk.packages[0].file)))
		.digest('hex');
	await f.saveSdk();
	await prepareRelease(f.options);
	const release = await verifyDirectory(f.output, f.options);
	assert.equal(release.version, '0.2.0');
	assert.equal(release.packages[0].version, '0.2.1');
	assert.match(
		await readFile(join(f.output, 'RELEASE-NOTES.md'), 'utf8'),
		/\| flowdular \| 0.2.1 \|/,
	);
});

test('SDK version must match the platform release', async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.root, 'scripts/sdk-packages.json'),
		JSON.stringify(['@flowdular/sdk']),
	);
	f.git('add', '.');
	f.git('commit', '-m', 'Declare SDK package');
	f.options.commit = f.git('rev-parse', 'HEAD');
	f.sdk.packages[0].name = '@flowdular/sdk';
	f.sdk.packages[0].version = '0.1.0';
	await f.saveSdk();
	await assert.rejects(prepareRelease(f.options), /version or digest mismatch/);
});
