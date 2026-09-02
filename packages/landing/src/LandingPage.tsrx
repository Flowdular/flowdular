import { useEffect, useRef, useState } from 'octane';
import { Seo } from '@octanejs/seo';
import { landingCopy, type LandingCopy } from './landing.copy.ts';
import {
	LANDING_LOCALES,
	persistLocale,
	preferredLocale,
	type LandingLocale,
} from './locale.ts';
import './landing.css';

/* The public landing is a standalone application. It shares nothing with the
   platform shell: its own copy, locale store, icons, brand mark and styles. */

/* The platform runs on its own origin. `CL_LANDING_APP_URL` points the
   sign-in and sign-up actions at it; unset, they stay same-origin paths. */
const APP_BASE = ((import.meta as
	ImportMeta & {
		readonly env?: Readonly<Record<string, string | undefined>>;
	}).env?.CL_LANDING_APP_URL ??
	'').trim().replace(/\/+$/, '');

function appUrl(path: string): string {
	return APP_BASE + path;
}

const SIGN_IN_URL = appUrl('/auth/login');
const REGISTER_URL = appUrl('/auth/register');

const GITHUB_URL = 'https://github.com/moxxy-ai/coreloom';
const CLONE_COMMAND = 'git clone https://github.com/moxxy-ai/coreloom.git';
const ENTERPRISE_CONTACT_URL =
	GITHUB_URL + '/issues/new?title=Enterprise%20license%20inquiry';

function docUrl(path: string): string {
	return GITHUB_URL + '/blob/main/' + path;
}

const ICONS: Readonly<Record<string, string>> = {
	activity: 'M3 12h4l2.5-7 5 14 2.5-7h4',
	'arrow-right': 'M5 12h14M13 6l6 6-6 6',
	bot: 'M12 2v3M8 5h8a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Zm1 7h.01M15 12h.01M9 16h6M2 11h2M20 11h2',
	building: 'M4 21V5l8-3v19M12 9l8 3v9M8 8h.01M8 12h.01M8 16h.01M16 15h.01M16 18h.01',
	check: 'm5 12 5 5L20 7',
	'chevron-down': 'm6 9 6 6 6-6',
	code: 'm8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14',
	copy: 'M9 9h11v11H9V9Zm-5 6V4h11',
	database: 'M12 3c5 0 8 1.3 8 3s-3 3-8 3-8-1.3-8-3 3-3 8-3Zm-8 3v12c0 1.7 3 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3 3 8 3s8-1.3 8-3',
	external: 'M14 4h6v6M20 4l-9 9M19 14v6H4V5h6',
	'file-text': 'M6 2h8l4 4v16H6V2Zm8 0v5h5M9 13h6M9 17h6',
	flask: 'M9 2h6M10 2v6l-5.5 9.5A3 3 0 0 0 7.1 22h9.8a3 3 0 0 0 2.6-4.5L14 8V2M7 15h10',
	folder: 'M3 6h6l2 2h10v11H3V6Z',
	'git-branch': 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
	lock: 'M5 11h14v10H5V11Zm3 0V7a4 4 0 0 1 8 0v4M12 15v2',
	menu: 'M4 7h16M4 12h16M4 17h16',
	message: 'M4 5h16v11H9l-5 4V5Z',
	modules: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
	'panel-left': 'M3 5h18v14H3zM9 5v14',
	play: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-2-14 6 4-6 4V8Z',
	plus: 'M12 5v14M5 12h14',
	settings: 'M4 8h10M18 8h2M14 8a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 16h4M12 16h8M8 16a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
	shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4',
	star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z',
	terminal: 'm5 7 5 5-5 5M12 17h7',
	users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6',
	x: 'M18 6 6 18M6 6l12 12',
	zap: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
};

const GITHUB_MARK = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

const MARK_WARP = [
	{ id: 'w1', type: 'circle', cx: 7.9, cy: 3.4, r: 1.7 },
	{ id: 'w2', type: 'rect', x: 6.2, y: 3.4, width: 3.4, height: 1.6 },
	{ id: 'w3', type: 'rect', x: 6.2, y: 10.8, width: 3.4, height: 9.8 },
	{ id: 'w4', type: 'circle', cx: 7.9, cy: 20.6, r: 1.7 },
	{ id: 'w5', type: 'circle', cx: 16.1, cy: 3.4, r: 1.7 },
	{ id: 'w6', type: 'rect', x: 14.4, y: 3.4, width: 3.4, height: 9.8 },
	{ id: 'w7', type: 'rect', x: 14.4, y: 19, width: 3.4, height: 1.6 },
	{ id: 'w8', type: 'circle', cx: 16.1, cy: 20.6, r: 1.7 },
] as const;

const MARK_WEFT = [
	{ id: 'f1', type: 'circle', cx: 3.4, cy: 7.9, r: 1.7 },
	{ id: 'f2', type: 'rect', x: 3.4, y: 6.2, width: 9.8, height: 3.4 },
	{ id: 'f3', type: 'rect', x: 19, y: 6.2, width: 1.6, height: 3.4 },
	{ id: 'f4', type: 'circle', cx: 20.6, cy: 7.9, r: 1.7 },
	{ id: 'f5', type: 'circle', cx: 3.4, cy: 16.1, r: 1.7 },
	{ id: 'f6', type: 'rect', x: 3.4, y: 14.4, width: 1.6, height: 3.4 },
	{ id: 'f7', type: 'rect', x: 10.8, y: 14.4, width: 9.8, height: 3.4 },
	{ id: 'f8', type: 'circle', cx: 20.6, cy: 16.1, r: 1.7 },
] as const;

function LIcon(props: { name: string; size?: number }) @{
	const size = props.size ?? 18;
	<svg
		class="l-icon"
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d={ICONS[props.name] ?? ICONS.modules} />
	</svg>
}

function GitHubMark(props: { size?: number }) @{
	const size = props.size ?? 18;
	<svg
		class="l-icon"
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="currentColor"
		aria-hidden="true"
	>
		<path d={GITHUB_MARK} />
	</svg>
}

function Mark(props: { size: number; warp?: string; weft?: string }) @{
	<svg
		viewBox="0 0 24 24"
		width={props.size}
		height={props.size}
		aria-hidden="true"
		style="flex:0 0 auto"
	>
		<g fill={props.warp ?? 'currentColor'}>
			@for (const shape of MARK_WARP; key shape.id) {
				@if (shape.type === 'rect') {
					<rect
						x={shape.x}
						y={shape.y}
						width={shape.width}
						height={shape.height}
					/>
				} @else {
					<circle cx={shape.cx} cy={shape.cy} r={shape.r} />
				}
			}
		</g>
		<g fill={props.weft ?? 'var(--l-copper)'}>
			@for (const shape of MARK_WEFT; key shape.id) {
				@if (shape.type === 'rect') {
					<rect
						x={shape.x}
						y={shape.y}
						width={shape.width}
						height={shape.height}
					/>
				} @else {
					<circle cx={shape.cx} cy={shape.cy} r={shape.r} />
				}
			}
		</g>
	</svg>
}

/* Hero backdrop: a woven dot field that drifts and parts under the pointer,
   the same idea as the sign-in screen. Decoration only: it renders nothing on
   the server, stops off screen, and holds still under reduced motion. */

interface Dot {
	x: number;
	y: number;
	originX: number;
	originY: number;
	velocityX: number;
	velocityY: number;
	copper: boolean;
}

const DOT_SPACING = 30;
const POINTER_RADIUS = 130;

