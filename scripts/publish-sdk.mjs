import expectedPackages from './sdk-packages.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(root, 'release-artifacts/sdk');
const manifest = JSON.parse(
	await readFile(join(directory, 'sdk.json'), 'utf8'),
);
const packages = manifest.packages;
if (
	JSON.stringify(packages.map((pkg) => pkg.name)) !==
	JSON.stringify(expectedPackages)
)
	throw new Error(
		'Unexpected public package set. Run release:pack for the current SDK layout.',
	);
for (const pkg of packages) {
	if (basename(pkg.file) !== pkg.file)
		throw new Error('Invalid SDK artifact filename.');
	const bytes = await readFile(join(directory, pkg.file));
	if (createHash('sha256').update(bytes).digest('hex') !== pkg.sha256)
		throw new Error(`Artifact changed: ${pkg.name}`);
}
console.log(
	packages.map((pkg) => `${pkg.name}@${pkg.version}\t${pkg.file}`).join('\n'),
);
if (!process.argv.includes('--apply')) {
	console.log(
		'\nPreview only. Authenticate npm for the @flowdular scope, then pass --apply to publish these exact tarballs.',
	);
} else {
	for (const pkg of packages) {
		const published = spawnSync(
			'npm',
			['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json'],
			{ encoding: 'utf8' },
		);
		if (published.status === 0) {
			const integrity =
				'sha512-' +
				createHash('sha512')
					.update(await readFile(join(directory, pkg.file)))
					.digest('base64');
			if (JSON.parse(published.stdout) !== integrity)
				throw new Error(
					`A different artifact already owns ${pkg.name}@${pkg.version}. Bump its version.`,
				);
			console.log(`Already published: ${pkg.name}@${pkg.version}`);
			continue;
		}
		if (!published.stderr.includes('E404'))
			throw new Error(
				`Cannot inspect npm publication for ${pkg.name}; check npm authentication and connectivity.`,
			);
		const result = spawnSync(
			'npm',
			['publish', join(directory, pkg.file), '--access', 'public'],
			{ stdio: 'inherit' },
		);
		if (result.status !== 0)
			throw new Error(
				`Publication stopped at ${pkg.name}. Rerun after resolving the failure; identical published tarballs are skipped.`,
			);
	}
}
