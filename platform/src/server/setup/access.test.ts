import { describe, expect, it } from 'vitest';
import {
	createSetupAccess,
	generateSetupToken,
	readSetupSessionCookie,
	setupSessionCookie,
} from './access.ts';

const TOKEN = 'a'.repeat(43);

describe('setup access', () => {
	it('refuses a missing token and every wrong one', () => {
		const access = createSetupAccess(TOKEN);

		expect(access.open(null).verdict).toBe('denied');
		expect(access.open('').verdict).toBe('denied');
		expect(access.open('b'.repeat(43)).verdict).toBe('denied');
		expect(access.open(TOKEN.slice(0, 42)).verdict).toBe('denied');
	});

	it('opens a session for the token and refuses a second cookie value', () => {
		const access = createSetupAccess(TOKEN);
		const opened = access.open(TOKEN);

		expect(opened.verdict).toBe('granted');
		expect(opened.session?.id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(access.resume(opened.session!.id)).toBe(opened.session);
		expect(access.resume('not-the-session')).toBeNull();
		expect(access.resume(null)).toBeNull();
	});

	it('locks out after five failures and stays locked for the window', () => {
		let now = 1_000;
		const access = createSetupAccess(TOKEN, () => now);

		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(access.open('wrong').verdict).toBe('denied');
		}
		const locked = access.open('wrong');
		expect(locked.verdict).toBe('locked');
		expect(locked.retryAfterMs).toBeGreaterThan(0);

		/* The correct token is refused while the lockout stands, so guessing
		   cannot be resumed by racing a valid attempt in between. */
		expect(access.open(TOKEN).verdict).toBe('locked');

		now += locked.retryAfterMs;
		expect(access.open(TOKEN).verdict).toBe('granted');
	});

	it('resets the failure count once the token is accepted', () => {
		const access = createSetupAccess(TOKEN);

		for (let attempt = 0; attempt < 4; attempt += 1) access.open('wrong');
		expect(access.open(TOKEN).verdict).toBe('granted');
		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(access.open('wrong').verdict).toBe('denied');
		}
	});

	it('binds the CSRF token to the session that minted it', () => {
		const access = createSetupAccess(TOKEN);
		const first = access.open(TOKEN).session!;

		expect(access.verifyCsrf(first, first.csrfToken)).toBe(true);
		expect(access.verifyCsrf(first, null)).toBe(false);
		expect(access.verifyCsrf(first, '')).toBe(false);
		expect(access.verifyCsrf(first, first.id)).toBe(false);

		const second = access.open(TOKEN).session!;
		expect(second.csrfToken).not.toBe(first.csrfToken);
		expect(access.verifyCsrf(second, first.csrfToken)).toBe(false);
		/* Opening again supersedes the previous session rather than keeping two. */
		expect(access.resume(first.id)).toBeNull();
	});

	it('expires a session and closes it on demand', () => {
		let now = 0;
		const access = createSetupAccess(TOKEN, () => now);
		const session = access.open(TOKEN).session!;

		now += 29 * 60 * 1000;
		expect(access.resume(session.id)).toBe(session);
		now += 31 * 60 * 1000;
		expect(access.resume(session.id)).toBeNull();

		const reopened = access.open(TOKEN).session!;
		access.close();
		expect(access.resume(reopened.id)).toBeNull();
	});

	it('issues a high-entropy token', () => {
		const tokens = new Set(
			Array.from({ length: 64 }, () => generateSetupToken()),
		);

		expect(tokens.size).toBe(64);
		for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('keeps the session cookie off other origins and out of scripts', () => {
		const cookie = setupSessionCookie('session-value', true);

		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Strict');
		expect(cookie).toContain('Secure');
		expect(setupSessionCookie('session-value', false)).not.toContain('Secure');
		expect(
			readSetupSessionCookie('other=1; coreloom_setup=session-value; x=2'),
		).toBe('session-value');
		expect(readSetupSessionCookie('other=1')).toBeNull();
		expect(readSetupSessionCookie(null)).toBeNull();
	});
});
