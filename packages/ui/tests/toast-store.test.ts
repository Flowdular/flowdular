import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore } from '../src/components/toast-store.ts';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('toast queue', () => {
	it('keeps the tone and message of every raised toast, oldest first', () => {
		const store = createToastStore();
		store.success('Saved');
		store.error('Refused');
		store.info('Running');
		expect(store.list().map((toast) => [toast.tone, toast.message])).toEqual([
			['success', 'Saved'],
			['error', 'Refused'],
			['info', 'Running'],
		]);
		expect(new Set(store.list().map((toast) => toast.id)).size).toBe(3);
	});

	it('hands out the same list until something changes', () => {
		const store = createToastStore();
		const before = store.list();
		expect(store.list()).toBe(before);
		store.info('Running');
		expect(store.list()).not.toBe(before);
		expect(store.list()).toBe(store.list());
	});

	it('removes a toast when its time runs out', () => {
		const store = createToastStore({ durationMs: 1000 });
		store.info('Running');
		vi.advanceTimersByTime(999);
		expect(store.list()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(store.list()).toHaveLength(0);
	});

	it('keeps a toast with no duration until it is closed', () => {
		const store = createToastStore({ durationMs: 0 });
		const id = store.error('Refused');
		vi.advanceTimersByTime(60_000);
		expect(store.list()).toHaveLength(1);
		store.dismiss(id);
		expect(store.list()).toHaveLength(0);
	});

	it('schedules nothing for a toast that is already gone', () => {
		const store = createToastStore({ durationMs: 1000 });
		const id = store.info('Running');
		store.dismiss(id);
		expect(vi.getTimerCount()).toBe(0);
		store.info('Running');
		store.clear();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('drops the oldest toast, and its timer, past the limit', () => {
		const store = createToastStore({ durationMs: 1000, limit: 2 });
		store.info('one');
		store.info('two');
		store.info('three');
		expect(store.list().map((toast) => toast.message)).toEqual([
			'two',
			'three',
		]);
		expect(vi.getTimerCount()).toBe(2);
	});

	it('tells every listener about a change until it unsubscribes', () => {
		const store = createToastStore({ durationMs: 0 });
		const seen: number[] = [];
		const stop = store.subscribe(() => seen.push(store.list().length));
		const id = store.info('Running');
		store.dismiss(id);
		store.dismiss(id);
		stop();
		store.info('Running');
		expect(seen).toEqual([1, 0]);
	});

	it('survives a listener that throws', () => {
		const store = createToastStore({ durationMs: 0 });
		const seen: string[] = [];
		store.subscribe(() => {
			throw new Error('host failed');
		});
		store.subscribe(() => seen.push('reached'));
		expect(() => store.success('Saved')).not.toThrow();
		expect(seen).toEqual(['reached']);
		expect(store.list()).toHaveLength(1);
	});

	it('empties the queue once', () => {
		const store = createToastStore({ durationMs: 0 });
		let changes = 0;
		store.subscribe(() => {
			changes += 1;
		});
		store.info('one');
		store.info('two');
		store.clear();
		store.clear();
		expect(store.list()).toEqual([]);
		expect(changes).toBe(3);
	});
});
