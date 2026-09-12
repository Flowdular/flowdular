import { describe, expect, it } from 'vitest';
import { prepareRequest } from '../src/services/call-service.ts';
import type { ConnectorOperation } from '../src/domain/types.ts';

/* The two expansions a definition can declare: one escaped segment, and a whole
   path the caller supplies. The shipped generic connector uses the reserved
   form, and a module shipping its own definition uses the other. */
function operation(path: string): ConnectorOperation {
	return {
		key: 'get',
		label: 'GET',
		method: 'GET',
		path,
		inputSchema: { type: 'object' },
		outputSchema: { type: 'object' },
	};
}

const SEGMENT = operation('/things/{id}/notes');
const RESERVED = operation('{+path}');

describe('CONNECTORS-PATH-SEGMENT', () => {
	it('keeps a value inside the segment the template gave it', () => {
		expect(
			prepareRequest('https://api.example.test/v1', SEGMENT, {
				id: 'a b/c',
			}).target.pathname,
		).toBe('/v1/things/a%20b%2Fc/notes');
		expect(
			prepareRequest('https://api.example.test/v1', RESERVED, {
				path: '/things/42',
			}).target.pathname,
		).toBe('/v1/things/42');
	});

	/* A dot segment survives the encoders and is resolved away by `new URL`, so
	   without this rule a value alone reaches a path the definition never
	   declared: `{id}` = `..` turns /v1/things/{id}/notes into /v1/things/notes,
	   and a base URL at the root leaves nothing to catch it at all. */
	it('refuses a dot segment in the escaped and the reserved expansion', () => {
		for (const value of ['.', '..', 'a/..', '../..']) {
			expect(() =>
				prepareRequest('https://api.example.test/v1', SEGMENT, { id: value }),
			).toThrow();
		}
		for (const value of ['/..', '/things/../../admin', '/things/.']) {
			expect(() =>
				prepareRequest('https://api.example.test/', RESERVED, { path: value }),
			).toThrow();
		}
	});

	it('leaves a value that only contains dots alone', () => {
		expect(
			prepareRequest('https://api.example.test/', SEGMENT, {
				id: '...',
			}).target.pathname,
		).toBe('/things/.../notes');
		expect(
			prepareRequest('https://api.example.test/', RESERVED, {
				path: '/reports/2026.09.12',
			}).target.pathname,
		).toBe('/reports/2026.09.12');
	});
});
