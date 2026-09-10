import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	flowdularEnvironment,
	flowdularStateDirectory,
} from '../src/runtime-config.ts';

const roots: string[] = [];
function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-brand-'));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe('Flowdular upgrade compatibility', () => {
	it('accepts legacy environment keys without overriding explicit new values or mutating the caller', () => {
		const source = {
			CL_DATABASE_URL: 'legacy',
			CL_AGENT_CREDENTIAL_KEY: 'key',
			FD_DATABASE_URL: '',
		};
		expect(flowdularEnvironment(source)).toMatchObject({
			FD_DATABASE_URL: '',
			FD_AGENT_CREDENTIAL_KEY: 'key',
		});
		expect(source).not.toHaveProperty('FD_AGENT_CREDENTIAL_KEY');
	});
	it('uses the new state path for a fresh workspace without creating it', () => {
		const root = workspace();
		expect(flowdularStateDirectory(root)).toBe(join(root, '.flowdular'));
	});
	it('reuses the existing state root so databases, vault keys and sandbox sessions stay together', () => {
		const root = workspace();
		mkdirSync(join(root, '.coreloom'));
		expect(flowdularStateDirectory(root)).toBe(join(root, '.coreloom'));
	});
	it('refuses ambiguous roots and symbolic links', () => {
		const root = workspace();
		mkdirSync(join(root, '.coreloom'));
		mkdirSync(join(root, '.flowdular'));
		expect(() => flowdularStateDirectory(root)).toThrow(/Both/);
		const other = workspace();
		symlinkSync(root, join(other, '.coreloom'));
		expect(() => flowdularStateDirectory(other)).toThrow(/regular directory/);
	});
});
