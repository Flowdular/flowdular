import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffold, ScaffoldError } from '../src/scaffold.ts';
import { SECRET_KEYS } from '../src/secrets.ts';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'create-flowdular-'));
	roots.push(root);
	return root;
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/* Inline and reference links; a bare autolink carries no relative target. */
const MARKDOWN_LINK = /\[[^\]]*\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g;

async function markdownFiles(directory: string): Promise<readonly string[]> {
	const found: string[] = [];
	for (const entry of await readdir(directory, {
		withFileTypes: true,
		recursive: true,
	})) {
		if (entry.isFile() && entry.name.endsWith('.md')) {
			found.push(join(entry.parentPath, entry.name));
		}
	}
	return found;
}

/* Docker matches a pattern against the whole context-relative path, never
   segment by segment, so a pattern without "**" only ever reaches the root. */
function patternMatcher(pattern: string): RegExp {
	let source = '';
	for (let index = 0; index < pattern.length; index += 1) {
		if (pattern.startsWith('**/', index)) {
			source += '(?:.*/)?';
			index += 2;
			continue;
		}
		const character = pattern[index]!;
		if (character === '*') source += '[^/]*';
		else if (character === '?') source += '[^/]';
		else source += character.replace(/[.+^${}()|[\]\\]/, '\\$&');
	}
	return new RegExp(`^${source}(?:/.*)?$`);
}

/* Last matching line wins, and a leading "!" re-includes. */
function excluded(ignoreFile: string, path: string): boolean {
	let result = false;
	for (const line of ignoreFile.split('\n')) {
		const pattern = line.trim();
		if (pattern === '' || pattern.startsWith('#')) continue;
		const negated = pattern.startsWith('!');
		if (patternMatcher(negated ? pattern.slice(1) : pattern).test(path)) {
			result = !negated;
		}
	}
	return result;
}