function Backdrop() @{
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const parent = canvas?.parentElement;
		const context = canvas?.getContext('2d');
		if (!canvas || !parent || !context) return;
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let width = 0;
		let height = 0;
		let scale = 1;
		let dots: Dot[] = [];
		let frame = 0;
		let time = 0;
		let visible = true;
		let pointerX = -10_000;
		let pointerY = -10_000;

		const build = () => {
			const rect = parent.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			scale = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			dots = [];
			let index = 0;
			for (let y = DOT_SPACING / 2; y < height; y += DOT_SPACING) {
				for (let x = DOT_SPACING / 2; x < width; x += DOT_SPACING) {
					dots.push({
						x,
						y,
						originX: x,
						originY: y,
						velocityX: 0,
						velocityY: 0,
						copper: index++ % 23 === 0,
					});
				}
			}
		};

		const draw = (animate: boolean) => {
			context.setTransform(scale, 0, 0, scale, 0, 0);
			context.clearRect(0, 0, width, height);
			for (const dot of dots) {
				if (animate) {
					const deltaX = dot.x - pointerX;
					const deltaY = dot.y - pointerY;
					const distanceSq = deltaX * deltaX + deltaY * deltaY;
					if (distanceSq < POINTER_RADIUS * POINTER_RADIUS) {
						const distance = Math.sqrt(distanceSq) || 1;
						const force = (1 - distance / POINTER_RADIUS) * 3.2;
						dot.velocityX += (deltaX / distance) * force;
						dot.velocityY += (deltaY / distance) * force;
					}
					const targetX =
						dot.originX + Math.sin(time * 0.7 + dot.originY * 0.045) * 1.6;
					const targetY =
						dot.originY + Math.cos(time * 0.6 + dot.originX * 0.05) * 1.6;
					dot.velocityX += (targetX - dot.x) * 0.02;
					dot.velocityY += (targetY - dot.y) * 0.02;
					dot.velocityX *= 0.9;
					dot.velocityY *= 0.9;
					dot.x += dot.velocityX;
					dot.y += dot.velocityY;
				}
				const drift = Math.hypot(dot.x - dot.originX, dot.y - dot.originY);
				const alpha = Math.min(0.5, 0.16 + drift * 0.02);
				context.beginPath();
				context.arc(dot.x, dot.y, dot.copper ? 1.9 : 1.4, 0, Math.PI * 2);
				context.fillStyle = dot.copper
					? `rgba(180, 96, 31, ${alpha + 0.1})`
					: `rgba(107, 120, 145, ${alpha})`;
				context.fill();
			}
		};

		const tick = () => {
			time += 1 / 60;
			draw(true);
			frame = requestAnimationFrame(tick);
		};
		const start = () => {
			if (frame || reducedMotion.matches || !visible || document.hidden) return;
			frame = requestAnimationFrame(tick);
		};
		const stop = () => {
			cancelAnimationFrame(frame);
			frame = 0;
		};

		const onPointerMove = (event: PointerEvent) => {
			const rect = parent.getBoundingClientRect();
			pointerX = event.clientX - rect.left;
			pointerY = event.clientY - rect.top;
		};
		const onPointerLeave = () => {
			pointerX = -10_000;
			pointerY = -10_000;
		};

		build();
		draw(false);
		parent.addEventListener('pointermove', onPointerMove);
		parent.addEventListener('pointerleave', onPointerLeave);
		start();
		const observer = new ResizeObserver(() => {
			build();
			draw(false);
		});
		observer.observe(parent);
		const visibility = new IntersectionObserver((entries) => {
			visible = entries.some((entry) => entry.isIntersecting);
			if (visible) start();
			else stop();
		});
		visibility.observe(parent);
		const onVisibilityChange = () => {
			if (document.hidden) stop();
			else start();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);

		return () => {
			stop();
			observer.disconnect();
			visibility.disconnect();
			parent.removeEventListener('pointermove', onPointerMove);
			parent.removeEventListener('pointerleave', onPointerLeave);
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	}, []);

	<canvas class="l-backdrop" ref={canvasRef} aria-hidden="true"></canvas>
}

/* Hero product demo: a workspace window and a terminal that enables a module.
   The timeline is a pure function of elapsed time, so a frame is only rendered
   when something visible changes and the loop resumes cleanly after a pause. */

const DEMO_COMMAND = 'pnpm coreloom module enable sales.orders --apply';
const DEMO_GATES = [
	{ id: 'spec-schema', ms: '0.4s' },
	{ id: 'module-schema', ms: '0.6s' },
	{ id: 'dependencies', ms: '1.1s' },
	{ id: 'typecheck', ms: '8.2s' },
	{ id: 'tests', ms: '5.7s' },
	{ id: 'format', ms: '0.9s' },
] as const;
const DEMO_RESULTS = [
	{
		id: 'composition',
		key: 'composition',
		value: 'platform/src/generated/modules.server.ts',
	},
	{
		id: 'scopes',
		key: 'scopes',
		value: 'sales.orders.read, sales.orders.manage',
	},
	{ id: 'enabled', key: 'enabled', value: 'sales.orders 0.1.0' },
] as const;
const DEMO_ROWS = [
	{
		id: 'SO-1041',
		customer: 'Acme Industries',
		status: 'pending',
		total: '12 400.00',
	},
	{
		id: 'SO-1040',
		customer: 'Northwind Trading',
		status: 'approved',
		total: '3 180.00',
	},
	{
		id: 'SO-1039',
		customer: 'Globex Logistics',
		status: 'draft',
		total: '860.00',
	},
] as const;

const DEMO_TYPE_START = 900;
const DEMO_CHAR_MS = 34;
const DEMO_TYPE_END = DEMO_TYPE_START + DEMO_COMMAND.length * DEMO_CHAR_MS;
const DEMO_GATES_START = DEMO_TYPE_END + 600;
const DEMO_GATE_MS = 340;
const DEMO_RESULTS_START =
	DEMO_GATES_START + DEMO_GATES.length * DEMO_GATE_MS + 260;
const DEMO_RESULT_MS = 420;
const DEMO_LANDED =
	DEMO_RESULTS_START + DEMO_RESULTS.length * DEMO_RESULT_MS + 320;
const DEMO_VIEW = DEMO_LANDED + 700;
const DEMO_ROW_MS = 240;
const DEMO_LOOP_MS = DEMO_VIEW + 5_400;

