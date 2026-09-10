// Browser regression against the real sandbox UI. All API and preview requests
// use synthetic fixtures: no model invocation, platform write or PR is made.
const { chromium } = await import(
	process.env.PLAYWRIGHT_MODULE ?? 'playwright'
);
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const out = await mkdtemp(join(tmpdir(), 'sandbox-workflow-'));
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4438';
const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH
		? { executablePath: process.env.CHROME_PATH }
		: {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors = [],
	calls = [],
	findings = {};
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('flowdular.locale', 'pl'));
await page.route('**/@fs/**/files/*.woff*', async (route) => {
	const path = decodeURIComponent(
		new URL(route.request().url()).pathname.slice(4),
	);
	if (!path.startsWith(join(repository, 'node_modules') + '/'))
		return route.abort();
	await route.fulfill({
		body: await readFile(path),
		contentType: 'font/woff2',
	});
});
const id = '00000000-0000-4000-8000-000000000001';
const modules = [
	{ id: 'booking.core', directory: 'booking', kind: 'new' },
	{ id: 'rooms.core', directory: 'rooms', kind: 'new' },
];
const session = {
	id,
	kind: 'new-module',
	moduleId: 'booking.core',
	moduleSuffix: 'booking',
	modules,
	title: 'Rezerwacje sal i dostępność zespołu',
	brief: 'Potrzebujemy rezerwacji sal bez nakładających się terminów.',
	blueprint: 'new-module@1.0.0',
	role: 'backend-engineer',
	driver: 'fake',
	model: null,
	resumeIds: {},
	autoContinue: false,
	chainDepth: 0,
	attachments: [],
	checkpoints: [],
	state: 'awaiting-approval',
	createdAt: Date.now(),
	updatedAt: Date.now(),
	ejectedAt: null,
	archivedAt: null,
	registeredWithPlatform: false,
};
const roles = [
	{ id: 'business-manager', name: 'Business manager' },
	{ id: 'backend-engineer', name: 'Backend engineer' },
	{ id: 'frontend-engineer', name: 'Frontend engineer' },
];
const state = {
	configuration: {
		mode: 'loopback',
		platformUrl: 'http://example.test',
		driver: 'fake',
		driverModel: null,
		previewData: 'fixtures',
		byok: null,
		github: {
			enabled: false,
			overridesProject: false,
			remote: 'origin',
			repository: null,
			baseBranch: 'main',
			branchPrefix: 'sandbox',
			mode: 'auto',
			forkOwner: null,
			reviewers: [],
			tokenFingerprint: null,
		},
	},
	connection: {
		connected: true,
		authority: {
			principal: {
				accountId: 'alice',
				tenantId: 'demo',
				displayName: 'Anna',
				email: 'anna@example.test',
				tenantName: 'Firma demonstracyjna',
				tenantSlug: 'demo',
				role: 'owner',
				scopes: [],
			},
			authority: {
				granted: true,
				grantId: 'g',
				capabilities: ['sandbox.access.use'],
				expiresAt: null,
			},
		},
		error: null,
	},
	drivers: [
		{
			id: 'fake',
			label: 'Moja subskrypcja AI',
			offered: true,
			kind: 'local-cli',
			requiresLoopback: true,
			availability: { available: true, detail: 'OK', version: 'test' },
		},
	],
	roles,
	sessions: [session],
	workspaceModules: [],
	running: [],
};
const review = modules.map((m) => ({
	module: m.directory,
	moduleId: m.id,
	kind: 'new',
	path: `modules/${m.directory}/spec/module.yaml`,
	present: true,
	status: 'draft',
	approved: false,
	approvedAt: null,
	changed: true,
	base: null,
	changes: [],
	draft: {
		id: m.id,
		name: m.directory === 'booking' ? 'Rezerwacje sal' : 'Sale spotkań',
		description: 'Prosta obsługa dostępności i rezerwacji sal.',
		specVersion: '0.1.0',
		status: 'draft',
		profile: 'business',
		tenancy: 'tenant',
		capabilities: ['api', 'ui'],
		locales: ['en', 'pl'],
		dependencies: [],
		permissions: [
			{ id: `${m.id}.items.read`, description: 'Przeglądanie rezerwacji' },
		],
		invariants: ['Rezerwacje nie mogą się nakładać.'],
		dataOwnership: ['Dane należą do organizacji.'],
		acceptanceScenarios: [
			{
				id: 'create',
				given: 'Dostępna sala',
				when: 'Użytkownik rezerwuje termin',
				then: 'Rezerwacja pojawia się na liście',
			},
		],
	},
}));
let running = false;
let releaseFollow;
let kind = 'approval',
	turnFailure = false,
	delayedSpec = false;
