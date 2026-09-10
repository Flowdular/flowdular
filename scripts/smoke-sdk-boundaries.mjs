import { readFile, writeFile, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
const consumer = resolve(process.argv[2]);
const require = createRequire(join(consumer, 'platform/package.json'));
const sdk = dirname(require.resolve('@flowdular/sdk/package.json'));
for (const removed of ['sandbox', 'coding-agent']) {
	try {
		await access(join(sdk, 'packages', removed));
		throw new Error(
			'The SDK still contains coding application code: ' + removed,
		);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}
const { build: viteBuild } = await import(require.resolve('vite'));
const { octane } = await import(require.resolve('@octanejs/vite-plugin'));
const probe = join(consumer, 'platform/ui-boundary.ts');
await writeFile(probe, "export {Button} from '@flowdular/sdk/ui';");
let ids = [];
try {
	await viteBuild({
		root: consumer,
		configFile: false,
		plugins: [
			octane(),
			{
				name: 'check-sdk-browser-boundary',
				generateBundle() {
					ids = [...this.getModuleIds()];
				},
			},
		],
		build: {
			target: 'esnext',
			write: false,
			lib: { entry: probe, formats: ['es'], fileName: 'ui' },
			minify: false,
		},
		logLevel: 'warn',
	});
} finally {
	await rm(probe);
}
const backend = ids.filter((p) =>
	/sdk\/(?:modules\/|packages\/(?:server|database|sandbox|harness|coding-agent|ai-provider)\/)/.test(
		p,
	),
);
if (ids.some((id) => id.includes('__vite-browser-external')))
	throw new Error('Browser UI has a Node-only import');
if (backend.length) throw new Error('UI imports backend: ' + backend.join(','));
console.log(
	'Octane browser UI build: ' +
		ids.length +
		' inputs; no server, database, agent, sandbox or core-module code.',
);
const metadata = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
if (metadata.exports['.']) throw new Error('Unexpected root barrel');
if (
	metadata.bin ||
	metadata.exports['./sandbox'] ||
	metadata.exports['./sandbox/server'] ||
	metadata.exports['./coding-agent']
)
	throw new Error('The SDK exposes the standalone coding sandbox.');
if (Object.keys(metadata.dependencies).some((n) => n.startsWith('@flowdular/')))
	throw new Error('SDK depends on an unpublished internal package');
console.log('SDK dependency and export boundaries pass.');