interface DemoFrame {
	readonly typed: number;
	readonly gates: number;
	readonly results: number;
	readonly landed: boolean;
	readonly orders: boolean;
	readonly rows: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function demoFrameAt(ms: number): DemoFrame {
	const typed = clamp(
		Math.floor((ms - DEMO_TYPE_START) / DEMO_CHAR_MS),
		0,
		DEMO_COMMAND.length,
	);
	const gates =
		ms < DEMO_GATES_START
			? 0
			: clamp(
					1 + Math.floor((ms - DEMO_GATES_START) / DEMO_GATE_MS),
					0,
					DEMO_GATES.length,
				);
	const results =
		ms < DEMO_RESULTS_START
			? 0
			: clamp(
					1 + Math.floor((ms - DEMO_RESULTS_START) / DEMO_RESULT_MS),
					0,
					DEMO_RESULTS.length,
				);
	const orders = ms >= DEMO_VIEW;
	const rows =
		orders
			? clamp(
					1 + Math.floor((ms - DEMO_VIEW - 200) / DEMO_ROW_MS),
					0,
					DEMO_ROWS.length,
				)
			: 0;
	return { typed, gates, results, landed: ms >= DEMO_LANDED, orders, rows };
}

function sameFrame(a: DemoFrame, b: DemoFrame): boolean {
	return a.typed === b.typed && a.gates === b.gates &&
		a.results === b.results &&
		a.landed === b.landed &&
		a.orders === b.orders &&
		a.rows === b.rows;
}

const DEMO_IDLE = demoFrameAt(0);
const DEMO_FINAL = demoFrameAt(DEMO_LOOP_MS - 1);

function ProductDemo(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [frame, setFrame] = useState<DemoFrame>(DEMO_IDLE);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			setFrame(DEMO_FINAL);
			return;
		}
		let current = DEMO_IDLE;
		let handle = 0;
		let origin = 0;
		let paused = 0;
		const tick = (now: number) => {
			const next = demoFrameAt((now - origin) % DEMO_LOOP_MS);
			if (!sameFrame(current, next)) {
				current = next;
				setFrame(next);
			}
			handle = requestAnimationFrame(tick);
		};
		const start = () => {
			if (handle) return;
			origin = performance.now() - paused;
			handle = requestAnimationFrame(tick);
		};
		const stop = () => {
			if (!handle) return;
			paused = (performance.now() - origin) % DEMO_LOOP_MS;
			cancelAnimationFrame(handle);
			handle = 0;
		};
		const visibility = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) start();
			else stop();
		});
		visibility.observe(root);
		return () => {
			stop();
			visibility.disconnect();
		};
	}, []);

	const gates = DEMO_GATES.map(
		(gate, index) => ({
			...gate,
			done: index < frame.gates,
			active: index === frame.gates,
		}),
	);
	const result =
		frame.results > 0 ? DEMO_RESULTS[frame.results - 1] : null;
	const rows = DEMO_ROWS.map(
		(row, index) => ({
			...row,
			shown: index < frame.rows,
			label: row.status === 'pending'
				? copy.demo.orders.pending
				: row.status === 'approved'
					? copy.demo.orders.approved
					: copy.demo.orders.draft,
		}),
	);
	const typing = frame.typed > 0 && frame.typed < DEMO_COMMAND.length;
	const running = frame.typed === DEMO_COMMAND.length && !frame.landed;

	<div
		class={['l-demo', frame.landed && 'is-landed', frame.orders && 'is-orders']}
		ref={rootRef}
		role="img"
		aria-label={copy.demo.label}
	>
		<div class="l-window">
			<div class="l-window__chrome">
				<span class="l-window__dots" aria-hidden="true">
					<i></i>
					<i></i>
					<i></i>
				</span>
				<span class="l-window__url">
					<LIcon name="lock" size={11} />
					app.coreloom.local/operations-demo/{frame.orders
						? 'orders'
						: 'dashboard'}
				</span>
			</div>
			<div class="l-app">
				<aside class="l-app__sidebar">
					<div class="l-app__brand">
						<Mark size={18} warp="#0f1729" weft="#b4601f" />
						<span>Operations Demo</span>
					</div>
					<div class="l-app__group">{copy.demo.groups.workspace}</div>
					<div class={['l-app__item', !frame.orders && 'is-active']}>
						<LIcon name="panel-left" size={14} />
						{copy.demo.nav.dashboard}
					</div>
					<div class="l-app__group">{copy.demo.groups.operations}</div>
					<div class="l-app__item">
						<LIcon name="users" size={14} />
						{copy.demo.nav.parties}
					</div>
					<div class="l-app__item">
						<LIcon name="database" size={14} />
						{copy.demo.nav.catalog}
					</div>
					<div class="l-app__item">
						<LIcon name="file-text" size={14} />
						{copy.demo.nav.expenses}
					</div>
					<div
						class={[
							'l-app__item',
							'l-app__item--new',
							frame.landed && 'is-shown',
							frame.orders && 'is-active',
						]}
					>
						<LIcon name="zap" size={14} />
						{copy.demo.nav.orders}
						<b>{copy.demo.newTag}</b>
					</div>
					<div class="l-app__group">{copy.demo.groups.administration}</div>
					<div class="l-app__item">
						<LIcon name="users" size={14} />
						{copy.demo.nav.users}
					</div>
					<div class="l-app__item">
						<LIcon name="shield" size={14} />
						{copy.demo.nav.roles}
					</div>
					<div class="l-app__item">
						<LIcon name="modules" size={14} />
						{copy.demo.nav.modules}
					</div>
				</aside>
				<div class="l-app__main">
					<div class="l-app__topbar">
						<span class="l-app__crumb">
							{frame.orders
								? copy.demo.orders.eyebrow
								: copy.demo.dashboard.eyebrow}
						</span>
						<span class="l-app__avatar" aria-hidden="true">AM</span>
					</div>
					<div class="l-app__views">
						<div class={['l-view', !frame.orders && 'is-active']}>
							<div class="l-view__head">
								<h4>{copy.demo.dashboard.title}</h4>
							</div>
							<div class="l-view__kpis">
								<div class="l-kpi">
									<span>{copy.demo.dashboard.parties}</span>
									<b>128</b>
								</div>
								<div class="l-kpi">
									<span>{copy.demo.dashboard.items}</span>
									<b>412</b>
								</div>
								<div class="l-kpi">
									<span>{copy.demo.dashboard.expenses}</span>
									<b>36</b>
								</div>
								<div class="l-kpi">
									<span>{copy.demo.dashboard.runs}</span>
									<b>57</b>
								</div>
							</div>
							<div class="l-view__card">
								<div
									class="l-view__card-head"
								>{copy.demo.dashboard.activity}</div>
								<div class="l-skeleton">
									<i style="width:72%"></i>
									<i style="width:58%"></i>
									<i style="width:81%"></i>
									<i style="width:47%"></i>
								</div>
							</div>
						</div>
						<div class={['l-view', frame.orders && 'is-active']}>
							<div class="l-view__head">
								<h4>{copy.demo.orders.title}</h4>
								<span class="l-view__button">
									<LIcon name="plus" size={12} />
									{copy.demo.orders.action}
								</span>
							</div>
							<div class="l-view__kpis l-view__kpis--3">
								<div class="l-kpi">
									<span>{copy.demo.orders.open}</span>
									<b>3</b>
								</div>
								<div class="l-kpi">
									<span>{copy.demo.orders.approval}</span>
									<b>1</b>
								</div>
								<div class="l-kpi">
									<span>{copy.demo.orders.month}</span>
									<b>16 440</b>
								</div>
							</div>
							<div class="l-view__card">
								<table class="l-table">
									<thead>
										<tr>
											<th>{copy.demo.orders.colOrder}</th>
											<th>{copy.demo.orders.colCustomer}</th>
											<th>{copy.demo.orders.colStatus}</th>
											<th class="l-table__num">{copy.demo.orders.colTotal}</th>
										</tr>
									</thead>
									<tbody>
										@for (const row of rows; key row.id) {
											<tr class={[row.shown && 'is-shown']}>
												<td class="l-table__mono">{row.id}</td>
												<td>{row.customer}</td>
												<td>
													<span
														class={['l-status', 'l-status--' + row.status]}
													>{row.label}</span>
												</td>
												<td class="l-table__num">{row.total}</td>
											</tr>
										}
									</tbody>
								</table>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
		<div class="l-terminal" aria-hidden="true">
			<div class="l-terminal__body">
				<div class="l-terminal__line">
					<span class="l-terminal__prompt">$</span>
					<span class="l-terminal__cmd">{DEMO_COMMAND.slice(
						0,
						frame.typed,
					)}</span>
					@if (typing || frame.typed === 0) {
						<span class="l-terminal__cursor"></span>
					}
				</div>
				<div
					class={['l-terminal__gates', (running || frame.landed) && 'is-on']}
				>
					@for (const gate of gates; key gate.id) {
						<span
							class={[
								'l-terminal__gate',
								gate.done && 'is-done',
								gate.active && 'is-active',
							]}
						>
							<i></i>
							{gate.id}
						</span>
					}
				</div>
				<div class={['l-terminal__status', frame.landed && 'is-ok']}>
					@if (frame.landed) {
						<>
							<LIcon name="check" size={12} />
							{copy.demo.enabled}
						</>
					} @else if (result) {
						<>
							<span class="l-terminal__key">{result.key}</span>
							<span class="l-terminal__value">{result.value}</span>
						</>
					}
				</div>
			</div>
		</div>
	</div>
}

/* How a change ships: an auto-advancing stepper with one stage per step. */

const HOW_STEPS = [
	{ id: 'brief', icon: 'message' },
	{ id: 'spec', icon: 'file-text' },
	{ id: 'gates', icon: 'shield' },
	{ id: 'preview', icon: 'panel-left' },
	{ id: 'deliver', icon: 'git-branch' },
] as const;
type HowStepId = (typeof HOW_STEPS)[number]['id'];
const HOW_STEP_MS = 5_200;

const SPEC_LINES = [
	{ id: 1, key: 'id', value: 'sales.orders' },
	{ id: 2, key: 'version', value: '0.1.0' },
	{
		id: 3,
		key: 'capabilities',
		value: '[api, database, client, translations]',
	},
	{ id: 4, key: 'entities', value: '' },
	{ id: 5, key: '  - order', value: '' },
	{ id: 6, key: 'permissions', value: '' },
	{ id: 7, key: '  - sales.orders.read', value: '' },
	{ id: 8, key: '  - sales.orders.manage', value: '' },
	{ id: 9, key: '  - sales.orders.approve', value: '' },
	{ id: 10, key: 'rules', value: '' },
	{ id: 11, key: '  - approval above 10000', value: '' },
] as const;

