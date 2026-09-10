import type {
	DatabaseAdapterProbeResult,
	DatabaseAdapterPublicDescriptor,
	DatabaseConfigurationField,
} from '@flowdular/database';
import { SETUP_CSRF_FIELD } from './access.ts';
import type { EnvironmentWriteResult } from './environment.ts';
import type { FirstRunSeed } from './seed.ts';

/* The installer runs before the application bundle can be served: there is no
   database, so there is no shell, no session and no client build to depend on.
   It therefore ships its own markup and its own copy of the design tokens it
   uses, taken from packages/ui/src/styles/tokens.css, and namespaces every
   class as setup-* so it can never restyle a ui-* primitive. */

const STEPS = ['Unlock', 'Database', 'Review', 'Sign in'] as const;
export type SetupStepName = (typeof STEPS)[number];

export interface ModuleCompatibility {
	readonly moduleId: string;
	readonly tenantOwned: boolean;
	readonly issues: readonly string[];
}

export interface SetupPageView {
	readonly step: SetupStepName;
	readonly csrfToken: string | null;
	readonly error: string | null;
	readonly notice: string | null;
	readonly adapters: readonly DatabaseAdapterPublicDescriptor[];
	readonly selectedAdapterId: string | null;
	readonly fieldErrors: Readonly<Record<string, string>>;
	readonly values: Readonly<Record<string, string>>;
	readonly probe: DatabaseAdapterProbeResult | null;
	readonly modules: readonly ModuleCompatibility[];
	readonly environment: EnvironmentWriteResult | null;
	readonly seed: FirstRunSeed | null;
	readonly modulesApproximated: boolean;
	readonly tokenFile: string | null;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/* Only the tokens this page uses, with the values tokens.css defines. A first
   run cannot import the stylesheet: the container image ships platform/dist
   and nothing else. */
const STYLES = `
:root{
--ink-0:#ffffff;--ink-25:#f9fafc;--ink-50:#f4f6fa;--ink-100:#e7ebf2;
--ink-200:#d3dae5;--ink-300:#b2bccc;--ink-400:#8794ab;--ink-500:#64738f;
--ink-600:#475572;--ink-900:#141b2e;--blue-50:#f1f5fe;--blue-100:#e3ebfc;
--blue-600:#2557d6;--blue-700:#1c45b3;--copper-300:#e08a45;--copper-500:#c9722d;
--green-50:#e6f5ec;--green-200:#b7e3c8;--green-600:#1b7f4e;
--amber-50:#fff4d6;--amber-200:#f3dc9a;--amber-600:#9a6700;
--red-50:#fce9e7;--red-200:#f2bdb9;--red-600:#c4322b;
--bg:var(--ink-50);--surface:var(--ink-0);--surface-2:var(--ink-25);
--line:var(--ink-200);--line-2:var(--ink-100);--ink:var(--ink-900);
--ink-2:var(--ink-600);--ink-3:var(--ink-500);--ink-4:var(--ink-400);
--primary:var(--blue-600);--primary-hover:var(--blue-700);--focus:var(--blue-600);
--success:var(--green-600);--success-bg:var(--green-50);--success-line:var(--green-200);
--warning:var(--amber-600);--warning-bg:var(--amber-50);--warning-line:var(--amber-200);
--danger:var(--red-600);--danger-bg:var(--red-50);--danger-line:var(--red-200);
--font-sans:'IBM Plex Sans Variable','IBM Plex Sans','Segoe UI',system-ui,-apple-system,sans-serif;
--font-mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
--text-xs:11px;--text-sm:12px;--text-md:13px;--text-base:14px;--text-lg:16px;
--control-h:36px;--r-sm:4px;--r:6px;--r-md:8px;--r-lg:12px;
--shadow-sm:0 1px 2px rgba(20,27,46,.06);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:var(--font-sans);font-size:var(--text-base);color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
.setup-page{display:grid;min-height:100vh;grid-template-columns:minmax(360px,.95fr) minmax(480px,1.05fr)}
.setup-story{position:relative;display:flex;min-height:100vh;flex-direction:column;padding:40px 48px;color:var(--ink-0);background:var(--ink-900);overflow:hidden}
.setup-story>*{position:relative}
.setup-backdrop{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.setup-brand{display:inline-flex;width:fit-content;align-items:center;gap:9px;font-size:var(--text-lg);font-weight:600;letter-spacing:-.01em}
.setup-brand svg{display:block}
.setup-kicker{font-size:var(--text-xs);font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.setup-story .setup-kicker{color:var(--copper-300)}
.setup-story__copy{max-width:560px;margin-block:auto;padding:60px 0}
.setup-story h1{max-width:16ch;margin:14px 0 16px;font-size:clamp(28px,3vw,36px);font-weight:600;line-height:1.12;letter-spacing:-.02em}
.setup-story__copy p{max-width:44ch;margin:0;font-size:var(--text-base);line-height:1.6;color:var(--ink-300)}
.setup-story footer{display:flex;justify-content:space-between;gap:16px;font-family:var(--font-mono);font-size:var(--text-xs);letter-spacing:.04em;color:var(--ink-400)}
.setup-panel{display:grid;place-items:center;padding:48px 32px;background:var(--bg)}
.setup-card{display:grid;gap:14px;width:min(520px,100%);padding:28px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-sm)}
.setup-card h2{margin:2px 0 0;font-size:20px;font-weight:600;letter-spacing:-.015em}
.setup-card__sub{margin:0 0 6px;font-size:var(--text-md);line-height:1.55;color:var(--ink-3)}
.setup-steps{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 4px;padding:0;list-style:none}
.setup-steps li{display:inline-flex;align-items:center;gap:7px;font-size:var(--text-sm);font-weight:500;color:var(--ink-4)}
.setup-steps li>i{display:grid;width:20px;height:20px;place-items:center;font-family:var(--font-mono);font-size:10px;font-style:normal;color:var(--ink-3);background:var(--surface-2);border:1px solid var(--line);border-radius:50%}
.setup-steps li.is-active{color:var(--ink)}
.setup-steps li.is-active>i{color:var(--ink-0);background:var(--primary);border-color:var(--primary)}
.setup-steps li.is-done{color:var(--ink-3)}
.setup-steps li.is-done>i{color:var(--success);background:var(--success-bg);border-color:var(--success-line)}
.setup-form{display:grid;gap:14px}
.setup-field{display:grid;gap:5px}
.setup-label{font-size:var(--text-sm);font-weight:500;color:var(--ink-2)}
.setup-input,.setup-select{width:100%;height:var(--control-h);padding:0 10px;font:inherit;font-size:var(--text-md);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.setup-input:focus-visible,.setup-select:focus-visible,.setup-btn:focus-visible,.setup-choice:focus-within{outline:2px solid var(--focus);outline-offset:1px}
.setup-input--error{border-color:var(--danger)}
.setup-help{font-size:var(--text-sm);line-height:1.5;color:var(--ink-3)}
.setup-help--error{color:var(--danger)}
.setup-row{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.setup-btn{display:inline-flex;height:var(--control-h);align-items:center;justify-content:center;gap:6px;padding:0 16px;font:inherit;font-size:var(--text-md);font-weight:500;color:var(--ink);cursor:pointer;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.setup-btn:hover{background:var(--surface-2)}
.setup-btn--primary{color:var(--ink-0);background:var(--primary);border-color:var(--primary)}
.setup-btn--primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.setup-btn--block{width:100%}
.setup-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
.setup-foot>:only-child{margin-left:auto}
.setup-alert{padding:10px 12px;font-size:var(--text-md);line-height:1.5;border:1px solid var(--danger-line);border-radius:var(--r);color:var(--danger);background:var(--danger-bg)}
.setup-alert--info{color:var(--ink-2);background:var(--blue-50);border-color:var(--blue-100)}
.setup-alert--warning{color:var(--amber-600);background:var(--warning-bg);border-color:var(--warning-line)}
.setup-alert--success{color:var(--green-600);background:var(--success-bg);border-color:var(--success-line)}
.setup-choices{display:grid;gap:10px}
.setup-choice{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}
.setup-choice b{font-size:var(--text-base);font-weight:600}
.setup-choice span{display:block;margin-top:3px;font-size:var(--text-sm);line-height:1.5;color:var(--ink-3)}
.setup-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.setup-list li{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:7px 10px;font-size:var(--text-md);background:var(--surface-2);border:1px solid var(--line-2);border-radius:var(--r-sm)}
.setup-list code{font-family:var(--font-mono);font-size:var(--text-sm)}
.setup-state{font-size:var(--text-sm);font-weight:500}
.setup-state--ok{color:var(--success)}
.setup-state--bad{color:var(--danger)}
.setup-block{margin:0;padding:12px 14px;overflow-x:auto;font-family:var(--font-mono);font-size:var(--text-sm);line-height:1.7;color:var(--ink);background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r);white-space:pre;-webkit-user-select:all;user-select:all}
.setup-credentials{display:grid;gap:8px;margin:0;padding:0}
.setup-credentials div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:baseline;padding:10px 12px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r)}
.setup-credentials code{font-family:var(--font-mono);font-size:var(--text-md);overflow-wrap:anywhere;-webkit-user-select:all;user-select:all}
.setup-credentials b{grid-column:1/-1;font-size:var(--text-xs);font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.setup-fieldset{border:0;margin:0;padding:0}
.setup-legend{padding:0}
.setup-sublabel{margin:0 0 6px}
.setup-note--gap{margin-top:8px}
.setup-note{margin:0;font-size:var(--text-sm);line-height:1.55;color:var(--ink-3)}
@media (max-width:900px){
.setup-page{grid-template-columns:1fr}
.setup-story{min-height:280px;padding:28px}
.setup-story__copy{padding:36px 0 16px}
.setup-story footer{display:none}
.setup-panel{padding:28px 16px 48px}
.setup-row{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/* Decoration only: aria-hidden, pointer-events none, and every step is
   readable with the canvas missing entirely. Mirrors the sign-in backdrop so
   the installer looks like the product it installs. */
const BACKDROP = `
(function(){
var c=document.getElementById('setup-backdrop');
var p=c&&c.parentElement,x=c&&c.getContext&&c.getContext('2d');
if(!c||!p||!x)return;
var S=30,R=130,dots=[],w=0,h=0,s=1,t=0,px=-1e4,py=-1e4,frame=0;
var reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
function build(){var r=p.getBoundingClientRect();w=r.width;h=r.height;
s=Math.min(window.devicePixelRatio||1,2);c.width=Math.max(1,Math.round(w*s));c.height=Math.max(1,Math.round(h*s));
dots=[];var i=0;for(var y=S/2;y<h;y+=S)for(var q=S/2;q<w;q+=S)dots.push({x:q,y:y,ox:q,oy:y,vx:0,vy:0,copper:i++%23===0});}
function draw(animate){x.setTransform(s,0,0,s,0,0);x.clearRect(0,0,w,h);
for(var i=0;i<dots.length;i++){var d=dots[i];
if(animate){var dx=d.x-px,dy=d.y-py,q=dx*dx+dy*dy;
if(q<R*R){var l=Math.sqrt(q)||1,f=(1-l/R)*3.2;d.vx+=dx/l*f;d.vy+=dy/l*f;}
d.vx+=(d.ox+Math.sin(t*.7+d.oy*.045)*1.6-d.x)*.02;
d.vy+=(d.oy+Math.cos(t*.6+d.ox*.05)*1.6-d.y)*.02;
d.vx*=.9;d.vy*=.9;d.x+=d.vx;d.y+=d.vy;}
var drift=Math.hypot(d.x-d.ox,d.y-d.oy),a=Math.min(.5,.14+drift*.02);
x.beginPath();x.arc(d.x,d.y,d.copper?1.9:1.4,0,Math.PI*2);
x.fillStyle=d.copper?'rgba(224,138,69,'+(a+.14)+')':'rgba(135,148,171,'+a+')';x.fill();}}
function tick(){t+=1/60;draw(true);frame=requestAnimationFrame(tick);}
build();
if(reduced.matches){draw(false);}else{
p.addEventListener('pointermove',function(e){var r=p.getBoundingClientRect();px=e.clientX-r.left;py=e.clientY-r.top;});
p.addEventListener('pointerleave',function(){px=-1e4;py=-1e4;});
frame=requestAnimationFrame(tick);}
new ResizeObserver(function(){cancelAnimationFrame(frame);build();
if(reduced.matches){draw(false);}else{frame=requestAnimationFrame(tick);}}).observe(p);
})();
`;

const MARK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M6 3v18M12 3v18M18 3v18" stroke="#c9722d" stroke-width="1.75" stroke-linecap="round" opacity=".85"/></svg>`;

function steps(current: SetupStepName): string {
	const index = STEPS.indexOf(current);
	const items = STEPS.map((name, position) => {
		const state =
			position === index ? 'is-active' : position < index ? 'is-done' : '';
		const marker = position < index ? '&#10003;' : `0${position + 1}`.slice(-2);
		return `<li class="${state}"><i aria-hidden="true">${marker}</i>${escapeHtml(name)}</li>`;
	});
	return `<ol class="setup-steps" aria-label="Setup progress">${items.join('')}</ol>`;
}

function field(
	definition: DatabaseConfigurationField,
	adapterId: string,
	view: SetupPageView,
): string {
	const name = `field:${adapterId}:${definition.key}`;
	const id = `f-${adapterId.replaceAll('.', '-')}-${definition.key}`;
	const error = view.fieldErrors[definition.key];
	const raw = view.values[name] ?? '';
	/* A secret is never rendered back into the form: the operator retypes it
	   rather than having the browser and the response carry it again. */
	const value = definition.secret ? '' : raw;
	const describedBy = `${id}-help`;
	const control = definition.secret
		? `<input class="setup-input${error ? ' setup-input--error' : ''}" id="${id}" name="${escapeHtml(name)}" type="password" autocomplete="new-password" spellcheck="false" maxlength="512"${definition.required ? ' required' : ''} aria-describedby="${describedBy}">`
		: definition.kind === 'select'
			? `<select class="setup-select${error ? ' setup-input--error' : ''}" id="${id}" name="${escapeHtml(name)}" aria-describedby="${describedBy}">${(
					definition.options ?? []
				)
					.map(
						(option) =>
							`<option value="${escapeHtml(option.value)}"${option.value === value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
					)
					.join('')}</select>`
			: `<input class="setup-input${error ? ' setup-input--error' : ''}" id="${id}" name="${escapeHtml(name)}" type="${definition.kind === 'integer' ? 'number' : 'text'}" value="${escapeHtml(value)}" spellcheck="false" maxlength="512"${definition.required ? ' required' : ''} aria-describedby="${describedBy}">`;
	return `<div class="setup-field"><label class="setup-label" for="${id}">${escapeHtml(definition.label)}</label>${control}<p class="setup-help${error ? ' setup-help--error' : ''}" id="${describedBy}"${error ? ' role="alert"' : ''}>${escapeHtml(error ?? definition.description)}</p></div>`;
}

function csrf(view: SetupPageView): string {
	return view.csrfToken
		? `<input type="hidden" name="${SETUP_CSRF_FIELD}" value="${escapeHtml(view.csrfToken)}">`
		: '';
}

function alerts(view: SetupPageView): string {
	return [
		view.error
			? `<p class="setup-alert" role="alert">${escapeHtml(view.error)}</p>`
			: '',
		view.notice
			? `<p class="setup-alert setup-alert--info">${escapeHtml(view.notice)}</p>`
			: '',
	].join('');
}

function unlockStep(view: SetupPageView): string {
	return `<header><span class="setup-kicker">First run</span><h2>Unlock setup</h2>
<p class="setup-card__sub">The setup token was printed in this deployment's output when it started${
		view.tokenFile
			? ` and written to <code>${escapeHtml(view.tokenFile)}</code>`
			: ''
	}. Paste it here to continue.</p></header>
