import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleServerComposition } from '@flowdular/server';
import { createContext } from '@octanejs/app-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformRuntimeLifecycle } from './lifecycle.ts';
import {
	createWorkerTickEndpoint,
	createWorkerTicker,
	WORKER_TICK_PATH,
	workerTickConfigFromEnvironment,
} from './worker-tick.ts';

const SECRET = 'x'.repeat(32);

function recordingComposition(events: string[], name: string) {
	return {
		routes: [],
		startWorker: () => {
			events.push(`${name}:start`);
		},
		stop: async () => {
			events.push(`${name}:stop`);
		},
	} satisfies ModuleServerComposition;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('worker tick configuration', () => {
	it('refuses a missing or short secret and an unbounded window', () => {
		expect(() => workerTickConfigFromEnvironment({})).toThrow(
			'FD_WORKER_TICK_SECRET must hold at least 32 characters',
		);
		expect(() =>
			workerTickConfigFromEnvironment({
				FD_WORKER_TICK_SECRET: SECRET,
				FD_WORKER_TICK_WINDOW_MS: '999999',
			}),
		).toThrow('FD_WORKER_TICK_WINDOW_MS must be an integer');
		expect(
			workerTickConfigFromEnvironment({ FD_WORKER_TICK_SECRET: SECRET }),
		).toEqual({ secret: SECRET, windowMs: 50_000 });
	});
});

describe('worker ticker', () => {
	it('runs every worker for one window and drains them before answering', async () => {
		const events: string[] = [];
		const ticker = createWorkerTicker(
			[
				recordingComposition(events, 'a'),
				{ routes: [] },
				recordingComposition(events, 'b'),
			],
			{ windowMs: 1_000 },
		);
		const tick = ticker.tick();
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(['a:start', 'b:start']);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await tick).toMatchObject({ status: 'drained', joined: false });
		expect(events).toEqual(['a:start', 'b:start', 'b:stop', 'a:stop']);
	});

	it('joins a tick that arrives while a window is open', async () => {
		const events: string[] = [];
		const ticker = createWorkerTicker([recordingComposition(events, 'a')], {
			windowMs: 1_000,
		});
		const first = ticker.tick();
		await vi.advanceTimersByTimeAsync(500);
		const second = ticker.tick();
		await vi.advanceTimersByTimeAsync(500);
		expect(await first).toMatchObject({ joined: false });
		expect(await second).toMatchObject({ joined: true });
		expect(events).toEqual(['a:start', 'a:stop']);
	});

	it('restarts the workers on the next tick after a drain', async () => {
		const events: string[] = [];
		const ticker = createWorkerTicker([recordingComposition(events, 'a')], {
			windowMs: 1_000,
		});
		for (let round = 0; round < 2; round += 1) {
			const tick = ticker.tick();
			await vi.advanceTimersByTimeAsync(1_000);
			await tick;
		}
		expect(events).toEqual(['a:start', 'a:stop', 'a:start', 'a:stop']);
	});

	it('stops the workers it started when a later one fails to start', async () => {
		const events: string[] = [];
		const ticker = createWorkerTicker(
			[
				recordingComposition(events, 'a'),
				{
					routes: [],
					startWorker: async () => {
						events.push('b:start');
						throw new Error('reconciliation failed');
					},
					stop: () => {
						events.push('b:stop');
					},
				},
				recordingComposition(events, 'c'),
			],
			{ windowMs: 1_000 },
		);
		await expect(ticker.tick()).rejects.toThrow('reconciliation failed');
		expect(events).toEqual(['a:start', 'b:start', 'b:stop', 'a:stop']);
	});

	it('ends an open window early on close and runs nothing afterwards', async () => {
		const events: string[] = [];
		const ticker = createWorkerTicker([recordingComposition(events, 'a')], {
			windowMs: 60_000,
		});
		const tick = ticker.tick();
		await vi.advanceTimersByTimeAsync(0);
		await ticker.close();
		expect(await tick).toMatchObject({ status: 'closed' });
		expect(await ticker.tick()).toMatchObject({ status: 'closed' });
		expect(events).toEqual(['a:start', 'a:stop']);
	});
});

