import { expect, it, vi } from 'vitest';
vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.alloc(32, 255) }));
import { generateSecrets } from '../src/secrets.ts';

it('encodes every possible MFA key byte in the alphabet accepted by auth', () => {
	const key = generateSecrets().FD_AUTH_MFA_KEY;
	expect(key).toMatch(/^[A-Za-z0-9_-]{43}=?$/);
	expect(Buffer.from(key, 'base64url')).toEqual(Buffer.alloc(32, 255));
});
