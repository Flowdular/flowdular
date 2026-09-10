import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	streamTurn,
	followTurn,
	streamEject,
	type TurnHandlers,
} from '../src/client/api.ts';

afterEach(() => vi.unstubAllGlobals());

describe('session turn transport', () => {
	it('reports a required restart as a note, never as a completed delivery step', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response(
						'event: restart.required\ndata: {"note":"Restart needed"}\n\n',
					),
				),
		);
		const onStep = vi.fn();
		streamEject('session', { onStep, onDone: vi.fn(), onFailed: vi.fn() });
		await vi.waitFor(() =>
			expect(onStep).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'restart', status: 'note' }),
			),
		);
	});
	const input = { message: 'Create a booking', role: 'auto', driver: 'fake' };
	function handlers() {
		return {
			onEntry: vi.fn(),
			onCompleted: vi.fn(),
			onEnded: vi.fn(),
			onFailed: vi.fn(),
		} satisfies TurnHandlers;
	}
	it('releases the composer after a refused start', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: { message: 'Unavailable' } }), {
					status: 503,
				}),
			),
		);
		const events = handlers();
		streamTurn('session', input, events);
		await vi.waitFor(() =>
			expect(events.onFailed).toHaveBeenCalledWith('Unavailable'),
		);
		expect(events.onEnded).toHaveBeenCalledTimes(1);
	});
	it('releases the composer after a network failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
		);
		const events = handlers();
		streamTurn('session', input, events);
		await vi.waitFor(() => expect(events.onFailed).toHaveBeenCalled());
		expect(events.onEnded).toHaveBeenCalledTimes(1);
	});
	it('ends exactly once after a completed stream', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('event: completed\ndata: {}\n\n', {
					headers: { 'content-type': 'text/event-stream' },
				}),
			),
		);
		const events = handlers();
		streamTurn('session', input, events);
		await vi.waitFor(() => expect(events.onEnded).toHaveBeenCalledTimes(1));
		expect(events.onCompleted).toHaveBeenCalledOnce();
	});
	it('does not report an aborted connection as a finished or failed turn', async () => {
		let rejectFetch!: (reason: Error) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(
				() =>
					new Promise((_resolve, reject) => {
						rejectFetch = reject;
					}),
			),
		);
		const events = handlers();
		const controller = streamTurn('session', input, events);
		controller.abort();
		rejectFetch(new Error('Aborted'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events.onEnded).not.toHaveBeenCalled();
		expect(events.onFailed).not.toHaveBeenCalled();
	});
	it('ends an attached stream once when the connection breaks', async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.error(new Error('Disconnected'));
			},
		});
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(body, {
					headers: { 'content-type': 'text/event-stream' },
				}),
			),
		);
		const events = handlers();
		expect(await followTurn('session', events).attached).toBe(true);
		await vi.waitFor(() => expect(events.onEnded).toHaveBeenCalledOnce());
		expect(events.onFailed).toHaveBeenCalledWith('Disconnected');
	});
});
