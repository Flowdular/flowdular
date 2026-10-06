import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ServerRoute } from '@octanejs/app-core';
import { OWNER_SCOPES } from '@flowdular/module-auth';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	validateWorkspaceSlug,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import type {
	DatabaseProvider,
	ModuleDatabaseRequirements,
} from '@flowdular/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInChrome } from '../../../../packages/ui/tests/chrome.ts';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
import { createSetupAccess } from './access.ts';
import {
	createSetupAdapters,
	PGLITE_ADAPTER_ID,
	POSTGRESQL_ADAPTER_ID,
} from './adapters.ts';
import { enabledDatabaseModules } from './modules.ts';
import {
	renderSetupPage,
	WORKSPACE_SLUG_TYPING_FILTER,
	type SetupPageView,
} from './page.ts';
import { createSetupRoutes } from './routes.ts';

const TOKEN = 'z'.repeat(43);
const ORIGIN = 'http://127.0.0.1:4310';
const SLOW = 180_000;
const OWNER = {
	workspaceName: 'Acme Finance',
	workspaceSlug: 'acme-finance',
	ownerName: 'Ada Owner',
	ownerEmail: 'ada@example.test',
	ownerPassword: 'SetupOwner987!',
	ownerPasswordConfirm: 'SetupOwner987!',
	applicationPath: '/app',
};