function HowItShips(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const [step, setStep] = useState<HowStepId>('brief');
	const barRef = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const bar = barRef.current;
		const animation = bar?.animate(
			[{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
			{ duration: HOW_STEP_MS, easing: 'linear', fill: 'forwards' },
		);
		const index = HOW_STEPS.findIndex((entry) => entry.id === step);
		const timer = setTimeout(() => {
			setStep(HOW_STEPS[(index + 1) % HOW_STEPS.length]!.id);
		}, HOW_STEP_MS);
		return () => {
			clearTimeout(timer);
			animation?.cancel();
		};
	}, [step]);

	const steps = HOW_STEPS.map(
		(entry, index) => ({
			...entry,
			number: String(index + 1).padStart(2, '0'),
			title: copy.how.steps[entry.id].title,
			text: copy.how.steps[entry.id].text,
			active: entry.id === step,
		}),
	);
	const chips = copy.how.stage.brief.chips.map(
		(label, index) => ({
			id: index,
			label,
		}),
	);
	const gates = DEMO_GATES.map((gate, index) => ({ ...gate, index }));

	<section class="l-section l-section--band l-how" id="how">
		<div class="l-container">
			<div class="l-head" data-reveal>
				<span class="l-kicker">{copy.how.kicker}</span>
				<h2>{copy.how.title}</h2>
				<p>{copy.how.description}</p>
			</div>
			<div class="l-how__grid" data-reveal>
				<ol class="l-steps">
					@for (const entry of steps; key entry.id) {
						<li class={['l-step', entry.active && 'is-active']}>
							<button
								type="button"
								class="l-step__button"
								aria-pressed={entry.active}
								onClick={() => setStep(entry.id)}
							>
								<span class="l-step__marker">
									<LIcon name={entry.icon} size={16} />
								</span>
								<span class="l-step__text">
									<span class="l-step__title">
										<i>{entry.number}</i>
										{entry.title}
									</span>
									<span class="l-step__desc">{entry.text}</span>
								</span>
							</button>
							@if (entry.active) {
								<span class="l-step__progress">
									<span ref={barRef}></span>
								</span>
							}
						</li>
					}
				</ol>
				<div class="l-stage">
					<div class={['l-stage__panel', step === 'brief' && 'is-active']}>
						<div class="l-chat">
							<div class="l-chat__bubble l-chat__bubble--user">
								<span class="l-chat__who">AM</span>
								<p>{copy.how.stage.brief.user}</p>
							</div>
							<div class="l-chat__bubble">
								<span class="l-chat__who l-chat__who--planner">
									<Mark size={14} warp="#0f1729" weft="#b4601f" />
								</span>
								<div>
									<p>{copy.how.stage.brief.planner}</p>
									<div class="l-chips">
										@for (const chip of chips; key chip.id) {
											<span
												class="l-chip"
												style={'--i:' + String(chip.id)}
											>{chip.label}</span>
										}
									</div>
								</div>
							</div>
						</div>
					</div>
					<div class={['l-stage__panel', step === 'spec' && 'is-active']}>
						<div class="l-code">
							<div class="l-code__bar">
								<LIcon name="file-text" size={13} />
								<span>{copy.how.stage.spec.file}</span>
								<em>{copy.how.stage.spec.hash}</em>
							</div>
							<div class="l-code__body l-code__body--yaml">
								@for (const line of SPEC_LINES; key line.id) {
									<span class="l-code__line" style={'--i:' + String(line.id)}>
										<span class="l-tok-key">{line.key}</span>
										@if (line.value) {
											<>
												<span class="l-tok-pn">{': '}</span>
												<span class="l-tok-str">{line.value}</span>
											</>
										} @else if (!line.key.startsWith(' ')) {
											<span class="l-tok-pn">:</span>
										}
									</span>
								}
							</div>
							<div class="l-code__foot">
								<span class="l-button l-button--primary l-button--sm">
									<LIcon name="check" size={13} />
									{copy.how.stage.spec.approve}
								</span>
							</div>
						</div>
					</div>
					<div class={['l-stage__panel', step === 'gates' && 'is-active']}>
						<div class="l-gates">
							<div class="l-gates__head">
								<LIcon name="shield" size={14} />
								<span>{copy.how.stage.gates.title}</span>
							</div>
							@for (const gate of gates; key gate.id) {
								<div class="l-gates__row" style={'--i:' + String(gate.index)}>
									<i>
										<LIcon name="check" size={11} />
									</i>
									<span>{gate.id}</span>
									<em>{gate.ms}</em>
								</div>
							}
							<div class="l-gates__foot">{copy.how.stage.gates.passed}</div>
						</div>
					</div>
					<div class={['l-stage__panel', step === 'preview' && 'is-active']}>
						<div class="l-preview">
							<div class="l-preview__bar">
								<span class="l-window__dots" aria-hidden="true">
									<i></i>
									<i></i>
									<i></i>
								</span>
								<b>{copy.how.stage.preview.badge}</b>
							</div>
							<div class="l-preview__app">
								<aside>
									<i></i>
									<i></i>
									<i class="is-active"></i>
									<i></i>
									<i></i>
								</aside>
								<div>
									<h4>{copy.how.stage.preview.title}</h4>
									<div class="l-preview__kpis">
										<span></span>
										<span></span>
										<span></span>
									</div>
									<div class="l-skeleton">
										<i style="width:70%"></i>
										<i style="width:55%"></i>
										<i style="width:78%"></i>
									</div>
								</div>
							</div>
							<p class="l-preview__note">{copy.how.stage.preview.note}</p>
						</div>
					</div>
					<div class={['l-stage__panel', step === 'deliver' && 'is-active']}>
						<div class="l-pr">
							<div class="l-pr__head">
								<span class="l-pr__icon">
									<LIcon name="git-branch" size={16} />
								</span>
								<div>
									<b>{copy.how.stage.deliver.title}</b>
									<span>{copy.how.stage.deliver.branch}</span>
								</div>
							</div>
							<div class="l-pr__checks">
								@for (const gate of gates; key gate.id) {
									<span style={'--i:' + String(gate.index)}>
										<LIcon name="check" size={11} />
										{gate.id}
									</span>
								}
							</div>
							<div class="l-pr__status">
								<i></i>
								{copy.how.stage.deliver.checks}
							</div>
							<div class="l-pr__actions">
								<span class="l-button l-button--ghost l-button--sm">
									<LIcon name="folder" size={13} />
									{copy.how.stage.deliver.eject}
								</span>
								<span class="l-button l-button--primary l-button--sm">
									<LIcon name="git-branch" size={13} />
									{copy.how.stage.deliver.pr}
								</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>
}

/* Sandbox: the lifecycle, in screenshots of the running product. */

const SANDBOX_SHOTS = [
	'/media/sandbox-request.png',
	'/media/sandbox-build.png',
	'/media/sandbox-preview.png',
	'/media/sandbox-deliver.png',
	'/media/sandbox-live.png',
] as const;
const SANDBOX_SLIDE_MS = 6_000;

function SandboxSection(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const [active, setActive] = useState(0);
	const [playing, setPlaying] = useState(false);
	const rootRef = useRef<HTMLElement | null>(null);
	const barRef = useRef<HTMLSpanElement | null>(null);

	/* The slideshow only runs while it is on screen and motion is allowed. */
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const observer = new IntersectionObserver((entries) => setPlaying(
			entries.some((entry) => entry.isIntersecting),
		), { threshold: 0.25 });
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!playing) return;
		const animation = barRef.current?.animate(
			[{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
			{ duration: SANDBOX_SLIDE_MS, easing: 'linear', fill: 'forwards' },
		);
		const timer = setTimeout(() => {
			setActive((active + 1) % SANDBOX_SHOTS.length);
		}, SANDBOX_SLIDE_MS);
		return () => {
			clearTimeout(timer);
			animation?.cancel();
		};
	}, [playing, active]);

	const select = (index: number) => {
		setPlaying(false);
		setActive(index);
	};
	const slides = copy.sandbox.slides.map(
		(slide, index) => ({
			id: index,
			...slide,
			src: SANDBOX_SHOTS[index] ?? SANDBOX_SHOTS[0],
			current: index === active,
		}),
	);
	const current = slides[active] ?? slides[0]!;
	const features = copy.sandbox.features.map(
		(feature, index) => ({
			id: index,
			...feature,
		}),
	);

	<section class="l-section l-sandbox" id="sandbox" ref={rootRef}>
		<div class="l-container">
			<div class="l-head" data-reveal>
				<span class="l-kicker">{copy.sandbox.kicker}</span>
				<h2>{copy.sandbox.title}</h2>
				<p>{copy.sandbox.description}</p>
			</div>
			<div class="l-slides" data-reveal>
				<div
					class="l-slides__tabs"
					role="tablist"
					aria-label={copy.sandbox.kicker}
				>
					@for (const slide of slides; key slide.id) {
						<button
							type="button"
							role="tab"
							class={['l-slides__tab', slide.current && 'is-active']}
							aria-selected={slide.current}
							onClick={() => select(slide.id)}
						>
							<i>{String(slide.id + 1).padStart(2, '0')}</i>
							{slide.label}
							@if (slide.current) {
								<span class="l-slides__progress">
									<span ref={barRef}></span>
								</span>
							}
						</button>
					}
				</div>
				<div class="l-slides__stage">
					@for (const slide of slides; key slide.id) {
						<img
							class={['l-slides__shot', slide.current && 'is-active']}
							src={slide.src}
							alt={slide.alt}
							width="1600"
							height="905"
							loading={slide.id === 0 ? 'eager' : 'lazy'}
							decoding="async"
						/>
					}
				</div>
				<div class="l-slides__caption">
					<b>{current.title}</b>
					<span>{current.text}</span>
				</div>
			</div>
			<div class="l-sandbox__features">
				@for (const feature of features; key feature.id) {
					<div data-reveal style={'--i:' + String(feature.id)}>
						<b>{feature.title}</b>
						<span>{feature.text}</span>
					</div>
				}
			</div>
		</div>
	</section>
}

/* The platform bento. Each card carries a small looping visual. */

const SCOPE_CHIPS = [
	'sales.orders.read',
	'sales.orders.manage',
	'sales.orders.approve',
	'auth.users.read',
	'catalog.items.manage',
	'system.settings.manage',
].map((scope, index) => ({ id: scope, index }));

const COMPOSITION_TILES = [
	'auth',
	'users',
	'catalog',
	'agents',
	'workflows',
	'orders',
].map((name, index) => ({ id: name, index }));

const AGENT_LOG = [
	{ id: 1, text: 'lease acquired  run r_41d' },
	{ id: 2, text: 'tool catalog.items.search  3 rows' },
	{ id: 3, text: 'tool parties.contacts.create  idempotent' },
	{ id: 4, text: 'run committed  audit #1 284' },
];

