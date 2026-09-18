import { createContext } from '@octanejs/app-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sessionMutationDenial } from '../src/server/session-security.ts';
import {
	call,
	closeAuthTestDatabases,
	jsonRequest,
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

async function workspace() {
	const runtime = await testRuntime();
	open.add(runtime);
	const session = await signUpOwner(runtime);
	const issue = async (
		label: string,
		extra: { allowWrites?: boolean; allowedOrigins?: readonly string[] } = {},
	) => {
		const issued = await runtime.authService.issueApiToken({
			tenantId: session.tenantId,
			accountId: session.accountId,
			label,
			scopes: ['users.members.read', 'auth.tokens.manage'],
			expiresAt: null,
			createdBy: session.accountId,
			...extra,
		});
		return issued.token;
	};
	return { runtime, session, issue };
}

/* The mutation guard every module endpoint runs first, reached the way a
   served request reaches it: through the authentication middleware. */
async function mutationDenial(
	runtime: TestRuntime,
	token: string,
	headers: Record<string, string> = {},
): Promise<Response | null> {
	const context = createContext(
		new Request(`${ORIGIN}/api/catalog/items`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, ...headers },
			body: '{}',
		}),
		{},
	);
	let denial: Response | null = null;
	const served = await runtime.middleware(context, () => {
		denial = sessionMutationDenial(context);
		return Promise.resolve(denial ?? new Response(null, { status: 204 }));
	});
	return served.status === 204 ? null : (denial ?? served);
}

describe('API token access', () => {
	it('lets a token issued with writes perform a module mutation', async () => {
		const { runtime, issue } = await workspace();
		expect(
			await mutationDenial(
				runtime,
				await issue('Writer', { allowWrites: true }),
			),
		).toBeNull();
	});

	it('refuses a mutation from a token issued without writes', async () => {
		const { runtime, issue } = await workspace();
		const denial = await mutationDenial(runtime, await issue('Reader'));
		expect(denial?.status).toBe(403);
		expect(await denial?.json()).toMatchObject({
			error: { code: 'TOKEN_MUTATION_DENIED' },
		});
	});

	it('never lets a token mint another, whatever it was issued with', async () => {
		const { runtime, issue } = await workspace();
		const token = await issue('Minter', { allowWrites: true });
		const response = await call(
			runtime,
			'/api/auth/api-tokens',
			jsonRequest(
				'/api/auth/api-tokens',
				{ label: 'Second', scopes: ['users.members.read'] },
				{ authorization: `Bearer ${token}` },
			),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'TOKEN_MUTATION_DENIED' },
		});
	});

	it('refuses a bound token presented from another origin', async () => {
		const { runtime, issue } = await workspace();
		const token = await issue('Blog', {
			allowWrites: true,
			allowedOrigins: ['https://blog.example.com'],
		});
		const denial = await mutationDenial(runtime, token, {
			origin: 'https://attacker.example.com',
		});
		expect(denial?.status).toBe(403);
		expect(await denial?.json()).toMatchObject({
			error: { code: 'TOKEN_ORIGIN_DENIED' },
		});
	});

	it('admits a bound token from the origin it names', async () => {
		const { runtime, issue } = await workspace();
		const token = await issue('Blog', {
			allowWrites: true,
			allowedOrigins: ['https://blog.example.com'],
		});
		expect(
			await mutationDenial(runtime, token, {
				origin: 'https://blog.example.com',
			}),
		).toBeNull();
	});

	it('keeps a token that names no origin out of every browser', async () => {
		const { runtime, issue } = await workspace();
		const token = await issue('Server side', { allowWrites: true });
		expect(await mutationDenial(runtime, token)).toBeNull();
		const denial = await mutationDenial(runtime, token, {
			origin: 'https://blog.example.com',
		});
		expect(await denial?.json()).toMatchObject({
			error: { code: 'TOKEN_ORIGIN_DENIED' },
		});
	});
});
