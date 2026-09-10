import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';

const harness = vi.hoisted(() => ({
	started: 0,
	release: () => {},
	entered: () => {},
	aborted: () => {},
	done: Promise.resolve(),
	deleted: vi.fn(),
}));

vi.mock('../src/server/sessions.ts', async (original) => ({
	...(await original<typeof import('../src/server/sessions.ts')>()),
	readSession: async () => ({
		id: '11111111-1111-4111-8111-111111111111',
		state: 'editing',
		archivedAt: null,
		owner: null,
	}),
	updateSession: async () => ({}),
	deleteSession: (...args: unknown[]) => harness.deleted(...args),
}));
vi.mock('../src/server/turns.ts', async (original) => ({
	...(await original<typeof import('../src/server/turns.ts')>()),
	async *runTurn(_context: unknown, input: { signal: AbortSignal }) {
		harness.started += 1;
		harness.entered();
		input.signal.addEventListener('abort', () => harness.aborted(), {
			once: true,
		});
		// Models an uncancellable formatter or a driver still draining writes.
		await harness.done;
		return { handoff: { kind: 'none' }, session: { autoContinue: false } };
	},
}));

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('unused')),
	cached: () => null,
	forget: () => {},
	dispose: () => {},
};
const streams: Response[] = [];

async function setup() {
	harness.started = 0;
	harness.deleted.mockClear();
	harness.done = new Promise<void>((resolve) => {
		harness.release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		harness.entered = resolve;
	});
	const root = await mkdtemp(join(tmpdir(), 'flowdular-turn-lifecycle-'));
	const runtime = {
		workspaceRoot: root,
		configuration: () => ({ ...DEFAULT_CONFIGURATION, mode: 'loopback' }),
		connection: () => ({ connected: true, authority: null }),
		platform: () => null,
		registry: () => ({}),
		roles: () => [],
	} as unknown as SandboxRuntime;
	const generation = () => {
		const router = createRouter([
			...createSandboxRoutes(runtime, preview, { port: 4320 }),
		]);
		return async (method: string, suffix: string, body?: unknown) => {
			const url = new URL(
				'/sandbox/api/sessions/11111111-1111-4111-8111-111111111111' + suffix,
				'http://127.0.0.1:4320',
			);
			const match = router.match(method, url.pathname)!;
			if (match.route.type !== 'server')
				throw new Error('Expected server route');
			const response = await match.route.handler({
				url,
				params: match.params,
				state: new Map(),
				request: new Request(url, {
					method,
					headers: {
						host: url.host,
						'content-type': 'application/json',
						'x-flowdular-sandbox': '1',
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			});
			if (response.headers.get('content-type')?.includes('text/event-stream'))
				streams.push(response);
			return response;
		};
	};
	return { generation, entered };
}

afterEach(async () => {
	harness.release();
	vi.useRealTimers();
	await Promise.all(streams.splice(0).map((response) => response.text()));
});

describe('sandbox turn ownership', () => {
	it('retains stream and stop ownership across route generations', async () => {
		const { generation, entered } = await setup();
		await generation()('POST', '/turn', { message: 'first' });
		await entered;
		const second = generation();
		const follow = await second('GET', '/turn/stream');
		expect(follow.headers.get('content-type')).toContain('text/event-stream');
		const stopped = await second('POST', '/stop', {});
		expect(await stopped.json()).toEqual({ stopped: true });
	});

	it('refuses deletion after the stop deadline while the writer is still alive', async () => {
		const { generation, entered } = await setup();
		const call = generation();
		await call('POST', '/turn', { message: 'first' });
		await entered;
		vi.useFakeTimers();
		const aborted = new Promise<void>((resolve) => {
			harness.aborted = resolve;
		});
		const deleting = call('POST', '/delete', { stop: true });
		await aborted;
		await vi.advanceTimersByTimeAsync(20_001);
		const response = await deleting;
		expect(response.status).toBe(409);
		expect(harness.deleted).not.toHaveBeenCalled();
		expect(
			(await call('GET', '/turn/stream')).headers.get('content-type'),
		).toContain('text/event-stream');
	});

	it('keeps the predecessor owned when two superseding requests time out', async () => {
		const { generation, entered } = await setup();
		const call = generation();
		await call('POST', '/turn', { message: 'first' });
		await entered;
		vi.useFakeTimers();
		await call('POST', '/turn', { message: 'second' });
		await vi.advanceTimersByTimeAsync(20_001);
		expect(harness.started).toBe(1);
		await call('POST', '/turn', { message: 'third' });
		await vi.advanceTimersByTimeAsync(20_001);
		expect(harness.started).toBe(1);
		expect(
			(await call('GET', '/turn/stream')).headers.get('content-type'),
		).toContain('text/event-stream');
	});
});
