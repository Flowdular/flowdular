// Checks that every place carrying the release version agrees with the
// workspace version. A release moves that number by hand through a dozen
// files, and the one that hurts when it is missed is the SDK pin in the
// scaffold: the generator would ship a template installing an SDK older than
// the composition it generates.
// Run: node scripts/release-versions.mjs --check
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	RELEASE_VERSION_SITES,
	ROOT_VERSION_SITE,
	releaseVersionDrift,
} from '../packages/cli/src/release-versions.ts';

const root = new URL('..', import.meta.url).pathname;

async function read(path) {
	try {
		return await readFile(join(root, path), 'utf8');
	} catch {
		return undefined;
	}
}

const rootSource = await read(ROOT_VERSION_SITE.path);
const version = rootSource
	? ROOT_VERSION_SITE.pattern.exec(rootSource)?.[1]
	: undefined;
if (!version) {
	console.error(
		`Cannot read ${ROOT_VERSION_SITE.what} from ${ROOT_VERSION_SITE.path}.`,
	);
	process.exit(1);
}

const sources = new Map();
for (const site of RELEASE_VERSION_SITES) {
	const source = await read(site.path);
	if (source !== undefined) sources.set(site.path, source);
}

const findings = releaseVersionDrift(version, sources);
if (findings.length > 0) {
	console.log(
		findings.map((found) => `${found.path}: ${found.message}`).join('\n'),
	);
	console.error(
		`${findings.length} ${findings.length === 1 ? 'place does' : 'places do'} not carry the workspace version ${version}. A release moves them together; see docs/platform-releases.md.`,
	);
	process.exit(1);
}
console.log(
	`Release version ${version} is carried by ${RELEASE_VERSION_SITES.length + 1} places.`,
);
