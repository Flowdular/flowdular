import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import {
	formatDevEvent,
	isClientDisconnectLog,
	parseDevArguments,
	shouldUseColor,
	withShutdownDeadline,
} from './dev.mjs';

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

	it('drops an HMR update when a restart replaces the environments', async () => {
		const temporaryRoot = await realpath(
			await mkdtemp(join(tmpdir(), 'coreloom-platform-hmr-')),
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
					name: 'coreloom-hmr-restart-race-reproduction',
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
