import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { AuthActor } from '@flowdular/module-auth';
import {
	createAuthRoutes,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { ACCESS_PERMISSIONS } from '../../src/acl/permissions.ts';
import { createAccessRoutes } from '../../src/api/endpoints.ts';
import {
	createAccessRuntime,
	type AccessRuntime,
} from '../../src/server/runtime.ts';
import { authDirectory } from '../../src/services/auth-directory.ts';

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
	/** Omitted on purpose by the CSRF cases. */
	readonly csrfToken?: string | undefined;
	readonly origin?: string | undefined;
}

export interface Harness {
	readonly auth: AuthRuntime;
	readonly access: AccessRuntime;
	readonly databases: DatabaseProvider;
	service(): Promise<AuthService>;
	signUp(email: string, slug: string): Promise<Workspace>;
	/** A session for a member the case created, with that member's own scopes. */
	signIn(email: string, workspaceSlug: string): Promise<Workspace>;
	/** An owner actor for the administration methods, with its live scopes. */
	owner(workspace: Workspace): Promise<AuthActor>;
	call(path: string, options?: CallOptions): Promise<Response>;
	dispose(): Promise<void>;
}

function contextOf(request: Request): unknown {
	return {
		request,
		params: {},
		url: new URL(request.url),
		state: new Map<string, unknown>(),
	};
}

/**
 * access.core in front of the authentication core the platform composes, both
 * on one embedded PostgreSQL with the real runtime role and forced row-level
 * security. Nothing about who holds what is faked: the reports read whatever
 * the auth service actually wrote.
 */
export async function openHarness(): Promise<Harness> {
	const databases = createPgliteTestProvider();
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
	const access = createAccessRuntime({
		databases,
		purpose: 'test',
		directory: authDirectory(auth),
	});
	const authRoutes = createAuthRoutes(auth);
	const accessRoutes = createAccessRoutes(auth, access);

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
		const response = await route.handler(contextOf(request) as never);
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

	/* The grant a deployment gets from `flowdular module enable`: the module's
	   own permissions reach the owners of every workspace and nobody else. */
	const grantOwnerScopes = async (): Promise<void> => {
		await (
			await auth.service()
		).grantModuleScopes(Object.values(ACCESS_PERMISSIONS));
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
		await grantOwnerScopes();
		return workspace;
	};

	const signIn = async (
		email: string,
		workspaceSlug: string,
	): Promise<Workspace> =>
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
		const route = accessRoutes.find(
			(candidate) =>
				candidate.path === path.split('?')[0] &&
				candidate.methods.includes(method),
		);
		if (!route) throw new Error(`access.core exposes no ${method} ${path}.`);
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
		const context = contextOf(request);
		await auth.middleware(context as never, async () => new Response(null));
		return route.handler(context as never);
	};

	return {
		auth,
		access,
		databases,
		service: () => auth.service(),
		signUp,
		signIn,
		owner: async (workspace) => ({
			accountId: workspace.accountId,
			tenantId: workspace.tenantId,
			email: workspace.email,
			role: 'owner',
			scopes: [
				...(await (
					await auth.service()
				).listGrantableScopes(workspace.tenantId)),
			],
		}),
		call,
		async dispose() {
			await access.dispose();
			await auth.dispose();
			await databases.dispose();
		},
	};
}
