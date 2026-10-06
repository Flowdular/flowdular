/* Real layout for render tests. jsdom lays nothing out, so a test about
   overflow, wrapping or position renders its page in headless Chrome over the
   DevTools protocol on a pipe; viewport emulation reaches phone widths that a
   headless window cannot. Typing tests open a served page the same way, so
   real key events meet its own Content-Security-Policy. The package carries no
   Node types, so Node is reached through specifiers TS does not resolve. */

interface ChromeProcess {
	readonly stdio: readonly [
		unknown,
		unknown,
		unknown,
		{
			write(data: string): boolean;
			on(event: 'error', listener: (error: Error) => void): void;
		},
		{ on(event: 'data', listener: (chunk: Uint8Array) => void): void },
	];
	once(event: 'exit', listener: () => void): void;
	once(event: 'error', listener: (error: Error) => void): void;
	kill(): boolean;
}

interface NodeApi {
	readonly spawn: (
		command: string,
		args: readonly string[],
		options: { readonly stdio: readonly ('ignore' | 'pipe')[] },
	) => ChromeProcess;
	readonly existsSync: (path: string) => boolean;
	readonly mkdtempSync: (prefix: string) => string;
	readonly writeFileSync: (path: string, data: string) => void;
	readonly rmSync: (
		path: string,
		options: { readonly recursive: true; readonly force: true },
	) => void;
	readonly tmpdir: () => string;
}

interface Message {
	readonly id?: number;
	readonly method?: string;
	readonly sessionId?: string;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly message: string };
}

interface Pending {
	readonly resolve: (message: Message) => void;
	readonly reject: (error: Error) => void;
}

type Cdp = ReturnType<typeof connect>;

const CALL_TIMEOUT_MS = 15_000;
/* A cold Chrome on a loaded CI runner can spend most of the call budget just
   starting, so a call sent before Chrome has answered anything gets this
   budget instead. It still fits the 60 s test and hook timeouts. */
const STARTUP_TIMEOUT_MS = 45_000;
/* Chrome closes in well under a second; a loaded machine gets the rest. */
const CLOSE_TIMEOUT_MS = 10_000;

const CHROME_PATHS: Readonly<Record<string, readonly string[]>> = {
	darwin: [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
	],
	linux: [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	],
};

const { env, platform } = (
	globalThis as unknown as {
		readonly process: {
			readonly env: Readonly<Record<string, string | undefined>>;
			readonly platform: string;
		};
	}
).process;

async function nodeApi(): Promise<NodeApi> {
	const [childProcess, fs, os] = await Promise.all([
		import('node:' + 'child_process'),
		import('node:' + 'fs'),
		import('node:' + 'os'),
	]);
	return { ...childProcess, ...fs, ...os } as NodeApi;
}

/** FD_CHROME, the variable `pnpm ui:preview` reads, or a usual install path. */
function chromeBinary(node: NodeApi): string {
	const found =
		env.FD_CHROME ||
		(CHROME_PATHS[platform] ?? []).find((path) => node.existsSync(path));
	if (!found) {
		throw new Error(
			'The browser tests need Chrome or Chromium. Set FD_CHROME to its binary.',
		);
	}
	return found;
}

function connect(chrome: ChromeProcess) {
	let nextId = 1;
	let buffer = '';
	let failure: Error | null = null;
	let started = false;
	const decoder = new TextDecoder();
	/** Answers by `call <id>`, events by `event <sessionId> <method>`. */
	const waiting = new Map<string, Pending>();

	/* Whatever still waits fails with the cause the moment Chrome dies, so the
	   caller's cleanup runs instead of a hook timeout that skips it. */
	const fail = (error: Error) => {
		failure ??= error;
		for (const pending of waiting.values()) pending.reject(failure);
		waiting.clear();
	};
	chrome.once('exit', () => fail(new Error('Chrome exited.')));
	chrome.once('error', fail);
	chrome.stdio[3].on('error', fail);

	chrome.stdio[4].on('data', (chunk) => {
		buffer += decoder.decode(chunk, { stream: true });
		for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
			const message = JSON.parse(buffer.slice(0, end)) as Message;
			buffer = buffer.slice(end + 1);
			started = true;
			const key =
				message.id === undefined
					? `event ${message.sessionId} ${message.method}`
					: `call ${message.id}`;
			waiting.get(key)?.resolve(message);
			waiting.delete(key);
		}
	});

	const wait = (key: string, label: string): Promise<Message> =>
		new Promise((resolve, reject) => {
			if (failure !== null) {
				reject(failure);
				return;
			}
			const [budget, name] = started
				? [CALL_TIMEOUT_MS, 'call']
				: [STARTUP_TIMEOUT_MS, 'startup'];
			const timer = setTimeout(() => {
				waiting.delete(key);
				reject(
					new Error(
						`Chrome did not answer ${label} within the ${budget / 1000} s ${name} budget.`,
					),
				);
			}, budget);
			waiting.set(key, {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});

	return {
		async send(
			method: string,
			params: Record<string, unknown> = {},
			sessionId?: string,
		): Promise<Record<string, unknown>> {
			const id = nextId++;
			const answer = wait(`call ${id}`, method);
			if (failure === null) {
				chrome.stdio[3].write(
					JSON.stringify({ id, method, params, sessionId }) + '\0',
				);
			}
			const message = await answer;
			if (message.error) {
				throw new Error(`${method}: ${message.error.message}`);
			}
			return message.result ?? {};
		},
		async next(method: string, sessionId: string): Promise<void> {
			await wait(`event ${sessionId} ${method}`, method);
		},
	};
}

/** Runs `use` against a fresh headless Chrome and stops it however `use` ends. */
async function withChrome<T>(
	node: NodeApi,
	binary: string,
	profile: string,
	use: (cdp: Cdp) => Promise<T>,
): Promise<T> {
	const chrome = node.spawn(
		binary,
		[
			'--headless',
			'--remote-debugging-pipe',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-gpu',
			'--hide-scrollbars',
			'--user-data-dir=' + profile,
			/* CI runners may lack the user namespaces Chrome's sandbox needs; the
			   page is this test's own static markup. */
			...(platform === 'linux' ? ['--no-sandbox'] : []),
		],
		{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
	);
	const exited = new Promise<void>((resolve) => {
		chrome.once('exit', resolve);
		chrome.once('error', () => resolve());
	});
	const cdp = connect(chrome);
	try {
		return await use(cdp);
	} finally {
		await closeChrome(chrome, cdp, exited);
	}
}

/* Browser.close has Chrome stop its network and storage services before it
   exits, and both write into the profile. A SIGTERM ends the browser process
   alone; under load those services outlive it and put files back into a
   profile the caller is already removing. SIGTERM stays for a Chrome that does
   not close. */
async function closeChrome(
	chrome: ChromeProcess,
	cdp: Cdp,
	exited: Promise<void>,
): Promise<void> {
	/* Chrome may exit before it answers, which fails the call itself. */
	cdp.send('Browser.close').catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const closed = await Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
		}),
	]);
	clearTimeout(timer);
	if (!closed) chrome.kill();
	await exited;
}

