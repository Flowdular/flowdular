import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFile,
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
function git(root, args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	}).trimEnd();
}
export function validateVersion(value) {
	if (typeof value !== 'string' || value.length > 60 || !VERSION.test(value))
		throw new Error(
			'Release version must be stable SemVer: X.Y.Z, without a v prefix',
		);
	return value;
}
function older(a, b) {
	const left = a.split('.').map(BigInt),
		right = b.split('.').map(BigInt);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] < right[i];
	}
	return false;
}
function safeName(name) {
	if (typeof name !== 'string' || !FILE.test(name) || basename(name) !== name)
		throw new Error('Unsafe release filename');
	return name;
}
async function regularBytes(path) {
	if (!(await lstat(path)).isFile())
		throw new Error(`Release asset is not a regular file: ${path}`);
	return readFile(path);
}
const escape = (text) =>
	text
		.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
		.replace(/[\\`*_\[\]]/g, '\\$&');
export async function preflight(root, version, previousTag = '') {
	validateVersion(version);
	if ((await json(join(root, 'package.json'))).version !== version)
		throw new Error(
			'Commit the requested version in package.json before releasing',
		);
	if (git(root, ['status', '--porcelain', '--untracked-files=normal']))
		throw new Error('Release source must be a clean committed checkout');
	const commit = git(root, ['rev-parse', 'HEAD']);
	const tags = git(root, ['tag', '--merged', 'HEAD', '--sort=-version:refname'])
		.split('\n')
		.filter(Boolean);
	const allTags = git(root, ['tag', '--list', `v${version}`]);
	if (allTags)
		throw new Error(
			`Tag v${version} already exists; releases are never overwritten`,
		);
	if (previousTag) {
		validateVersion(previousTag.slice(1));
		if (
			!previousTag.startsWith('v') ||
			!tags.includes(previousTag) ||
			!older(previousTag.slice(1), version)
		)
			throw new Error(
				'Previous tag must be an older stable release reachable from HEAD',
			);
	} else
		previousTag =
			tags.find(
				(t) =>
					t.startsWith('v') &&
					VERSION.test(t.slice(1)) &&
					older(t.slice(1), version),
			) ?? '';
	return { version, tag: `v${version}`, commit, previousTag };
}
export async function prepareRelease({
	root,
	version,
	repository,
	previousTag = '',
	commit,
	output = join(root, 'release-artifacts/platform'),
}) {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
		throw new Error('Invalid GitHub repository');
	const release = await preflight(root, version, previousTag);
	if (commit && release.commit !== commit)
		throw new Error('Unexpected checkout commit');
	const expected = await json(join(root, 'scripts/sdk-packages.json'));
	const sdk = await json(join(root, 'release-artifacts/sdk/sdk.json'));
	if (
		JSON.stringify(sdk.packages?.map((p) => p.name)) !==
			JSON.stringify(expected) ||
		!expected.length ||
		new Set(expected).size !== expected.length
	)
		throw new Error('Unexpected public package set');
	const names = new Set();
	for (const pkg of sdk.packages) {
		safeName(pkg.file);
		if (!pkg.file.endsWith('.tgz') || names.has(pkg.file))
			throw new Error('Invalid or duplicate package asset');
		names.add(pkg.file);
		validateVersion(pkg.version);
		if (
			(pkg.name === '@flowdular/sdk' && pkg.version !== version) ||
			!/^[a-f0-9]{64}$/.test(pkg.sha256)
		)
			throw new Error(`Package version or digest mismatch: ${pkg.name}`);
		const file = join(root, 'release-artifacts/sdk', pkg.file);
		if (digest(await regularBytes(file)) !== pkg.sha256)
			throw new Error(`Package bytes changed: ${pkg.name}`);
		const metadata = JSON.parse(
			execFileSync('tar', ['-xOf', file, 'package/package.json'], {
				encoding: 'utf8',
				maxBuffer: 1024 * 1024,
			}),
		);
		if (metadata.name !== pkg.name || metadata.version !== pkg.version)
			throw new Error(`Packed identity mismatch: ${pkg.name}`);
	}
	await mkdir(output); // Refuse stale output instead of deleting or reusing files.
	for (const pkg of sdk.packages)
		await copyFile(
			join(root, 'release-artifacts/sdk', pkg.file),
			join(output, pkg.file),
		);
	await copyFile(
		join(root, 'release-artifacts/sdk/sdk.json'),
		join(output, 'sdk.json'),
	);
	const source = `flowdular-${version}-source.tar.gz`;
	git(root, [
		'archive',
		'--format=tar.gz',
		`--prefix=flowdular-${version}/`,
		`--output=${join(output, source)}`,
		release.commit,
	]);
	const range = release.previousTag
		? `${release.previousTag}..${release.commit}`
		: release.commit;
	const records = git(root, [
		'log',
		'--reverse',
		'--format=%H%x00%s%x00%b%x00',
		range,
	]).split('\0');
	const commits = [];
	for (let i = 0; i + 2 < records.length; i += 3)
		commits.push({
			sha: records[i].trim(),
			subject: records[i + 1],
			body: records[i + 2].trim(),
		});
	if (!commits.length) throw new Error('No commits in release range');
	const base = `https://github.com/${repository}`;
	const compare = release.previousTag
		? `${base}/compare/${release.previousTag}...${release.tag}`
		: `${base}/tree/${release.commit}`;
	const packages = sdk.packages
		.map((p) => `| ${p.name} | ${p.version} | \`${p.file}\` |`)
		.join('\n');
	const header = `# Flowdular ${release.tag}\n\nSource commit: ${release.commit}\n\nPrevious release: ${release.previousTag || 'Initial release'}\n\n[Full comparison](${compare})\n\n## Packages\n\n| Package | Version | Artifact |\n| --- | --- | --- |\n${packages}\n`;
	const changes = commits
		.map(
			(c) =>
				`### ${escape(c.subject)}\n\n[${c.sha.slice(0, 12)}](${base}/commit/${c.sha})\n${
					c.body
						? '\n' +
							c.body
								.split('\n')
								.map((line) => '> ' + escape(line))
								.join('\n') +
							'\n'
						: ''
				}`,
		)
		.join('\n');
	const files = release.previousTag
		? git(root, ['diff', '--stat', release.previousTag, release.commit])
		: git(root, ['ls-tree', '-r', '--name-only', release.commit]);
	await writeFile(
		join(output, 'CHANGELOG.md'),
		header +
			`\n## All ${commits.length} commits\n\n` +
			changes +
			'\n## Changed files\n\n' +
			files
				.split('\n')
				.map((line) => '    ' + line)
				.join('\n') +
			'\n',
	);
	const identity = `${base}/.github/workflows/platform-release.yml@refs/heads/main`;
	const summary = commits
		.slice(0, 50)
		.map(
			(c) =>
				`- ${escape(c.subject.slice(0, 200))} ([${c.sha.slice(0, 8)}](${base}/commit/${c.sha}))`,
		)
		.join('\n');
	const notes =
		header +
		`\n## Changes\n\n${summary}\n\nAll ${commits.length} commits, their complete messages and the file summary are included in the attached [CHANGELOG.md](${base}/releases/download/${release.tag}/CHANGELOG.md).\n\n## Verify downloaded assets\n\nDownload all release assets into one directory. With Cosign installed, run:\n\n\`\`\`sh\ncosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \\\n  --certificate-identity '${identity}' \\\n  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \\\n  --certificate-github-workflow-sha '${release.commit}'\nsha256sum --check SHA256SUMS\n\`\`\`\n\nSignatures cover the listed artifacts through SHA256SUMS. Git tags and GitHub-generated source downloads are not signed by this workflow; use the attached signed source archive. This action does not publish to npm.\n`;
	await writeFile(join(output, 'RELEASE-NOTES.md'), notes);
	const filesToHash = (await readdir(output)).sort();
	const assets = [];
	for (const file of filesToHash)
		assets.push({
			file,
			sha256: digest(await regularBytes(join(output, file))),
		});
	await writeFile(
		join(output, 'release.json'),
		JSON.stringify(
			{
				schemaVersion: 1,
				...release,
				repository,
				packages: sdk.packages,
				assets,
			},
			null,
			2,
		) + '\n',
	);
	assets.push({
		file: 'release.json',
		sha256: digest(await readFile(join(output, 'release.json'))),
	});
	await writeFile(
		join(output, 'SHA256SUMS'),
		assets.map((a) => `${a.sha256}  ${a.file}\n`).join(''),
	);
	return { ...release, output };
}
export async function verifyDirectory(
	directory,
	{ version, repository, commit },
) {
	const release = await json(join(directory, 'release.json'));
	if (
		release.version !== validateVersion(version) ||
		release.tag !== `v${version}` ||
		release.repository !== repository ||
		release.commit !== commit
	)
		throw new Error('Release metadata differs from the selected source');
	const lines = (await readFile(join(directory, 'SHA256SUMS'), 'utf8'))
		.trimEnd()
		.split('\n');
	const seen = new Set();
	for (const line of lines) {
		const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
		if (!match) throw new Error('Invalid checksum line');
		const file = safeName(match[2]);
		if (
			seen.has(file) ||
			file === 'SHA256SUMS' ||
			file === 'SHA256SUMS.sigstore.json'
		)
			throw new Error('Invalid checksum coverage');
		seen.add(file);
		if (digest(await regularBytes(join(directory, file))) !== match[1])
			throw new Error(`Checksum mismatch: ${file}`);
	}
	for (const file of [
		'release.json',
		'sdk.json',
		'CHANGELOG.md',
		'RELEASE-NOTES.md',
		`flowdular-${version}-source.tar.gz`,
		...release.packages.map((p) => p.file),
	])
		if (!seen.has(file)) throw new Error(`Unsigned asset: ${file}`);
	for (const file of await readdir(directory))
		if (
			!seen.has(file) &&
			!['SHA256SUMS', 'SHA256SUMS.sigstore.json'].includes(file)
		)
			throw new Error(`Unexpected release asset: ${file}`);
	return release;
}
export async function publishRelease(
	directory,
	options,
	call = (args) => execFileSync('gh', args, { encoding: 'utf8' }),
) {
	const release = await verifyDirectory(directory, options);
	await regularBytes(join(directory, 'SHA256SUMS.sigstore.json'));
	const repo = options.repository,
		tag = release.tag;
	// Atomic creation fails on an existing ref. Never replace a tag or release.
	call([
		'api',
		`repos/${repo}/git/refs`,
		'--method',
		'POST',
		'-f',
		`ref=refs/tags/${tag}`,
		'-f',
		`sha=${release.commit}`,
	]);
	call([
		'release',
		'create',
		tag,
		'--repo',
		repo,
		'--verify-tag',
		'--draft',
		'--title',
		`Flowdular ${tag}`,
		'--notes-file',
		join(directory, 'RELEASE-NOTES.md'),
	]);
	const files = (await readdir(directory))
		.sort()
		.map((file) => join(directory, safeName(file)));
	call(['release', 'upload', tag, ...files, '--repo', repo]);
	if (!options.draft)
		call(['release', 'edit', tag, '--repo', repo, '--draft=false']);
	return tag;
}
const root = fileURLToPath(new URL('..', import.meta.url));
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const options = {
		root,
		version: process.env.RELEASE_VERSION,
		previousTag: process.env.PREVIOUS_TAG || '',
		repository: process.env.GITHUB_REPOSITORY,
		commit: process.env.GITHUB_SHA,
		draft: process.env.RELEASE_DRAFT === 'true',
	};
	const directory = join(root, 'release-artifacts/platform');
	const command = process.argv[2];
	if (command === 'check') {
		if (process.env.GITHUB_REF !== 'refs/heads/main')
			throw new Error('Release only from main');
		const checked = await preflight(root, options.version, options.previousTag);
		if (checked.commit !== options.commit)
			throw new Error('Unexpected checkout commit');
	} else if (command === 'prepare') {
		const prepared = await prepareRelease(options);
		if (process.env.GITHUB_OUTPUT)
			await appendFile(process.env.GITHUB_OUTPUT, `tag=${prepared.tag}\n`);
	} else if (command === 'verify') await verifyDirectory(directory, options);
	else if (command === 'publish')
		console.log(await publishRelease(directory, options));
	else throw new Error('Expected check, prepare, verify or publish');
}