const CLI_LINES = [
	{ id: 1, text: 'pnpm coreloom doctor --json' },
	{
		id: 2,
		text: 'pnpm coreloom module new sales.orders --spec modules/sales-orders/spec/module.yaml',
	},
	{ id: 3, text: 'pnpm coreloom module enable sales.orders --apply' },
	{
		id: 4,
		text: 'pnpm coreloom auth sync-scopes --module sales.orders --apply',
	},
];

function PlatformGrid(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const workspaces = copy.platform.accounts.rows.map(
		(name, index) => ({
			id: index,
			name,
		}),
	);
	const settings = copy.platform.admin.rows.map(
		(name, index) => ({
			id: index,
			name,
		}),
	);

	<section class="l-section l-section--band l-platform" id="platform">
		<div class="l-container">
			<div class="l-head" data-reveal>
				<span class="l-kicker">{copy.platform.kicker}</span>
				<h2>{copy.platform.title}</h2>
				<p>{copy.platform.description}</p>
			</div>
			<div class="l-bento">
				<article class="l-card" data-reveal style="--i:0">
					<div class="l-card__visual l-micro-ws">
						@for (const workspace of workspaces; key workspace.id) {
							<div
								class="l-micro-ws__row"
								style={'--i:' + String(workspace.id)}
							>
								<i>{workspace.name.slice(0, 1)}</i>
								<span>{workspace.name}</span>
								<b>{copy.platform.accounts.active}</b>
							</div>
						}
					</div>
					<span class="l-card__icon">
						<LIcon name="users" size={18} />
					</span>
					<h3>{copy.platform.accounts.title}</h3>
					<p>{copy.platform.accounts.text}</p>
				</article>
				<article class="l-card" data-reveal style="--i:1">
					<div class="l-card__visual l-micro-scopes">
						@for (const scope of SCOPE_CHIPS; key scope.id) {
							<span style={'--i:' + String(scope.index)}>{scope.id}</span>
						}
					</div>
					<span class="l-card__icon">
						<LIcon name="lock" size={18} />
					</span>
					<h3>{copy.platform.permissions.title}</h3>
					<p>{copy.platform.permissions.text}</p>
				</article>
				<article class="l-card" data-reveal style="--i:2">
					<div class="l-card__visual l-micro-tiles">
						@for (const tile of COMPOSITION_TILES; key tile.id) {
							<span style={'--i:' + String(tile.index)}>
								<LIcon name="modules" size={13} />
								{tile.id}
							</span>
						}
					</div>
					<span class="l-card__icon">
						<LIcon name="modules" size={18} />
					</span>
					<h3>{copy.platform.composition.title}</h3>
					<p>{copy.platform.composition.text}</p>
				</article>
				<article class="l-card" data-reveal style="--i:3">
					<div class="l-card__visual l-micro-log">
						@for (const line of AGENT_LOG; key line.id) {
							<span style={'--i:' + String(line.id)}>
								<i></i>
								{line.text}
							</span>
						}
					</div>
					<span class="l-card__icon">
						<LIcon name="bot" size={18} />
					</span>
					<h3>{copy.platform.agents.title}</h3>
					<p>{copy.platform.agents.text}</p>
				</article>
				<article class="l-card" data-reveal style="--i:4">
					<div class="l-card__visual l-micro-graph">
						<span class="l-micro-graph__node">
							<LIcon name="play" size={13} />
						</span>
						<i class="l-micro-graph__link"></i>
						<span class="l-micro-graph__node">
							<LIcon name="bot" size={13} />
						</span>
						<i class="l-micro-graph__link"></i>
						<span class="l-micro-graph__node">
							<LIcon name="shield" size={13} />
						</span>
						<i class="l-micro-graph__link"></i>
						<span class="l-micro-graph__node">
							<LIcon name="zap" size={13} />
						</span>
					</div>
					<span class="l-card__icon">
						<LIcon name="activity" size={18} />
					</span>
					<h3>{copy.platform.workflows.title}</h3>
					<p>{copy.platform.workflows.text}</p>
				</article>
				<article class="l-card" data-reveal style="--i:5">
					<div class="l-card__visual l-micro-settings">
						@for (const setting of settings; key setting.id) {
							<div
								class="l-micro-settings__row"
								style={'--i:' + String(setting.id)}
							>
								<span>{setting.name}</span>
								<i></i>
							</div>
						}
					</div>
					<span class="l-card__icon">
						<LIcon name="settings" size={18} />
					</span>
					<h3>{copy.platform.admin.title}</h3>
					<p>{copy.platform.admin.text}</p>
				</article>
				<article class="l-card l-card--wide" data-reveal style="--i:6">
					<div class="l-card__copy">
						<span class="l-card__icon">
							<LIcon name="terminal" size={18} />
						</span>
						<h3>{copy.platform.cli.title}</h3>
						<p>{copy.platform.cli.text}</p>
					</div>
					<div class="l-cli">
						@for (const line of CLI_LINES; key line.id) {
							<div class="l-cli__line" style={'--i:' + String(line.id)}>
								<span class="l-terminal__prompt">$</span>
								<span>{line.text}</span>
							</div>
						}
						<div class="l-cli__line">
							<span class="l-terminal__prompt">$</span>
							<span class="l-terminal__cursor"></span>
						</div>
					</div>
				</article>
			</div>
		</div>
	</section>
}

/* The module contract: a real module's file tree and a real endpoint. */

const MODULE_TREE = [
	{ id: 1, depth: 0, name: 'spec/module.yaml', kind: 'file', hot: true },
	{ id: 2, depth: 0, name: 'module.json', kind: 'file', hot: false },
	{ id: 3, depth: 0, name: 'migrations', kind: 'dir', hot: false },
	{
		id: 4,
		depth: 1,
		name: '0001_catalog_core.up.sql',
		kind: 'file',
		hot: false,
	},
	{
		id: 5,
		depth: 1,
		name: '0002_catalog_history.up.sql',
		kind: 'file',
		hot: false,
	},
	{ id: 6, depth: 0, name: 'src', kind: 'dir', hot: false },
	{ id: 7, depth: 1, name: 'acl/permissions.ts', kind: 'file', hot: true },
	{ id: 8, depth: 1, name: 'api/endpoints.ts', kind: 'file', hot: true },
	{ id: 9, depth: 1, name: 'agent/tools.ts', kind: 'file', hot: false },
	{
		id: 10,
		depth: 1,
		name: 'services/sqlite-repository.ts',
		kind: 'file',
		hot: false,
	},
	{
		id: 11,
		depth: 1,
		name: 'client/CatalogView.tsrx',
		kind: 'file',
		hot: true,
	},
	{ id: 12, depth: 1, name: 'platform.ts', kind: 'file', hot: false },
	{ id: 13, depth: 0, name: 'translations', kind: 'dir', hot: false },
	{ id: 14, depth: 1, name: 'en.json', kind: 'file', hot: false },
	{ id: 15, depth: 1, name: 'pl.json', kind: 'file', hot: false },
	{ id: 16, depth: 0, name: 'tests', kind: 'dir', hot: false },
	{ id: 17, depth: 1, name: 'endpoints.test.ts', kind: 'file', hot: true },
	{ id: 18, depth: 1, name: 'migrations.test.ts', kind: 'file', hot: false },
] as const;

interface CodeToken {
	readonly k: 'kw' | 'fn' | 'str' | 'id' | 'pn' | 'key';
	readonly v: string;
}

const ENDPOINT_CODE: readonly (readonly CodeToken[])[] = [
	[
		{ k: 'kw', v: 'const ' },
		{ k: 'id', v: 'list' },
		{ k: 'pn', v: ' = ' },
		{ k: 'fn', v: 'defineEndpoint' },
		{ k: 'pn', v: '({' },
	],
	[
		{ k: 'key', v: '  id' },
		{ k: 'pn', v: ': ' },
		{ k: 'str', v: '\'catalog.items.list\'' },
		{ k: 'pn', v: ',' },
	],
	[
		{ k: 'key', v: '  path' },
		{ k: 'pn', v: ': ' },
		{ k: 'str', v: '\'/api/catalog/items\'' },
		{ k: 'pn', v: ',' },
	],
	[
		{ k: 'key', v: '  methods' },
		{ k: 'pn', v: ': [' },
		{ k: 'str', v: '\'GET\'' },
		{ k: 'pn', v: '],' },
	],
	[
		{ k: 'key', v: '  access' },
		{ k: 'pn', v: ': { ' },
		{ k: 'key', v: 'kind' },
		{ k: 'pn', v: ': ' },
		{ k: 'str', v: '\'permission\'' },
		{ k: 'pn', v: ', ' },
		{ k: 'key', v: 'permission' },
		{ k: 'pn', v: ': ' },
		{ k: 'id', v: 'PERMISSIONS.read' },
		{ k: 'pn', v: ' },' },
	],
	[
		{ k: 'key', v: '  handler' },
		{ k: 'pn', v: ': ({ ' },
		{ k: 'id', v: 'octane' },
		{ k: 'pn', v: ' }) =>' },
	],
	[
		{ k: 'pn', v: '    ' },
		{ k: 'fn', v: 'jsonResponse' },
		{ k: 'pn', v: '({' },
	],
	[
		{ k: 'key', v: '      items' },
		{ k: 'pn', v: ': ' },
		{ k: 'id', v: 'service' },
		{ k: 'pn', v: '.' },
		{ k: 'fn', v: 'list' },
		{ k: 'pn', v: '(' },
		{ k: 'fn', v: 'principalFromContext' },
		{ k: 'pn', v: '(' },
		{ k: 'id', v: 'octane' },
		{ k: 'pn', v: ')!.' },
		{ k: 'id', v: 'tenantId' },
		{ k: 'pn', v: '),' },
	],
	[
		{ k: 'pn', v: '    }),' },
	],
	[
		{ k: 'pn', v: '});' },
	],
];

