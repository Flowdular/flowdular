import { describe, expect, it } from 'vitest';
import { AuthServiceError } from '@flowdular/module-auth/server';
import { translateAuthError } from '../src/services/directory-service.ts';
import { DirectoryServiceError } from '../src/services/service-error.ts';
import translations from '../translations/en.json';

function reported(
	code: string,
	message: string,
	status: number,
): DirectoryServiceError {
	const translated = translateAuthError(
		new AuthServiceError(code, message, status),
	);
	expect(translated).toBeInstanceOf(DirectoryServiceError);
	return translated as DirectoryServiceError;
}

describe('auth.core refusals reaching a directory screen', () => {
	it('reports the refusals this module names, each with its own code', () => {
		expect(reported('LAST_OWNER', 'refused', 409).code).toBe('LAST_OWNER');
		expect(reported('ROLE_NOT_FOUND', 'refused', 404).code).toBe(
			'ROLE_UNKNOWN',
		);
		const missing = reported('ACCOUNT_NOT_FOUND', 'refused', 404);
		expect(missing.code).toBe('MEMBER_NOT_FOUND');
		expect(missing.status).toBe(404);
	});

	/* A code auth.core adds later would otherwise travel to a screen as a stable
	   code this module never declared and no locale can translate. */
	it('answers a code it does not name with its own bounded refusal', () => {
		const refused = reported('MFA_CHALLENGE_INVALID', 'not for a reader', 400);
		expect(refused.code).toBe('DIRECTORY_REFUSED');
		expect(refused.status).toBe(400);
		expect(refused.message).not.toContain('not for a reader');
	});

	/* A fault is not a decision: answering one as a refusal would tell the
	   reader their change was rejected when nothing rejected it. */
	it('leaves a fault of auth.core a fault', () => {
		const fault = new AuthServiceError('MAIL_DELIVERY_FAILED', 'down', 503);
		expect(translateAuthError(fault)).toBe(fault);
	});

	it('translates every code it can answer with', () => {
		for (const code of [
			'LAST_OWNER',
			'ROLE_UNKNOWN',
			'MEMBER_NOT_FOUND',
			'DIRECTORY_REFUSED',
		]) {
			expect([code, 'error.code.' + code in translations]).toEqual([
				code,
				true,
			]);
		}
	});
});
