import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentRunGrantAuthority } from '../src/services/run-grant.ts';

describe('run grants issued before the Flowdular rename', () => {
	it('accepts a correctly signed legacy issuer and still rejects tampering and expiry', () => {
		const key = Buffer.alloc(32, 17);
		let now = 1_000;
		const authority = new AgentRunGrantAuthority(key, 30_000, () => now);
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
		expect(issued.claims.issuer).toBe('flowdular-control-plane');
		const payload = Buffer.from(
			JSON.stringify({ ...issued.claims, issuer: 'coreloom-control-plane' }),
		).toString('base64url');
		const signed = `v1.${payload}`;
		const legacy = `${signed}.${createHmac('sha256', key).update(signed).digest('base64url')}`;
		expect(authority.verify(legacy)).toMatchObject({
			tenantId: 'tenant',
			runId: 'run',
		});
		expect(() => authority.verify(`${legacy.slice(0, -4)}xxxx`)).toThrow();
		now = 31_001;
		expect(() => authority.verify(legacy)).toThrow();
	});
});