const CODE_LINES = ENDPOINT_CODE.map(
	(tokens, index) => ({
		id: index,
		tokens: tokens.map((token, tokenIndex) => ({ id: tokenIndex, ...token })),
	}),
);

const MODULE_IDS = [
	'auth.core',
	'users.core',
	'system.core',
	'profile.core',
	'parties.core',
	'catalog.core',
	'expenses.core',
	'agents.core',
	'automations.core',
	'workflows.core',
	'sandbox.core',
];

const MARQUEE = [...MODULE_IDS, ...MODULE_IDS].map(
	(id, index) => ({
		id: String(index),
		label: id,
	}),
);

function ModuleContract(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const points = copy.modules.points.map(
		(text, index) => ({ id: index, text }),
	);

	<section class="l-section l-modules" id="modules">
		<div class="l-container">
			<div class="l-head l-head--left" data-reveal>
				<span class="l-kicker">{copy.modules.kicker}</span>
				<h2>{copy.modules.title}</h2>
				<p>{copy.modules.description}</p>
			</div>
			<div class="l-modules__grid">
				<div class="l-tree" data-reveal>
					<div class="l-tree__bar">
						<LIcon name="folder" size={13} />
						<span>{copy.modules.treeTitle}</span>
					</div>
					<ul>
						@for (const node of MODULE_TREE; key node.id) {
							<li
								class={['l-tree__node', node.hot && 'is-hot']}
								style={'--d:' + String(node.depth) + ';--i:' + String(node.id)}
							>
								<LIcon
									name={node.kind === 'dir' ? 'folder' : 'file-text'}
									size={13}
								/>
								<span>{node.name}</span>
							</li>
						}
					</ul>
				</div>
				<div class="l-modules__code" data-reveal>
					<div class="l-code l-code--dark">
						<div class="l-code__bar">
							<LIcon name="code" size={13} />
							<span>{copy.modules.codeTitle}</span>
						</div>
						<div class="l-code__body">
							@for (const line of CODE_LINES; key line.id) {
								<span class="l-code__line" style={'--i:' + String(line.id)}>
									@for (const token of line.tokens; key token.id) {
										<span class={['l-tok-' + token.k]}>{token.v}</span>
									}
								</span>
							}
						</div>
					</div>
					<ul class="l-points">
						@for (const point of points; key point.id) {
							<li style={'--i:' + String(point.id)}>
								<LIcon name="check" size={14} />
								{point.text}
							</li>
						}
					</ul>
				</div>
			</div>
		</div>
		<div class="l-marquee" aria-label={copy.modules.marqueeLabel}>
			<div class="l-marquee__track">
				@for (const item of MARQUEE; key item.id) {
					<span>
						<LIcon name="modules" size={13} />
						{item.label}
					</span>
				}
			</div>
		</div>
	</section>
}

/* Agents and workflows: the canvas, a run log and the skills. */

const WORKFLOW_NODES = [
	{ id: 'input', icon: 'play' },
	{ id: 'agent', icon: 'bot' },
	{ id: 'validator', icon: 'check' },
	{ id: 'gate', icon: 'shield' },
	{ id: 'action', icon: 'zap' },
	{ id: 'output', icon: 'activity' },
] as const;

const WORKFLOW_LOG = [
	{ id: 1, code: 'input.received', detail: 'customer=acme' },
	{ id: 2, code: 'agent.run', detail: 'onboarding-assistant 1.4s' },
	{ id: 3, code: 'validator.pass', detail: 'schema=customer.v2' },
	{ id: 4, code: 'gate.pass', detail: 'score=0.93' },
	{ id: 5, code: 'action.crm.create', detail: 'id=cus_8f2' },
	{ id: 6, code: 'output.emitted', detail: 'run=r_41d' },
];

const SKILLS = [
	'module-new',
	'module-update',
	'core-extend',
	'bug-hunt',
	'perf-audit',
	'ux-design',
	'auth-security-review',
	'test-hardening',
	'migration-authoring',
	'translations-i18n',
	'cli-extension',
	'agent-tool-design',
	'workflow-development',
	'release-eject-pr',
].map((name, index) => ({ id: name, index }));

function AgentsSection(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const nodes = WORKFLOW_NODES.map(
		(node, index) => ({
			...node,
			index,
			label: copy.agents.canvas.nodes[node.id],
			last: index === WORKFLOW_NODES.length - 1,
		}),
	);

	<section class="l-section l-agents" id="agents">
		<div class="l-container">
			<div class="l-agents__grid">
				<div class="l-head l-head--left" data-reveal>
					<span class="l-kicker">{copy.agents.kicker}</span>
					<h2>{copy.agents.title}</h2>
					<p>{copy.agents.description}</p>
					<div class="l-skills">
						<h3>{copy.agents.skills.title}</h3>
						<p>{copy.agents.skills.text}</p>
						<div class="l-chips l-chips--mono">
							@for (const skill of SKILLS; key skill.id) {
								<span class="l-chip" style={'--i:' + String(skill.index)}>
									/{skill.id}
								</span>
							}
						</div>
					</div>
				</div>
				<div class="l-canvas" data-reveal>
					<div class="l-canvas__bar">
						<span>
							<LIcon name="activity" size={13} />
							{copy.agents.canvas.title}
						</span>
						<em>{copy.agents.canvas.dryRun}</em>
					</div>
					<div class="l-canvas__nodes">
						@for (const node of nodes; key node.id) {
							<>
								<div class="l-node" style={'--i:' + String(node.index)}>
									<span>
										<LIcon name={node.icon} size={15} />
									</span>
									<b>{node.label}</b>
								</div>
								@if (!node.last) {
									<i class="l-link" aria-hidden="true"></i>
								}
							</>
						}
					</div>
					<div class="l-canvas__log">
						@for (const line of WORKFLOW_LOG; key line.id) {
							<div style={'--i:' + String(line.id)}>
								<span>{line.code}</span>
								<em>{line.detail}</em>
							</div>
						}
					</div>
					<div class="l-canvas__foot">
						<span>
							<i></i>
							{copy.agents.canvas.trace}
						</span>
						<span>{copy.agents.canvas.history}</span>
					</div>
				</div>
			</div>
		</div>
	</section>
}

/* Open source, licensing and the questions companies ask first. */

function OpenSourceSection(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const points = copy.openSource.points.map(
		(text, index) => ({
			id: index,
			text,
		}),
	);

	<section class="l-section l-section--band l-oss" id="open-source">
		<div class="l-container l-oss__grid">
			<div class="l-head l-head--left" data-reveal>
				<span class="l-kicker">{copy.openSource.kicker}</span>
				<h2>{copy.openSource.title}</h2>
				<p>{copy.openSource.description}</p>
				<ul class="l-points l-points--light">
					@for (const point of points; key point.id) {
						<li style={'--i:' + String(point.id)}>
							<LIcon name="check" size={14} />
							{point.text}
						</li>
					}
				</ul>
			</div>
			<a
				class="l-repo"
				href={GITHUB_URL}
				target="_blank"
				rel="noreferrer"
				data-reveal
			>
				<div class="l-repo__head">
					<GitHubMark size={26} />
					<div>
						<b>{copy.openSource.repo.name}</b>
						<span>{copy.openSource.repo.tagline}</span>
					</div>
				</div>
				<div class="l-repo__meta">
					<span>
						<i class="l-repo__dot"></i>
						TypeScript
					</span>
					<span>
						<LIcon name="shield" size={13} />
						MIT
					</span>
					<span>
						<LIcon name="git-branch" size={13} />
						main
					</span>
				</div>
				<div class="l-repo__actions">
					<span class="l-button l-button--ghost l-button--sm">
						<LIcon name="star" size={13} />
						{copy.openSource.repo.star}
					</span>
					<span class="l-button l-button--ghost l-button--sm">
						<LIcon name="git-branch" size={13} />
						{copy.openSource.repo.fork}
					</span>
					<span class="l-button l-button--ghost l-button--sm">
						<LIcon name="message" size={13} />
						{copy.openSource.repo.issues}
					</span>
				</div>
				<div class="l-repo__graph" aria-hidden="true">
					<i style="--h:32%"></i>
					<i style="--h:48%"></i>
					<i style="--h:40%"></i>
					<i style="--h:66%"></i>
					<i style="--h:52%"></i>
					<i style="--h:74%"></i>
					<i style="--h:60%"></i>
					<i style="--h:88%"></i>
					<i style="--h:70%"></i>
					<i style="--h:96%"></i>
					<i style="--h:82%"></i>
					<i style="--h:100%"></i>
				</div>
			</a>
		</div>
	</section>
}

