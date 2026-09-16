import type { DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	createAuthRoutes,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { ADAPTERS_PERMISSIONS } from '../../src/acl/permissions.ts';
import { createAdaptersRoutes } from '../../src/api/endpoints.ts';
import {
	createAdaptersRuntime,
	type AdaptersRuntime,
} from '../../src/server/runtime.ts';
import {
	createFakeCalls,
	createFakeList,
	createFakeWriter,
	LIST_PERMISSION,
	PORT_PERMISSION,
	type FakeCalls,
	type FakeWriter,
} from './fakes.ts';
import { sinkRegistration, sourceRegistration } from './service.ts';

export const ORIGIN = 'https://erp.example';
export const PASSWORD = 'correct horse battery staple';

export interface Workspace {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
}

export interface CallOptions {
	readonly method?: 'GET' | 'POST';
	readonly session?: Workspace | undefined;
	readonly body?: unknown;
	readonly csrfToken?: string | undefined;
}

export interface HttpHarness {
	readonly auth: AuthRuntime;
	readonly adapters: AdaptersRuntime;
	readonly writer: FakeWriter;
	readonly calls: FakeCalls;
	signUp(email: string, slug: string): Promise<Workspace>;
	member(
		owner: Workspace,
		slug: string,
		email: string,
		scopes: readonly string[],
	): Promise<Workspace>;
	call(path: string, options?: CallOptions): Promise<Response>;
	dispose(): Promise<void>;
}

function contextOf(request: Request, params: Record<string, string>): unknown {
	return {
		request,
		params,
		url: new URL(request.url),
		state: new Map<string, unknown>(),
	};
}

function match(pattern: string, path: string): Record<string, string> | null {
	const expected = pattern.split('/');
	const actual = path.split('/');
	if (expected.length !== actual.length) return null;
	const params: Record<string, string> = {};
	for (let index = 0; index < expected.length; index += 1) {
		const segment = expected[index]!;
		if (segment.startsWith(':')) {
			params[segment.slice(1)] = decodeURIComponent(actual[index]!);
		} else if (segment !== actual[index]) {
			return null;
		}
	}
	return params;
}

/**
 * adapters.core in front of the authentication core the platform composes,
 * both on one test database with the real roles and forced row-level
 * security, and fakes of the capabilities an adapter run consumes.
 */
export async function openHttpHarness(): Promise<HttpHarness> {
	const databases: DatabaseProvider = createTestDatabaseProvider();
	const auth = createAuthRuntime({
		databases,
		purpose: 'test',
		secureCookies: false,
		cookieName: 'coreloom_session_dev',
		sessionTtlMs: 3_600_000,
		sessionIdleMs: 3_600_000,
		passwordMinLength: 12,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	const writer = createFakeWriter();
	const calls = createFakeCalls();
	const list = createFakeList();
	const adapters = createAdaptersRuntime({
		databases,
		purpose: 'test',
		calls: () => calls.calls,
		writer: () => writer.writer,
		lists: () => list.lists,
		meters: () => undefined,
		principal: async (tenantId, accountId) => {
			const member = await (
				await auth.service()
			).findTenantMember(tenantId, accountId);
			return member
				? {
						accountId,
						tenantId,
						email: member.email,
						displayName: member.displayName,
						role: member.role,
						scopes: member.scopes,
						tenants: [],
					}
				: null;
		},
		timeZone: async () => 'UTC',
		recordedAllowed: true,
		pollIntervalMs: 60_000,
	});
	adapters.catalogue.sources.register('vendors.core', [sourceRegistration()]);
	adapters.catalogue.sinks.register('vendors.core', [sinkRegistration()]);
	adapters.catalogue.seal();
	const authRoutes = createAuthRoutes(auth);
	const routes = createAdaptersRoutes(auth, adapters);

	const authCall = async (
		path: string,
		body: unknown,
		email: string,
	): Promise<Workspace> => {
		const route = authRoutes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes('POST'),
		);
		if (!route) throw new Error(`auth.core exposes no POST ${path}.`);
		const request = new Request(ORIGIN + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify(body),
		});
		const response = await route.handler(contextOf(request, {}) as never);
		if (response.status >= 400) {
			throw new Error(`${path} answered ${response.status}.`);
		}
		const answer = (await response.json()) as {
			csrfToken: string;
			principal: { accountId: string; tenantId: string };
		};
		return {
			cookie: response.headers.get('set-cookie')!.split(';')[0]!,
			csrfToken: answer.csrfToken,
			accountId: answer.principal.accountId,
			tenantId: answer.principal.tenantId,
			email,
		};
	};

	const signIn = (email: string, workspace: string) =>
		authCall(
			'/api/auth/sign-in',
			{ email, password: PASSWORD, workspace },
			email,
		);

	return {
		auth,
		adapters,
		writer,
		calls,
		async signUp(email, slug) {
			const workspace = await authCall(
				'/api/auth/sign-up',
				{
					email,
					password: PASSWORD,
					displayName: 'Owner Person',
					organizationName: slug,
					organizationSlug: slug,
				},
				email,
			);
			await (
				await auth.service()
			).grantModuleScopes([
				...Object.values(ADAPTERS_PERMISSIONS),
				PORT_PERMISSION,
				LIST_PERMISSION,
			]);
			return signIn(email, slug);
		},
		async member(owner, slug, email, scopes) {
			const service = await auth.service();
			const actor = {
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: owner.email,
				role: 'owner',
				scopes: [...(await service.listGrantableScopes(owner.tenantId))],
			};
			const created = await service.createTenantMember(
				{
					tenantId: owner.tenantId,
					email,
					password: PASSWORD,
					displayName: 'Member Person',
					role: 'member',
				},
				actor as never,
			);
			await service.setMembershipScopes(
				actor as never,
				created.accountId,
				scopes,
			);
			return signIn(email, slug);
		},
		async call(path, options = {}) {
			const method = options.method ?? 'GET';
			const bare = path.split('?')[0]!;
			const candidates = routes
				.filter((route) => route.methods.includes(method))
				.sort(
					(left, right) =>
						Number(left.path.includes(':')) - Number(right.path.includes(':')),
				);
			let params: Record<string, string> | null = null;
			const route = candidates.find((candidate) => {
				params = match(candidate.path, bare);
				return params !== null;
			});
			if (!route || params === null) {
				throw new Error(`adapters.core exposes no ${method} ${path}.`);
			}
			const headers = new Headers();
			if (options.session) headers.set('cookie', options.session.cookie);
			if (options.csrfToken) headers.set('x-csrf-token', options.csrfToken);
			if (method === 'POST') headers.set('origin', ORIGIN);
			if (options.body !== undefined) {
				headers.set('content-type', 'application/json');
			}
			const request = new Request(ORIGIN + path, {
				method,
				headers,
				...(options.body === undefined
					? {}
					: { body: JSON.stringify(options.body) }),
			});
			const context = contextOf(request, params);
			await auth.middleware(context as never, async () => new Response(null));
			return route.handler(context as never);
		},
		async dispose() {
			await adapters.dispose();
			await auth.dispose();
			await databases.dispose();
		},
	};
}