let resolveSpec, lastSpecSave;
function chat() {
	return [
		{
			sequence: 1,
			at: 1,
			kind: 'user',
			role: 'operator',
			module: 'rooms',
			text: session.brief,
		},
		{
			sequence: 2,
			at: 2,
			kind: 'agent',
			role: 'business-manager',
			module: 'rooms',
			text: 'Plan jest gotowy. Sprawdź zasady i zatwierdź dalszą pracę.',
		},
		{
			sequence: 3,
			at: 3,
			kind: 'system',
			role: 'backend-engineer',
			module: 'rooms',
			text: 'Specification needs approval before implementation.',
			handoff: {
				kind,
				role: 'backend-engineer',
				roleName: 'Backend engineer',
				module: 'rooms',
				prompt: 'Build rooms module',
				reason: 'Ready',
			},
		},
	];
}
const diffs = modules.map((m) => ({
	module: m.directory,
	path: 'spec/module.yaml',
	change: 'created',
	additions: 1,
	deletions: 0,
	truncated: false,
	binary: false,
	hunks: [
		{
			header: '@@ -0,0 +1 @@',
			lines: [{ type: 'add', oldLine: null, newLine: 1, text: `id: ${m.id}` }],
		},
	],
}));
const view = () => ({
	session,
	paths: {
		module: 'modules/booking',
		modules: modules.map((m) => ({ id: m.id, path: `modules/${m.directory}` })),
	},
	chat: [
		...chat(),
		...(running
			? [
					{
						sequence: 4,
						at: Date.now() - 60000,
						kind: 'event',
						role: 'backend-engineer',
						event: { type: 'reasoning', text: '   ' },
					},
					{
						sequence: 5,
						at: Date.now() - 60000,
						kind: 'event',
						role: 'backend-engineer',
						event: { type: 'activity', phase: 'thinking' },
					},
					{
						sequence: 6,
						at: Date.now() - 60000,
						kind: 'event',
						role: 'backend-engineer',
						event: { type: 'activity', phase: 'thinking' },
					},
				]
			: []),
	],
	specs: review,
	diffs,
	running,
});
const plan = {
	target: 'workspace',
	moduleId: 'booking.core',
	targetPath: 'modules/booking',
	files: ['spec/module.yaml'],
	overwrites: [],
	removes: [],
	gates: ['spec-schema', 'tests'],
	newPackages: [],
	enable: true,
	modules: modules.map((m) => ({
		...m,
		targetPath: `modules/${m.directory}`,
		files: ['spec/module.yaml'],
		additions: ['spec/module.yaml'],
		overwrites: [],
		removes: [],
		newPackages: [],
		enable: true,
	})),
	changedFiles: 2,
	platformLocal: true,
	restartRequired: true,
	notes: [],
	availableTargets: [{ id: 'workspace', available: true, reason: null }],
};
const json = (route, body, status = 200) =>
	route.fulfill({
		status,
		contentType: 'application/json',
		body: JSON.stringify(body),
	});
