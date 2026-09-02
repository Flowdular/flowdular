import { afterEach, describe, expect, it, vi } from 'vitest';
import { inviteTenantMember } from '../src/client/api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('member invitation client', () => {
	it('uses the auth invitation endpoint with the current CSRF proof', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ invitation: { id: 'invite-1', expiresAt: 42 } }),
		);
		vi.stubGlobal('fetch', fetchMock);
		await expect(
			inviteTenantMember(
				{ email: 'person@example.com', role: 'member' },
				'csrf-value',
			),
		).resolves.toEqual({ id: 'invite-1', expiresAt: 42 });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/auth/invitations',
			expect.objectContaining({
				method: 'POST',
				credentials: 'same-origin',
				body: JSON.stringify({
					email: 'person@example.com',
					role: 'member',
				}),
			}),
		);
		const options = fetchMock.mock.calls[0]![1] as RequestInit;
		expect(new Headers(options.headers).get('x-csrf-token')).toBe('csrf-value');
	});
});