function LicensingSection(props: { copy: LandingCopy }) @{
	const copy = props.copy;
	const core = copy.licensing.core.points.map(
		(text, index) => ({
			id: index,
			text,
		}),
	);
	const enterprise = copy.licensing.enterprise.points.map(
		(text, index) => ({
			id: index,
			text,
		}),
	);
	const faq = copy.faq.items.map((item, index) => ({ id: index, ...item }));

	<section class="l-section l-license" id="licensing">
		<div class="l-container">
			<div class="l-head" data-reveal>
				<span class="l-kicker">{copy.licensing.kicker}</span>
				<h2>{copy.licensing.title}</h2>
				<p>{copy.licensing.description}</p>
			</div>
			<div class="l-plans">
				<article class="l-plan" data-reveal style="--i:0">
					<div class="l-plan__head">
						<span class="l-plan__icon">
							<LIcon name="code" size={18} />
						</span>
						<div>
							<b>{copy.licensing.core.name}</b>
							<span>{copy.licensing.core.license}</span>
						</div>
						<em>{copy.licensing.core.price}</em>
					</div>
					<p>{copy.licensing.core.text}</p>
					<ul>
						@for (const point of core; key point.id) {
							<li>
								<LIcon name="check" size={14} />
								{point.text}
							</li>
						}
					</ul>
					<a
						class="l-button l-button--ghost"
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
					>
						<GitHubMark size={15} />
						{copy.licensing.core.cta}
					</a>
				</article>
				<article class="l-plan l-plan--enterprise" data-reveal style="--i:1">
					<div class="l-plan__head">
						<span class="l-plan__icon">
							<LIcon name="building" size={18} />
						</span>
						<div>
							<b>{copy.licensing.enterprise.name}</b>
							<span>{copy.licensing.enterprise.license}</span>
						</div>
						<em>{copy.licensing.enterprise.price}</em>
					</div>
					<p>{copy.licensing.enterprise.text}</p>
					<ul>
						@for (const point of enterprise; key point.id) {
							<li>
								<LIcon name="check" size={14} />
								{point.text}
							</li>
						}
					</ul>
					<a
						class="l-button l-button--primary"
						href={ENTERPRISE_CONTACT_URL}
						target="_blank"
						rel="noreferrer"
					>
						{copy.licensing.enterprise.cta}
						<LIcon name="arrow-right" size={15} />
					</a>
				</article>
			</div>
			<div class="l-faq" data-reveal>
				<h3>{copy.faq.title}</h3>
				@for (const item of faq; key item.id) {
					<details class="l-faq__item">
						<summary>
							<span>{item.q}</span>
							<LIcon name="chevron-down" size={16} />
						</summary>
						<div class="l-faq__answer">
							<p>{item.a}</p>
						</div>
					</details>
				}
			</div>
		</div>
	</section>
}

const LOCAL_COMMANDS = [
	{ id: 1, text: CLONE_COMMAND },
	{ id: 2, text: 'cd coreloom && pnpm install' },
	{
		id: 3,
		text: 'pnpm coreloom setup quick --apply --confirm reset-local-auth',
	},
	{ id: 4, text: 'pnpm dev' },
];

function FinalCta(props: { copy: LandingCopy }) @{
	const copy = props.copy;

	<section class="l-section l-cta">
		<Backdrop />
		<div class="l-container">
			<div class="l-head" data-reveal>
				<span class="l-kicker">{copy.cta.kicker}</span>
				<h2>{copy.cta.title}</h2>
				<p>{copy.cta.description}</p>
			</div>
			<div class="l-cta__grid">
				<div class="l-cta__panel" data-reveal style="--i:0">
					<h3>
						<LIcon name="terminal" size={16} />
						{copy.cta.local.title}
					</h3>
					<div class="l-cli l-cli--static">
						@for (const line of LOCAL_COMMANDS; key line.id) {
							<div class="l-cli__line">
								<span class="l-terminal__prompt">$</span>
								<span>{line.text}</span>
							</div>
						}
					</div>
					<small>{copy.cta.local.note}</small>
				</div>
				<div
					class="l-cta__panel l-cta__panel--accent"
					data-reveal
					style="--i:1"
				>
					<h3>
						<Mark size={18} warp="#0f1729" weft="#b4601f" />
						{copy.cta.hosted.title}
					</h3>
					<p>{copy.cta.hosted.text}</p>
					<a
						class="l-button l-button--primary l-button--lg"
						href={REGISTER_URL}
					>
						{copy.cta.hosted.action}
						<LIcon name="arrow-right" size={16} />
					</a>
					<a class="l-cta__link" href={SIGN_IN_URL}>{copy.cta.hosted.signIn}</a>
				</div>
			</div>
		</div>
	</section>
}

interface LocaleSwitchProps {
	readonly copy: LandingCopy;
	readonly locale: LandingLocale;
	readonly onSelect: (locale: LandingLocale) => void;
}

function LocaleSwitch(props: LocaleSwitchProps) @{
	const locales = LANDING_LOCALES.map(
		(code) => ({
			id: code,
			active: code === props.locale,
		}),
	);
	<div class="l-locale" role="group" aria-label={props.copy.nav.language}>
		@for (const entry of locales; key entry.id) {
			<button
				type="button"
				class={['l-locale__option', entry.active && 'is-active']}
				aria-pressed={entry.active}
				onClick={() => props.onSelect(entry.id)}
			>{entry.id.toUpperCase()}</button>
		}
	</div>
}