const roots: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-setup-routes-'));
	roots.push(root);
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({ modules: { enabled: ['auth.core', 'catalog.core'] } }),
	);
	for (const [directory, id] of [
		['auth', 'auth.core'],
		['catalog', 'catalog.core'],
	]) {
		mkdirSync(join(root, 'modules', directory!), { recursive: true });
		writeFileSync(
			join(root, 'modules', directory!, 'module.json'),
			JSON.stringify({
				id,
				capabilities: ['api', 'database'],
				tenancy: 'required',
			}),
		);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function harness(
	root: string,
	modules?: readonly ModuleDatabaseRequirements[],
	webMountPaths: readonly string[] = [],
	setupOptions: {
		readonly databasePreconfigured?: boolean;
		readonly environment?: NodeJS.ProcessEnv;
		readonly restartApplication?: (exitCode: number) => void;
	} = {},
) {
	const enabled = enabledDatabaseModules(root);
	const routes = createSetupRoutes({
		environment: setupOptions.environment ?? { NODE_ENV: 'development' },
		databasePreconfigured: setupOptions.databasePreconfigured ?? false,
		webMountPaths,
		workspaceRoot: root,
		adapters: createSetupAdapters({ workspaceRoot: root, production: false }),
		access: createSetupAccess(TOKEN),
		modules: modules ?? enabled.modules,
		modulesApproximated: enabled.approximated,
		tokenFile: join(root, '.flowdular', 'setup-token'),
		secureCookies: false,
		...(setupOptions.restartApplication
			? { restartApplication: setupOptions.restartApplication }
			: {}),
	});
	const route = (path: string): ServerRoute =>
		routes.find((entry) => entry.path === path)!;
	let cookie: string | null = null;
	const call = async (
		path: string,
		body?: Record<string, string>,
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		if (cookie) headers.cookie = cookie;
		const request = body
			? new Request(`${ORIGIN}${path}`, {
					method: 'POST',
					headers,
					body: new URLSearchParams(body),
				})
			: new Request(`${ORIGIN}${path}`, { headers });
		const response = await route(path).handler(createContext(request, {}));
		const issued = response.headers.get('set-cookie');
		if (issued) cookie = issued.split(';')[0] ?? null;
		return response;
	};
	return { routes, route, call, csrf: '' };
}

async function csrfOf(response: Response): Promise<string> {
	const html = await response.text();
	return /name="setupCsrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

/* The completed page requests its restart with fetch, which a browser checks
   against connect-src, or default-src when the policy has no connect-src. */
function fetchSources(response: Response): readonly string[] {
	const directives = new Map(
		(response.headers.get('content-security-policy') ?? '')
			.split(';')
			.map((directive) => directive.trim().split(/\s+/))
			.map(([name, ...sources]) => [name, sources] as const),
	);
	return directives.get('connect-src') ?? directives.get('default-src') ?? [];
}

describe('first-run routes', () => {
	it('rejects a backoffice prefix claimed by a public module before provisioning', async () => {
		const root = workspace();
		const app = harness(root, undefined, ['/backoffice/blog'], {
			databasePreconfigured: true,
			environment: {
				NODE_ENV: 'development',
				FD_APPLICATION_PATH: '/backoffice',
			},
		});
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));
		const response = await app.call('/setup', {
			step: 'workspace',
			setupCsrf: csrf,
			...OWNER,
			applicationPath: '/backoffice',
		});
		expect(await response.text()).toContain(
			'overlaps a configured public module',
		);
		expect(existsSync(join(root, '.env'))).toBe(false);
	});
	it.each(['/api', '/', '//example.test', '/back office', '/setup'])(
		'rejects invalid backoffice address %s before provisioning',
		async (applicationPath) => {
			const root = workspace();
			const app = harness(root, undefined, [], {
				databasePreconfigured: true,
			});
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const setup = await (await app.call('/setup')).text();
			expect(setup).toContain(
				'name="applicationPath" type="text" value="/app"',
			);
			const csrf = /name="setupCsrf" value="([^"]+)"/.exec(setup)![1]!;
			const response = await app.call('/setup', {
				step: 'workspace',
				setupCsrf: csrf,
				...OWNER,
				applicationPath,
			});
			expect(await response.text()).toContain('System addresses are reserved');
			expect(existsSync(join(root, '.env'))).toBe(false);
		},
	);
	it('keeps the deployment-owned backoffice path fixed', async () => {
		const root = workspace();
		const app = harness(root, undefined, [], {
			databasePreconfigured: true,
		});
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));
		const response = await app.call('/setup', {
			step: 'workspace',
			setupCsrf: csrf,
			...OWNER,
			applicationPath: '/backoffice',
		});
		const html = await response.text();
		expect(html).toContain('controlled by the deployment');
		expect(html).not.toContain(OWNER.ownerPassword);
		expect(existsSync(join(root, '.env'))).toBe(false);
	});
	it.each([
		[{}, 12],
		[{ FD_AUTH_PASSWORD_MIN_LENGTH: '' }, 12],
		[{ FD_AUTH_PASSWORD_MIN_LENGTH: '16' }, 16],
	])(
		'asks the workspace step for the password length auth.core enforces (%o)',
		async (environment, minimum) => {
			const app = harness(workspace(), undefined, [], {
				databasePreconfigured: true,
				environment: { NODE_ENV: 'development', ...environment },
			});
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const setup = await (await app.call('/setup')).text();
			expect(setup).toContain(`Use at least ${minimum} characters.`);
			const short = 'Qx7!vRm2#pLw9$tZ'.slice(0, minimum - 1);
			const response = await app.call('/setup', {
				step: 'workspace',
				setupCsrf: /name="setupCsrf" value="([^"]+)"/.exec(setup)![1]!,
				...OWNER,
				ownerPassword: short,
				ownerPasswordConfirm: short,
			});
			const html = await response.text();
			expect(html).toContain(
				`Password must contain at least ${minimum} characters.`,
			);
			expect(html).not.toContain('Review setup</h2>');
		},
	);
	it.each(['abc', '4', '129', '12.5'])(
		'refuses to start on FD_AUTH_PASSWORD_MIN_LENGTH=%j, as auth.core does',
		(value) => {
			const root = workspace();
			const environment = {
				NODE_ENV: 'development',
				FD_AUTH_PASSWORD_MIN_LENGTH: value,
			};
			const refusal =
				'FD_AUTH_PASSWORD_MIN_LENGTH must be an integer between 8 and 128.';
			expect(() =>
				authRuntimeOptionsFromEnvironment(environment, root),
			).toThrow(refusal);
			expect(() => harness(root, undefined, [], { environment })).toThrow(
				refusal,
			);
		},
	);
	it('lets the browser refuse a workspace address auth.core would refuse', async () => {
		const app = harness(workspace(), undefined, [], {
			databasePreconfigured: true,
		});
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const setup = await (await app.call('/setup')).text();
		const input =
			/<input [^>]*id="setup-workspaceSlug"[^>]*>/.exec(setup)?.[0] ?? '';
		expect(input).toContain(
			' autocapitalize="none" autocorrect="off" spellcheck="false"',
		);
		expect(input).toContain(
			String.raw` pattern="(?!.*--)[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]"`,
		);
		/* Browsers compile a pattern attribute anchored and with the v flag. */
		const browser = new RegExp(
			`^(?:${/ pattern="([^"]+)"/.exec(input)![1]})$`,
			'v',
		);
		const accepts = (slug: string) => {
			try {
				return validateWorkspaceSlug(slug) === slug;
			} catch {
				return false;
			}
		};
		for (const slug of [
			'acme',
			'acme-finance',
			'a1b',
			'0ps',
			'x'.repeat(48),
			'x'.repeat(49),
			'ab',
			'a',
			'-acme',
			'acme-',
			'ac--me',
			'acme corp',
			'acme_corp',
			'acme!',
			'zażółć',
			'<b>acme</b>',
		]) {
			expect(browser.test(slug), slug).toBe(accepts(slug));
		}
	});
	it('ships the workspace address filter under the page nonce', async () => {
		const app = harness(workspace(), undefined, [], {
			databasePreconfigured: true,
		});
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const response = await app.call('/setup');
		const policy = response.headers.get('content-security-policy') ?? '';
		const html = await response.text();
		const filter = [
			...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g),
		].find(([, , source]) => source!.includes(WORKSPACE_SLUG_TYPING_FILTER));
		expect(policy.split('; ')).toContain(`script-src 'nonce-${filter?.[1]}'`);
	});
	it('refuses what a workspace address cannot hold while it is typed, in Chrome', async () => {
		const app = harness(workspace(), undefined, [], {
			databasePreconfigured: true,
		});
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const response = await app.call('/setup');
		const html = await response.text();
		const server = createServer((request, reply) => {
			if (request.url === '/setup') {
				reply.writeHead(200, Object.fromEntries(response.headers)).end(html);
			} else reply.writeHead(404).end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, '127.0.0.1', resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			await openInChrome(`http://127.0.0.1:${port}/setup`, async (page) => {
				const field = "document.getElementById('setup-workspaceSlug')";
				const read = () =>
					page.evaluate<{ value: string; caret: number; valid: boolean }>(
						`(({ value, selectionStart, validity }) => ({ value, caret: selectionStart, valid: validity.valid }))(${field})`,
					);
				await page.evaluate(`${field}.focus()`);
				await page.type('Acme Corp_2026!');
				expect(await read()).toEqual({
					value: 'acme-corp2026',
					caret: 13,
					valid: true,
				});
				await page.evaluate("document.execCommand('undo')");
				const undone = (await read()).value;
				expect('acme-corp2026'.startsWith(undone)).toBe(true);
				expect(undone).not.toBe('acme-corp2026');
				await page.evaluate("document.execCommand('redo')");
				expect((await read()).value).toBe('acme-corp2026');
				await page.evaluate(`${field}.setSelectionRange(4, 4)`);
				await page.type('_X');
				expect(await read()).toEqual({
					value: 'acmex-corp2026',
					caret: 5,
					valid: true,
				});
				await page.evaluate("document.execCommand('undo')");
				expect((await read()).value).toBe('acme-corp2026');
				await page.evaluate("document.execCommand('redo')");
				expect((await read()).value).toBe('acmex-corp2026');
				await page.evaluate(`${field}.select()`);
				await page.insertText('!'.repeat(10) + 'x'.repeat(50));
				expect((await read()).value).toBe('x'.repeat(48));
				await page.evaluate(`${field}.select()`);
				await page.type('Łódź');
				expect(await read()).toEqual({ value: 'lodz', caret: 4, valid: true });
				await page.type(' Straße');
				expect(await read()).toEqual({
					value: 'lodz-strasse',
					caret: 12,
					valid: true,
				});
				await page.evaluate(`${field}.select()`);
				await page.insertText('Łódź');
				expect(await read()).toEqual({ value: 'lodz', caret: 4, valid: true });
				await page.evaluate("document.execCommand('undo')");
				expect((await read()).value).toBe('lodz-strasse');
				await page.evaluate("document.execCommand('redo')");
				expect((await read()).value).toBe('lodz');
				await page.evaluate(`${field}.select()`);
				await page.type('Zażółć gęślą jaźń');
				expect(await read()).toEqual({
					value: 'zazolc-gesla-jazn',
					caret: 17,
					valid: true,
				});
				await page.evaluate(`${field}.select()`);
				await page.insertText(' Zażółć  Gęślą Jaźń ');
				expect(await read()).toEqual({
					value: 'zazolc-gesla-jazn-',
					caret: 18,
					valid: false,
				});
				await page.compose('Ż!b');
				expect((await read()).value).toBe('zazolc-gesla-jazn-Ż!b');
				await page.insertText('Ż!b');
				expect(await read()).toEqual({
					value: 'zazolc-gesla-jazn-zb',
					caret: 20,
					valid: true,
				});
				await page.evaluate(`${field}.setSelectionRange(0, 6)`);
				await page.evaluate("document.execCommand('delete')");
				await page.type('b');
				expect(await read()).toEqual({
					value: 'b-gesla-jazn-zb',
					caret: 1,
					valid: true,
				});
				await page.type('-');
				expect(await read()).toEqual({
					value: 'b-gesla-jazn-zb',
					caret: 1,
					valid: true,
				});
				await page.evaluate(`${field}.setSelectionRange(0, 0)`);
				await page.insertText('X'.repeat(50));
				expect(await read()).toEqual({
					value: 'x'.repeat(33) + 'b-gesla-jazn-zb',
					caret: 33,
					valid: true,
				});
				await page.evaluate(`${field}.select()`);
				await page.insertText('x'.repeat(46));
				await page.type('æ');
				expect(await read()).toEqual({
					value: 'x'.repeat(46) + 'ae',
					caret: 48,
					valid: true,
				});
				await page.evaluate(`${field}.select()`);
				await page.insertText('x'.repeat(47));
				await page.type('ßœ');
				expect(await read()).toEqual({
					value: 'x'.repeat(47) + 's',
					caret: 48,
					valid: true,
				});
				/* An engine that cannot replay the filtered text keeps the raw
				   edit, which the pattern refuses, rather than losing it. */
				await page.evaluate(
					`${field}.select(), (document.execCommand = () => false)`,
				);
				await page.type('Ab');
				expect(await read()).toEqual({ value: 'Ab', caret: 2, valid: false });
			});
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	}, 60_000);
	it('serves the unlock step and nothing else before the token is presented', async () => {
		const app = harness(workspace());

		const page = await app.call('/setup');
		const html = await page.text();

		expect(page.status).toBe(200);
		expect(html).toContain('Unlock setup');
		expect(html).not.toContain('Connect PostgreSQL');
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(page.headers.get('content-security-policy')).toContain(
			"default-src 'none'",
		);
	});

	it('composes only the installer paths', () => {
		const app = harness(workspace());

		expect(app.routes.map((route) => route.path)).toEqual([
			'/setup',
			'/',
			'/api/*path',
			'/*path',
		]);
	});

	it('answers every application API with a not-configured refusal', async () => {
		const app = harness(workspace());

		const response = await app.call('/api/*path');

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: 'PLATFORM_NOT_CONFIGURED' },
		});
	});

	it('refuses a wrong token and locks out after repeated attempts', async () => {
		const app = harness(workspace());

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const denied = await app.call('/setup', {
				step: 'unlock',
				token: 'wrong',
			});
			expect(denied.status).toBe(401);
			expect(await denied.text()).toContain('not the setup token');
		}
		const locked = await app.call('/setup', { step: 'unlock', token: 'wrong' });
		expect(locked.status).toBe(429);
		expect(locked.headers.get('retry-after')).toBeTruthy();

		const correct = await app.call('/setup', {
			step: 'unlock',
			token: TOKEN,
		});
		expect(correct.status).toBe(429);
		expect(correct.headers.get('set-cookie')).toBeNull();
	});

	it('refuses a step without the token and without a session', async () => {
		const app = harness(workspace());

		const response = await app.call('/setup', {
			step: 'configure',
			adapter: PGLITE_ADAPTER_ID,
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toContain('Unlock setup');
	});

	it('refuses an oversized streamed form without a Content-Length header', async () => {
		const app = harness(workspace());
		const request = new Request(`${ORIGIN}/setup`, {
			method: 'POST',
			body: new URLSearchParams({
				step: 'unlock',
				token: TOKEN,
				filler: 'x'.repeat(65 * 1024),
			}),
		});
		expect(request.headers.get('content-length')).toBeNull();

		const response = await app
			.route('/setup')
			.handler(createContext(request, {}));
		expect(response.status).toBe(400);
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(await response.text()).toContain('That request could not be read.');
		expect(await (await app.call('/setup')).text()).toContain('Unlock setup');
	});

	it('opens the database step for the right token', async () => {
		const app = harness(workspace());

		const unlocked = await app.call('/setup', {
			step: 'unlock',
			token: TOKEN,
		});
		expect(unlocked.status).toBe(303);
		expect(unlocked.headers.get('set-cookie')).toContain('HttpOnly');
		expect(unlocked.headers.get('set-cookie')).toContain('SameSite=Strict');

		const page = await app.call('/setup');
		expect(page.headers.get('x-flowdular-setup')).toBe('first-run');
		const html = await page.text();
		expect(html).toContain('Connect PostgreSQL');
		expect(html).toContain('Embedded PostgreSQL');
		expect(html).toContain('PostgreSQL server');
	});

	it(
		'skips database entry when the deployment provides one and never writes its environment',
		async () => {
			const root = workspace();
			const data = join(root, 'preconfigured-data');
			let restarts = 0;
			let restartExitCode: number | null = null;
			const app = harness(root, undefined, [], {
				databasePreconfigured: true,
				restartApplication: (exitCode) => {
					restarts++;
					restartExitCode = exitCode;
				},
				environment: {
					NODE_ENV: 'development',
					FD_DATABASE_ADAPTER: 'pglite',
					FD_DATABASE_PGLITE_DIRECTORY: data,
					FD_SETUP_AUTO_RESTART: 'true',
				},
			});
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const workspaceHtml = await (await app.call('/setup')).text();
			const csrf = /name="setupCsrf" value="([^"]+)"/.exec(workspaceHtml)![1]!;

			expect(workspaceHtml).toContain('Create your workspace');
			expect(workspaceHtml).toContain('Database, configured by deployment');
			expect(/<input[^>]*name="adapter"/.test(workspaceHtml)).toBe(false);
			expect(
				/<input[^>]*name="applicationPath"[^>]*value="\/app"[^>]*readonly/.test(
					workspaceHtml,
				),
			).toBe(true);

			const review = await app.call('/setup', {
				step: 'workspace',
				setupCsrf: csrf,
				...OWNER,
			});
			const reviewHtml = await review.text();
			expect(reviewHtml).toContain(
				'PostgreSQL is configured by this deployment',
			);
			expect(reviewHtml).toContain('Migrate and create workspace');
			expect(reviewHtml).not.toContain(OWNER.ownerPassword);

			const done = await app.call('/setup', { step: 'apply', setupCsrf: csrf });
			const doneHtml = await done.text();
			expect(doneHtml).toContain('Flowdular is ready');
			expect(doneHtml).toContain(OWNER.ownerEmail);
			expect(doneHtml).not.toContain(OWNER.ownerPassword);
			expect(existsSync(join(root, '.env'))).toBe(false);
			expect(doneHtml).toContain("step:'restart'");
			expect(fetchSources(done)).toEqual(["'self'"]);
			expect(restarts).toBe(0);
			const restart = await app.call('/setup', {
				step: 'restart',
				setupCsrf: csrf,
			});
			expect(restart.status).toBe(204);
			expect(restarts).toBe(1);
			expect(restartExitCode).toBe(0);
			const repeat = await app.call('/setup', {
				step: 'restart',
				setupCsrf: csrf,
			});
			expect(repeat.status).toBe(204);
			expect(restarts).toBe(1);
			const forged = await app.call('/setup', {
				step: 'restart',
				setupCsrf: 'forged',
			});
			expect(forged.status).toBe(403);
			expect(restarts).toBe(1);
		},
		SLOW,
	);

	it(
		'restarts a standalone setup only after its connection settings are durable',
		async () => {
			const root = workspace();
			let restarts = 0;
			let restartExitCode: number | null = null;
			const app = harness(root, undefined, [], {
				environment: {
					NODE_ENV: 'development',
					FD_SETUP_AUTO_RESTART: 'true',
					FD_SETUP_RESTART_EXIT_CODE: '75',
				},
				restartApplication: (exitCode) => {
					restarts++;
					restartExitCode = exitCode;
				},
			});
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));
			await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
			});
			await app.call('/setup', {
				step: 'workspace',
				setupCsrf: csrf,
				...OWNER,
			});
			const done = await app.call('/setup', {
				step: 'apply',
				setupCsrf: csrf,
			});
			const html = await done.text();
			expect(html).toContain("step:'restart'");
			expect(restarts).toBe(0);
			expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
				'FD_DATABASE_ADAPTER=pglite',
			);
			expect(
				(
					await app.call('/setup', {
						step: 'restart',
						setupCsrf: csrf,
					})
				).status,
			).toBe(204);
			expect(restarts).toBe(1);
			expect(restartExitCode).toBe(75);
			expect(
				(
					await app.call('/setup', {
						step: 'restart',
						setupCsrf: csrf,
					})
				).status,
			).toBe(204);
			expect(restarts).toBe(1);
		},
		SLOW,
	);

	it(
		'keeps a standalone setup running when its environment cannot be saved',
		async () => {
			const root = workspace();
			mkdirSync(join(root, '.env'));
			let restarts = 0;
			const app = harness(root, undefined, [], {
				environment: {
					NODE_ENV: 'development',
					FD_SETUP_AUTO_RESTART: 'true',
				},
				restartApplication: () => {
					restarts++;
				},
			});
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));
			await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
			});
			await app.call('/setup', {
				step: 'workspace',
				setupCsrf: csrf,
				...OWNER,
			});
			const done = await app.call('/setup', {
				step: 'apply',
				setupCsrf: csrf,
			});
			const html = await done.text();
			expect(html).toContain('Save the connection settings');
			expect(html).not.toContain("step:'restart'");
			expect(
				(
					await app.call('/setup', {
						step: 'restart',
						setupCsrf: csrf,
					})
				).status,
			).toBe(200);
			expect(restarts).toBe(0);
		},
		SLOW,
	);

	it('re-renders invalid workspace input without exposing the owner password', async () => {
		const root = workspace();
		const app = harness(root, undefined, [], { databasePreconfigured: true });
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));

		const invalid = await app.call('/setup', {
			step: 'workspace',
			setupCsrf: csrf,
			...OWNER,
			workspaceSlug: 'Invalid Space',
		});
		const html = await invalid.text();
		expect(html).toContain('Create your workspace');
		expect(html).toContain('Some values need attention');
		expect(html).not.toContain(OWNER.ownerPassword);
		expect(existsSync(join(root, '.env'))).toBe(false);
	});

	it('rejects a mismatched owner password without echoing either value', async () => {
		const root = workspace();
		const app = harness(root, undefined, [], { databasePreconfigured: true });
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));
		const response = await app.call('/setup', {
			step: 'workspace',
			setupCsrf: csrf,
			...OWNER,
			ownerPasswordConfirm: 'DifferentOwner987!',
		});
		const html = await response.text();
		expect(html).toContain('Passwords do not match.');
		expect(html).not.toContain(OWNER.ownerPassword);
		expect(html).not.toContain('DifferentOwner987!');
		expect(existsSync(join(root, '.env'))).toBe(false);
	});

	it('shows only environment key names when a read-only deployment cannot save settings', () => {
		const view: SetupPageView = {
			step: 'Sign in',
			csrfToken: null,
			databasePreconfigured: false,
			autoRestart: true,
			error: null,
			notice: null,
			adapters: [],
			selectedAdapterId: null,
			fieldErrors: {},
			values: { applicationPath: '/app' },
			probe: null,
			modules: [],
			environment: {
				status: 'read-only',
				path: '/deployment/.env',
				added: [],
				kept: [],
				block:
					'FD_DATABASE_URL=postgresql://runtime:CANARY_SECRET@database/flowdular',
			},
			seed: {
				workspace: { name: OWNER.workspaceName, slug: OWNER.workspaceSlug },
				accounts: [
					{
						email: OWNER.ownerEmail,
						displayName: OWNER.ownerName,
						role: 'owner',
						scopes: [],
					},
				],
				ungrantedModules: [],
			},
			modulesApproximated: false,
			tokenFile: null,
			passwordMinLength: 12,
		};
		const html = renderSetupPage(view, 'test-nonce');
		expect(html).toContain('FD_DATABASE_URL');
		expect(html).not.toContain('CANARY_SECRET');
		expect(html).toContain('Save the connection settings');
		expect(html).not.toContain('The app is restarting');
	});

	it('shows the Flowdular three-bar mark beside the brand name', async () => {
		const html = await (await harness(workspace()).call('/setup')).text();
		const brand =
			/<span class="setup-brand">(<svg[\s\S]*?<\/svg>)Flowdular<\/span>/.exec(
				html,
			)?.[1];

		expect(brand).toBeDefined();
		expect(
			[
				...brand!.matchAll(
					/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="5" rx="2.5"\/>/g,
				),
			].map((bar) => bar.slice(1).join(',')),
		).toEqual(['2,3,20', '8,10,14', '14,17,8']);
		expect(brand).toContain('<g fill="#e08a45"><rect x="14" y="17"');
		expect(brand).not.toContain('<path');
	});

	it('refuses a form that does not carry this session CSRF token', async () => {
		const app = harness(workspace());
		await app.call('/setup', { step: 'unlock', token: TOKEN });

		const forged = await app.call('/setup', {
			step: 'configure',
			adapter: PGLITE_ADAPTER_ID,
			setupCsrf: 'forged',
		});

		expect(forged.status).toBe(403);
		/* The session is dropped, so the next step starts from the token again. */
		expect(await (await app.call('/setup')).text()).toContain('Unlock setup');
	});

	it('reports the fields that need attention before any connection is opened', async () => {
		const root = workspace();
		const app = harness(root);
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));

		const response = await app.call('/setup', {
			step: 'configure',
			setupCsrf: csrf,
			adapter: POSTGRESQL_ADAPTER_ID,
			[`field:${POSTGRESQL_ADAPTER_ID}:host`]: '',
			[`field:${POSTGRESQL_ADAPTER_ID}:port`]: '5432',
		});
		const html = await response.text();

		expect(html).toContain('Enter a host name or an address.');
		expect(html).toContain('Enter the password for this role.');
		expect(existsSync(join(root, '.env'))).toBe(false);
	});

	it(
		'lets the operator go back from workspace details to the database connection',
		async () => {
			const root = workspace();
			const app = harness(root);
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));
			const workspaceStep = await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
			});
			const workspaceHtml = await workspaceStep.text();
			expect(workspaceHtml).toContain(
				'name="step" value="back" formnovalidate',
			);

			const back = await app.call('/setup', { step: 'back', setupCsrf: csrf });
			const html = await back.text();
			expect(html).toContain('Connect PostgreSQL');
			expect(html).not.toContain('Create your workspace');
			expect(existsSync(join(root, '.env'))).toBe(false);
		},
		SLOW,
	);

	it('leaves no configuration behind when the probe fails', async () => {
		const root = workspace();
		const app = harness(root);
		await app.call('/setup', { step: 'unlock', token: TOKEN });
		const csrf = await csrfOf(await app.call('/setup'));

		const attempt = await app.call('/setup', {
			step: 'configure',
			setupCsrf: csrf,
			adapter: POSTGRESQL_ADAPTER_ID,
			[`field:${POSTGRESQL_ADAPTER_ID}:host`]: '127.0.0.1',
			[`field:${POSTGRESQL_ADAPTER_ID}:port`]: '1',
			[`field:${POSTGRESQL_ADAPTER_ID}:database`]: 'flowdular',
			[`field:${POSTGRESQL_ADAPTER_ID}:migrator-user`]: 'flowdular_migrator',
			[`field:${POSTGRESQL_ADAPTER_ID}:migrator-password`]: 'migrator-secret',
			[`field:${POSTGRESQL_ADAPTER_ID}:runtime-user`]: 'flowdular_runtime',
			[`field:${POSTGRESQL_ADAPTER_ID}:runtime-password`]: 'runtime-secret',
			[`field:${POSTGRESQL_ADAPTER_ID}:background-user`]:
				'flowdular_background',
			[`field:${POSTGRESQL_ADAPTER_ID}:background-password`]:
				'background-secret',
			[`field:${POSTGRESQL_ADAPTER_ID}:tls`]: 'disable',
		});
		const html = await attempt.text();

		expect(html).toContain('Connect PostgreSQL');
		expect(html).not.toContain('Create your workspace');
		expect(html).not.toContain('runtime-secret');
		expect(html).not.toContain('postgresql://');
		expect(existsSync(join(root, '.env'))).toBe(false);

		/* Applying anyway is refused, and still writes nothing. */
		const applied = await app.call('/setup', {
			step: 'apply',
			setupCsrf: csrf,
		});
		expect(await applied.text()).toContain('Connect PostgreSQL');
		expect(existsSync(join(root, '.env'))).toBe(false);
	});

	it(
		'refuses a database an enabled module cannot run on, naming the module',
		async () => {
			const root = workspace();
			const app = harness(root, [
				{
					moduleId: 'legacy.core',
					tenantOwned: true,
					dialectIds: ['mysql'],
					capabilities: ['flowdular.database.transactions'],
				},
			]);
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));

			const configured = await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: join(root, 'data'),
			});
			expect(await configured.text()).toContain('Create your workspace');
			const review = await app.call('/setup', {
				step: 'workspace',
				setupCsrf: csrf,
				...OWNER,
			});
			const html = await review.text();

			expect(html).toContain('legacy.core');
			expect(html).toContain('dialect');
			expect(html).not.toContain('Migrate and create workspace');

			const applied = await app.call('/setup', {
				step: 'apply',
				setupCsrf: csrf,
			});
			expect(await applied.text()).toContain('cannot run on this database');
			expect(existsSync(join(root, '.env'))).toBe(false);
		},
		SLOW,
	);

	it(
		'creates the chosen workspace and owner, then stores the connection settings',
		async () => {
			const root = workspace();
			const data = join(root, 'data');
			const app = harness(root);
			await app.call('/setup', { step: 'unlock', token: TOKEN });
			const csrf = await csrfOf(await app.call('/setup'));

			const configured = await app.call('/setup', {
				step: 'configure',
				setupCsrf: csrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: data,
			});
			expect(await configured.text()).toContain('Create your workspace');
			const review = await app.call('/setup', {
				step: 'workspace',
				setupCsrf: csrf,
				...OWNER,
				applicationPath: '/backoffice',
			});
			const reviewHtml = await review.text();
			expect(reviewHtml).toContain('Migrate and create workspace');
			expect(reviewHtml).toContain('auth.core');
			expect(reviewHtml).toContain('catalog.core');
			expect(reviewHtml).toContain('BYPASSRLS');
			expect(reviewHtml).toContain('/backoffice');
			expect(reviewHtml).toContain(OWNER.ownerEmail);
			expect(reviewHtml).not.toContain(OWNER.ownerPassword);

			const done = await app.call('/setup', {
				step: 'apply',
				setupCsrf: csrf,
			});
			const html = await done.text();

			expect(html).toContain('Flowdular is ready');
			expect(html).toContain(OWNER.ownerEmail);
			expect(html).not.toContain(OWNER.ownerPassword);
			expect(html).not.toContain('demo accounts');
			expect(html).toContain('Providers');

			const written = readFileSync(join(root, '.env'), 'utf8');
			expect(written).toContain('FD_DATABASE_ADAPTER=pglite');
			expect(written).toContain('FD_APPLICATION_PATH=/backoffice');
			expect(html).toContain('href="/backoffice"');
			expect(written).toContain(`FD_DATABASE_PGLITE_DIRECTORY=${data}`);

			const provider = createPlatformDatabaseProvider(
				databaseProviderConfigFromEnvironment(
					{
						NODE_ENV: 'development',
						FD_DATABASE_ADAPTER: 'pglite',
						FD_DATABASE_PGLITE_DIRECTORY: data,
					},
					root,
				),
			);
			const auth = createAuthRuntime({
				...authRuntimeOptionsFromEnvironment({ NODE_ENV: 'development' }, root),
				databases: provider,
			});
			try {
				const service = await auth.service();
				const [tenant] = await service.listTenants();
				expect(tenant?.slug).toBe(OWNER.workspaceSlug);
				const members = await service.listTenantMembers(tenant!.tenantId);
				const owner = members.find(
					(member) => member.email === OWNER.ownerEmail,
				)!;

				expect(members).toHaveLength(1);
				expect(owner.displayName).toBe(OWNER.ownerName);
				expect([...owner.scopes].sort()).toEqual([...OWNER_SCOPES].sort());

				const audit = await service.queryAudit({
					tenantId: tenant!.tenantId,
					limit: 20,
				});
				const actions = audit.events.map((event) => event.action);
				expect(actions).toContain('auth.workspace.provisioned');
				const provisioned = audit.events.find(
					(event) => event.action === 'auth.workspace.provisioned',
				)!;
				expect(provisioned.actorLabel).toBe('setup:first-run');
				expect(provisioned.subjectId).toBe(tenant!.tenantId);
			} finally {
				await auth.dispose();
				await provider.dispose();
			}
		},
		SLOW,
	);

	it(
		'stops instead of touching a database that already holds a workspace',
		async () => {
			const root = workspace();
			const data = join(root, 'data');
			const first = harness(root);
			await first.call('/setup', { step: 'unlock', token: TOKEN });
			const firstCsrf = await csrfOf(await first.call('/setup'));
			await first.call('/setup', {
				step: 'configure',
				setupCsrf: firstCsrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: data,
			});
			await first.call('/setup', {
				step: 'workspace',
				setupCsrf: firstCsrf,
				...OWNER,
			});
			expect(
				await (
					await first.call('/setup', { step: 'apply', setupCsrf: firstCsrf })
				).text(),
			).toContain('Flowdular is ready');

			/* A second deployment pointed at the same database is not a first run. */
			const second = harness(root);
			await second.call('/setup', { step: 'unlock', token: TOKEN });
			const secondCsrf = await csrfOf(await second.call('/setup'));
			await second.call('/setup', {
				step: 'configure',
				setupCsrf: secondCsrf,
				adapter: PGLITE_ADAPTER_ID,
				[`field:${PGLITE_ADAPTER_ID}:data-directory`]: data,
			});
			await second.call('/setup', {
				step: 'workspace',
				setupCsrf: secondCsrf,
				...OWNER,
			});
			const refused = await second.call('/setup', {
				step: 'apply',
				setupCsrf: secondCsrf,
			});
			const html = await refused.text();

			expect(html).toContain('does not reset an existing installation');
			expect(html).not.toContain('Flowdular is ready');
		},
		SLOW,
	);
});

