import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { renderEnvironmentBlock, writeEnvironmentFile } from './environment.ts';

const roots: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-setup-env-'));
	roots.push(root);
	return root;
}

/* Root ignores permission bits, so the filesystem refusal can only be
   reproduced for an unprivileged process. */
const unprivileged =
	typeof process.getuid === 'function' && process.getuid() !== 0;

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			chmodSync(root, 0o700);
		} catch {
			/* Already writable. */
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe('first-run environment file', () => {
	it('writes the missing keys with owner-only permissions', () => {
		const root = workspace();

		const result = writeEnvironmentFile(root, {
			FD_DATABASE_ADAPTER: 'postgresql',
			FD_DATABASE_URL: 'postgresql://runtime:s3cret@db.example:5432/flowdular',
		});

		expect(result.status).toBe('written');
		expect(result.added).toEqual(['FD_DATABASE_ADAPTER', 'FD_DATABASE_URL']);
		const contents = readFileSync(join(root, '.env'), 'utf8');
		expect(contents).toContain('FD_DATABASE_ADAPTER=postgresql');
		expect(contents).toContain(
			'FD_DATABASE_URL=postgresql://runtime:s3cret@db.example:5432/flowdular',
		);
		expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
	});

	it('never replaces a key the file already sets', () => {
		const root = workspace();
		writeFileSync(
			join(root, '.env'),
			'# existing\nFD_DATABASE_URL=postgresql://kept:kept@kept/kept\n',
		);

		const result = writeEnvironmentFile(root, {
			FD_DATABASE_ADAPTER: 'postgresql',
			FD_DATABASE_URL: 'postgresql://new:new@new/new',
		});

		expect(result.status).toBe('written');
		expect(result.kept).toEqual(['FD_DATABASE_URL']);
		expect(result.added).toEqual(['FD_DATABASE_ADAPTER']);
		const contents = readFileSync(join(root, '.env'), 'utf8');
		expect(contents).toContain('postgresql://kept:kept@kept/kept');
		expect(contents).not.toContain('postgresql://new:new@new/new');
	});

	it('reports nothing to do when every key is already set', () => {
		const root = workspace();
		writeFileSync(join(root, '.env'), 'FD_DATABASE_ADAPTER=pglite\n');

		const result = writeEnvironmentFile(root, {
			FD_DATABASE_ADAPTER: 'pglite',
		});

		expect(result.status).toBe('unchanged');
		expect(result.block).toBe('FD_DATABASE_ADAPTER=pglite');
	});

	it.runIf(unprivileged)(
		'reports a refused write and leaves no file behind',
		() => {
			const root = workspace();
			chmodSync(root, 0o500);

			const result = writeEnvironmentFile(root, {
				FD_DATABASE_ADAPTER: 'postgresql',
				FD_DATABASE_URL:
					'postgresql://runtime:s3cret@db.example:5432/flowdular',
			});

			expect(result.status).toBe('read-only');
			expect(result.added).toEqual([]);
			/* The block the operator has to paste still carries every value. */
			expect(result.block).toContain('FD_DATABASE_URL=postgresql://');
			chmodSync(root, 0o700);
			expect(readdirSync(root)).toEqual([]);
		},
	);

	it('refuses a value a .env file cannot represent unambiguously', () => {
		const root = workspace();

		const result = writeEnvironmentFile(root, {
			FD_DATABASE_PGLITE_DIRECTORY: '/data/"quoted"/pglite',
		});

		expect(result.status).toBe('failed');
		expect(() => readFileSync(join(root, '.env'), 'utf8')).toThrow();
	});

	it('quotes only what needs quoting', () => {
		expect(
			renderEnvironmentBlock({
				FD_DATABASE_ADAPTER: 'pglite',
				FD_DATABASE_PGLITE_DIRECTORY: '/var/lib/my data/pglite',
			}),
		).toBe(
			'FD_DATABASE_ADAPTER=pglite\nFD_DATABASE_PGLITE_DIRECTORY="/var/lib/my data/pglite"',
		);
	});
});
