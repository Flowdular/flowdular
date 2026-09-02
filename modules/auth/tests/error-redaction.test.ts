import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from '../src/server/http.ts';

describe('auth server error redaction', () => {
	it('does not pass an unexpected secret-bearing error to the logger', async () => {
		const logged = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const response = errorResponse(
			new Error('database failed for password super-secret-value'),
			'[auth.core] test failed',
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: 'INTERNAL_ERROR',
				message: 'The request could not be completed.',
			},
		});
		expect(logged).toHaveBeenCalledWith('[auth.core] test failed (Error)');
		expect(JSON.stringify(logged.mock.calls)).not.toContain(
			'super-secret-value',
		);
		logged.mockRestore();
	});
});
