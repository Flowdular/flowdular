import { describe, expect, it, vi } from 'vitest';
import {
	activatePlatformRuntimeLifecycle,
	createPlatformRuntimeLifecycle,
	prepareAndActivatePlatformRuntimeLifecycle,
} from './lifecycle.ts';

describe('platform runtime lifecycle', () => {
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
			'Platform runtime teardown did not release every resource.',
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
