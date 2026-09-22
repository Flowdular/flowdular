// Renders the raster brand assets from HTML with headless Chrome:
// the Open Graph card, the README hero and banner and the GitHub avatar.
// Run: node scripts/brand-assets.mjs [--out <dir>]
// Chrome is found at CHROME or the macOS default install.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const outIndex = process.argv.indexOf('--out');
const out = outIndex === -1 ? root : resolve(process.argv[outIndex + 1]);
const chrome =
	process.env.CHROME ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9377;

const require = createRequire(resolve(root, 'packages/ui/package.json'));
const fontDir = dirname(
	require.resolve('@fontsource-variable/ibm-plex-sans/package.json'),
);
const font = pathToFileURL(
	resolve(fontDir, 'files/ibm-plex-sans-latin-wght-normal.woff2'),
).href;

const NAVY = '#101728';
const INK = '#f4f6fb';
const COPPER = '#e08a45';
const MUTED = '#a7b0c0';

const mark = (size, ink = INK, accent = COPPER) => `
<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
	<rect x="2" y="3" width="20" height="5" rx="2.5" fill="${ink}"/>
	<rect x="8" y="10" width="14" height="5" rx="2.5" fill="${ink}"/>
	<rect x="14" y="17" width="8" height="5" rx="2.5" fill="${accent}"/>
</svg>`;

/* Five module tiles joined by copper paths: the flat version of the
   assembly the earlier renders showed. */
const modules = (width) => `
<svg viewBox="0 0 400 320" width="${width}" aria-hidden="true">
	<g fill="none" stroke="${COPPER}" stroke-width="6" stroke-linecap="round">
		<path d="M110 70h60v60"/>
		<path d="M290 70h-60v60"/>
		<path d="M110 250h60v-60"/>
		<path d="M290 250h-60v-60"/>
	</g>
	<g fill="#1c2540" stroke="#2c3757" stroke-width="2">
		<rect x="30" y="30" width="80" height="80" rx="18"/>
		<rect x="290" y="30" width="80" height="80" rx="18"/>
		<rect x="30" y="210" width="80" height="80" rx="18"/>
		<rect x="290" y="210" width="80" height="80" rx="18"/>
	</g>
	<rect x="150" y="110" width="100" height="100" rx="22" fill="${COPPER}"/>
	<g transform="translate(200 160) scale(2.6) translate(-12 -12)">
		<rect x="2" y="3" width="20" height="5" rx="2.5" fill="${NAVY}"/>
		<rect x="8" y="10" width="14" height="5" rx="2.5" fill="${NAVY}"/>
		<rect x="14" y="17" width="8" height="5" rx="2.5" fill="${INK}"/>
	</g>
</svg>`;

const page = (width, height, body) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face{font-family:'Plex';src:url('${font}') format('woff2');font-weight:100 900}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
body{background:${NAVY};color:${INK};font-family:'Plex',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.card{position:relative;width:${width}px;height:${height}px;display:flex;align-items:center}
.copy{display:flex;flex-direction:column;gap:0}
.brand{display:flex;align-items:center;gap:22px}
.word{font-weight:700;letter-spacing:-0.03em;line-height:1}
.line{font-weight:600;letter-spacing:-0.025em;line-height:1.08}
.warm{color:#f6e7d4}
.site{color:${MUTED};font-weight:500}
.art{position:absolute;right:0;top:0;bottom:0;display:flex;align-items:center}
</style></head><body>${body}</body></html>`;

const og = page(
	1200,
	630,
	`<div class="card">
	<div class="copy" style="padding-left:72px;gap:0">
		<div class="brand">${mark(92)}<span class="word" style="font-size:88px">Flowdular</span></div>
		<div class="line" style="font-size:60px;margin-top:64px">Your business.</div>
		<div class="line warm" style="font-size:60px">Your building blocks.</div>
		<div class="site" style="font-size:26px;margin-top:64px">flowdular.com</div>
	</div>
	<div class="art" style="right:72px">${modules(400)}</div>
</div>`,
);

const hero = page(
	2164,
	727,
	`<div class="card">
	<div class="copy" style="padding-left:110px">
		<div class="word" style="font-size:150px">Flowdular</div>
		<div class="line" style="font-size:54px;margin-top:44px">Your business.</div>
		<div class="line warm" style="font-size:54px">Your building blocks.</div>
		<div class="site" style="font-size:28px;margin-top:64px">flowdular.com</div>
	</div>
	<div class="art" style="right:140px;gap:80px;align-items:center">
		${mark(360)}
		${modules(520)}
	</div>
</div>`,
);

const banner = page(
	2000,
	672,
	`<div class="card">
	<div class="copy" style="padding-left:120px">
		<div class="brand" style="gap:40px">${mark(200)}<span class="word" style="font-size:170px">Flowdular</span></div>
		<div class="line" style="font-size:54px;margin-top:36px;padding-left:240px">Build your business platform.</div>
	</div>
	<div class="art" style="right:140px">${modules(520)}</div>
</div>`,
);

const avatar = page(
	1240,
	1240,
	`<div class="card" style="justify-content:center">${mark(900)}</div>`,
);

const jobs = [
	{ html: og, format: 'png', file: 'platform/public/og.png' },
	{ html: og, format: 'png', file: 'packages/sandbox/public/og.png' },
	{
		html: hero,
		format: 'webp',
		file: 'docs/assets/flowdular-readme-hero.webp',
	},
	{
		html: banner,
		format: 'webp',
		file: 'docs/assets/flowdular-readme-banner.webp',
	},
	{
		html: avatar,
		format: 'webp',
		file: 'docs/assets/flowdular-github-avatar.webp',
	},
];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
	if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}`);
	const profile = resolve(out, '.brand-assets-profile');
	const browser = spawn(chrome, [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--allow-file-access-from-files',
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'about:blank',
	]);
	try {
		let targets = [];
		for (let attempt = 0; attempt < 40 && targets.length === 0; attempt += 1) {
			await wait(250);
			try {
				targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			} catch {
				targets = [];
			}
		}
		const target = targets.find((entry) => entry.type === 'page');
		if (!target) throw new Error('Chrome exposed no page target');
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((open) => (ws.onopen = open));
		let id = 0;
		const pending = new Map();
		ws.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.id && pending.has(message.id)) {
				pending.get(message.id)(message.result);
				pending.delete(message.id);
			}
		};
		const send = (method, params = {}) =>
			new Promise((done) => {
				id += 1;
				pending.set(id, done);
				ws.send(JSON.stringify({ id, method, params }));
			});
		await send('Page.enable');
		for (const job of jobs) {
			const [width, height] = /width:(\d+)px;height:(\d+)px/
				.exec(job.html)
				.slice(1)
				.map(Number);
			await send('Emulation.setDeviceMetricsOverride', {
				width,
				height,
				deviceScaleFactor: 1,
				mobile: false,
			});
			const file = resolve(out, `.brand-assets-${job.format}.html`);
			writeFileSync(file, job.html);
			await send('Page.navigate', { url: pathToFileURL(file).href });
			await wait(1200);
			const shot = await send('Page.captureScreenshot', {
				format: job.format,
				quality: job.format === 'webp' ? 92 : undefined,
			});
			const path = resolve(out, job.file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, Buffer.from(shot.data, 'base64'));
			console.log('wrote', path);
		}
		ws.close();
	} finally {
		browser.kill('SIGKILL');
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
