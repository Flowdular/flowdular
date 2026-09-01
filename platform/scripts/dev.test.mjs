import { describe, expect, it } from 'vitest';
import {
	formatDevEvent,
	isClientDisconnectLog,
	parseDevArguments,
	shouldUseColor,
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
});
