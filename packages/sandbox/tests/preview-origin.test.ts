import { describe, expect, it } from 'vitest';
import { previewHopHeaders } from '../src/server/preview-worker-manager.ts';
import { assertBrowserOrigin, assertSameOrigin } from '../src/server/routes.ts';

const SANDBOX = 'http://127.0.0.1:4320';
const WORKER = 'http://127.0.0.1:51899';

function browserRequest(
	headers: Readonly<Record<string, string>>,
	method = 'POST',
): Request {
	return new Request(SANDBOX + '/api/auth/sign-in', {
		method,
		headers: { host: '127.0.0.1:4320', ...headers },
	});
}

describe('browser origin boundary', () => {
	it('accepts a request from the sandbox page', () => {
		expect(() =>
			assertBrowserOrigin(
				browserRequest({ origin: SANDBOX, 'sec-fetch-site': 'same-origin' }),
			),
		).not.toThrow();
	});

	it('accepts a request that carries no origin', () => {
		expect(() => assertBrowserOrigin(browserRequest({}))).not.toThrow();
	});

	it('rejects a cross-site post', () => {
		expect(() =>
			assertBrowserOrigin(
				browserRequest({
					origin: 'https://evil.example',
					'sec-fetch-site': 'cross-site',
				}),
			),
		).toThrow(/sandbox page only/);
	});

	it('rejects an origin that names another host', () => {
		expect(() =>
			assertBrowserOrigin(browserRequest({ origin: 'http://127.0.0.1:4999' })),
		).toThrow(/sandbox page only/);
	});

	it('still requires the sandbox header for sandbox mutations', () => {
		expect(() => assertSameOrigin(browserRequest({ origin: SANDBOX }))).toThrow(
			/header/,
		);
		expect(() =>
			assertSameOrigin(
				browserRequest({ origin: SANDBOX, 'x-coreloom-sandbox': '1' }),
			),
		).not.toThrow();
	});
});

describe('preview worker hop headers', () => {
	it('presents the worker origin so draft auth routes match their own URL', () => {
		const headers = previewHopHeaders(
			new Headers({
				origin: SANDBOX,
				referer: SANDBOX + '/preview/1a2b',
				host: '127.0.0.1:4320',
				connection: 'keep-alive',
				'content-length': '18',
				'content-type': 'application/json',
				'x-coreloom-preview-session': '1a2b',
			}),
			WORKER,
		);

		expect(headers.get('origin')).toBe(WORKER);
		expect(headers.get('referer')).toBeNull();
		expect(headers.get('host')).toBeNull();
		expect(headers.get('connection')).toBeNull();
		expect(headers.get('content-length')).toBeNull();
		expect(headers.get('content-type')).toBe('application/json');
		expect(headers.get('x-coreloom-preview-session')).toBe('1a2b');
	});

	it('adds no origin to a request that had none', () => {
		const headers = previewHopHeaders(
			new Headers({ accept: 'application/json' }),
			WORKER,
		);

		expect(headers.has('origin')).toBe(false);
		expect(headers.get('accept')).toBe('application/json');
	});

	it('leaves the source headers untouched', () => {
		const source = new Headers({ origin: SANDBOX });

		previewHopHeaders(source, WORKER);

		expect(source.get('origin')).toBe(SANDBOX);
	});
});
