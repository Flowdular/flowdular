import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flowdularStateDirectory } from '../src/runtime-config.ts';

const roots: string[] = [];
function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-state-'));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe('local state directory', () => {
	it('uses the state path for a fresh workspace without creating it', () => {
		const root = workspace();
		expect(flowdularStateDirectory(root)).toBe(join(root, '.flowdular'));
	});
	it('returns an existing state directory', () => {
		const root = workspace();
		mkdirSync(join(root, '.flowdular'));
		expect(flowdularStateDirectory(root)).toBe(join(root, '.flowdular'));
	});
	it('refuses a symbolic link in place of the state directory', () => {
		const root = workspace();
		const other = workspace();
		symlinkSync(root, join(other, '.flowdular'));
		expect(() => flowdularStateDirectory(other)).toThrow(/regular directory/);
	});
});