describe('worker tick endpoint', () => {
	function request(authorization?: string) {
		return createContext(
			new Request(`http://localhost${WORKER_TICK_PATH}`, {
				headers: authorization ? { authorization } : {},
			}),
			{},
		);
	}

	it('refuses a caller without the tick secret and runs no worker', async () => {
		const tick = vi.fn();
		const endpoint = createWorkerTickEndpoint(
			{ tick, close: async () => {} },
			{ secret: SECRET, windowMs: 50_000 },
		);
		for (const header of [undefined, 'Bearer wrong', `Basic ${SECRET}`]) {
			const response = await endpoint.serverRoute.handler(request(header));
			expect(response.status).toBe(401);
		}
		expect(tick).not.toHaveBeenCalled();
	});

	it('answers the drained report to the scheduler', async () => {
		const endpoint = createWorkerTickEndpoint(
			{
				tick: async () => ({
					status: 'drained',
					joined: false,
					windowMs: 1_000,
					durationMs: 1_002,
				}),
				close: async () => {},
			},
			{ secret: SECRET, windowMs: 50_000 },
		);
		const response = await endpoint.serverRoute.handler(
			request(`Bearer ${SECRET}`),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({ status: 'drained' });
	});

	it('gives a scheduler GET the full window and a request POST a short one', async () => {
		const tick = vi.fn(async (windowMs?: number) => ({
			status: 'drained' as const,
			joined: false,
			windowMs: windowMs ?? 0,
			durationMs: 0,
		}));
		const endpoint = createWorkerTickEndpoint(
			{ tick, close: async () => {} },
			{ secret: SECRET, windowMs: 50_000 },
		);
		for (const method of ['GET', 'POST']) {
			await endpoint.serverRoute.handler(
				createContext(
					new Request(`http://localhost${WORKER_TICK_PATH}`, {
						method,
						headers: { authorization: `Bearer ${SECRET}` },
					}),
					{},
				),
			);
		}
		expect(tick.mock.calls).toEqual([[50_000], [15_000]]);
	});

	it('reports a failed tick without its cause', async () => {
		const endpoint = createWorkerTickEndpoint(
			{
				tick: async () => {
					throw new Error('postgres://user:secret@host/db refused');
				},
				close: async () => {},
			},
			{ secret: SECRET, windowMs: 50_000 },
		);
		const response = await endpoint.serverRoute.handler(
			request(`Bearer ${SECRET}`),
		);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain('secret@host');
	});
});

describe('worker tick retirement', () => {
	it('ends an open window when the runtime retires instead of waiting it out', async () => {
		vi.useRealTimers();
		const events: string[] = [];
		const ticker = createWorkerTicker([recordingComposition(events, 'a')], {
			windowMs: 50_000,
		});
		const endpoint = createWorkerTickEndpoint(ticker, {
			secret: SECRET,
			windowMs: 50_000,
		});
		/* The wiring octane.config.ts gives the ticker. */
		const lifecycle = createPlatformRuntimeLifecycle();
		lifecycle.addInterrupt(() => ticker.close());
		const tick = createContext(
			new Request(`http://localhost${WORKER_TICK_PATH}`, {
				headers: { authorization: `Bearer ${SECRET}` },
			}),
			{},
		);
		const answered = Promise.resolve(
			lifecycle.middleware(tick, () =>
				Promise.resolve(endpoint.serverRoute.handler(tick)),
			),
		).then(async (response) => ({
			status: response.status,
			report: await response.json(),
		}));
		await vi.waitFor(() => expect(events).toEqual(['a:start']));

		const retired = await Promise.race([
			lifecycle.retire().then(() => 'retired'),
			delay(1_000).then(() => 'waiting out the window'),
		]);

		expect(retired).toBe('retired');
		expect(await answered).toMatchObject({
			status: 503,
			report: { status: 'closed' },
		});
		expect(events).toEqual(['a:start', 'a:stop']);
	});
});
