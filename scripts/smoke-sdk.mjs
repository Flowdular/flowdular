import { access, cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(
	process.argv[2] ?? join(root, 'release-artifacts/sdk'),
);
const consumer = join(
	await mkdtemp(join(tmpdir(), 'flowdular-sdk-consumer-')),
	'my-app',
);
const manifest = JSON.parse(
	await readFile(join(artifacts, 'sdk.json'), 'utf8'),
);
const sandbox = manifest.packages.find(
	(pkg) => pkg.name === '@flowdular/sandbox',
);
if (!sandbox) throw new Error('Missing independent sandbox artifact.');
const generator = manifest.packages.find(
	(pkg) => pkg.name === 'create-flowdular',
);
if (!generator) throw new Error('Missing generator artifact.');
const unpack = await mkdtemp(join(tmpdir(), 'flowdular-generator-'));
const extracted = spawnSync(
	'tar',
	['-xzf', join(artifacts, generator.file), '-C', unpack],
	{ stdio: 'inherit' },
);
if (extracted.status !== 0)
	throw new Error('Cannot inspect the packed generator.');
const generated = spawnSync(
	process.execPath,
	[join(unpack, 'package/dist/bin.js'), consumer, '--no-install', '--no-git'],
	{ stdio: 'inherit' },
);
if (generated.status !== 0) throw new Error('Packed generator failed.');
const overrides = Object.fromEntries(
	manifest.packages
		.filter(
			(pkg) =>
				![
					'@flowdular/module-expenses',
					'@flowdular/module-parties',
					'@flowdular/module-catalog',
				].includes(pkg.name),
		)
		.map((pkg) => [pkg.name, `file:${join(artifacts, pkg.file)}`]),
);
// Override only the distribution channel; every dependency resolves from a
// packed artifact. No symlink or source alias back to the authoring repository.
const workspaceYaml = await readFile(
	join(consumer, 'pnpm-workspace.yaml'),
	'utf8',
);
await writeFile(
	join(consumer, 'pnpm-workspace.yaml'),
	workspaceYaml +
		'\noverrides:\n' +
		Object.entries(overrides)
			.map(
				([name, value]) =>
					`  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
			)
			.join('\n') +
		'\n',
);
function run(args, cwd = consumer) {
	const result = spawnSync('pnpm', args, {
		cwd,
		stdio: 'inherit',
		env: { ...process.env, CI: 'true' },
	});
	if (result.status !== 0)
		throw new Error(`Consumer failed: pnpm ${args.join(' ')} (${consumer})`);
}
console.log(`Clean SDK consumer: ${consumer}`);
for (const path of [
	'.ai/README.md',
	'.ai/guides/application-development.md',
	'.ai/agents/reviewer.md',
	'.ai/skills/auto-review/SKILL.md',
	'.ai/references/catalog/module.json',
	'.agents/skills/module-new/SKILL.md',
	'.claude/skills/auto-review/SKILL.md',
	'AGENTS.md',
	'CLAUDE.md',
	'rulesync.jsonc',
	'docs/agent-contract.md',
])
	await access(join(consumer, path));
try {
	await access(join(consumer, '.claude/settings.local.json'));
	throw new Error('Generator copied personal Claude settings.');
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
}
run(['install', '--ignore-scripts']);
// Only the fixture's tarball overrides were appended outside the formatter.
run(['exec', 'prettier', '--write', 'pnpm-workspace.yaml']);
run(['rules:check']);
run(['flowdular', 'doctor', '--json']);
run(['flowdular', 'blueprint', 'validate', '--all']);
run(['flowdular', 'setup', 'quick', '--json']);
const setupEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !key.startsWith('FD_') && !key.startsWith('CORELOOM_'),
	),
);
const setup = spawnSync(
	'pnpm',
	[
		'flowdular',
		'setup',
		'quick',
		'--apply',
		'--confirm',
		'reset-local-auth',
		'--json',
	],
	{
		cwd: consumer,
		stdio: 'inherit',
		env: {
			...setupEnvironment,
			NODE_ENV: 'development',
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: join(consumer, '.flowdular/test-setup'),
		},
	},
);
if (setup.status !== 0) throw new Error('Fresh consumer quick setup failed.');
const application = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-application-setup.mjs'), consumer],
	{ stdio: 'inherit', timeout: 90000 },
);
if (application.status !== 0)
	throw new Error('Initialized application startup failed.');
run(['flowdular', 'module', 'validate', '--json']);
if (process.argv[3]) {
	const registry = resolve(process.argv[3]);
	const catalog = JSON.parse(await readFile(registry, 'utf8'));
	for (const id of [
		...new Set(catalog.releases.map((release) => release.manifest.id)),
	]) {
		run([
			'flowdular',
			'module',
			'install',
			id,
			'--registry',
			registry,
			'--apply',
		]);
		// Use the same source-composition API as module enable. Scope grants need
		// an operator/tenant and are exercised separately by the auth CLI tests.
		const code = `import {enableModule} from 'flowdular/distribution'; import {readFile} from 'node:fs/promises'; const root=process.cwd(); const configPath=root+'/flowdular.json'; const config=JSON.parse(await readFile(configPath,'utf8')); await enableModule({root,configPath,config},${JSON.stringify(id)},true);`;
		const enabled = spawnSync(
			process.execPath,
			['--input-type=module', '-e', code],
			{ cwd: consumer, stdio: 'inherit', env: { ...process.env, CI: 'true' } },
		);
		if (enabled.status !== 0) throw new Error(`Module enable failed: ${id}`);
	}
	run(['flowdular', 'module', 'validate', '--locked']);
}
run(['verify']);
run(['build']);
const boundaries = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-sdk-boundaries.mjs'), consumer],
	{ stdio: 'inherit' },
);
if (boundaries.status !== 0)
	throw new Error('SDK public entrypoint check failed.');
// Model npm-exec: the tool and its SDK live outside the consumer workspace.
const runner = await mkdtemp(join(tmpdir(), 'flowdular-sandbox-runner-'));
await writeFile(
	join(runner, 'package.json'),
	JSON.stringify({
		private: true,
		type: 'module',
		dependencies: { '@flowdular/sandbox': overrides['@flowdular/sandbox'] },
	}),
);
await writeFile(
	join(runner, 'pnpm-workspace.yaml'),
	'overrides:\n' +
		Object.entries(overrides)
			.map(
				([name, value]) =>
					`  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
			)
			.join('\n') +
		'\n',
);
run(['install', '--ignore-scripts'], runner);
const sandboxSmoke = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-sandbox-package.mjs'), consumer, runner],
	{ stdio: 'inherit' },
);
if (sandboxSmoke.status !== 0)
	throw new Error('Standalone sandbox consumer check failed.');
console.log(`SDK consumer passed: ${consumer}`);