${steps(view.step)}${alerts(view)}
<form class="setup-form" method="post" action="/setup"><input type="hidden" name="step" value="unlock">
<div class="setup-field"><label class="setup-label" for="setup-token">Setup token</label>
<input class="setup-input" id="setup-token" name="token" type="password" autocomplete="off" spellcheck="false" maxlength="256" required autofocus aria-describedby="setup-token-help">
<p class="setup-help" id="setup-token-help">Restarting this deployment issues a new token.</p></div>
<button class="setup-btn setup-btn--primary setup-btn--block" type="submit">Continue</button></form>`;
}

function configureStep(view: SetupPageView): string {
	const selected = view.selectedAdapterId ?? view.adapters[0]?.adapterId ?? '';
	const choices = view.adapters
		.map(
			(adapter) =>
				`<label class="setup-choice"><input type="radio" name="adapter" value="${escapeHtml(adapter.adapterId)}"${adapter.adapterId === selected ? ' checked' : ''}><span><b>${escapeHtml(adapter.label)}</b><span>${escapeHtml(adapter.description)}</span></span></label>`,
		)
		.join('');
	const fieldsets = view.adapters
		.map((adapter) => {
			const inner = adapter.configurationSchema.fields
				.map((definition) => field(definition, adapter.adapterId, view))
				.join('');
			/* Every fieldset is rendered open. The script below collapses the ones
			   the operator did not pick, so the form stays complete without it. */
			return `<fieldset class="setup-form setup-fieldset" data-adapter="${escapeHtml(adapter.adapterId)}"><legend class="setup-label setup-legend">${escapeHtml(adapter.label)}</legend>${inner || '<p class="setup-help">Nothing to configure.</p>'}</fieldset>`;
		})
		.join('');
	return `<header><span class="setup-kicker">Step 2 of 4</span><h2>Choose a database</h2>
