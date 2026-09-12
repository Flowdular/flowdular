import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArgumentError, parseArguments } from '../src/args.ts';
import { detectPackageManager } from '../src/pm.ts';
import { nextSteps } from '../src/report.ts';
import { run } from '../src/index.ts';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'create-flowdular-cli-'));
	roots.push(root);
	return root;
}

describe('parseArguments', () => {
	it('defaults to the default template, install and git', () => {
		expect(parseArguments(['my-app'])).toMatchObject({
			target: 'my-app',
			template: 'default',
			install: true,
			git: true,
			force: false,
		});
	});

	it('reads a value as the next argument or after an equals sign', () => {
		expect(parseArguments(['my-app', '--pm', 'npm']).packageManager).toBe(
			'npm',
		);
		expect(parseArguments(['my-app', '--pm=yarn']).packageManager).toBe('yarn');
		expect(parseArguments(['my-app', '-t', 'default']).template).toBe(
			'default',
		);
	});

	it('turns the negative flags off', () => {
		const options = parseArguments(['my-app', '--no-install', '--no-git']);

		expect(options.install).toBe(false);
		expect(options.git).toBe(false);
	});

	it('rejects an unknown option, an unknown manager and a second directory', () => {
		for (const argv of [
			['my-app', '--wat'],
			['my-app', '--pm', 'bun'],
			['my-app', 'other-app'],
			['--pm'],
		]) {
			expect(() => parseArguments(argv), argv.join(' ')).toThrow(ArgumentError);
		}
	});

	it('rejects a directory that escapes the current one', () => {
		expect(() => parseArguments(['../evil'])).toThrow(/escapes/);
	});

	it('needs a directory unless help or version was asked for', () => {
		expect(() => parseArguments([])).toThrow(ArgumentError);
		expect(parseArguments(['--help']).help).toBe(true);
		expect(parseArguments(['--version']).version).toBe(true);
	});
});

describe('detectPackageManager', () => {
	it('uses pnpm workspaces even when launched by npm create', () => {
		expect(detectPackageManager('pnpm/11.17.0 npm/? node/v24.18.0')).toBe(
			'pnpm',
		);
		expect(detectPackageManager('npm/11.0.0 node/v24.18.0')).toBe('pnpm');
		expect(detectPackageManager('yarn/4.6.0 npm/? node/v24.18.0')).toBe('pnpm');
	});

	it('falls back to pnpm when nothing announced itself', () => {
		expect(detectPackageManager(undefined)).toBe('pnpm');
		expect(detectPackageManager('bun/1.2.0')).toBe('pnpm');
	});
});

describe('nextSteps', () => {
	it('lists install only when the scaffolder did not run it', () => {
		expect(
			nextSteps({
				directory: 'my-app',
				packageManager: 'pnpm',
				installed: true,
			}),
		).toEqual(['cd my-app', 'pnpm flowdular setup', 'pnpm dev']);
		expect(
			nextSteps({
				directory: 'my-app',
				packageManager: 'pnpm',
				installed: false,
			})[1],
		).toBe('pnpm install');
	});

	it('separates script arguments the way npm needs', () => {
		expect(
			nextSteps({
				directory: 'my-app',
				packageManager: 'npm',
				installed: true,
			}),
		).toEqual(['cd my-app', 'npm run flowdular -- setup', 'npm run dev']);
	});
});

describe('run', () => {
	it('scaffolds and prints the next commands with --no-install --no-git', async () => {
		const cwd = await workspace();
		let out = '';
		let err = '';

		const code = await run(['my-app', '--no-install', '--no-git'], {
			cwd,
			out: (text) => (out += text),
			err: (text) => (err += text),
		});

		expect(err).toBe('');
		expect(code).toBe(0);
		expect(out).toContain('Created my-app in ' + join(cwd, 'my-app'));
		expect(out).toContain('cd my-app');
		expect(out).toContain('pnpm install');
		expect(out).toContain('pnpm flowdular setup');
		expect(out).toContain('pnpm dev');
		expect(out).toContain('http://localhost:4310');
		expect(out).toContain('pnpm sandbox');
		expect(out).toContain('AGENTS.md, CLAUDE.md, .ai/skills');
		expect(
			JSON.parse(
				await readFile(join(cwd, 'my-app', 'package.json'), 'utf8'),
			) as { name: string },
		).toMatchObject({ name: 'my-app' });
		await expect(stat(join(cwd, 'my-app', '.git'))).rejects.toThrow();
		await expect(stat(join(cwd, 'my-app', 'node_modules'))).rejects.toThrow();
	});

	it('reports a bad directory without creating anything', async () => {
		const cwd = await workspace();
		let out = '';
		let err = '';

		const code = await run(['../evil'], {
			cwd,
			out: (text) => (out += text),
			err: (text) => (err += text),
		});

		expect(code).toBe(1);
		expect(err).toContain('ERROR');
		expect(out).toBe('');
	});
});
