import { createHash } from 'node:crypto';
import {
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
	lstat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const base = join(root, '.ai/references');
const target = join(base, 'catalog');
const metadataPath = join(base, 'catalog.provenance.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function check() {
	const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
	const seen = new Set();
	async function walk(directory, prefix = '') {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix + entry.name;
			if (entry.isDirectory())
				await walk(join(directory, entry.name), path + '/');
			else {
				if (
					!entry.isFile() ||
					entry.isSymbolicLink() ||
					hash(await readFile(join(directory, entry.name))) !==
						metadata.files[path]
				)
					throw new Error(`Generated reference differs: ${path}`);
				seen.add(path);
			}
		}
	}
	await walk(target);
	if (seen.size !== Object.keys(metadata.files).length)
		throw new Error('Generated reference is missing files.');
	return metadata;
}
if (process.argv.includes('--check')) {
	await check();
	console.log('Pinned catalog reference matches its release.');
} else {
	const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
	if (
		!process.argv.includes('--apply') ||
		!process.argv.includes('--artifact') ||
		!process.argv.includes('--sha256') ||
		!process.argv.includes('--source-commit')
	)
		throw new Error(
			'Use --artifact <file> --sha256 <digest> --source-commit <commit> --apply, or --check.',
		);
	const bytes = await readFile(flag('--artifact'));
	if (
		hash(bytes) !== flag('--sha256') ||
		!/^[a-f0-9]{40}$/.test(flag('--source-commit'))
	)
		throw new Error('Invalid artifact digest or source commit.');
	const { validateModuleArtifact } = await import(
		'../packages/cli/dist/distribution.js'
	);
	const artifact = validateModuleArtifact(JSON.parse(bytes));
	if (artifact.manifest.id !== 'catalog.core')
		throw new Error('Only the catalog reference belongs here.');
	let hasMetadata = false;
	try {
		await readFile(metadataPath);
		hasMetadata = true;
		await check();
	} catch (error) {
		if (error.code !== 'ENOENT' || hasMetadata) throw error;
		try {
			await lstat(target);
			throw new Error('Refusing to replace an unowned reference directory.');
		} catch (missing) {
			if (missing.code !== 'ENOENT') throw missing;
		}
	}
	await rm(target, { recursive: true, force: true });
	for (const file of artifact.files) {
		const path = join(target, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.from(file.content, 'base64'));
	}
	await writeFile(
		metadataPath,
		JSON.stringify(
			{
				id: artifact.manifest.id,
				version: artifact.manifest.version,
				repository: 'Flowdular/official-modules',
				sourceCommit: flag('--source-commit'),
				artifactSha256: hash(bytes),
				files: Object.fromEntries(
					artifact.files.map((file) => [file.path, file.sha256]),
				),
			},
			null,
			'\t',
		) + '\n',
	);
	console.log(`Generated catalog reference ${artifact.manifest.version}.`);
}