describe('scaffold', () => {
	it('writes a runnable app tree and rewrites the package name', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		expect(result.name).toBe('my-app');
		expect(result.directory).toBe(join(cwd, 'my-app'));
		const manifest = JSON.parse(
			await readFile(join(result.directory, 'package.json'), 'utf8'),
		) as { name: string; scripts: Record<string, string> };
		expect(manifest.name).toBe('my-app');
		const project = JSON.parse(
			await readFile(join(result.directory, 'flowdular.json'), 'utf8'),
		);
		const platform = JSON.parse(
			await readFile(
				new URL('../../../flowdular.json', import.meta.url),
				'utf8',
			),
		);
		expect([...project.modules.enabled].sort()).toEqual(
			[...platform.modules.enabled, 'example.core'].sort(),
		);
		expect(project.agent).toEqual({
			policy: '.ai/policies/capabilities.yaml',
			modelRouting: '.ai/policies/model-routing.yaml',
			blueprints: '.ai/blueprints',
		});
		expect(
			await exists(join(result.directory, '.claude/settings.local.json')),
		).toBe(false);
		expect(
			await readFile(join(result.directory, 'AGENTS.md'), 'utf8'),
		).toContain('.ai/guides/application-development.md');
		expect(
			await readFile(
				join(result.directory, '.ai/skills/module-new/SKILL.md'),
				'utf8',
			),
		).toContain("from '@flowdular/sdk/server'");
		expect(manifest.scripts.dev).toContain('platform/scripts/dev.mjs');
		expect(
			await readFile(join(result.directory, 'platform/index.html'), 'utf8'),
		).toBe(
			await readFile(
				new URL('../../../platform/index.html', import.meta.url),
				'utf8',
			),
		);

		for (const path of [
			'pnpm-workspace.yaml',
			'flowdular.json',
			'tsconfig.base.json',
			'README.md',
			'.ai/README.md',
			/* The capability card every spec interview and skill cites. */
			'.ai/platform-capabilities.md',
			'.ai/guides/application-development.md',
			'.ai/skills/auto-review/SKILL.md',
			'.ai/agents/reviewer.md',
			'.ai/rules/flowdular.md',
			'.ai/references/catalog/module.json',
			'.agents/skills/module-new/SKILL.md',
			'.claude/skills/auto-review/SKILL.md',
			'AGENTS.md',
			'CLAUDE.md',
			'rulesync.jsonc',
			'docs/agent-contract.md',
			'docs/design-system.md',
			'docs/adr/0006-agentic-workflows.md',
			'docs/adr/0007-module-owned-agents.md',
			'platform/package.json',
			'platform/octane.config.ts',
			'platform/src/App.tsrx',
			'platform/src/server/database.ts',
			'platform/src/generated/modules.server.ts',
			'platform/src/generated/modules.client.ts',
			'modules/example/module.json',
			'modules/example/spec/module.yaml',
			'modules/example/src/platform.ts',
			'modules/example/src/api/endpoints.ts',
			'modules/example/src/services/database-repository.ts',
			'modules/example/migrations/0001_example_core.up.sql',
			'modules/example/translations/en.json',
			'modules/example/translations/pl.json',
			'modules/example/tests/module.test.ts',
			'specs/application.yaml',
			'.env.example',
			'.dockerignore',
			'infra/README.md',
			'infra/docker/Dockerfile',
			'infra/docker/compose.yaml',
			'infra/docker/postgres/10-roles.sh',
			'infra/docker/postgres/tls-init.sh',
			'infra/kubernetes/kustomization.yaml',
			'infra/kubernetes/deployment.yaml',
			'docs/sandbox.md',
			'docs/cli.md',
			'docs/getting-started.md',
			'docs/cli-extensions.md',
			'docs/module-web-surfaces.md',
		]) {
			expect(await exists(join(result.directory, path)), path).toBe(true);
		}
		expect(manifest.scripts.sandbox).toContain('@flowdular/sandbox');
		expect(manifest.scripts.verify).toContain('spec validate --all');
	});

	it('names the application spec after the directory it scaffolds into', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my.app_1',
			template: 'default',
			force: false,
		});

		const spec = await readFile(
			join(result.directory, 'specs/application.yaml'),
			'utf8',
		);
		expect(spec).toContain('id: application.my-app-1');
		expect(spec).toContain('status: approved');
		expect(spec).not.toContain('application.app-name');
	});

	it('documents every production key it cannot generate a value for', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		const example = await readFile(
			join(result.directory, '.env.example'),
			'utf8',
		);
		for (const key of [
			...SECRET_KEYS,
			/* Rotation needs the retired key alongside the new one; an operator
			   who cannot see it here replaces the key and loses what it sealed. */
			...SECRET_KEYS.filter((key) => key !== 'FD_AGENT_RUN_GRANT_KEY').map(
				(key) => `${key}_PREVIOUS`,
			),
			'FD_DATABASE_URL',
			'FD_DATABASE_MIGRATOR_URL',
			'FD_DATABASE_BACKGROUND_URL',
			'FD_AUTH_SECURE_COOKIE',
			/* Both topologies in infra/ terminate TLS in front of the app. */
			'FD_TRUST_PROXY',
			'FD_AUTH_MAIL_TRANSPORT',
			'FD_AUTH_SMTP_URL',
			'FD_AUTH_MAIL_FROM',
		]) {
			expect(example, key).toContain(`\n${key}=`);
		}
		/* A placeholder file that leaked a real value would be committed. */
		for (const key of SECRET_KEYS) {
			expect(example, key).toContain(`\n${key}=\n`);
		}
	});

	it('restores the ignore file npm cannot ship under its real name', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		expect(await exists(join(result.directory, '.gitignore'))).toBe(true);
		expect(await exists(join(result.directory, '_gitignore'))).toBe(false);
		expect(
			await readFile(join(result.directory, '.gitignore'), 'utf8'),
		).toContain('.env');
	});

	it('keeps every environment file out of the docker build context', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		const ignore = await readFile(
			join(result.directory, '.dockerignore'),
			'utf8',
		);
		/* infra/README.md tells the operator to write infra/docker/.env, and
		   "COPY . ." in infra/docker/Dockerfile would otherwise bake it in. */
		for (const path of [
			'.env',
			'.env.local',
			'.env.production',
			'infra/docker/.env',
			'platform/.env.local',
		]) {
			expect(excluded(ignore, path), path).toBe(true);
		}
		for (const path of ['.env.example', 'infra/docker/.env.example']) {
			expect(excluded(ignore, path), path).toBe(false);
		}
	});

	it('writes an .env whose keys differ between two scaffolds', async () => {
		const cwd = await workspace();

		const first = await scaffold({
			cwd,
			target: 'first',
			template: 'default',
			force: false,
		});
		const second = await scaffold({
			cwd,
			target: 'second',
			template: 'default',
			force: false,
		});

		const read = async (directory: string) => {
			const contents = await readFile(join(directory, '.env'), 'utf8');
			return SECRET_KEYS.map(
				(key) =>
					contents
						.split('\n')
						.find((line) => line.startsWith(`${key}=`))
						?.slice(key.length + 1) ?? '',
			);
		};
		const firstKeys = await read(first.directory);
		const secondKeys = await read(second.directory);

		expect(firstKeys.every((value) => value.length > 0)).toBe(true);
		for (const [index, value] of firstKeys.entries()) {
			expect(secondKeys[index]).not.toBe(value);
		}
	});

	it('resolves every relative link its guidance and documentation carry', async () => {
		const cwd = await workspace();

		const result = await scaffold({
			cwd,
			target: 'my-app',
			template: 'default',
			force: false,
		});

		/* An agent follows these links inside the generated workspace, so a
		   document the copy list forgot reads as a missing capability. */
		const broken: string[] = [];
		for (const directory of ['docs', '.ai']) {
			for (const file of await markdownFiles(
				join(result.directory, directory),
			)) {
				const source = await readFile(file, 'utf8');
				for (const match of source.matchAll(MARKDOWN_LINK)) {
					const target = match[1] ?? '';
					const path = target.split('#')[0] ?? '';
					if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
					if (await exists(resolve(dirname(file), path))) continue;
					broken.push(`${relative(result.directory, file)} -> ${target}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it('refuses a directory that is not empty', async () => {
		const cwd = await workspace();
		await scaffold({ cwd, target: 'taken', template: 'default', force: false });

		await expect(
			scaffold({ cwd, target: 'taken', template: 'default', force: false }),
		).rejects.toBeInstanceOf(ScaffoldError);
		await expect(
			scaffold({ cwd, target: 'taken', template: 'default', force: false }),
		).rejects.toThrow(/not empty/);
	});

	it('scaffolds into a directory that is not empty with force', async () => {
		const cwd = await workspace();
		const target = join(cwd, 'occupied');
		await scaffold({
			cwd,
			target: 'occupied',
			template: 'default',
			force: false,
		});
		await writeFile(join(target, 'NOTES.md'), 'keep me');

		const result = await scaffold({
			cwd,
			target: 'occupied',
			template: 'default',
			force: true,
		});

		expect(result.name).toBe('occupied');
		expect(await readFile(join(target, 'NOTES.md'), 'utf8')).toBe('keep me');
	});

	it('refuses a directory name npm would reject as a package name', async () => {
		const cwd = await workspace();

		await expect(
			scaffold({ cwd, target: 'My App', template: 'default', force: false }),
		).rejects.toThrow(/not a valid npm package name/);
	});

	it('refuses a template it does not ship', async () => {
		const cwd = await workspace();

		await expect(
			scaffold({ cwd, target: 'my-app', template: 'missing', force: false }),
		).rejects.toThrow(/not a template/);
		expect(await exists(join(cwd, 'my-app'))).toBe(false);
	});
});
