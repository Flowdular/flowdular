import { describe, expect, it } from 'vitest';
import {
	classifySetupFailure,
	redactSetupSecrets,
	SetupProbeError,
} from './sanitize.ts';

const SECRET = 'pa55word-that-must-never-appear';
const DSN = `postgresql://runtime:${SECRET}@db.internal:5432/flowdular`;

function pgError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

describe('setup failure classification', () => {
	it('never carries the driver message, the DSN, or a password', () => {
		const failures = [
			pgError('28P01', `password authentication failed for user "runtime"`),
			pgError('ENOTFOUND', `getaddrinfo ENOTFOUND db.internal`),
			pgError('3D000', 'database "flowdular" does not exist'),
			new Error(`connect failed for ${DSN}`),
		];

		for (const failure of failures) {
			const { message } = classifySetupFailure(failure, [SECRET]);
			expect(message).not.toContain(SECRET);
			expect(message).not.toContain(DSN);
			expect(message).not.toContain('db.internal');
			expect(message).not.toContain(failure.message);
			expect(message.length).toBeGreaterThan(20);
		}
	});

	it('maps the failures an operator can act on to distinct codes', () => {
		expect(classifySetupFailure(pgError('28P01', 'x')).code).toBe(
			'AUTHENTICATION_REJECTED',
		);
		expect(classifySetupFailure(pgError('3D000', 'x')).code).toBe(
			'DATABASE_MISSING',
		);
		expect(classifySetupFailure(pgError('42501', 'x')).code).toBe(
			'PERMISSION_DENIED',
		);
		expect(classifySetupFailure(pgError('ECONNREFUSED', 'x')).code).toBe(
			'HOST_UNREACHABLE',
		);
		expect(classifySetupFailure(pgError('ETIMEDOUT', 'x')).code).toBe(
			'TIMED_OUT',
		);
		expect(
			classifySetupFailure(pgError('DEPTH_ZERO_SELF_SIGNED_CERT', 'x')).code,
		).toBe('TLS_REJECTED');
		expect(classifySetupFailure(new Error('anything at all')).code).toBe(
			'PROBE_FAILED',
		);
		expect(
			classifySetupFailure(new SetupProbeError('ROLE_TOO_PRIVILEGED')).code,
		).toBe('ROLE_TOO_PRIVILEGED');
	});

	it('says what the runtime role may not hold', () => {
		expect(
			classifySetupFailure(new SetupProbeError('ROLE_TOO_PRIVILEGED')).message,
		).toContain('BYPASSRLS');
	});

	it('removes every secret occurrence and ignores values too short to match', () => {
		expect(redactSetupSecrets(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe(
			'a [redacted] b [redacted]',
		);
		expect(redactSetupSecrets('the server is on', ['on'])).toBe(
			'the server is on',
		);
	});
});