<p class="setup-card__sub">Flowdular stores everything in one PostgreSQL database. Nothing is written until you confirm the review on the next step.</p></header>
${steps(view.step)}${alerts(view)}
<form class="setup-form" method="post" action="/setup">${csrf(view)}<input type="hidden" name="step" value="configure">
<div class="setup-choices">${choices}</div>${fieldsets}
<label class="setup-label" for="application-path">Backoffice address</label>
<input class="setup-input" id="application-path" name="applicationPath" value="${escapeHtml(view.values.applicationPath ?? '/app')}" maxlength="64" required aria-describedby="application-path-help${view.fieldErrors.applicationPath ? ' application-path-error' : ''}"${view.fieldErrors.applicationPath ? ' aria-invalid="true"' : ''}>
<p class="setup-help" id="application-path-help">Use /app or choose another path, such as /backoffice. Public modules can use the homepage separately. Takes effect after restart.</p>
${view.fieldErrors.applicationPath ? `<p role="alert" id="application-path-error">${escapeHtml(view.fieldErrors.applicationPath)}</p>` : ''}
<button class="setup-btn setup-btn--primary setup-btn--block" type="submit">Test connection</button></form>`;
}

function reviewStep(view: SetupPageView): string {
	const blocked = view.modules.filter((module) => module.issues.length > 0);
	const probe = view.probe;
	const modules = view.modules
		.map(
			(module) =>
				`<li><code>${escapeHtml(module.moduleId)}</code><span class="setup-state ${module.issues.length > 0 ? 'setup-state--bad' : 'setup-state--ok'}">${
					module.issues.length > 0
						? escapeHtml(module.issues.join(' '))
						: module.tenantOwned
							? 'tenant isolated'
							: 'compatible'
				}</span></li>`,
		)
		.join('');
	return `<header><span class="setup-kicker">Step 3 of 4</span><h2>Review</h2>
