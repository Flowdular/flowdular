// Splits the workspace test suites into balanced shards for CI and runs one.
//   node scripts/test-shards.mjs --shard 2/3          run shard 2 of 3
//   node scripts/test-shards.mjs --shard 2/3 --list   print its packages
// Weights are seconds from a CI run (scripts/test-weights.json); a package the
// file does not name weighs DEFAULT_WEIGHT until the file is refreshed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_WEIGHT = 30;
const root = fileURLToPath(new URL('..', import.meta.url));

/** Workspace directories (relative, posix) whose package.json has a test script. */
export function testedPackages(workspace = root) {
	const found = [];
	const consider = (directory) => {
		const manifest = join(directory, 'package.json');
		if (!existsSync(manifest)) return;
		const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
		if (pkg.scripts?.test) {
			found.push({
				directory: relative(workspace, directory).split('\\').join('/'),
				name: pkg.name,
			});
		}
	};
	consider(join(workspace, 'platform'));
	for (const group of ['modules', 'packages']) {
		const base = join(workspace, group);
		if (!existsSync(base)) continue;
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (entry.isDirectory()) consider(join(base, entry.name));
		}
	}
	return found.sort((left, right) =>
		left.directory.localeCompare(right.directory),
	);
}

/**
 * Greedy longest-first assignment: every package lands in exactly one shard,
 * the heaviest first into the lightest shard, ties broken by directory so the
 * split is the same on every runner.
 */
export function assignShards(packages, weights, count) {
	if (!Number.isInteger(count) || count < 1) {
		throw new Error('The shard count must be a positive integer.');
	}
	const weighted = packages
		.map((pkg) => ({
			...pkg,
			weight: weights[pkg.directory] ?? DEFAULT_WEIGHT,
		}))
		.sort(
			(left, right) =>
				right.weight - left.weight ||
				left.directory.localeCompare(right.directory),
		);
	const shards = Array.from({ length: count }, () => ({
		total: 0,
		packages: [],
	}));
	for (const pkg of weighted) {
		let lightest = shards[0];
		for (const shard of shards) {
			if (shard.total < lightest.total) lightest = shard;
		}
		lightest.packages.push(pkg);
		lightest.total += pkg.weight;
	}
	return shards;
}

function parseShard(value) {
	const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
	if (!match) throw new Error('Pass --shard <index>/<count>, for example 1/3.');
	const index = Number(match[1]);
	const count = Number(match[2]);
	if (index < 1 || index > count) {
		throw new Error(`Shard ${value} is outside 1/${count}..${count}/${count}.`);
	}
	return { index, count };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const flag = process.argv.indexOf('--shard');
	const { index, count } = parseShard(process.argv[flag + 1]);
	const weights = JSON.parse(
		readFileSync(join(root, 'scripts/test-weights.json'), 'utf8'),
	);
	const shard = assignShards(testedPackages(), weights, count)[index - 1];
	console.log(
		`Shard ${index}/${count}: ${shard.packages.length} packages, about ${shard.total} s of tests.`,
	);
	if (process.argv.includes('--list')) {
		for (const pkg of shard.packages)
			console.log(`${pkg.weight}\t${pkg.directory}`);
		process.exit(0);
	}
	const filters = shard.packages.flatMap((pkg) => ['--filter', pkg.name]);
	const result = spawnSync(
		'pnpm',
		['-r', '--workspace-concurrency=2', ...filters, 'test'],
		{ cwd: root, stdio: 'inherit' },
	);
	process.exit(result.status ?? 1);
}
