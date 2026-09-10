import { expect, it } from 'vitest';
import { runActions } from '../src/client/run-actions.ts';

it('never offers cancellation after settlement or a second cancellation request', () => {
	for (const status of [
		'succeeded',
		'failed',
		'refused',
		'cancelled',
		'cancel-requested',
	] as const)
		expect(
			runActions({ mode: 'live', status }, { execute: true, cancel: true })
				.cancel,
		).toBe(false);
});
it('only retries failed live runs when the actor can execute', () => {
	expect(
		runActions(
			{ mode: 'simulate', status: 'failed' },
			{ execute: true, cancel: true },
		).retry,
	).toBe(false);
	expect(
		runActions(
			{ mode: 'live', status: 'failed' },
			{ execute: false, cancel: true },
		).retry,
	).toBe(false);
	expect(
		runActions(
			{ mode: 'live', status: 'failed' },
			{ execute: true, cancel: false },
		).retry,
	).toBe(true);
});
it('offers cancellation only for active live runs with permission', () => {
	for (const status of [
		'queued',
		'running',
		'waiting-agent',
		'waiting-retry',
	] as const) {
		expect(
			runActions({ mode: 'live', status }, { execute: false, cancel: true })
				.cancel,
		).toBe(true);
		expect(
			runActions({ mode: 'live', status }, { execute: true, cancel: false })
				.cancel,
		).toBe(false);
		expect(
			runActions({ mode: 'simulate', status }, { execute: true, cancel: true })
				.cancel,
		).toBe(false);
	}
});