export function LandingPage() @{
	const [locale, setLocale] = useState<LandingLocale>('en');
	const copy = landingCopy(locale);
	const rootRef = useRef<HTMLElement | null>(null);
	const [enhanced, setEnhanced] = useState(false);
	const [scrolled, setScrolled] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [productOpen, setProductOpen] = useState(false);
	const [opened, setOpened] = useState(false);
	const [copied, setCopied] = useState(false);

	const selectLocale = (next: LandingLocale) => {
		setLocale(next);
		persistLocale(next);
		document.documentElement.lang = next;
	};

	useEffect(() => {
		const preferred = preferredLocale();
		if (preferred !== 'en') setLocale(preferred);
		document.documentElement.lang = preferred;
		setEnhanced(true);
		const curtain = window.setTimeout(() => setOpened(true), 1_120);
		const onScroll = () => setScrolled(window.scrollY > 12);
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			clearTimeout(curtain);
			window.removeEventListener('scroll', onScroll);
		};
	}, []);

	/* Reveal on scroll. Re-run per locale so re-rendered sections above the
   fold never wait for an intersection that already happened. */
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !enhanced) return;
		const targets = Array.from(
			root.querySelectorAll<HTMLElement>('[data-reveal]'),
		);
		const reduced = window.matchMedia(
			'(prefers-reduced-motion: reduce)',
		).matches;
		const pending: HTMLElement[] = [];
		const visible: HTMLElement[] = [];
		for (const target of targets) {
			if (reduced || target.getBoundingClientRect().top < window.innerHeight) {
				visible.push(target);
			} else {
				pending.push(target);
			}
		}
		/* The opening curtain in index.html clears around 1080ms. On the first
   paint the fold waits for it, so the page fades in behind it instead of
   animating out of sight. */
		const reveal = () => {
			for (const target of visible) target.classList.add('is-in');
		};
		let handle = 0;
		if (reduced || opened) reveal();
		else handle = window.setTimeout(reveal, 780);
		if (pending.length === 0) return () => clearTimeout(handle);
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add('is-in');
				observer.unobserve(entry.target);
			}
		}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
		for (const target of pending) observer.observe(target);
		return () => {
			clearTimeout(handle);
			observer.disconnect();
		};
	}, [enhanced, locale, opened]);

	useEffect(() => {
		if (!productOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setProductOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [productOpen]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1_600);
		return () => clearTimeout(timer);
	}, [copied]);

	const copyClone = () => {
		const clipboard = navigator.clipboard;
		if (!clipboard) return;
		void clipboard.writeText(CLONE_COMMAND).then(
			() => setCopied(true),
			() => undefined,
		);
	};
	const facts = [
		{ id: 'license', ...copy.facts.license },
		{ id: 'modules', ...copy.facts.modules },
		{ id: 'gates', ...copy.facts.gates },
		{ id: 'skills', ...copy.facts.skills },
		{ id: 'stack', ...copy.facts.stack },
	];
	const productLinks = [
		{
			id: 'platform',
			href: '#platform',
			label: copy.nav.platform,
			hint: copy.nav.platformHint,
		},
		{
			id: 'modules',
			href: '#modules',
			label: copy.nav.modules,
			hint: copy.nav.modulesHint,
		},
		{
			id: 'agents',
			href: '#agents',
			label: copy.nav.agents,
			hint: copy.nav.agentsHint,
		},
		{
			id: 'open-source',
			href: '#open-source',
			label: copy.nav.openSource,
			hint: copy.nav.openSourceHint,
		},
	];
	const navLinks = [
		{ id: 'how', href: '#how', label: copy.nav.how },
		{ id: 'sandbox', href: '#sandbox', label: copy.nav.sandbox },
		{ id: 'licensing', href: '#licensing', label: copy.nav.licensing },
	];
	const panelLinks = [...productLinks, ...navLinks];
	const closeMenus = () => {
		setMenuOpen(false);
		setProductOpen(false);
	};

	<main
		class={['l-page', enhanced && 'is-enhanced']}
		ref={rootRef}
		lang={locale}
	>
		<Seo
			title={copy.seo.title}
			titleTemplate="%s · Coreloom"
			description={copy.seo.description}
			robots={{ index: true, follow: true }}
			openGraph={{
				type: 'website',
				siteName: 'Coreloom',
				images: [
					{ url: '/og.png', width: 1200, height: 630, alt: copy.seo.imageAlt },
				],
			}}
			twitter={{ card: 'summary_large_image', image: '/og.png' }}
		/>

		<header class={['l-nav', scrolled && 'is-scrolled', menuOpen && 'is-open']}>
			<div class="l-container l-nav__inner">
				<a class="l-brand" href="/" aria-label={copy.nav.home}>
					<Mark size={26} warp="#0f1729" weft="#b4601f" />
					<span>Coreloom</span>
				</a>
				<nav class="l-nav__links" aria-label={copy.nav.label}>
					<div
						class={['l-menu', productOpen && 'is-open']}
						onPointerEnter={() => setProductOpen(true)}
						onPointerLeave={() => setProductOpen(false)}
					>
						<button
							type="button"
							class="l-menu__trigger"
							aria-expanded={productOpen}
							onClick={() => setProductOpen(!productOpen)}
						>
							{copy.nav.product}
							<LIcon name="chevron-down" size={14} />
						</button>
						<div class="l-menu__panel" aria-label={copy.nav.productMenu}>
							@for (const link of productLinks; key link.id) {
								<a href={link.href} onClick={closeMenus}>
									<b>{link.label}</b>
									<span>{link.hint}</span>
								</a>
							}
						</div>
					</div>
					@for (const link of navLinks; key link.id) {
						<a href={link.href} onClick={closeMenus}>{link.label}</a>
					}
				</nav>
				<div class="l-nav__actions">
					<a
						class="l-nav__github"
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
						aria-label={copy.nav.github}
					>
						<GitHubMark size={17} />
						<span>GitHub</span>
					</a>
					<LocaleSwitch copy={copy} locale={locale} onSelect={selectLocale} />
					<a
						class="l-button l-button--ghost l-button--sm l-nav__sign-in"
						href={SIGN_IN_URL}
					>{copy.nav.signIn}</a>
					<a
						class="l-button l-button--primary l-button--sm"
						href={REGISTER_URL}
					>{copy.nav.create}</a>
					<button
						type="button"
						class="l-nav__toggle"
						aria-label={copy.nav.menu}
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen(!menuOpen)}
					>
						<LIcon name={menuOpen ? 'x' : 'menu'} size={20} />
					</button>
				</div>
			</div>
			<div class="l-nav__panel">
				@for (const link of panelLinks; key link.id) {
					<a href={link.href} onClick={closeMenus}>{link.label}</a>
				}
				<a href={SIGN_IN_URL}>{copy.nav.signIn}</a>
			</div>
		</header>

		<section class="l-hero">
			<Backdrop />
			<div class="l-container l-hero__inner">
				<div class="l-hero__copy">
					<a
						class="l-badge"
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
						data-reveal
						style="--i:0"
					>
						<i></i>
						{copy.hero.badge}
						<LIcon name="arrow-right" size={13} />
					</a>
					<span
						class="l-kicker"
						data-reveal
						style="--i:1"
					>{copy.hero.kicker}</span>
					<h1 data-reveal style="--i:2">
						{copy.hero.title + ' '}
						<em>{copy.hero.titleAccent}</em>
					</h1>
					<p data-reveal style="--i:3">{copy.hero.description}</p>
					<div class="l-clone" data-reveal style="--i:4">
						<span class="l-terminal__prompt">$</span>
						<code>{CLONE_COMMAND}</code>
						<button
							type="button"
							class={['l-clone__copy', copied && 'is-copied']}
							aria-label={copy.hero.cloneLabel}
							onClick={copyClone}
						>
							<LIcon name={copied ? 'check' : 'copy'} size={14} />
							<span>
								{copied ? copy.hero.copied : copy.hero.copy}
							</span>
						</button>
					</div>
					<div class="l-hero__actions" data-reveal style="--i:5">
						<a
							class="l-button l-button--primary l-button--lg"
							href={REGISTER_URL}
						>
							{copy.hero.primary}
							<LIcon name="arrow-right" size={16} />
						</a>
						<a
							class="l-button l-button--ghost l-button--lg"
							href={GITHUB_URL}
							target="_blank"
							rel="noreferrer"
						>
							<GitHubMark size={17} />
							{copy.hero.secondary}
						</a>
					</div>
					<small data-reveal style="--i:6">{copy.hero.note}</small>
				</div>
				<div class="l-hero__demo" data-reveal style="--i:4">
					<ProductDemo copy={copy} />
				</div>
			</div>
		</section>

		<section class="l-facts" aria-label={copy.facts.label}>
			<div class="l-container l-facts__grid">
				@for (const fact of facts; key fact.id) {
					<div class="l-fact" data-reveal>
						<b>{fact.value}</b>
						<span>{fact.label}</span>
					</div>
				}
			</div>
		</section>

		<HowItShips copy={copy} />
		<SandboxSection copy={copy} />
		<PlatformGrid copy={copy} />
		<ModuleContract copy={copy} />
		<AgentsSection copy={copy} />
		<OpenSourceSection copy={copy} />
		<LicensingSection copy={copy} />
		<FinalCta copy={copy} />

		<footer class="l-footer">
			<div class="l-container l-footer__grid">
				<div class="l-footer__brand">
					<a class="l-brand" href="/" aria-label={copy.nav.home}>
						<Mark size={24} warp="#0f1729" weft="#b4601f" />
						<span>Coreloom</span>
					</a>
					<p>{copy.footer.tagline}</p>
					<a
						class="l-nav__github"
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
					>
						<GitHubMark size={16} />
						<span>{copy.openSource.repo.name}</span>
					</a>
				</div>
				<div class="l-footer__col">
					<b>{copy.footer.product}</b>
					<a href="#platform">{copy.nav.platform}</a>
					<a href="#how">{copy.nav.how}</a>
					<a href="#sandbox">{copy.nav.sandbox}</a>
					<a href="#modules">{copy.nav.modules}</a>
					<a href="#agents">{copy.nav.agents}</a>
					<a href={REGISTER_URL}>{copy.nav.create}</a>
				</div>
				<div class="l-footer__col">
					<b>{copy.footer.openSource}</b>
					<a
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.repository}</a>
					<a
						href={GITHUB_URL + '/issues'}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.issues}</a>
					<a
						href={GITHUB_URL + '/releases'}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.releases}</a>
					<a
						href={docUrl('AGENTS.md')}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.contract}</a>
				</div>
				<div class="l-footer__col">
					<b>{copy.footer.resources}</b>
					<a
						href={GITHUB_URL + '#readme'}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.readme}</a>
					<a
						href={docUrl('docs/architecture-blueprint.md')}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.architecture}</a>
					<a
						href={docUrl('docs/design-system.md')}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.designSystem}</a>
					<a
						href={docUrl('docs/cli-extensions.md')}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.cli}</a>
				</div>
				<div class="l-footer__col">
					<b>{copy.footer.licensing}</b>
					<a href="#licensing">{copy.footer.links.mit}</a>
					<a
						href={ENTERPRISE_CONTACT_URL}
						target="_blank"
						rel="noreferrer"
					>{copy.footer.links.enterprise}</a>
				</div>
			</div>
			<div class="l-container l-footer__bottom">
				<span>{copy.footer.copyright}</span>
				<span>{copy.footer.built}</span>
				<LocaleSwitch copy={copy} locale={locale} onSelect={selectLocale} />
			</div>
		</footer>
	</main>
}