await page.route('**/sandbox/api/**', async (route) => {
	const req = route.request(),
		url = new URL(req.url()),
		path = url.pathname;
	const body = req.method() === 'POST' ? req.postDataJSON() : null;
	calls.push({ path, method: req.method(), body });
	if (path.endsWith('/turn/stream')) {
		await new Promise((resolve) => {
			releaseFollow = resolve;
		});
		return route.fulfill({ status: 204 });
	}
	if (path.endsWith('/settings') && body) {
		session.autoContinue = body.autoContinue;
		return json(route, { session });
	}
	if (path.endsWith('/state')) return json(route, state);
	if (path.endsWith('/config'))
		return json(route, {
			configuration: state.configuration,
			connection: state.connection,
		});
	if (path.endsWith('/spec') && req.method() === 'GET') {
		if (delayedSpec) await new Promise((r) => (resolveSpec = r));
		const module = url.searchParams.get('module') || 'booking';
		return json(route, {
			module,
			moduleId: module + '.core',
			path: `modules/${module}/spec/module.yaml`,
			text: `id: ${module}.core\nstatus: draft\n`,
		});
	}
	if (path.endsWith('/spec') && body) {
		lastSpecSave = body;
		return json(route, view());
	}
	if (path.endsWith('/turn')) {
		if (turnFailure)
			return json(
				route,
				{
					error: {
						code: 'DRIVER_UNAVAILABLE',
						message: 'The selected driver is unavailable.',
					},
				},
				503,
			);
		return route.fulfill({
			contentType: 'text/event-stream',
			body: 'event: completed\ndata: {}\n\n',
		});
	}
	if (path.endsWith('/stop')) return json(route, { stopped: false });
	if (path.endsWith('/approve'))
		return json(route, { session, status: 'approved', module: body.module });
	if (path.endsWith('/format'))
		return json(route, { gate: { id: 'format', status: 'passed' }, gates: [] });
	if (path.endsWith('/gates'))
		return json(route, {
			gates: [
				{
					id: 'tests',
					module: 'rooms',
					status: 'failed',
					output: 'A booking overlaps an existing reservation.',
					durationMs: 1,
				},
			],
		});
	if (path.endsWith('/eject')) {
		if (!body?.apply) return json(route, { plan });
		return route.fulfill({
			contentType: 'text/event-stream',
			body: 'event: copy.completed\ndata: {"files":2}\n\nevent: failed\ndata: {"message":"Synthetic delivery stopped before writes"}\n\n',
		});
	}
	if (path === `/sandbox/api/sessions/${id}`) return json(route, view());
	return json(route, { error: { message: 'Blocked by review harness' } }, 403);
});
await page.route('**/preview/**', (route) =>
	route.fulfill({
		contentType: 'text/html',
		body: '<html lang="pl"><body><h1>Podgląd testowy modułu</h1><p>Dane demonstracyjne, bez operacji na platformie.</p></body></html>',
	}),
);
async function open() {
	await page.goto(`${baseUrl}/sessions/${id}`);
	await page.locator('.session-bar').waitFor();
	await page.locator('#flowdular-splash').waitFor({ state: 'detached' });
}
try {
	await open();
	const stateDirectory = existsSync(join(repository, '.coreloom'))
		? '.coreloom'
		: '.flowdular';
	const sessionsRoot = join(repository, stateDirectory, 'sandbox/sessions');
	await mkdir(sessionsRoot, { recursive: true });
	const draftRoot = await mkdtemp(join(sessionsRoot, 'hmr-regression-'));
	try {
		const draftFile = join(
			draftRoot,
			'workspace/modules/sample/src/client/Probe.tsrx',
		);
		await mkdir(join(draftFile, '..'), { recursive: true });
		await writeFile(draftFile, "export const marker = 'preview-before';");
		const moduleUrl = new URL('/@fs' + draftFile, baseUrl);
		assert.match(await (await fetch(moduleUrl)).text(), /preview-before/);
		await page
			.locator('.chat__composer textarea')
			.fill('Preserve this unsent message.');
		await page.evaluate(() => {
			window.__reloadProbe = 'preserved';
		});
		await writeFile(draftFile, "export const marker = 'preview-after';");
		const deadline = Date.now() + 10000;
		let refreshed = false;
		while (Date.now() < deadline) {
			if ((await (await fetch(moduleUrl)).text()).includes('preview-after')) {
				refreshed = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(
			refreshed,
			true,
			'The preview transform must reflect the saved file',
		);
		// Allow delivery of any full-reload message emitted by this save.
		await new Promise((resolve) => setTimeout(resolve, 750));
		assert.equal(await page.evaluate(() => window.__reloadProbe), 'preserved');
		assert.equal(
			await page.locator('.chat__composer textarea').inputValue(),
			'Preserve this unsent message.',
		);
		await page.locator('.chat__composer textarea').fill('');
		findings.previewIsolation =
			'Draft save refreshes the transformed module without reloading the page or losing unsent text';
	} finally {
		await rm(draftRoot, { recursive: true, force: true });
	}
	await page.locator('.workspace-menu__button').click();
	await page.getByRole('menuitem', { name: 'Modele AI · BYOK' }).click();
	const modelDrawer = page.getByRole('dialog');
	await modelDrawer.locator('select').selectOption('openai-compatible');
	await modelDrawer.locator('[name="model"]').fill('test-model');
	await modelDrawer.locator('[name="credential"]').fill('synthetic-key');
	await modelDrawer
		.locator('[name="baseURL"]')
		.fill('https://models.example/v1');
	await modelDrawer.screenshot({
		path: out + '/byok-settings.png',
		animations: 'disabled',
	});
	await modelDrawer
		.getByRole('button', { name: 'Zapisz', exact: true })
		.click();
	await modelDrawer.waitFor({ state: 'detached' });
	const configCall = calls.find((call) => call.path.endsWith('/config'));
	assert.equal(configCall.body.byokKind, 'openai-compatible');
	assert.equal(configCall.body.byokModel, 'test-model');
	assert.equal(configCall.body.byokCredential, 'synthetic-key');
	assert.equal(configCall.body.byokBaseUrl, 'https://models.example/v1');
	findings.byok =
		'Provider settings submit through the authenticated configuration endpoint';
	const settings = page.locator('.chat-settings button');
	const panel = page.locator('#composer-settings');
	assert.equal(await panel.count(), 0);
	const settingsBounds = await settings.boundingBox();
	const attachBounds = await page.locator('.chat__attach').boundingBox();
	assert.ok(settingsBounds.x < attachBounds.x);
	assert.ok(
		Math.abs(
			settingsBounds.y +
				settingsBounds.height / 2 -
				attachBounds.y -
				attachBounds.height / 2,
		) < 2,
	);
	await settings.focus();
	await page.keyboard.press('Enter');
	await panel.waitFor();
	const handoffs = panel.getByRole('checkbox').nth(0);
	const fresh = panel.getByRole('checkbox', {
		name: 'Świeży kontekst agenta',
		exact: true,
	});
	const initialHandoffs = await handoffs.isChecked();
	await page.keyboard.press('Tab');
	assert.equal(
		await handoffs.evaluate((node) => node === document.activeElement),
		true,
	);
	await page.keyboard.press('Space');
	await page.waitForFunction(
		(expected) =>
			document.querySelector('#composer-settings input')?.checked === expected,
		!initialHandoffs,
	);
	assert.equal(await handoffs.isChecked(), !initialHandoffs);
	await fresh.check();
	await page.keyboard.press('Escape');
	await panel.waitFor({ state: 'detached' });
	assert.equal(
		await settings.evaluate((node) => node === document.activeElement),
		true,
	);
	await settings.click();
	assert.equal(await fresh.isChecked(), true);
	assert.equal(await handoffs.isChecked(), !initialHandoffs);
	await panel.screenshot({
		path: out + '/composer-settings.png',
		animations: 'disabled',
	});
	await handoffs.click();
	await page.waitForFunction(
		(expected) =>
			document.querySelector('#composer-settings input')?.checked === expected,
		initialHandoffs,
	);
	await fresh.uncheck();
	await page.locator('.chat__composer textarea').click();
	await panel.waitFor({ state: 'detached' });
	findings.composerSettings =
		'Keyboard toggles, retained state, Escape focus restoration and outside dismissal passed';
	running = true;
	await open();
	await page.getByText(/Brak aktualizacji od \d+s/).waitFor();
	const firstAge = await page.locator('.chat__activity-age').innerText();
	await page.waitForFunction(
		(previous) =>
			document.querySelector('.chat__activity-age')?.textContent !== previous,
		firstAge,
	);
	assert.equal(await page.locator('.chat__event--active').count(), 1);
	assert.equal(await page.locator('.chat__events li').count(), 1);
	await settings.click();
	assert.equal(await fresh.isDisabled(), true);
	assert.equal(await handoffs.isEnabled(), true);
	await page.keyboard.press('Escape');
	await page.screenshot({
		path: out + '/quiet-agent.png',
		animations: 'disabled',
	});
	running = false;
	releaseFollow?.();
	await open();
	assert.equal(await page.locator('.chat__activity-age').count(), 0);
	findings.agentActivity =
		'Quiet duration ticks, activity is coalesced, fresh context is disabled while running, and the status unmounts after completion';

	await page.screenshot({
		animations: 'disabled',
		path: out + '/session-pl.png',
	});
	findings.previewLayout = await page.evaluate(() => {
		const chat = document
			.querySelector('.sandbox__chat')
			.getBoundingClientRect();
		const card = document.querySelector('.work-card').getBoundingClientRect();
		const composer = document
			.querySelector('.chat__composer textarea')
			.getBoundingClientRect();
		return {
			chatRight: chat.right,
			cardLeft: card.left,
			cardRight: card.right,
			composerRight: composer.right,
		};
	});
	assert.ok(
		findings.previewLayout.chatRight > findings.previewLayout.cardRight,
	);
	assert.ok(
		findings.previewLayout.composerRight < findings.previewLayout.cardLeft,
	);
	findings.plText = await page.locator('.sandbox__body').innerText();
	findings.approvalActions = await page
		.getByRole('button', { name: 'Edytuj specyfikację', exact: true })
		.count();
	await page.getByRole('button', { name: 'Zatwierdź', exact: true }).click();
	await page.getByRole('button', { name: 'Wyślij', exact: true }).waitFor();
	assert.equal(
		calls.filter((call) => call.path.endsWith('/approve')).at(-1)?.body.module,
		'rooms',
	);
	await page
		.locator('.session-bar')
		.getByRole('button', { name: 'Zmiany (2)', exact: true })
		.click();
	await page
		.getByRole('dialog')
		.getByRole('combobox', { name: 'Moduł', exact: true })
		.selectOption('rooms');
	await page.getByRole('button', { name: 'Specyfikacja', exact: true }).click();
	await page.locator('.spec-editor__text').waitFor();
	await page.waitForFunction(() =>
		document.querySelector('.spec-editor__text')?.value.includes('rooms.core'),
	);
	delayedSpec = true;
	await page
		.getByRole('combobox', { name: 'Moduł', exact: true })
		.selectOption('booking');
	assert.equal(
		await page
			.getByRole('button', { name: 'Zapisz', exact: true })
			.isDisabled(),
		true,
	);
	assert.equal(await page.locator('.spec-editor__text').inputValue(), '');
	delayedSpec = false;
	await page.waitForFunction(
		() => document.querySelector('.spec-editor__text')?.disabled,
	);
	resolveSpec?.();
	await page.waitForFunction(() =>
		document
			.querySelector('.spec-editor__text')
			?.value.includes('booking.core'),
	);
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await page.getByText('Zapisano specyfikację', { exact: false }).waitFor();
	findings.specTarget = {
		selector: await page
			.getByRole('combobox', { name: 'Moduł', exact: true })
			.inputValue(),
		saved: lastSpecSave,
		path: await page.locator('.spec-editor__bar').innerText(),
	};
	await page.screenshot({
		animations: 'disabled',
		path: out + '/spec-module-mismatch.png',
	});
	delayedSpec = false;
	resolveSpec?.();
	await page.keyboard.press('Escape');
	kind = 'continue';
	await open();
	await page
		.getByRole('combobox', { name: 'Moduł docelowy', exact: true })
		.selectOption('booking');
	await page
		.getByRole('button', {
			name: 'Kontynuuj: Reguły biznesowe i dane',
			exact: true,
		})
		.click();
	await page.getByRole('button', { name: 'Wyślij', exact: true }).waitFor();
	findings.continuation = calls.filter((c) => c.path.endsWith('/turn')).at(-1);
	turnFailure = true;
	await page
		.locator('.chat__composer textarea')
		.fill('Proszę dodać opis rezerwacji.');
	await settings.click();
	await fresh.check();
	await page.getByRole('button', { name: 'Wyślij', exact: true }).click();
	assert.equal(
		calls.filter((c) => c.path.endsWith('/turn')).at(-1).body.freshContext,
		true,
	);
	await page
		.getByText('The selected driver is unavailable.', { exact: true })
		.waitFor();
	findings.failedTurn = {
		stopVisible: await page
			.getByRole('button', { name: 'Zatrzymaj', exact: true })
			.isVisible(),
		message: await page.locator('.chat__composer textarea').inputValue(),
	};
	await page.screenshot({
		animations: 'disabled',
		path: out + '/failed-turn.png',
	});
	turnFailure = false;
	await open();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		animations: 'disabled',
		path: out + '/session-mobile.png',
	});
	await settings.click();
	await panel.waitFor();
	const panelBounds = await panel.boundingBox();
	assert.ok(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 390);
	assert.ok(panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= 844);
	await page.screenshot({
		path: out + '/composer-settings-mobile.png',
		animations: 'disabled',
	});
	await page.keyboard.press('Escape');
	findings.mobile = {
		previewButtons: await page
			.getByRole('button', { name: 'Podgląd', exact: true })
			.count(),
		previewVisible: await page
			.getByRole('button', { name: 'Podgląd', exact: true })
			.isVisible(),
		body: await page.locator('.sandbox__body').boundingBox(),
		composer: await page.locator('.chat__composer').boundingBox(),
	};
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page
		.getByRole('button', { name: 'Sprawdź moduły', exact: true })
		.click();
	await page
		.getByText('A booking overlaps an existing reservation.', { exact: true })
		.waitFor();
	findings.gates = await page.getByRole('dialog').innerText();
	await page.screenshot({
		animations: 'disabled',
		path: out + '/gates-fixed.png',
	});
	await page.keyboard.press('Escape');
	await page
		.locator('.session-bar')
		.getByRole('button', { name: 'Dostarcz', exact: true })
		.click();
	await page.locator('.eject').waitFor();
	await page.screenshot({
		animations: 'disabled',
		path: out + '/delivery-plan.png',
	});
	await page
		.locator('.eject')
		.getByRole('button', { name: 'Dostarcz', exact: true })
		.click();
	await page
		.getByText('Synthetic delivery stopped before writes', { exact: true })
		.waitFor();
	findings.deliveryText = await page.locator('.eject').innerText();
	await page.screenshot({
		animations: 'disabled',
		path: out + '/delivery-failed.png',
	});
	await page
		.locator('.eject')
		.getByRole('button', { name: 'Zamknij', exact: true })
		.click();
	await page.locator('.workspace-menu__button').click();
	await page
		.getByRole('combobox', { name: 'Język', exact: true })
		.selectOption('en');
	await page
		.locator('.session-bar')
		.getByRole('button', { name: 'Check modules', exact: true })
		.waitFor();
	findings.languageSwitch = {
		locale: await page.evaluate(() => localStorage.getItem('flowdular.locale')),
		sessionBar: await page.locator('.session-bar').innerText(),
	};
	await page.locator('.workspace-menu__button').click();
	await page.screenshot({
		animations: 'disabled',
		path: out + '/session-en.png',
	});
	diffs.splice(0);
	await open();
	await page.setViewportSize({ width: 390, height: 844 });
	findings.noChangesMobile = {
		changesDisabled: await page
			.locator('.session-bar')
			.getByRole('button', { name: 'Zmiany (0)', exact: true })
			.isDisabled(),
		previewVisible: await page
			.getByRole('button', { name: 'Podgląd', exact: true })
			.isVisible(),
	};
	findings.pageErrors = errors;
	assert.equal(findings.approvalActions, 1);
	assert.equal(findings.specTarget.saved.module, 'booking');
	assert.match(findings.specTarget.saved.text, /booking.core/);
	assert.equal(findings.continuation.body.module, 'rooms');
	assert.equal(findings.failedTurn.stopVisible, false);
	assert.equal(findings.failedTurn.message, 'Proszę dodać opis rezerwacji.');
	assert.equal(findings.noChangesMobile.previewVisible, true);
	await page
		.locator('.session-bar')
		.getByRole('button', { name: 'Podgląd', exact: true })
		.click();
	await page.getByRole('dialog').locator('iframe').waitFor();
	await page.screenshot({
		animations: 'disabled',
		path: out + '/mobile-preview-fixed.png',
	});
	assert.match(findings.gates, /Wymaga poprawy/);
	assert.match(findings.deliveryText, /Przenoszenie modułu do platformy/);
	assert.doesNotMatch(findings.deliveryText, /2 files/);
	assert.deepEqual(errors, []);
} finally {
	findings.artifacts = out;
	await writeFile(out + '/results.json', JSON.stringify(findings, null, 2));
	console.log(JSON.stringify(findings, null, 2));
	await browser.close();
}
