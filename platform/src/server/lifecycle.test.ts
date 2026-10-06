import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
	activatePlatformRuntimeLifecycle,
	createPlatformRuntimeLifecycle,
	prepareAndActivatePlatformRuntimeLifecycle,
} from './lifecycle.ts';

/* Far below the development server's 6 s shutdown budget, and far above what
   a retirement that waits on nothing takes. */
function settlesSoon(promise: Promise<unknown>): Promise<string> {
	return Promise.race([
		promise.then(() => 'settled'),
		delay(1_000).then(() => 'still waiting'),
	]);
}

function eventStream(cancel: () => void): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('retry: 1000\n\n'));
			},
			cancel,
		}),
		{ headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
	);
}

describe('platform runtime lifecycle', () => {
	it('ends an open event stream when it retires instead of waiting for it', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const disposed = vi.fn();
		lifecycle.add(disposed);
		const cancelled = vi.fn();
		const response = await lifecycle.middleware(
			{ request: new Request('https://test/events') } as never,
			async () => eventStream(cancelled),
		);
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			'retry: 1000\n\n',
		);

		await expect(settlesSoon(lifecycle.retire())).resolves.toBe('settled');

		expect(await reader.read()).toEqual({ done: true, value: undefined });
		expect(cancelled).toHaveBeenCalledOnce();
		expect(disposed).toHaveBeenCalledOnce();
	});

	it('ends an event stream that a request answers after retirement began', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const cancelled = vi.fn();
		let answer!: (response: Response) => void;
		const pending = lifecycle.middleware(
			{ request: new Request('https://test/events') } as never,
			() => new Promise<Response>((resolve) => (answer = resolve)),
		);
		const retired = lifecycle.retire();
		answer(eventStream(cancelled));

		await expect(settlesSoon((await pending).text())).resolves.toBe('settled');
		await expect(settlesSoon(retired)).resolves.toBe('settled');
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it('interrupts a producer that holds a request open before the requests drain', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const events: string[] = [];
		let endWindow!: () => void;
		const window = new Promise<void>((resolve) => (endWindow = resolve));
		lifecycle.add(() => {
			events.push('dispose');
		});
		lifecycle.addQuiesce(() => {
			events.push('quiesce');
		});
		lifecycle.addInterrupt(() => {
			events.push('interrupt');
			endWindow();
		});
		const sent = Promise.resolve(
			lifecycle.middleware({} as never, async () => {
				await window;
				events.push('answered');
				return new Response('closed', { status: 503 });
			}),
		).then(async (response) => `${response.status} ${await response.text()}`);

		await expect(settlesSoon(lifecycle.retire())).resolves.toBe('settled');

		expect(await sent).toBe('503 closed');
		expect(events).toEqual(['interrupt', 'answered', 'quiesce', 'dispose']);
	});

	it('reports a failed interrupt with the teardown failures', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const disposed = vi.fn();
		lifecycle.add(disposed);
		lifecycle.addInterrupt(() => {
			throw new Error('window did not close');
		});

		await expect(lifecycle.retire()).rejects.toThrow(
			'Platform runtime teardown did not release every resource: window did not close',
		);
		expect(disposed).toHaveBeenCalledOnce();
	});

	it('runs an interrupt registered after retirement at once', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		await lifecycle.retire();
		const interrupted = vi.fn();

		lifecycle.addInterrupt(interrupted);

		await vi.waitFor(() => expect(interrupted).toHaveBeenCalledOnce());
	});

	it.each(['close', 'cancel', 'error', 'abort'] as const)(
		'keeps resources alive until a response stream finishes through %s',
		async (mode) => {
			const lifecycle = createPlatformRuntimeLifecycle();
			const disposed = vi.fn();
			lifecycle.add(disposed);
			const abort = new AbortController();
			let stream!: ReadableStreamDefaultController<Uint8Array>;
			const response = await lifecycle.middleware(
				{
					request: new Request('https://test/', { signal: abort.signal }),
				} as never,
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								stream = controller;
							},
						}),
					),
			);
			const retired = lifecycle.retire();
			await Promise.resolve();
			expect(disposed).not.toHaveBeenCalled();
			if (mode === 'cancel') await response.body!.cancel();
			else if (mode === 'abort') abort.abort();
			else if (mode === 'error') {
				stream.error(new Error('stream failed'));
				await expect(response.text()).rejects.toThrow('stream failed');
			} else {
				stream.enqueue(new TextEncoder().encode('done'));
				stream.close();
				expect(await response.text()).toBe('done');
			}
			await retired;
			expect(disposed).toHaveBeenCalledOnce();
		},
	);
	it('waits for an active request and disposes resources once in reverse order', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const events: string[] = [];
		lifecycle.add(() => {
			events.push('auth');
		});
		lifecycle.add(async () => {
			events.push('module');
		});
		let release: (() => void) | undefined;
		const request = lifecycle.middleware({} as never, async () => {
			events.push('request');
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return new Response('ok');
		});

		const retired = lifecycle.retire();
		await Promise.resolve();
		expect(events).toEqual(['request']);
		release?.();
		await (await request).text();
		await retired;
		expect(events).toEqual(['request', 'module', 'auth']);

		await lifecycle.retire();
		expect(events).toEqual(['request', 'module', 'auth']);
	});

	it('runs every disposer even when one fails', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const last = vi.fn();
		lifecycle.add(last);
		lifecycle.add(() => {
			throw new Error('broken cleanup');
		});

		await expect(lifecycle.retire()).rejects.toThrow(
			/* The message carries each cause, so a logger that prints one line still
		   says what failed. */
			'Platform runtime teardown did not release every resource: broken cleanup',
		);
		expect(last).toHaveBeenCalledOnce();
	});

	it('quiesces every producer before disposing any module resource', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const events: string[] = [];
		lifecycle.add(() => {
			events.push('dispose:first');
		});
		lifecycle.addQuiesce(async () => {
			events.push('stop:first');
		});
		lifecycle.add(() => {
			events.push('dispose:second');
		});
		lifecycle.addQuiesce(() => {
			events.push('stop:second');
		});

		await lifecycle.retire();

		expect(events).toEqual([
			'stop:second',
			'stop:first',
			'dispose:second',
			'dispose:first',
		]);
	});

	it('refuses a request after retirement instead of using disposed routes', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const next = vi.fn(async () => new Response('unsafe'));
		await lifecycle.retire();

		const response = await lifecycle.middleware({} as never, next);

		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('1');
		expect(next).not.toHaveBeenCalled();
	});

	it('keeps an event source reconnecting after retirement instead of refusing it', async () => {
		const lifecycle = createPlatformRuntimeLifecycle();
		const next = vi.fn(async () => new Response('unsafe'));
		await lifecycle.retire();

		const response = await lifecycle.middleware(
			{
				request: new Request('https://test/events', {
					headers: { accept: 'text/event-stream' },
				}),
			} as never,
			next,
		);

		/* Any other answer ends an EventSource for good. */
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
		expect(await response.text()).toBe('retry: 1000\n\n');
		const read = await lifecycle.middleware(
			{
				request: new Request('https://test/api/runs', {
					headers: { accept: 'application/json' },
				}),
			} as never,
			next,
		);
		expect(read.status).toBe(503);
		expect(next).not.toHaveBeenCalled();
	});

	it('retires the previous activated generation', async () => {
		const previous = createPlatformRuntimeLifecycle();
		const released = vi.fn();
		previous.add(released);
		activatePlatformRuntimeLifecycle(previous);

		const current = createPlatformRuntimeLifecycle();
		activatePlatformRuntimeLifecycle(current);
		await previous.retire();
		expect(released).toHaveBeenCalledOnce();

		await current.retire();
	});

	it('keeps the healthy generation active when preparation fails', async () => {
		const previous = createPlatformRuntimeLifecycle();
		const previousDisposed = vi.fn();
		previous.add(previousDisposed);
		await activatePlatformRuntimeLifecycle(previous);

		const candidate = createPlatformRuntimeLifecycle();
		await expect(
			prepareAndActivatePlatformRuntimeLifecycle(candidate, [
				() => {
					throw new Error('module definition drift');
				},
			]),
		).rejects.toThrow('module definition drift');

		const next = vi.fn(async () => new Response('healthy'));
		const response = await previous.middleware({} as never, next);
		expect(await response.text()).toBe('healthy');
		expect(next).toHaveBeenCalledOnce();
		expect(previousDisposed).not.toHaveBeenCalled();

		await candidate.retire();
		await previous.retire();
	});
});
