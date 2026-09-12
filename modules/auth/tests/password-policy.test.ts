import { describe, expect, it } from 'vitest';
import {
	assertPasswordPolicy,
	COMMON_PASSWORDS,
	emailLocalPart,
} from '../src/services/validation.ts';

/* The policy is pure, so it is proven here directly; the endpoint and service
   suites prove that every credential path runs through it. */
describe('password policy', () => {
	it('keeps the minimum length rule and its stable code', () => {
		expect(() => assertPasswordPolicy('short', 12)).toThrow(
			expect.objectContaining({ code: 'INVALID_INPUT', status: 400 }),
		);
		expect(() => assertPasswordPolicy('x'.repeat(1_025), 12)).toThrow(
			expect.objectContaining({ code: 'INVALID_INPUT' }),
		);
	});

	it('refuses the most common passwords with a stable code', () => {
		/* Fixed and bounded: the lookup is never allowed to become a download. */
		expect(COMMON_PASSWORDS.size).toBeLessThanOrEqual(256);
		for (const entry of COMMON_PASSWORDS) {
			expect(entry).toBe(entry.toLowerCase());
		}
		for (const common of ['password123', '1qaz2wsx', 'qwertyuiop']) {
			expect(() => assertPasswordPolicy(common, 8)).toThrow(
				expect.objectContaining({ code: 'PASSWORD_TOO_COMMON', status: 400 }),
			);
		}
	});

	/* The denylist is worthless if the length rule answers first: at the default
	   minimum every entry shorter than it would come back as INVALID_INPUT, and
	   the long breached entries would clear the policy entirely. */
	it('reaches the denylist at the default minimum length', () => {
		for (const breached of [
			'password1234',
			'passwordpassword',
			'administrator',
			'qwerty123456',
			'1234567890123',
		]) {
			expect(breached.length).toBeGreaterThanOrEqual(12);
			expect(() => assertPasswordPolicy(breached)).toThrow(
				expect.objectContaining({ code: 'PASSWORD_TOO_COMMON', status: 400 }),
			);
		}
		expect(() => assertPasswordPolicy('qwertyuiop')).toThrow(
			expect.objectContaining({ code: 'PASSWORD_TOO_COMMON' }),
		);
	});

	it('folds case and surrounding space before the denylist lookup', () => {
		expect(() => assertPasswordPolicy('  PassWord123  ', 8)).toThrow(
			expect.objectContaining({ code: 'PASSWORD_TOO_COMMON' }),
		);
	});

	it('refuses a password that carries the address local part', () => {
		expect(() =>
			assertPasswordPolicy(
				'ada.lovelace winter',
				12,
				'Ada.Lovelace@Example.com',
			),
		).toThrow(
			expect.objectContaining({
				code: 'PASSWORD_CONTAINS_EMAIL',
				status: 400,
			}),
		);
		expect(emailLocalPart('Ada.Lovelace@Example.com')).toBe('ada.lovelace');
	});

	it('ignores a local part too short to carry the address', () => {
		expect(() =>
			assertPasswordPolicy('absolutely unrelated', 12, 'ab@example.com'),
		).not.toThrow();
	});

	it('accepts a long password unrelated to the address', () => {
		expect(() =>
			assertPasswordPolicy('steady tangerine harbor', 12, 'ada@example.com'),
		).not.toThrow();
	});

	it('applies no address rule when the caller holds no address', () => {
		expect(() => assertPasswordPolicy('ada winter harbor', 12)).not.toThrow();
	});
});