/* catalog.core is enabled and declares two permissions the owner defaults do
   not carry, as an application's own module does. auth.core declares one the
   owner already holds, so it is never reported as ungranted. ledger.core sits
   in the same root without being enabled, so nothing of it may be granted. */
function declareModulePermissions(root: string): void {
	mkdirSync(join(root, 'modules', 'auth', 'spec'), { recursive: true });
	writeFileSync(
		join(root, 'modules', 'auth', 'spec', 'module.yaml'),
		'id: auth.core\npermissions:\n  - id: auth.profile.read\n',
	);
	mkdirSync(join(root, 'modules', 'catalog', 'spec'), { recursive: true });
	writeFileSync(
		join(root, 'modules', 'catalog', 'spec', 'module.yaml'),
		'id: catalog.core\npermissions:\n  - id: catalog.items.read\n  - id: catalog.items.manage\n',
	);
	mkdirSync(join(root, 'modules', 'ledger', 'spec'), { recursive: true });
	writeFileSync(
		join(root, 'modules', 'ledger', 'module.json'),
		JSON.stringify({ id: 'ledger.core', capabilities: ['api'] }),
	);
	writeFileSync(
		join(root, 'modules', 'ledger', 'spec', 'module.yaml'),
		'id: ledger.core\npermissions:\n  - id: ledger.entries.read\n',
	);
}

