import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createContext } from '@octanejs/app-core';
import {
	nodeRequestToWebRequest,
	sendWebResponse,
} from '@octanejs/app-core/node';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import {
	activatePlatformRuntimeLifecycle,
	createPlatformRuntimeLifecycle,
	PLATFORM_LIFECYCLE_RETIRE_EVENT,
} from '../src/server/lifecycle.ts';
import {
	formatDevEvent,
	isClientDisconnectLog,
	parseDevArguments,
	shouldUseColor,
	stopServing,
	withShutdownDeadline,
} from './dev.mjs';

/* A stop that waits on nothing takes milliseconds; the development server's
   budget is 6 s, and a kept-alive connection holds the close for 4 to 6 s. */
const PROMPT_STOP_MS = 1_000;
const noHmr = { ws: { close: () => Promise.resolve() } };

async function listening(httpServer) {
	await new Promise((resolveListen) =>
		httpServer.listen(0, '127.0.0.1', resolveListen),
	);
	return `http://127.0.0.1:${httpServer.address().port}`;
}

describe('development launcher arguments', () => {
	it('supports quiet defaults and explicit verbose networking', () => {
		expect(parseDevArguments([])).toMatchObject({
			host: '0.0.0.0',
			port: 4310,
			verbose: false,
		});
		expect(
			parseDevArguments(['--verbose', '--host=127.0.0.1', '--port', '4400']),
		).toMatchObject({ host: '127.0.0.1', port: 4400, verbose: true });
	});

	it('rejects invalid or unknown options', () => {
		expect(() => parseDevArguments(['--port', '70000'])).toThrow('between');
		expect(() => parseDevArguments(['--debug'])).toThrow('Unknown');
	});

	it('honors terminal color controls', () => {
		expect(shouldUseColor({}, false)).toBe(false);
		expect(shouldUseColor({ TERM: 'dumb' }, true)).toBe(false);
		expect(shouldUseColor({ TERM_PROGRAM: 'WarpTerminal' }, false)).toBe(true);
		expect(shouldUseColor({ NO_COLOR: '' }, true)).toBe(false);
		expect(shouldUseColor({ FORCE_COLOR: '1', NO_COLOR: '' }, false)).toBe(
			true,
		);
	});

	it('colors runtime events only when enabled', () => {
		expect(formatDevEvent('reload', 'src/App.tsrx', false)).toBe(
			'[octane:reload] src/App.tsrx',
		);
		expect(formatDevEvent('error', 'Port is busy.', true)).toContain(
			'\u001B[31m',
		);
	});

	it('recognizes an aborted SSR stream as a client disconnect', () => {
		expect(
			isClientDisconnectLog([
				'[octane] SSR render error:',
				new Error('The client disconnected before the request completed.'),
			]),
		).toBe(true);
		expect(
			isClientDisconnectLog([
				'[octane] SSR render error:',
				new Error('Cannot read properties of undefined'),
			]),
		).toBe(false);
		expect(isClientDisconnectLog(['[octane:reload] src/App.tsrx'])).toBe(false);
	});

	it('bounds terminal shutdown when Vite does not close', async () => {
		await expect(
			withShutdownDeadline(new Promise(() => {}), 10),
		).rejects.toThrow('shutdown exceeded 10 ms');
	});

	it('stops serving while a browser tab holds the HMR socket', async () => {
		const temporaryRoot = await realpath(
			await mkdtemp(join(tmpdir(), 'flowdular-platform-hmr-socket-')),
		);
		const httpServer = createHttpServer();
		const server = await createServer({
			root: temporaryRoot,
			configFile: false,
			logLevel: 'silent',
			server: { middlewareMode: true, ws: { server: httpServer } },
		});
		await new Promise((resolveListen) =>
			httpServer.listen(0, '127.0.0.1', resolveListen),
		);
		const tab = new WebSocket(
			`ws://127.0.0.1:${httpServer.address().port}/`,
			'vite-hmr',
		);
		try {
			await new Promise((resolveOpen, rejectOpen) => {
				tab.onopen = resolveOpen;
				tab.onerror = () => rejectOpen(new Error('The HMR socket failed.'));
			});
			await expect(
				withShutdownDeadline(stopServing(httpServer, server), 5_000),
			).resolves.toBeUndefined();
			expect(httpServer.listening).toBe(false);
		} finally {
			tab.close();
			await server.close();
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('closes a connection whose response finishes after the stop began', async () => {
		let endStream;
		const httpServer = createHttpServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write('retry: 1000\n\n');
			endStream = () => response.end();
		});
		const origin = await listening(httpServer);
		const reader = (await fetch(`${origin}/events`)).body.getReader();
		try {
			await reader.read();
			const stopped = stopServing(httpServer, noHmr);
			endStream();
			await expect(
				withShutdownDeadline(stopped, PROMPT_STOP_MS),
			).resolves.toBeUndefined();
			expect(await reader.read()).toMatchObject({ done: true });
		} finally {
			httpServer.closeAllConnections();
		}
	});

	it('stops promptly while a browser holds an event stream open', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		await activatePlatformRuntimeLifecycle(lifecycle);
		let producing = true;
		const httpServer = createHttpServer(async (request, response) => {
			const answer = await lifecycle.middleware(
				createContext(nodeRequestToWebRequest(request, response), {}),
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('retry: 1000\n\n'));
							},
							cancel() {
								producing = false;
							},
						}),
						{ headers: { 'content-type': 'text/event-stream' } },
					),
			);
			await sendWebResponse(response, answer);
		});
		const origin = await listening(httpServer);
		const reader = (
			await fetch(`${origin}/api/workflow-runs/events`)
		).body.getReader();
		try {
			await reader.read();
			/* The order dev.mjs stops in: stop accepting, then retire the
			   generation through the event the lifecycle listens to. */
			const httpClose = stopServing(httpServer, noHmr);
			const retirements = [];
			process.emit(PLATFORM_LIFECYCLE_RETIRE_EVENT, (retirement) =>
				retirements.push(retirement),
			);
			expect(retirements).toHaveLength(1);
			await expect(
				withShutdownDeadline(
					Promise.all([httpClose, ...retirements]),
					PROMPT_STOP_MS,
				),
			).resolves.toBeDefined();
			expect(await reader.read()).toMatchObject({ done: true });
			expect(producing).toBe(false);
		} finally {
			httpServer.closeAllConnections();
			await lifecycle.retire().catch(() => undefined);
		}
	});

	it('drops an HMR update when a restart replaces the environments', async () => {
		const temporaryRoot = await realpath(
			await mkdtemp(join(tmpdir(), 'flowdular-platform-hmr-')),
		);
		const sourceFile = join(temporaryRoot, 'main.js');
		await writeFile(sourceFile, 'export const value = 1;\n');

		let updateStarted = false;
		const overlayErrors = [];
		const server = await createServer({
			root: temporaryRoot,
			configFile: false,
			logLevel: 'silent',
			plugins: [
				{
					name: 'flowdular-hmr-restart-race-reproduction',
					handleHotUpdate(context) {
						updateStarted = true;
						const environmentsBeforeRestart = context.server.environments;
						/* Vite replaces this collection during a restart. A source update
						   that captured the previous collection must stop before dispatching
						   HMR to an environment absent from its hot map. */
						context.server.environments = {
							...environmentsBeforeRestart,
							restarted: Object.create(environmentsBeforeRestart.client),
						};
						setTimeout(() => {
							context.server.environments = environmentsBeforeRestart;
						}, 50);
					},
				},
			],
			server: { middlewareMode: true },
		});
		const send = server.ws.send.bind(server.ws);
		server.ws.send = (payload, ...arguments_) => {
			if (payload?.type === 'error') overlayErrors.push(payload.err?.message);
			return send(payload, ...arguments_);
		};

		try {
			await server.transformRequest(sourceFile);
			await writeFile(sourceFile, 'export const value = 2;\n');
			const deadline = Date.now() + 2_000;
			while (!updateStarted && Date.now() < deadline) {
				await new Promise((resolveWait) => setTimeout(resolveWait, 10));
			}
			expect(updateStarted).toBe(true);
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			expect(overlayErrors).toEqual([]);
		} finally {
			await server.close();
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});
});
