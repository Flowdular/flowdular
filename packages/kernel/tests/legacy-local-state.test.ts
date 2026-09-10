import {
	lstatSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	flowdularLocalDataPath,
	LegacyLocalStateError,
	UnsafeLocalStatePathError,
} from '../src/legacy-local-state.ts';

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'flowdular-local-state-'));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe('Flowdular local data path', () => {
	it('returns the new path for a new workspace', () => {
		expect(flowdularLocalDataPath(workspace, 'auth.db')).toBe(
			join(workspace, '.flowdular/data/auth.db'),
		);
		expect(lstatSync(join(workspace, '.flowdular/data')).isDirectory()).toBe(
			true,
		);
	});

	it('refuses to create an empty replacement while legacy data exists', () => {
		mkdirSync(join(workspace, '.octane-erp'));
		writeFileSync(join(workspace, '.octane-erp/auth.db'), 'legacy');

		expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
			LegacyLocalStateError,
		);
	});

	it('uses a migrated target while preserving the legacy source', () => {
		mkdirSync(join(workspace, '.octane-erp'));
		mkdirSync(join(workspace, '.flowdular/data'), { recursive: true });
		writeFileSync(join(workspace, '.octane-erp/auth.db'), 'legacy');
		writeFileSync(join(workspace, '.flowdular/data/auth.db'), 'migrated');

		expect(flowdularLocalDataPath(workspace, 'auth.db')).toBe(
			join(workspace, '.flowdular/data/auth.db'),
		);
	});

	it('rejects path traversal in a file name', () => {
		expect(() => flowdularLocalDataPath(workspace, '../auth.db')).toThrow(
			/single path segment/,
		);
	});

	it('refuses a linked destination directory', () => {
		const outside = mkdtempSync(join(tmpdir(), 'flowdular-linked-data-'));
		mkdirSync(join(workspace, '.flowdular'));
		symlinkSync(outside, join(workspace, '.flowdular/data'));
		try {
			expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
				UnsafeLocalStatePathError,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('refuses a linked Flowdular state root', () => {
		const outside = mkdtempSync(join(tmpdir(), 'flowdular-linked-root-'));
		symlinkSync(outside, join(workspace, '.flowdular'));
		try {
			expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
				UnsafeLocalStatePathError,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('refuses linked target and legacy files', () => {
		const outside = join(workspace, 'outside.db');
		writeFileSync(outside, 'outside');
		mkdirSync(join(workspace, '.flowdular/data'), { recursive: true });
		symlinkSync(outside, join(workspace, '.flowdular/data/auth.db'));
		expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);

		rmSync(join(workspace, '.flowdular'), { recursive: true, force: true });
		mkdirSync(join(workspace, '.octane-erp'));
		symlinkSync(outside, join(workspace, '.octane-erp/auth.db'));
		expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);
	});

	it('refuses directories where a database or key file is expected', () => {
		mkdirSync(join(workspace, '.flowdular/data/auth.db'), { recursive: true });
		expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);

		rmSync(join(workspace, '.flowdular'), { recursive: true, force: true });
		mkdirSync(join(workspace, '.octane-erp/auth.db'), { recursive: true });
		expect(() => flowdularLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);
	});
});