function embeddedEnvironment(data: string): NodeJS.ProcessEnv {
	return {
		NODE_ENV: 'development',
		FD_DATABASE_ADAPTER: 'pglite',
		FD_DATABASE_PGLITE_DIRECTORY: data,
	};
}

async function completeSetup(root: string, data: string): Promise<string> {
	const app = harness(root, undefined, [], {
		databasePreconfigured: true,
		environment: embeddedEnvironment(data),
	});
	await app.call('/setup', { step: 'unlock', token: TOKEN });
	const csrf = await csrfOf(await app.call('/setup'));
	await app.call('/setup', { step: 'workspace', setupCsrf: csrf, ...OWNER });
	return (await app.call('/setup', { step: 'apply', setupCsrf: csrf })).text();
}

/* An embedded directory admits one open provider, so every look at the
   database opens its own and closes it before setup opens the next. */
async function withAuthService<T>(
	root: string,
	data: string,
	body: (
		service: Awaited<ReturnType<AuthRuntime['service']>>,
		databases: DatabaseProvider,
	) => Promise<T>,
): Promise<T> {
	const databases = createPlatformDatabaseProvider(
		databaseProviderConfigFromEnvironment(embeddedEnvironment(data), root),
	);
	const auth = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment({ NODE_ENV: 'development' }, root),
		databases,
	});
	try {
		return await body(await auth.service(), databases);
	} finally {
		await auth.dispose();
		await databases.dispose();
	}
}

