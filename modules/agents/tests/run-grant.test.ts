import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentRunGrantAuthority } from '../src/services/run-grant.ts';

describe('run grant issuer boundary', () => {
	it('refuses a correctly signed grant from another issuer', () => {
		const key = Buffer.alloc(32, 17);
		const authority = new AgentRunGrantAuthority(key, 30_000, () => 1_000);
		const issued = authority.issue({
			tenantId: 'tenant',
			runId: 'run',
			providerId: 'provider',
			modelId: 'model',
			workerId: 'worker',
			attempt: 1,
			permissions: ['agents.execute'],
			toolGrants: [],
			leaseExpiresAt: 31_000,
		});
		expect(authority.verify(issued.token)).toMatchObject({
			tenantId: 'tenant',
			runId: 'run',
		});
		const payload = Buffer.from(
			JSON.stringify({ ...issued.claims, issuer: 'other-control-plane' }),
		).toString('base64url');
		const signed = `v1.${payload}`;
		const foreign = `${signed}.${createHmac('sha256', key).update(signed).digest('base64url')}`;
		expect(() => authority.verify(foreign)).toThrow(
			expect.objectContaining({ code: 'RUN_GRANT_BOUNDARY_INVALID' }),
		);
	});
});
