// Renders a design fragment with the platform's own stylesheet, so a screen can
// be looked at before it is a component and long before the app boots.
//
// The fragment is markup and nothing else: no <html>, no <style>, no CSS rule.
// Everything visual comes from packages/ui, which is what keeps a preview from
// becoming a second source of truth about how the platform looks.
//
// Run: node scripts/ui-preview.mjs <fragment.html> [--shot <file.png>] [--open]
//      node scripts/ui-preview.mjs --scaffold <fragment.html>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parsePreviewArguments } from '../packages/cli/src/ui-preview-args.ts';

const root = new URL('..', import.meta.url).pathname;
const OUTPUT = join(root, '.flowdular', 'ui-preview');
/* The platform's own stylesheets, linked rather than copied, plus the shell's,
   which is what puts a screen inside the container the app gives it. */
const STYLESHEETS = [
	join(root, 'packages/ui/src/styles/index.css'),
	join(root, 'packages/client/src/shell/shell.css'),
];
const CHROME =
	process.env.FD_CHROME ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SCAFFOLD = `<!-- One screen, every state it can be in. Markup only: every class comes from
     packages/ui (docs/design-system.md) or this module's own stylesheet, and
     "pnpm ui-classes:check" refuses a class no stylesheet declares. -->
<section class="ui-view" data-state="populated">
	<header class="ui-page-head">
		<div class="ui-page-head__text">
			<span class="ui-page-head__eyebrow">Administration</span>
			<h1 class="ui-page-head__title">Screen name</h1>
			<p class="ui-page-head__description">One sentence on what a reader does here.</p>
		</div>
		<div class="ui-page-head__actions">
			<button class="ui-btn ui-btn--secondary ui-btn--sm" type="button">Refresh</button>
			<button class="ui-btn ui-btn--primary ui-btn--sm" type="button">New record</button>
		</div>
	</header>

	<section class="ui-card">
		<div class="ui-card__head">
			<h2 class="ui-card__title">Records <span class="ui-card__count">12 of 12</span></h2>
		</div>
		<div class="ui-table-wrap">
			<table class="ui-table">
				<caption class="ui-visually-hidden">Records of this workspace</caption>
				<thead>
					<tr>
						<th scope="col">Record</th>
						<th scope="col">Status</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<span class="ui-cell-stack">
								<span class="ui-cell-stack__primary">A realistic name</span>
								<span class="ui-cell-stack__secondary ui-cell-stack__line--mono">record-id</span>
							</span>
						</td>
						<td><span class="ui-tag ui-tag--success">active</span></td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
</section>

<section class="ui-view" data-state="loading">
	<section class="ui-card">
		<div class="ui-card__head">
			<h2 class="ui-card__title">Records</h2>
		</div>
		<div class="ui-table-wrap">
			<table class="ui-table">
				<thead>
					<tr>
						<th scope="col">Record</th>
						<th scope="col">Status</th>
					</tr>
				</thead>
				<tbody>
					<tr class="ui-table__placeholder">
						<td colspan="2">
							<div class="ui-table__placeholder-body ui-table__empty">Loading records…</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
</section>

<section class="ui-view" data-state="empty">
	<div class="ui-card">
		<div class="ui-empty">
			<span class="ui-empty__icon">
				<!-- One path from ICON_PATHS in packages/ui/src/icons/Icon.tsrx. -->
				<svg class="ui-icon" viewBox="0 0 24 24" width="18" height="18" stroke-width="1.75" aria-hidden="true">
					<path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />
				</svg>
			</span>
			<b>No records yet</b>
			<p>Name the first action a reader should take.</p>
		</div>
	</div>
</section>

<section class="ui-view" data-state="error">
	<p class="ui-alert ui-alert--danger" role="alert"><span>What failed, in the words a reader can act on.</span></p>
</section>

<section class="ui-view" data-state="denied">
	<div class="ui-card">
		<div class="ui-empty">
			<span class="ui-empty__icon">
				<!-- One path from ICON_PATHS in packages/ui/src/icons/Icon.tsrx. -->
				<svg class="ui-icon" viewBox="0 0 24 24" width="18" height="18" stroke-width="1.75" aria-hidden="true">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4" />
				</svg>
			</span>
			<b>Access denied</b>
			<p>Name the permission this screen needs.</p>
		</div>
	</div>
</section>
`;

