import { createContext } from '@octanejs/app-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApiTokenRateLimiter } from '../src/middleware/rate-limit.ts';
import {
	closeAuthTestDatabases,
	ORIGIN,
	signUpOwner,
	testRuntime,
	type TestRuntime,
} from './helpers.ts';

const open = new Set<TestRuntime>();

afterEach(async () => {
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function workspace(defaultLimit?: number) {
	const runtime = await testRuntime();
	open.add(runtime);
	const session = await signUpOwner(runtime);
	if (defaultLimit !== undefined) {
		await runtime.moduleSettings.set(
			'',
			'auth.core',
			'apiTokenRateLimit',
			defaultLimit,
			session.accountId,
		);
	}
	const issue = async (rateLimitPerMinute?: number) =>
		(
			await runtime.authService.issueApiToken({
				tenantId: session.tenantId,
				accountId: session.accountId,
				label: 'Blog reader',
				scopes: ['users.members.read'],
				...(rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute }),
				expiresAt: null,
				createdBy: session.accountId,
			})
		).token;
	return { runtime, issue };
}

/* One read through the whole middleware chain, the way a served request
   reaches it. */
function read(runtime: TestRuntime, token: string): Promise<Response> {
	const context = createContext(
		new Request(`${ORIGIN}/api/catalog/items`, {
			headers: { authorization: `Bearer ${token}` },
		}),
		{},
	);
	return runtime.middleware(context, () =>
		Promise.resolve(Response.json({ items: [] })),
	) as Promise<Response>;
}

describe('API token rate limit', () => {
	it('tells the caller what it has left on every answer', async () => {
		const { runtime, issue } = await workspace();
		const token = await issue(3);
		const first = await read(runtime, token);
		expect(first.status).toBe(200);
		expect(first.headers.get('x-ratelimit-limit')).toBe('3');
		expect(first.headers.get('x-ratelimit-remaining')).toBe('2');
		expect(Number(first.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0);
		expect(
			(await read(runtime, token)).headers.get('x-ratelimit-remaining'),
		).toBe('1');
	});

	it('refuses the request that spends more than the token was given', async () => {
		const { runtime, issue } = await workspace();
		const token = await issue(2);
		await read(runtime, token);
		await read(runtime, token);
		const refused = await read(runtime, token);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({
			error: { code: 'TOKEN_RATE_LIMITED' },
		});
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
	});

	it('falls back to the deployment setting when the token names no rate', async () => {
		const { runtime, issue } = await workspace(1);
		const token = await issue();
		expect((await read(runtime, token)).status).toBe(200);
		expect((await read(runtime, token)).status).toBe(429);
	});

	it('leaves a token unlimited when the deployment removed the ceiling', async () => {
		const { runtime, issue } = await workspace(0);
		const token = await issue();
		const response = await read(runtime, token);
		expect(response.status).toBe(200);
		expect(response.headers.get('x-ratelimit-limit')).toBeNull();
	});

	it('refuses a rate the service cannot hold', async () => {
		const { runtime } = await workspace();
		const session = await signUpOwner(runtime, 'second@example.com', 'second');
		await expect(
			runtime.authService.issueApiToken({
				tenantId: session.tenantId,
				accountId: session.accountId,
				label: 'Too much',
				scopes: ['users.members.read'],
				rateLimitPerMinute: 100_001,
				expiresAt: null,
				createdBy: session.accountId,
			}),
		).rejects.toThrow(/between 0 and 100000/);
	});
});

describe('createApiTokenRateLimiter', () => {
	it('starts a new window once the old one passed', () => {
		const limiter = createApiTokenRateLimiter(1_000);
		expect(limiter.consume('token', 1, 0).allowed).toBe(true);
		expect(limiter.consume('token', 1, 500).allowed).toBe(false);
		expect(limiter.consume('token', 1, 1_000).allowed).toBe(true);
	});

	it('counts each credential in its own window', () => {
		const limiter = createApiTokenRateLimiter();
		expect(limiter.consume('first', 1, 0).allowed).toBe(true);
		expect(limiter.consume('second', 1, 0).allowed).toBe(true);
		expect(limiter.consume('first', 1, 0).allowed).toBe(false);
	});

	it('admits everything when no ceiling applies', () => {
		const limiter = createApiTokenRateLimiter();
		for (let index = 0; index < 1_000; index += 1) {
			expect(limiter.consume('token', 0, 0).allowed).toBe(true);
		}
		expect(limiter.consume('token', 0, 0).limit).toBe(0);
	});

	it('stays bounded when a flood of distinct credentials arrives', () => {
		const limiter = createApiTokenRateLimiter(1_000);
		for (let index = 0; index < 10_000; index += 1) {
			limiter.consume(`token-${index}`, 1, index);
		}
		/* The oldest windows were dropped, so an early credential starts fresh
		   rather than being refused from a retained count. */
		expect(limiter.consume('token-0', 1, 10_000).allowed).toBe(true);
	});
});
