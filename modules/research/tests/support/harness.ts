import type { DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	createAuthRoutes,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { RESEARCH_PERMISSIONS } from '../../src/acl/permissions.ts';
import { createResearchRoutes } from '../../src/api/endpoints.ts';
import type { ResearchSettings } from '../../src/domain/types.ts';
import {
	createResearchRuntime,
	type ResearchRuntime,
	type ResearchRuntimeOptions,
} from '../../src/server/runtime.ts';

export const ORIGIN = 'https://erp.example';
export const PASSWORD = 'correct horse battery staple';
const COOKIE_NAME = 'coreloom_session_dev';

type AuthService = Awaited<ReturnType<AuthRuntime['service']>>;

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
	readonly origin?: string | undefined;
}

export interface Harness {
	readonly auth: AuthRuntime;
	readonly research: ResearchRuntime;
	readonly databases: DatabaseProvider;
	service(): Promise<AuthService>;
	signUp(email: string, slug: string): Promise<Workspace>;
	signIn(email: string, workspaceSlug: string): Promise<Workspace>;
	/** A member of the workspace holding exactly the scopes named. */
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

/* A route path with `:name` segments against a concrete path. */
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
 * research.core in front of the authentication core the platform composes,
 * both on one embedded PostgreSQL with the real runtime role and forced
 * row-level security.
 */
export async function openHarness(
	settings: () => ResearchSettings,
	runtime: Partial<Omit<ResearchRuntimeOptions, 'databases' | 'purpose'>> = {},
): Promise<Harness> {
	const databases = createTestDatabaseProvider();
	const auth = createAuthRuntime({
		databases,
		purpose: 'test',
		secureCookies: false,
		cookieName: COOKIE_NAME,
		sessionTtlMs: 3_600_000,
		sessionIdleMs: 3_600_000,
		passwordMinLength: 12,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	const research = createResearchRuntime({
		databases,
		purpose: 'test',
		workspaceRoot: process.cwd(),
		settings: async () => settings(),
		...runtime,
	});
	const authRoutes = createAuthRoutes(auth);
	const researchRoutes = createResearchRoutes(auth, research);

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

	const signUp = async (email: string, slug: string): Promise<Workspace> => {
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
		).grantModuleScopes(Object.values(RESEARCH_PERMISSIONS));
		return workspace;
	};

	const signIn = (email: string, workspaceSlug: string) =>
		authCall(
			'/api/auth/sign-in',
			{ email, password: PASSWORD, workspace: workspaceSlug },
			email,
		);

	const call = async (
		path: string,
		options: CallOptions = {},
	): Promise<Response> => {
		const method = options.method ?? 'GET';
		const bare = path.split('?')[0]!;
		/* Static paths first, as the router orders them. */
		const candidates = researchRoutes
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
			throw new Error(`research.core exposes no ${method} ${path}.`);
		}
		const headers = new Headers();
		if (options.session) headers.set('cookie', options.session.cookie);
		if (options.csrfToken) headers.set('x-csrf-token', options.csrfToken);
		if (options.origin !== undefined) headers.set('origin', options.origin);
		else if (method === 'POST') headers.set('origin', ORIGIN);
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
	};

	return {
		auth,
		research,
		databases,
		service: () => auth.service(),
		signUp,
		signIn,
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
		call,
		async dispose() {
			await research.dispose();
			await auth.dispose();
			await databases.dispose();
		},
	};
}
