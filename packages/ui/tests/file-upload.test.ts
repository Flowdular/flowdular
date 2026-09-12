import { describe, expect, it } from 'vitest';
import {
	acceptsFile,
	fileRefusal,
	type FileFacts,
} from '../src/components/file-upload.ts';

const PDF: FileFacts = {
	name: 'Contract.PDF',
	type: 'application/pdf',
	size: 2048,
};
const PNG: FileFacts = { name: 'scan.png', type: 'image/png', size: 4096 };

describe('accepted files', () => {
	it('takes an exact content type, a family and a suffix', () => {
		expect(acceptsFile(PDF, ['application/pdf'])).toBe(true);
		expect(acceptsFile(PNG, ['image/*'])).toBe(true);
		expect(acceptsFile(PDF, ['.pdf'])).toBe(true);
		expect(acceptsFile(PDF, ['image/*', 'text/csv'])).toBe(false);
		expect(acceptsFile(PNG, ['image/jpeg'])).toBe(false);
	});

	it('ignores the case of both the rule and the file', () => {
		expect(
			acceptsFile({ ...PDF, type: 'APPLICATION/PDF' }, ['application/pdf']),
		).toBe(true);
		expect(acceptsFile(PDF, ['.PDF'])).toBe(true);
	});

	/* A screen that could not read the port limits still has to offer the
	   upload: the server stays the authority on what it takes. */
	it('accepts everything when the screen has no list', () => {
		expect(acceptsFile(PDF, undefined)).toBe(true);
		expect(acceptsFile(PDF, [])).toBe(true);
		expect(acceptsFile(PDF, ['*/*'])).toBe(true);
	});
});

describe('file refusals', () => {
	it('names the type before the size', () => {
		expect(fileRefusal(PNG, ['application/pdf'], 1)).toBe('type');
	});

	it('refuses a file past the ceiling and keeps one exactly on it', () => {
		expect(fileRefusal(PDF, undefined, 2047)).toBe('size');
		expect(fileRefusal(PDF, undefined, 2048)).toBeNull();
	});

	it('refuses nothing while the ceiling is unknown', () => {
		expect(fileRefusal(PDF, undefined, null)).toBeNull();
		expect(fileRefusal(PDF, undefined, undefined)).toBeNull();
	});
});
