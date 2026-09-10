import { describe, expect, it } from 'vitest';
import { checkProjectName, checkTargetPath } from '../src/name.ts';

describe('checkProjectName', () => {
	it('accepts the names npm accepts', () => {
		for (const name of ['my-app', 'app', 'my.app_1', '@acme/app', 'a']) {
			expect(checkProjectName(name), name).toMatchObject({ valid: true });
		}
	});

	it('rejects uppercase, leading dots and underscores, and reserved names', () => {
		for (const name of ['MyApp', '.app', '_app', 'node_modules']) {
			expect(checkProjectName(name), name).toMatchObject({ valid: false });
		}
	});

	it('rejects names with characters a registry URL cannot carry', () => {
		for (const name of ['my app', 'my/app', 'my(app)', 'my!app', '']) {
			expect(checkProjectName(name), name).toMatchObject({ valid: false });
		}
	});

	it('rejects a name past the 214 character limit', () => {
		expect(checkProjectName('a'.repeat(214))).toMatchObject({ valid: true });
		expect(checkProjectName('a'.repeat(215))).toMatchObject({ valid: false });
	});

	it('explains why a name was rejected', () => {
		expect(checkProjectName('MyApp').reason).toContain('uppercase');
	});
});

describe('checkTargetPath', () => {
	it('accepts a plain and a nested directory', () => {
		expect(checkTargetPath('my-app')).toMatchObject({ valid: true });
		expect(checkTargetPath('apps/my-app')).toMatchObject({ valid: true });
	});

	it('rejects every form of upward traversal', () => {
		for (const path of ['../evil', 'apps/../../evil', '..', 'a/../../b']) {
			expect(checkTargetPath(path), path).toMatchObject({ valid: false });
		}
	});

	it('rejects a null byte', () => {
		expect(checkTargetPath('my-app\u0000.txt')).toMatchObject({ valid: false });
	});
});
