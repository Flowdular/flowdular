import { describe, expect, it } from 'vitest';
import { HttpProblem, readJsonObject, requiredInteger } from '../src/http.ts';

describe('HTTP input boundary', () => {
	it('rejects non-JSON request bodies', async () => {
		await expect(
			readJsonObject(
				new Request('https://example.test', {
					method: 'POST',
					body: 'value',
				}),
			),
		).rejects.toMatchObject({ code: 'CONTENT_TYPE_REQUIRED', status: 415 });
	});

	it('accepts a bounded JSON object', async () => {
		await expect(
			readJsonObject(
				new Request('https://example.test', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ amount: 1200 }),
				}),
			),
		).resolves.toEqual({ amount: 1200 });
	});

	it('requires safe integer fields', () => {
		expect(() => requiredInteger({ amount: 1.5 }, 'amount')).toThrow(
			HttpProblem,
		);
	});
});