<p class="setup-card__sub">${
		blocked.length > 0
			? 'This database cannot serve every enabled module, so it is not activated.'
			: 'Applying runs every module migration, creates the demo workspace with its accounts, and stores the connection settings.'
	}</p></header>
${steps(view.step)}${alerts(view)}
${
	probe?.status === 'ready'
		? `<p class="setup-alert setup-alert--success">Connected in ${probe.latencyMs} ms as the runtime role, which holds neither SUPERUSER nor BYPASSRLS.</p>`
		: `<p class="setup-alert" role="alert">${escapeHtml(probe?.message ?? 'The connection could not be tested.')}</p>`
}
<p>Backoffice address: <code>${escapeHtml(view.values.applicationPath ?? '/app')}</code></p>
<div><p class="setup-label setup-sublabel">Enabled modules that own tables</p><ul class="setup-list">${modules || '<li><span class="setup-help">No enabled module owns database tables.</span></li>'}</ul>${
		view.modulesApproximated
			? '<p class="setup-note setup-note--gap">This build ships without the module manifests, so every enabled module is checked against the strictest requirements any of them can ask for.</p>'
			: ''
	}</div>
<form class="setup-form" method="post" action="/setup">${csrf(view)}
<div class="setup-foot"><button class="setup-btn" type="submit" name="step" value="back">Back</button>
${
	blocked.length === 0 && probe?.status === 'ready'
		? '<button class="setup-btn setup-btn--primary" type="submit" name="step" value="apply">Migrate and create the workspace</button>'
		: ''
}</div></form>`;
}

function environmentSection(result: EnvironmentWriteResult): string {
	const block = `<pre class="setup-block">${escapeHtml(result.block)}</pre>`;
	if (result.status === 'read-only') {
		return `<p class="setup-alert setup-alert--warning">This deployment's filesystem is read only, so it cannot store the connection settings itself. Add the block below to the environment of this service in your orchestrator, then restart it. Until you do, a restart returns to this screen.</p>${block}`;
	}
	if (result.status === 'failed') {
		return `<p class="setup-alert" role="alert">The connection settings could not be stored in <code>${escapeHtml(result.path)}</code>. Add the block below to this deployment's environment yourself, then restart it.</p>${block}`;
	}
	if (result.status === 'unchanged') {
		return `<p class="setup-alert setup-alert--info">Every one of these keys was already set in <code>${escapeHtml(result.path)}</code>, so nothing was replaced.</p>${block}`;
	}
	return `<p class="setup-note">Stored in <code>${escapeHtml(result.path)}</code>, readable only by this user${
		result.kept.length > 0
			? `. ${escapeHtml(result.kept.join(', '))} was already set there and was left as it is`
			: ''
	}.</p>`;
}

