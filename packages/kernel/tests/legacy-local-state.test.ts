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
	coreloomLocalDataPath,
	LegacyLocalStateError,
	UnsafeLocalStatePathError,
} from '../src/legacy-local-state.ts';

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-local-state-'));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe('Coreloom local data path', () => {
	it('returns the new path for a new workspace', () => {
		expect(coreloomLocalDataPath(workspace, 'auth.db')).toBe(
			join(workspace, '.coreloom/data/auth.db'),
		);
		expect(lstatSync(join(workspace, '.coreloom/data')).isDirectory()).toBe(
			true,
		);
	});

	it('refuses to create an empty replacement while legacy data exists', () => {
		mkdirSync(join(workspace, '.octane-erp'));
		writeFileSync(join(workspace, '.octane-erp/auth.db'), 'legacy');

		expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
			LegacyLocalStateError,
		);
	});

	it('uses a migrated target while preserving the legacy source', () => {
		mkdirSync(join(workspace, '.octane-erp'));
		mkdirSync(join(workspace, '.coreloom/data'), { recursive: true });
		writeFileSync(join(workspace, '.octane-erp/auth.db'), 'legacy');
		writeFileSync(join(workspace, '.coreloom/data/auth.db'), 'migrated');

		expect(coreloomLocalDataPath(workspace, 'auth.db')).toBe(
			join(workspace, '.coreloom/data/auth.db'),
		);
	});

	it('rejects path traversal in a file name', () => {
		expect(() => coreloomLocalDataPath(workspace, '../auth.db')).toThrow(
			/single path segment/,
		);
	});

	it('refuses a linked destination directory', () => {
		const outside = mkdtempSync(join(tmpdir(), 'coreloom-linked-data-'));
		mkdirSync(join(workspace, '.coreloom'));
		symlinkSync(outside, join(workspace, '.coreloom/data'));
		try {
			expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
				UnsafeLocalStatePathError,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('refuses a linked Coreloom state root', () => {
		const outside = mkdtempSync(join(tmpdir(), 'coreloom-linked-root-'));
		symlinkSync(outside, join(workspace, '.coreloom'));
		try {
			expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
				UnsafeLocalStatePathError,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('refuses linked target and legacy files', () => {
		const outside = join(workspace, 'outside.db');
		writeFileSync(outside, 'outside');
		mkdirSync(join(workspace, '.coreloom/data'), { recursive: true });
		symlinkSync(outside, join(workspace, '.coreloom/data/auth.db'));
		expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);

		rmSync(join(workspace, '.coreloom'), { recursive: true, force: true });
		mkdirSync(join(workspace, '.octane-erp'));
		symlinkSync(outside, join(workspace, '.octane-erp/auth.db'));
		expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);
	});

	it('refuses directories where a database or key file is expected', () => {
		mkdirSync(join(workspace, '.coreloom/data/auth.db'), { recursive: true });
		expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);

		rmSync(join(workspace, '.coreloom'), { recursive: true, force: true });
		mkdirSync(join(workspace, '.octane-erp/auth.db'), { recursive: true });
		expect(() => coreloomLocalDataPath(workspace, 'auth.db')).toThrow(
			UnsafeLocalStatePathError,
		);
	});
});