/** Opens `url` in a new tab and returns its session once the page has loaded. */
async function openPage(cdp: Cdp, url: string): Promise<string> {
	const { targetId } = await cdp.send('Target.createTarget', {
		url: 'about:blank',
	});
	const { sessionId } = (await cdp.send('Target.attachToTarget', {
		targetId,
		flatten: true,
	})) as { sessionId: string };
	await cdp.send('Page.enable', {}, sessionId);
	await Promise.all([
		cdp.next('Page.loadEventFired', sessionId),
		cdp.send('Page.navigate', { url }, sessionId),
	]);
	return sessionId;
}

async function evaluate<T>(
	cdp: Cdp,
	sessionId: string,
	expression: string,
): Promise<T> {
	const evaluated = (await cdp.send(
		'Runtime.evaluate',
		{ expression, awaitPromise: true, returnByValue: true },
		sessionId,
	)) as {
		result: { value: T };
		exceptionDetails?: { text: string };
	};
	if (evaluated.exceptionDetails) {
		throw new Error(evaluated.exceptionDetails.text);
	}
	return evaluated.result.value;
}

/**
 * Loads `html` once and returns what `measure` (an expression) evaluates to at
 * each viewport width, after the web fonts are ready. Widths are applied in
 * order on the same page, as a window resize would.
 */
export async function measureInChrome<T>(
	html: string,
	widths: readonly number[],
	measure: string,
): Promise<T[]> {
	const node = await nodeApi();
	const binary = chromeBinary(node);
	const directory = node.mkdtempSync(node.tmpdir() + '/flowdular-ui-layout-');
	try {
		const page = directory + '/page.html';
		node.writeFileSync(page, html);
		return await withChrome(
			node,
			binary,
			directory + '/profile',
			async (cdp) => {
				const sessionId = await openPage(cdp, 'file://' + page);
				const results: T[] = [];
				for (const width of widths) {
					await cdp.send(
						'Emulation.setDeviceMetricsOverride',
						{ width, height: 900, deviceScaleFactor: 1, mobile: false },
						sessionId,
					);
					results.push(
						await evaluate<T>(
							cdp,
							sessionId,
							`document.fonts.ready.then(() => (${measure}))`,
						),
					);
				}
				return results;
			},
		);
	} finally {
		node.rmSync(directory, { recursive: true, force: true });
	}
}

/** A loaded page whose focused element receives input as a person gives it. */
export interface ChromePage {
	/** Evaluates `expression` in the page, awaiting a returned promise. */
	evaluate<T>(expression: string): Promise<T>;
	/** Presses one key per character. */
	type(text: string): Promise<void>;
	/** Inserts `text` in one edit, as a paste does. */
	insertText(text: string): Promise<void>;
	/** Holds `text` as uncommitted input method text; insertText commits it. */
	compose(text: string): Promise<void>;
}

/** Opens `url`, with its own response headers in force, and runs `use` on it. */
export async function openInChrome<T>(
	url: string,
	use: (page: ChromePage) => Promise<T>,
): Promise<T> {
	const node = await nodeApi();
	const binary = chromeBinary(node);
	const directory = node.mkdtempSync(node.tmpdir() + '/flowdular-ui-page-');
	try {
		return await withChrome(
			node,
			binary,
			directory + '/profile',
			async (cdp) => {
				const sessionId = await openPage(cdp, url);
				return use({
					evaluate: (expression) => evaluate(cdp, sessionId, expression),
					async type(text) {
						for (const key of text) {
							await cdp.send(
								'Input.dispatchKeyEvent',
								{ type: 'keyDown', key, text: key },
								sessionId,
							);
							await cdp.send(
								'Input.dispatchKeyEvent',
								{ type: 'keyUp', key },
								sessionId,
							);
						}
					},
					async insertText(text) {
						await cdp.send('Input.insertText', { text }, sessionId);
					},
					async compose(text) {
						await cdp.send(
							'Input.imeSetComposition',
							{
								text,
								selectionStart: text.length,
								selectionEnd: text.length,
							},
							sessionId,
						);
					},
				});
			},
		);
	} finally {
		node.rmSync(directory, { recursive: true, force: true });
	}
}