function doneStep(view: SetupPageView): string {
	const seed = view.seed;
	const accounts = (seed?.accounts ?? [])
		.map(
			(account) =>
				`<div><b>${escapeHtml(account.displayName)} &middot; ${escapeHtml(account.role)}</b><code>${escapeHtml(account.email)}</code><code>${escapeHtml(account.password)}</code></div>`,
		)
		.join('');
	return `<header><span class="setup-kicker">Step 4 of 4</span><h2>Flowdular is ready</h2>
<p class="setup-card__sub">The database is migrated and the workspace ${escapeHtml(seed?.workspace.name ?? '')} exists. Restart this deployment to leave setup and open the sign-in screen.</p></header>
${steps(view.step)}${alerts(view)}
<div><p class="setup-label setup-sublabel">Sign in with</p><div class="setup-credentials">${accounts}</div>
<p class="setup-note setup-note--gap">These are the product's demo accounts. You can change their passwords or disable them under Administration, Users.</p></div>
${view.environment ? environmentSection(view.environment) : ''}
<a class="setup-btn setup-btn--primary setup-btn--block" href="${escapeHtml(view.values.applicationPath ?? '/app')}">Go to sign in</a>`;
}

export function renderSetupPage(view: SetupPageView, nonce: string): string {
	const body =
		view.step === 'Unlock'
			? unlockStep(view)
			: view.step === 'Database'
				? configureStep(view)
				: view.step === 'Review'
					? reviewStep(view)
					: doneStep(view);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Set up Flowdular</title>
<style nonce="${nonce}">${STYLES}</style></head>
<body><main class="setup-page">
<section class="setup-story" aria-label="Flowdular">
<canvas class="setup-backdrop" id="setup-backdrop" aria-hidden="true"></canvas>
<span class="setup-brand">${MARK}Flowdular</span>
<div class="setup-story__copy"><span class="setup-kicker">Installation</span>
<h1>One database, then the workspace is yours.</h1>
<p>Flowdular keeps accounts, workspaces, permissions, and every module's records in one PostgreSQL database. Point it at one here and it migrates itself, creates the first workspace, and hands you the accounts to sign in with.</p></div>
<footer><span>Agentic foundation platform</span><span>Setup</span></footer></section>
<section class="setup-panel"><div class="setup-card">${body}</div></section>
</main>
<script nonce="${nonce}">${BACKDROP}</script>
<script nonce="${nonce}">
(function(){var f=document.querySelectorAll('input[name="adapter"]');if(!f.length)return;
function sync(){for(var i=0;i<f.length;i++){var s=document.querySelector('fieldset[data-adapter="'+f[i].value+'"]');
if(s)s.hidden=!f[i].checked;}}
for(var i=0;i<f.length;i++)f[i].addEventListener('change',sync);sync();})();
</script>
</body></html>`;
}
