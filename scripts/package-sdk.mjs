import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import members from './sdk-members.json' with { type: 'json' };
import expected from './sdk-packages.json' with { type: 'json' };
import { sdkSource } from './sdk-source.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'release-artifacts/sdk'));
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, '.staging-'));
try {
	async function json(path) {
		return JSON.parse(await readFile(path, 'utf8'));
	}
	async function save(path, value) {
		await writeFile(path, JSON.stringify(value, null, '\t') + '\n');
	}
	function run(command, args, cwd = root) {
		const result = spawnSync(command, args, {
			cwd,
			encoding: 'utf8',
			stdio: 'pipe',
		});
		if (result.status !== 0)
			throw new Error(
				`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
			);
		return result.stdout;
	}
	async function copyMember(from, to, pkg) {
		await mkdir(to, { recursive: true });
		for (const path of new Set(['package.json', ...(pkg.files ?? [])])) {
			try {
				await cp(join(from, path), join(to, path), { recursive: true });
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
		}
	}
	async function rewriteSources(directory, rewrite = sdkSource) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await rewriteSources(path, rewrite);
			else if (/\.(?:ts|tsrx|tsx|js|mjs|css|md)$/.test(entry.name))
				await writeFile(path, rewrite(await readFile(path, 'utf8')));
		}
	}
	const sdk = await json(join(root, 'packages/sdk/package.json'));
	sdk.exports = {
		'./package.json': './package.json',
		'./modules.json': './modules.json',
	};
	sdk.dependencies = {};
	const sdkRoot = join(staging, 'sdk');
	await mkdir(sdkRoot);
	const modules = [];
	for (const [name, member] of Object.entries(members)) {
		const source = join(root, member.directory);
		const pkg = await json(join(source, 'package.json'));
		if (pkg.name !== name)
			throw new Error(`SDK member identity changed: ${name}`);
		await copyMember(source, join(sdkRoot, member.directory), pkg);
		for (const [key, value] of Object.entries(pkg.exports ?? {})) {
			if (typeof value !== 'string' || !value.startsWith('./'))
				throw new Error(`Unsupported SDK export: ${name} ${key}`);
			sdk.exports[`./${member.export}${key === '.' ? '' : key.slice(1)}`] =
				`./${member.directory}/${value.slice(2)}`;
		}
		for (const [dependency, version] of Object.entries(
			pkg.dependencies ?? {},
		)) {
			if (members[dependency]) continue;
			if (dependency.startsWith('@flowdular/'))
				throw new Error(`Unbundled SDK dependency: ${dependency}`);
			if (
				sdk.dependencies[dependency] &&
				sdk.dependencies[dependency] !== version
			)
				throw new Error(`Conflicting SDK dependency: ${dependency}`);
			sdk.dependencies[dependency] = version;
		}
		if (member.directory.startsWith('modules/'))
			modules.push({
				manifest: `${member.directory}/module.json`,
				import: `@flowdular/sdk/${member.export}`,
			});
	}
	await rewriteSources(sdkRoot);
	// Sandbox reference preparation uses the same layout as the authoring repository.
	for (const path of [
		'.ai/skills',
		'.ai/blueprints',
		'.ai/agents',
		'.ai/policies',
		'.ai/references/catalog',
		'.ai/references/catalog.provenance.json',
		'docs/design-system.md',
		'docs/agent-contract.md',
		'tsconfig.base.json',
		'AGENTS.md',
		'LICENSE',
	])
		await cp(join(root, path), join(sdkRoot, path), { recursive: true });
	await rewriteSources(join(sdkRoot, '.ai/skills'));
	await rewriteSources(join(sdkRoot, 'docs'));
	await save(join(sdkRoot, 'modules.json'), { schemaVersion: 1, modules });
	await save(join(sdkRoot, 'package.json'), sdk);
	await cp(join(root, 'packages/sdk/README.md'), join(sdkRoot, 'README.md'));
	await cp(join(root, 'packages/sdk/assets'), join(sdkRoot, 'assets'), {
		recursive: true,
	});
	run('pnpm', ['--filter', '@flowdular/cli', 'build']);
	run('pnpm', ['--filter', 'create-flowdular', 'build']);
	const cli = await json(join(root, 'packages/cli/package.json'));
	cli.name = 'flowdular';
	delete cli.private;
	cli.publishConfig = { access: 'public' };
	cli.exports = {
		'.': './dist/index.js',
		'./distribution': './dist/distribution.js',
	};
	cli.dependencies = Object.fromEntries(
		Object.entries(cli.dependencies).filter(([name]) => !members[name]),
	);
	cli.dependencies['@flowdular/sdk'] = sdk.version;
	delete cli.devDependencies;
	delete cli.scripts;
	cli.files = ['dist', 'README.md', 'LICENSE', 'assets'];
	const cliRoot = join(staging, 'cli');
	await mkdir(cliRoot);
	await cp(join(root, 'packages/cli/dist'), join(cliRoot, 'dist'), {
		recursive: true,
	});
	await cp(join(root, 'LICENSE'), join(cliRoot, 'LICENSE'));
	await cp(join(root, 'packages/cli/README.md'), join(cliRoot, 'README.md'));
	await cp(join(root, 'packages/cli/assets'), join(cliRoot, 'assets'), {
		recursive: true,
	});
	await save(join(cliRoot, 'package.json'), cli);
	const generatorRoot = join(staging, 'generator');
	const generator = await json(
		join(root, 'packages/create-flowdular/package.json'),
	);
	await copyMember(
		join(root, 'packages/create-flowdular'),
		generatorRoot,
		generator,
	);
	delete generator.scripts;
	delete generator.devDependencies;
	await save(join(generatorRoot, 'package.json'), generator);
	await cp(join(root, 'LICENSE'), join(generatorRoot, 'LICENSE'));
	// The coding application is an independent SDK consumer, not an SDK member.
	const sandboxRoot = join(staging, 'sandbox');
	const sandbox = await json(join(root, 'packages/sandbox/package.json'));
	await copyMember(join(root, 'packages/sandbox'), sandboxRoot, sandbox);
	// Only the sandbox consumes coding-agent. Keep its drivers with the app.
	const codingAgent = await json(
		join(root, 'packages/coding-agent/package.json'),
	);
	await copyMember(
		join(root, 'packages/coding-agent'),
		join(sandboxRoot, 'internal/coding-agent'),
		codingAgent,
	);
	await rewriteSources(sandboxRoot, (source) =>
		sdkSource(source).replaceAll('@flowdular/coding-agent', '#coding-agent'),
	);
	sandbox.imports = { '#coding-agent': './internal/coding-agent/src/index.ts' };
	sandbox.files = [...sandbox.files, 'internal'];
	const sandboxDependencies = {};
	for (const dependencies of [codingAgent.dependencies, sandbox.dependencies]) {
		for (const [name, version] of Object.entries(dependencies)) {
			if (members[name] || name === '@flowdular/coding-agent') continue;
			if (name.startsWith('@flowdular/') || version.startsWith('workspace:'))
				throw new Error(`Unbundled sandbox dependency: ${name}`);
			if (sandboxDependencies[name] && sandboxDependencies[name] !== version)
				throw new Error(`Conflicting sandbox dependency: ${name}`);
			sandboxDependencies[name] = version;
		}
	}
	sandbox.dependencies = sandboxDependencies;
	sandbox.dependencies['@flowdular/sdk'] = sdk.version;
	sandbox.publishConfig = { access: 'public' };
	delete sandbox.private;
	delete sandbox.devDependencies;
	delete sandbox.scripts;
	await save(join(sandboxRoot, 'package.json'), sandbox);
	await cp(join(root, 'LICENSE'), join(sandboxRoot, 'LICENSE'));
	// The executable must run in plain Node before Vite can transform SDK source.
	run('pnpm', [
		'--filter',
		'@flowdular/cli',
		'exec',
		'esbuild',
		'../sandbox/bin/flowdular-sandbox.mjs',
		'--bundle',
		'--platform=node',
		'--format=esm',
		'--external:vite',
		'--external:./register-types.mjs',
		'--outfile=' + join(sandboxRoot, 'bin/flowdular-sandbox.mjs'),
	]);
	const records = [];
	for (const directory of [sdkRoot, cliRoot, generatorRoot, sandboxRoot]) {
		const pkg = await json(join(directory, 'package.json'));
		const result = JSON.parse(
			run(
				'npm',
				['pack', '--ignore-scripts', '--json', '--pack-destination', output],
				directory,
			),
		)[0];
		const bytes = await readFile(join(output, result.filename));
		records.push({
			name: pkg.name,
			version: pkg.version,
			file: result.filename,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		});
	}
	if (JSON.stringify(records.map((p) => p.name)) !== JSON.stringify(expected))
		throw new Error('Unexpected public package set.');
	await save(join(output, 'sdk.json'), { schemaVersion: 1, packages: records });
	console.log(
		`Packed exactly ${records.length} public packages into ${output}`,
	);
} finally {
	await rm(staging, { recursive: true, force: true });
}
