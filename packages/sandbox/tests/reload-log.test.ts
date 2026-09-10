import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchSandboxReloads } from '../src/server/reload-log.ts';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const draft =
	'/app/.flowdular/sandbox/sessions/session-one/workspace/modules/blog/src/';
function setup(verbose = false) {
	vi.useFakeTimers();
	const watcher = new EventEmitter();
	const httpServer = new EventEmitter();
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const dispose = watchSandboxReloads(
		{ watcher, httpServer } as never,
		'/sandbox',
		(message) => console.log('[octane:reload] ' + message),
		verbose,
	);
	return { watcher, httpServer, log, dispose };
}
describe('sandbox reload log', () => {
	it('groups repeated writes into a readable module summary', () => {
		const { watcher, log, dispose } = setup();
		for (const file of [
			'api.ts',
			'api.ts',
			'state.ts',
			'BlogView.tsrx',
			'state.ts',
		])
			watcher.emit('all', 'change', draft + file);
		expect(log).not.toHaveBeenCalled();
		vi.advanceTimersByTime(750);
		expect(log).toHaveBeenCalledExactlyOnceWith(
			'[octane:reload] Draft blog (session-) · 3 files changed',
		);
		dispose();
	});
	it('keeps source paths in verbose mode and removes listeners on shutdown', () => {
		const { watcher, httpServer, log } = setup(true);
		watcher.emit('all', 'change', draft + 'api.ts');
		vi.advanceTimersByTime(750);
		expect(log).toHaveBeenCalledWith('[octane:reload] ' + draft + 'api.ts');
		watcher.emit('all', 'change', draft + 'state.ts');
		httpServer.emit('close');
		vi.advanceTimersByTime(1000);
		expect(log).toHaveBeenCalledTimes(1);
		expect(watcher.listenerCount('all')).toBe(0);
	});
	it('counts added and removed files, distinguishes sessions, and ignores unrelated state', () => {
		const { watcher, log, dispose } = setup();
		watcher.emit('all', 'add', draft + 'api.ts');
		watcher.emit(
			'all',
			'unlink',
			draft.replace('session-one', 'another-session') + 'api.ts',
		);
		watcher.emit('all', 'change', '/app/.flowdular/sandbox/session.json');
		vi.advanceTimersByTime(750);
		expect(log).toHaveBeenCalledTimes(2);
		dispose();
	});
});
