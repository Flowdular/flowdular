import {
	access,
	cp,
	mkdtemp,
	readFile,
	readdir,
	writeFile,
} from 'node:fs/promises';
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
	'.ai/platform-capabilities.md',
	'.ai/guides/application-development.md',
	'.ai/agents/reviewer.md',
	'.ai/skills/auto-review/SKILL.md',
	'.ai/references/catalog/module.json',
	'.agents/skills/module-new/SKILL.md',
	'.claude/skills/auto-review/SKILL.md',
	'.claude/agents/reviewer.md',
	'.codex/agents/reviewer.toml',
	'AGENTS.md',
	'CLAUDE.md',
	'rulesync.jsonc',
	'docs/agent-contract.md',
	'docs/module-distribution.md',
	'docs/sandbox.md',
	'specs/application.yaml',
	'infra/docker/Dockerfile',
	'render.yaml',
	'.env.example',
])
	await access(join(consumer, path));
const renderBlueprint = await readFile(join(consumer, 'render.yaml'), 'utf8');
if (renderBlueprint !== (await readFile(join(root, 'render.yaml'), 'utf8')))
	throw new Error('Packed generator Render Blueprint differs from the source.');
if (
	!renderBlueprint.includes('runtime: docker') ||
	!renderBlueprint.includes('key: FD_DATABASE_MIGRATOR_URL')
)
	throw new Error('Packed generator Render Blueprint is incomplete.');
try {
	await access(join(consumer, '.claude/settings.local.json'));
	throw new Error('Generator copied personal Claude settings.');
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
}
// Exercise the same build-script policy as a normal generated-app install.
run(['install']);
const firstRun = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-application-first-run.mjs'), consumer],
	{ stdio: 'inherit', timeout: 240000 },
);
if (firstRun.status !== 0)
	throw new Error('Fresh application sandbox provisioning failed.');
// The packed SDK is the sandbox reference fallback for a workspace without its
// own .ai tree, so it must carry the capability card the skills cite.
await access(
	join(
		consumer,
		'platform/node_modules/@flowdular/sdk/.ai/platform-capabilities.md',
	),
);
// Only the fixture's tarball overrides were appended outside the formatter.
run(['exec', 'prettier', '--write', 'pnpm-workspace.yaml']);
run(['rules:check']);
run(['flowdular', 'doctor', '--json']);
run(['flowdular', 'blueprint', 'validate', '--all']);
run(['flowdular', 'setup', 'quick', '--json']);
const setupEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('FD_')),
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
const stops = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-application-stop.mjs'), consumer],
	{ stdio: 'inherit', timeout: 300000 },
);
if (stops.status !== 0)
	throw new Error('Initialized application did not drain when stopped.');
run(['flowdular', 'module', 'validate', '--json']);
if (process.argv[3]) {
	const catalogPath = resolve(process.argv[3]);
	const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
	run([
		'flowdular',
		'module',
		'source',
		'add',
		'smoke',
		catalogPath,
		'--apply',
	]);
	for (const id of [
		...new Set(catalog.releases.map((release) => release.manifest.id)),
	]) {
		let installed = false;
		try {
			const lock = JSON.parse(
				await readFile(join(consumer, 'flowdular.modules.lock.json'), 'utf8'),
			);
			installed = lock.modules.some((entry) => entry.id === id);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		if (!installed) {
			run(['flowdular', 'module', 'plan', id, '--source', 'smoke', '--apply']);
			const planFiles = await readdir(join(consumer, 'module-plans'));
			const plans = await Promise.all(
				planFiles.map(async (file) =>
					JSON.parse(
						await readFile(join(consumer, 'module-plans', file), 'utf8'),
					),
				),
			);
			const matches = plans.filter((plan) => plan.target === id);
			if (matches.length !== 1)
				throw new Error(`Expected one saved plan for ${id}.`);
			run(['flowdular', 'module', 'apply', matches[0].id, '--apply']);
		}
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
const bundledFirstRun = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-built-first-run-root.mjs'), consumer],
	{ stdio: 'inherit', timeout: 45_000 },
);
if (bundledFirstRun.status !== 0)
	throw new Error('Bundled first-run workspace root check failed.');
const deployedModules = spawnSync(
	process.execPath,
	[join(root, 'scripts/smoke-deployed-modules.mjs'), consumer],
	{ stdio: 'inherit', timeout: 180_000 },
);
if (deployedModules.status !== 0)
	throw new Error('Deployed module manifest check failed.');
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