async function asMigrator(
	databases: DatabaseProvider,
	text: string,
): Promise<void> {
	const lease = await databases.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
	});
	try {
		await lease.database.execute({ text });
	} finally {
		await lease.release();
	}
}

describe('permissions of the modules enabled before first run', () => {
	it(
		'gives the setup owner and the built-in owner role every permission an enabled module declares',
		async () => {
			const root = workspace();
			declareModulePermissions(root);
			const data = join(root, 'data');

			const html = await completeSetup(root, data);

			expect(html).toContain('Flowdular is ready');
			expect(html).not.toContain('sync-scopes');
			await withAuthService(root, data, async (service) => {
				const [tenant] = await service.listTenants();
				const [owner] = await service.listTenantMembers(tenant!.tenantId);
				expect([...owner!.scopes].sort()).toEqual(
					[
						...OWNER_SCOPES,
						'catalog.items.manage',
						'catalog.items.read',
					].sort(),
				);
				const later = await service.planMemberProvision({
					workspace: OWNER.workspaceSlug,
					email: 'second-owner@example.test',
					role: 'owner',
					operator: 'test:routes',
				});
				expect(later.role.scopes).toEqual(
					expect.arrayContaining([
						'catalog.items.manage',
						'catalog.items.read',
					]),
				);
				expect(later.role.scopes).not.toContain('ledger.entries.read');
			});
		},
		SLOW,
	);

	it(
		'completes setup and names the repair command when the grant fails after the workspace exists',
		async () => {
			const root = workspace();
			declareModulePermissions(root);
			const data = join(root, 'data');
			await withAuthService(root, data, (_service, databases) =>
				asMigrator(
					databases,
					`ALTER TABLE auth_membership_scopes ADD CONSTRAINT setup_grant_refusal
					 CHECK (scope NOT LIKE 'catalog.%') NOT VALID`,
				),
			);

			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			let html: string;
			let warnings: readonly string[];
			try {
				html = await completeSetup(root, data);
			} finally {
				warnings = warn.mock.calls.map((call) => String(call[0]));
				warn.mockRestore();
			}

			expect(html).toContain('Flowdular is ready');
			expect(html).toContain(
				'pnpm flowdular auth sync-scopes --module catalog.core --apply',
			);
			expect(html).not.toContain('auth.core');
			expect(html).not.toContain('ledger.core');
			const logged = warnings.filter((line) =>
				line.includes('could not grant'),
			);
			expect(logged).toHaveLength(1);
			expect(logged[0]).toContain('catalog.core');
			expect(logged[0]).toContain('(23514)');
			expect(logged[0]).not.toContain('setup_grant_refusal');
			await withAuthService(root, data, async (service) => {
				const [tenant] = await service.listTenants();
				expect(tenant?.slug).toBe(OWNER.workspaceSlug);
				const [owner] = await service.listTenantMembers(tenant!.tenantId);
				expect([...owner!.scopes].sort()).toEqual([...OWNER_SCOPES].sort());
			});
		},
		SLOW,
	);
});
