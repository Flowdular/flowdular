import assert from 'node:assert/strict';
import {
	mkdtemp,
	mkdir,
	writeFile,
	symlink,
	readdir,
	rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// An isolated test module, not an enabled business module in the operator's app.
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'flowdular-web-smoke-'));
let server;
let output = '';
const write = async (path, text) => {
	await mkdir(resolve(directory, path, '..'), { recursive: true });
	await writeFile(join(directory, path), text);
};
const run = (args, cwd = directory) =>
	new Promise((resolveResult, reject) => {
		const child = spawn(process.execPath, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let log = '';
		child.stdout.on('data', (value) => {
			log += value;
		});
		child.stderr.on('data', (value) => {
			log += value;
		});
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolveResult(log) : reject(new Error(log)),
		);
	});

try {
	await mkdir(join(directory, 'platform/node_modules'), { recursive: true });
	for (const name of await readdir(join(root, 'platform/node_modules'))) {
		if (name.startsWith('.')) continue;
		await symlink(
			join(root, 'platform/node_modules', name),
			join(directory, 'platform/node_modules', name),
		);
	}
	await mkdir(join(directory, 'platform/node_modules/@fixture'), {
		recursive: true,
	});
	await symlink(
		join(directory, 'modules/demo'),
		join(directory, 'platform/node_modules/@fixture/module'),
	);
	await write(
		'package.json',
		JSON.stringify({ private: true, type: 'module' }),
	);
	await write(
		'flowdular.json',
		JSON.stringify({
			modules: { roots: ['modules'], enabled: ['demo.core'] },
			application: { path: '/app' },
			web: {
				mounts: [
					{
						id: 'store',
						moduleId: 'demo.core',
						surfaceId: 'site',
						path: '/',
						tenantId: 'tenant-root',
					},
					{
						id: 'acme',
						moduleId: 'demo.core',
						surfaceId: 'site',
						path: '/blog',
						tenantId: 'tenant-a',
					},
					{
						id: 'other',
						moduleId: 'demo.core',
						surfaceId: 'site',
						path: '/sites/other',
						tenantId: 'tenant-b',
					},
				],
			},
		}),
	);
	await write(
		'modules/demo/module.json',
		JSON.stringify({
			schemaVersion: 1,
			id: 'demo.core',
			package: '@fixture/module',
			version: '1.0.0',
			profile: 'full',
			capabilities: ['api'],
			dependencies: [],
			tenancy: 'required',
			locales: ['en'],
			stability: 'experimental',
			platform: { server: true },
		}),
	);
	await write(
		'modules/demo/package.json',
		JSON.stringify({
			name: '@fixture/module',
			type: 'module',
			exports: {
				'./platform': './src/platform.ts',
				'./web': './src/Page.tsrx',
				'./layout': './src/Layout.tsrx',
			},
		}),
	);
	await symlink(
		join(directory, 'platform/node_modules'),
		join(directory, 'modules/demo/node_modules'),
	);
	await write(
		'modules/demo/src/platform.ts',
		`import { defineWebSurface } from '@flowdular/server';
export function createServerComposition() { return { routes: [], web: [defineWebSurface({ id: 'site', pages: [
{id:'home',path:'/',entry:['Page','@fixture/module/web'],access:{kind:'public'},load:({site})=>({title:'Home '+site.tenantId})},
{ id: 'record', path: '/records/:slug', entry: ['Page', '@fixture/module/web'], layout: '@fixture/module/layout', access: { kind: 'public' }, load: ({site,params}) => params.slug === 'draft' ? new Response('Not found', {status:404}) : { title: 'Published '+site.tenantId, slug: params.slug } },
{ id: 'private', path: '/private', entry: ['Page', '@fixture/module/web'], access: { kind: 'authenticated' }, load: () => ({title:'Secret'}) }
] })] }; }`,
	);
	await write(
		'modules/demo/src/Page.tsrx',
		`import { useState } from 'octane';
import { Head, Seo } from '@octanejs/seo';
import { webPageData } from '@flowdular/client/web';
export function Page(props) @{
const data = webPageData(props);
const [count, setCount] = useState(0);
<Head><Seo title={data.title} description="A module-owned public page" />
<main><h1>{data.title}</h1><p>{data.slug}</p><button onClick={() => setCount(count + 1)}>Count {count}</button></main></Head>
}`,
	);
	await write(
		'modules/demo/src/Layout.tsrx',
		`export default function Layout(props) @{ <section><header>Module layout</header>{props.children}</section> }`,
	);
	await write(
		'platform/package.json',
		JSON.stringify({ name: '@fixture/app', type: 'module', dependencies: {} }),
	);
	await write(
		'platform/vite.config.ts',
		`import { defineConfig } from 'vite'; import {octane} from '@octanejs/vite-plugin'; export default defineConfig({plugins:[octane()],build:{target:'esnext'}});`,
	);
	await write(
		'platform/octane.config.ts',
		`import { defineConfig } from '@octanejs/vite-plugin';
import {createModuleWebRoutes,assertRouteConflicts,createApplicationRoutes} from '@flowdular/server';
import {composeModuleServer,moduleWebMounts,applicationBasePath} from './src/generated/modules.server.ts';
const path = process.env.FD_APPLICATION_PATH ?? applicationBasePath;
const routes = [...createApplicationRoutes({path,entry:['App','/src/App.tsrx'],publicRoot:true}), ...createModuleWebRoutes({modules:composeModuleServer({agentDefinitions:{forModule:()=>({})}} as never),mounts:moduleWebMounts,applicationPath:path,resolveIdentity:()=>null})];
assertRouteConflicts(routes); export default defineConfig({router:{routes}});`,
	);
	await write(
		'platform/src/App.tsrx',
		`import {configureApplicationFromPage,applicationPath} from '@flowdular/client/routing';
export function App(props) @{ configureApplicationFromPage(props); <main><h1>Backoffice</h1><a href={applicationPath()}>Dashboard home</a></main> }`,
	);
	await write(
		'platform/index.html',
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><!--ssr-head--></head><body><div id="root"><!--ssr-body--></div></body></html>',
	);
	await run([
		join(root, 'packages/cli/dist/index.js'),
		'module',
		'sync',
		'--apply',
	]);
	await run(
		[join(root, 'platform/node_modules/vite/bin/vite.js'), 'build'],
		join(directory, 'platform'),
	);
	const port = await new Promise((resolvePort) => {
		const socket = createServer();
		socket.listen(0, '127.0.0.1', () => {
			const value = socket.address().port;
			socket.close(() => resolvePort(value));
		});
	});
	server = spawn(process.execPath, ['dist/server/entry.js'], {
		cwd: join(directory, 'platform'),
		env: {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			FD_APPLICATION_PATH: '/backoffice',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	server.stdout.on('data', (value) => {
		output += value;
	});
	server.stderr.on('data', (value) => {
		output += value;
	});
	const base = `http://127.0.0.1:${port}`;
	let response;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			response = await fetch(base + '/blog/records/same');
			break;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
	}
	assert(response, output);
	assert.equal(response.status, 200, await response.clone().text());
	const html = await response.text();
	assert.match(html, /Published tenant-a/);
	assert.match(html, /Module layout/);
	assert.match(html, /flowdular-web-data/);
	assert.match(html, /<title>Published tenant-a<\/title>/);
	assert.doesNotMatch(html, /AuthenticationCore|Sign in|noindex/);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal((await fetch(base + '/blog/records/draft')).status, 404);
	assert.equal((await fetch(base + '/blog/missing/deep')).status, 404);
	assert.equal((await fetch(base + '/blog/private')).status, 401);
	assert.match(
		await (await fetch(base + '/sites/other/records/same')).text(),
		/Published tenant-b/,
	);
	assert.deepEqual(
		await (
			await fetch(base + '/blog/records/same?tenantId=tenant-b', {
				headers: { accept: 'application/vnd.flowdular.page+json' },
			})
		).json(),
		{ title: 'Published tenant-a', slug: 'same' },
	);
	const home = await fetch(base + '/');
	assert.equal(home.status, 200);
	assert.match(await home.text(), /Home tenant-root/);
	const office = await fetch(base + '/backoffice');
	assert.equal(office.status, 200);
	assert.match(await office.text(), /href="\/backoffice"/);
	const legacy = await fetch(base + '/app/acme/settings?q=1', {
		redirect: 'manual',
	});
	assert.equal(legacy.status, 308);
	assert.equal(legacy.headers.get('location'), '/backoffice/acme/settings?q=1');
	console.log(
		`Production web smoke passed. Fixture: ${directory}. URL: ${base}/blog/records/same`,
	);
	if (process.env.FD_WEB_SMOKE_KEEP === 'true') {
		console.log(
			'Keeping fixture and server for browser inspection. Stop with Ctrl-C.',
		);
		await new Promise((resolveStop) => {
			process.once('SIGTERM', resolveStop);
			process.once('SIGINT', resolveStop);
		});
	}
} finally {
	server?.kill('SIGTERM');
	if (process.env.FD_WEB_SMOKE_KEEP !== 'true')
		await rm(directory, { recursive: true, force: true });
}
