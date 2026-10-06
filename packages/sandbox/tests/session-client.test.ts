import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	streamTurn,
	followTurn,
	streamEject,
	watchSession,
	type SessionView,
	type TurnHandlers,
} from '../src/client/api.ts';
import { approvalErrorFor, type ApprovalRefusal } from '../src/client/state.ts';
import type { ChatEntry } from '../src/server/sessions.ts';

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
	it('names the first error of a failed gate as the delivery step detail', async () => {
		const gate = {
			id: 'spec-schema',
			status: 'failed',
			command: 'pnpm --silent flowdular spec validate --all --json',
			output:
				'$ tsx src/index.ts spec validate --all --json\n{\n  "protocolVersion": 1,',
			durationMs: 1,
			issues: [
				{
					file: 'modules/booking/spec/module.yaml',
					code: 'SPEC_FIELD_RESERVED',
					path: '/entities/0/fields/1/id',
					message: 'Field "booking.createdAt" collides with a column.',
				},
			],
		};
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response(
						`event: gate.completed\ndata: ${JSON.stringify(gate)}\n\n`,
					),
				),
		);
		const onStep = vi.fn();
		streamEject('session', { onStep, onDone: vi.fn(), onFailed: vi.fn() });
		await vi.waitFor(() =>
			expect(onStep).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'gate:spec-schema',
					status: 'failed',
					detail:
						'SPEC_FIELD_RESERVED: Field "booking.createdAt" collides with a column.',
				}),
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

describe('session change feed', () => {
	/* The browser's EventSource, reduced to what the feed uses. */
	class FakeEventSource {
		static opened: FakeEventSource[] = [];
		readonly listeners = new Map<string, (() => void)[]>();
		closed = false;
		constructor(readonly url: string) {
			FakeEventSource.opened.push(this);
		}
		addEventListener(type: string, listener: () => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		close() {
			this.closed = true;
		}
		emit(type: string) {
			for (const listener of this.listeners.get(type) ?? []) listener();
		}
	}

	it('reports the opening and every change, and closes with the view', () => {
		FakeEventSource.opened = [];
		vi.stubGlobal('EventSource', FakeEventSource);
		const onChanged = vi.fn();

		const stop = watchSession('session 1', onChanged);
		const source = FakeEventSource.opened[0]!;
		expect(source.url).toBe('/sandbox/api/sessions/session%201/events');
		/* The opening counts: a change made before the feed connected, or while
		   it was reconnecting, must still reload the view. */
		source.emit('ready');
		source.emit('changed');
		source.emit('changed');
		expect(onChanged).toHaveBeenCalledTimes(3);

		stop();
		expect(source.closed).toBe(true);
	});
});

describe('the banner of a refused approval', () => {
	const approvalHandoff: ChatEntry = {
		sequence: 7,
		at: 7,
		kind: 'system',
		role: 'business-manager',
		module: 'booking',
		text: 'The specification is ready for approval.',
		handoff: {
			kind: 'approval',
			role: 'backend-engineer',
			roleName: 'Backend engineer',
			reason: 'The specification is ready for approval.',
			prompt: '',
			module: 'booking',
		},
	};
	const refusal: ApprovalRefusal = {
		session: 'session-1',
		module: 'booking',
		handoff: 7,
		message:
			'The specification of booking.core changed after you reviewed it. Review the current text and approve again.',
	};
	/* What a reload of the session route returns, reduced to what decides
	   whether the refusal still explains the card on screen. */
	function view(
		chat: readonly ChatEntry[],
		approved: boolean,
		session = 'session-1',
	): SessionView {
		return {
			session: { id: session },
			chat,
			specs: [{ module: 'booking', approved }],
		} as unknown as SessionView;
	}

	it('stays while the card it was refused on is still the one to approve', () => {
		/* The reload after the refusal shows the current text, still unapproved. */
		expect(approvalErrorFor(refusal, view([approvalHandoff], false))).toBe(
			refusal.message,
		);
	});

	it('goes once another client approves the module', () => {
		const approvedElsewhere: ChatEntry = {
			sequence: 8,
			at: 8,
			kind: 'system',
			role: 'business-manager',
			module: 'booking',
			decision: 'approved',
			text: 'You approved the specification of booking.core.',
		};
		expect(
			approvalErrorFor(
				refusal,
				view([approvalHandoff, approvedElsewhere], true),
			),
		).toBe('');
	});

	it('goes once a newer handoff replaces the card', () => {
		const answered: ChatEntry = {
			...approvalHandoff,
			sequence: 12,
			at: 12,
			handoff: { ...approvalHandoff.handoff!, kind: 'question' },
		};
		expect(
			approvalErrorFor(refusal, view([approvalHandoff, answered], false)),
		).toBe('');
	});

	it('never shows beside another session or without one', () => {
		expect(
			approvalErrorFor(refusal, view([approvalHandoff], false, 'session-2')),
		).toBe('');
		expect(approvalErrorFor(refusal, null)).toBe('');
		expect(approvalErrorFor(null, view([approvalHandoff], false))).toBe('');
	});
});
