import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sdkSource } from './sdk-source.mjs';

// Build-time inputs are explicit. Never copy a developer's tool settings,
// credentials, transcripts or personal agent configuration into an app.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'packages/create-flowdular/agent-template');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of [
	'.ai/README.md',
	'.ai/platform-capabilities.md',
	'.ai/agents',
	'.ai/blueprints',
	'.ai/examples',
	'.ai/guides',
	'.ai/policies',
	'.ai/rules',
	'.ai/skills',
	'.ai/references',
	'docs/agent-contract.md',
	'docs/adr',
	'docs/design-system.md',
	'docs/modules.md',
	'docs/module-distribution.md',
	'docs/database-adapters.md',
	'docs/configuration.md',
	'docs/getting-started.md',
	'docs/cli.md',
	'docs/cli-extensions.md',
	'docs/module-web-surfaces.md',
	'docs/sandbox.md',
	'rulesync.jsonc',
	'platform/scripts/build.mjs',
]) {
	await cp(join(root, path), join(output, path), { recursive: true });
}
// Copied once it exists upstream; a release before then still builds.
for (const path of ['docs/operations.md']) {
	try {
		await cp(join(root, path), join(output, path));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}
async function rewrite(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (path === join(output, '.ai/references')) continue;
			await rewrite(path);
		} else if (/\.(?:md|ts|tsrx|json)$/.test(entry.name)) {
			const source = await readFile(path, 'utf8');
			// Package selectors name module workspaces, not SDK import subpaths.
			const filters = [];
			const protectedSource = source.replace(
				/--filter\s+@flowdular\/[a-z0-9-]+/g,
				(filter) => {
					filters.push(filter);
					return `FLOWDULAR_FILTER_${filters.length - 1}`;
				},
			);
			await writeFile(
				path,
				sdkSource(protectedSource)
					.replace(
						/FLOWDULAR_FILTER_(\d+)/g,
						(_, index) => filters[Number(index)],
					)
					// Monorepo-relative links to packages the SDK does not ship.
					.replace(
						/\]\(\.\.\/packages\/sandbox\/README\.md\)/g,
						'](https://github.com/flowdular/flowdular/blob/main/packages/sandbox/README.md)',
					)
					// Releasing the SDK is a core-repository procedure, not an
					// application one, so that document is never copied out.
					.replace(
						/\]\(npm-publication\.md\)/g,
						'](https://github.com/flowdular/flowdular/blob/main/docs/npm-publication.md)',
					),
			);
		}
	}
}
await rewrite(output);
const rules = join(output, '.ai/rules/flowdular.md');
await writeFile(
	rules,
	(await readFile(rules, 'utf8')) +
		`
## Application workspace

For application work, use the path and task map in
.ai/guides/application-development.md.

This is a generated application consuming the published Flowdular SDK. Extend
this application's modules; never edit installed dependencies. Upstream paths
such as packages/server and core modules/auth refer to the read-only SDK under
platform/node_modules/@flowdular/sdk after installation. Sandbox implementation
sources belong to the separate @flowdular/sandbox package. A core change must be
made in the Flowdular repository and released before this application uses it.

The skills and examples use @flowdular/sdk subpath imports. For pnpm --filter,
read the actual module package name from its package.json. Use pnpm verify and
pnpm build for this application. Root .ai files are editable project guidance;
run pnpm rules:generate after changing rules or skills, then pnpm rules:check.
AGENTS.md, CLAUDE.md, .agents/skills and .claude/skills are generated copies.
`,
);
const generated = spawnSync(
	join(root, 'node_modules/.bin/rulesync'),
	['generate'],
	{
		cwd: output,
		stdio: 'inherit',
	},
);
if (generated.error) throw generated.error;
if (generated.status !== 0)
	throw new Error('Agent template RuleSync generation failed.');
