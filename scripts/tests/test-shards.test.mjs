import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	assignShards,
	DEFAULT_WEIGHT,
	testedPackages,
} from '../test-shards.mjs';

const weights = JSON.parse(
	readFileSync(new URL('../test-weights.json', import.meta.url), 'utf8'),
);

test('every tested workspace package runs in exactly one of three shards', () => {
	const packages = testedPackages();
	assert.ok(packages.length > 20);
	const shards = assignShards(packages, weights, 3);
	const assigned = shards.flatMap((shard) =>
		shard.packages.map((pkg) => pkg.directory),
	);
	assert.deepEqual(
		[...assigned].sort(),
		packages.map((pkg) => pkg.directory).sort(),
	);
	assert.equal(new Set(assigned).size, assigned.length);
});

test('the split is balanced and the same on every run', () => {
	const packages = testedPackages();
	const first = assignShards(packages, weights, 3);
	const second = assignShards([...packages].reverse(), weights, 3);
	assert.deepEqual(first, second);
	const totals = first.map((shard) => shard.total);
	const heaviest = Math.max(
		...packages.map((pkg) => weights[pkg.directory] ?? DEFAULT_WEIGHT),
	);
	assert.ok(Math.max(...totals) - Math.min(...totals) <= heaviest);
});

test('a package without a recorded weight gets the default weight', () => {
	const shards = assignShards(
		[
			{ directory: 'modules/new', name: '@x/new' },
			{ directory: 'modules/old', name: '@x/old' },
		],
		{ 'modules/old': 5 },
		1,
	);
	assert.equal(shards[0].total, DEFAULT_WEIGHT + 5);
	assert.throws(() => assignShards([], {}, 0));
});