function usage(message) {
	console.error(
		`${message}\nRun: node scripts/ui-preview.mjs <fragment.html> [--shot <file.png>] [--open]\n     node scripts/ui-preview.mjs --scaffold <fragment.html>`,
	);
	process.exit(1);
}

const argv = process.argv.slice(2);
const invocation = parsePreviewArguments(argv);
if (invocation.refusal) usage(invocation.refusal);
const { fragment: target, scaffold, shot, open: openInBrowser } = invocation;
const fragmentPath = isAbsolute(target)
	? target
	: resolve(process.cwd(), target);

if (scaffold) {
	await mkdir(dirname(fragmentPath), { recursive: true });
	await writeFile(fragmentPath, SCAFFOLD);
	console.log(
		`Wrote ${relative(root, fragmentPath)}. Edit the markup, then render it with node scripts/ui-preview.mjs ${relative(root, fragmentPath)}`,
	);
	process.exit(0);
}

let fragment;
try {
	fragment = await readFile(fragmentPath, 'utf8');
} catch {
	usage(`No fragment at ${target}.`);
}
if (/<(style|html|head|body)\b/i.test(fragment)) {
	usage(
		'A fragment is markup only. Delete the <style>, <html>, <head> or <body> it carries; the platform stylesheet is what dresses it.',
	);
}

/* The workspace stylesheet is linked, never copied: a preview shows what the
   platform looks like today, including a change made a minute ago. */
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${relative(root, fragmentPath)}</title>
${STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${sheet}" />`).join('\n')}
<style>
/* The only rules this harness owns, and they dress the harness alone: a strip
   naming each state and a rule between them. Everything a reader judges comes
   from the linked stylesheets, so a preview cannot drift from the platform.
   Namespaced so it can never reach a ui- class. */
.preview-state { border-top: 1px dashed var(--line-2); padding-top: 12px; }
.preview-state:first-of-type { border-top: 0; padding-top: 0; }
.preview-state__name {
	display: block;
	margin-bottom: 8px;
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--ink-3);
}
</style>
<script type="module">
/* Labels every state the fragment declares, so one page shows all five and a
   reader can tell which is which. */
for (const section of document.querySelectorAll('[data-state]')) {
	section.classList.add('preview-state');
	const name = document.createElement('span');
	name.className = 'preview-state__name';
	name.textContent = section.dataset.state;
	section.prepend(name);
}
</script>
</head>
<body>
<main class="workspace__content">
${fragment}
</main>
</body>
</html>
`;
await mkdir(OUTPUT, { recursive: true });
const rendered = join(
	OUTPUT,
	relative(root, fragmentPath).replaceAll('/', '-') || 'preview.html',
);
await writeFile(rendered, page);
console.log(`Rendered file://${rendered}`);

if (openInBrowser) {
	const [command, ...leading] =
		process.platform === 'darwin'
			? ['open']
			: process.platform === 'win32'
				? ['cmd', '/c', 'start', '']
				: ['xdg-open'];
	const opener = spawn(command, [...leading, rendered], { stdio: 'ignore' });
	const opened = await new Promise((settle) => {
		opener.once('error', () => settle(false));
		opener.once('close', (code) => settle(code === 0));
	});
	console.log(
		opened
			? 'Opened it in the default browser.'
			: `Could not open a browser here; the address above is the whole answer.`,
	);
}

if (shot) {
	const destination = isAbsolute(shot) ? shot : resolve(process.cwd(), shot);
	await mkdir(dirname(destination), { recursive: true });
	const chrome = spawn(
		CHROME,
		[
			'--headless',
			'--disable-gpu',
			'--hide-scrollbars',
			'--window-size=1440,1200',
			`--screenshot=${destination}`,
			`file://${rendered}`,
		],
		{ stdio: 'ignore' },
	);
	const code = await new Promise((settle) => chrome.once('close', settle));
	if (code !== 0) {
		console.error(
			`Chrome exited with ${code}. Set FD_CHROME to the browser binary if it lives elsewhere.`,
		);
		process.exit(1);
	}
	console.log(`Captured ${relative(root, destination)}`);
}
