import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { METERING_PERMISSIONS } from '../src/acl/permissions.ts';
import { createMeteringRoutes } from '../src/api/endpoints.ts';
import { createMeteringRuntime } from '../src/server/runtime.ts';
import type { MeteringRepository } from '../src/services/repository.ts';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import { createHarness, RUN_TOKENS_KEY } from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);

function principal(
	scopes: readonly string[],
	accountId = 'account-ada',
	tenantId = TENANT,
): AuthPrincipal {
	return {
		accountId,
		tenantId,
		email: `${accountId}@example.com`,
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

/* The real authentication middleware publishes the principal these routes read,
   so they are exercised through the same state the platform gives them rather
   than a hand-placed principal. */
function authRuntime(
	sessions: ReadonlyMap<string, AuthPrincipal>,
): AuthRuntime {
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3_600,
	};
	const service = {
		resolveSession: async (token: string | null) => {
			const found = token === null ? undefined : sessions.get(token);
			return found
				? { principal: found, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null;
		},
		resolveApiToken: async () => null,
		listTenantMembers: async () => [],
	} as unknown as Awaited<ReturnType<AuthRuntime['service']>>;
	return {
		cookie,
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		authorizeAgentToolAccess: () => [],
		middleware: createAuthenticationMiddleware(async () => service, cookie),
		service: async () => service,
	} as unknown as AuthRuntime;
}

let shared: MeteringTestDatabase;

beforeAll(async () => {
	shared = await openMeteringTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

/**
 * A repository that refuses every call, so a denial that reached it would fail
 * the case instead of passing on a status the handler produced afterwards.
 */
function unreachableRepository(): MeteringRepository {
	const refuse = () => {
		throw new Error('The denial let the request reach the repository.');
	};
	return new Proxy({} as MeteringRepository, { get: () => refuse });
}

function fixture(
	session: AuthPrincipal | null,
	repository: MeteringRepository = shared.repository,
) {
	const runtime = createMeteringRuntime({
		databases: shared.databases,
		repository,
		warningPercent: () => 80,
		now: () => SEPTEMBER,
	});
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createMeteringRoutes(auth, runtime);
	const route = (path: string) => {
		const found = routes.find((candidate) => candidate.path === path);
		if (!found) throw new Error(`Route GET ${path} is missing.`);
		return found;
	};
	const call = async (
		requestPath: string,
		options: { readonly authenticated?: boolean } = {},
	) => {
		const { authenticated = true } = options;
		const headers = new Headers();
		if (authenticated && session) {
			headers.set('cookie', `coreloom_session_dev=${SESSION_TOKEN}`);
		}
		const request = new Request(ORIGIN + requestPath, { headers });
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return route(requestPath.split('?')[0]!).handler(context as never);
	};
	return { call, runtime };
}

async function seed(): Promise<void> {
	const { service } = createHarness({
		repository: shared.repository,
		now: () => SEPTEMBER,
	});
	await service.setLimit({
		tenantId: TENANT,
		meter: RUN_TOKENS_KEY,
		monthlyLimit: 1_000,
		setBy: 'cli:operator',
	});
	await service.record({
		tenantId: TENANT,
		meter: RUN_TOKENS_KEY,
		amount: 250,
		sourceRef: 'run-1',
	});
}

describe('metering endpoints', () => {
	it('answers the meters of the workspace with this month usage and the warning share', async () => {
		await seed();
		const { call } = fixture(principal([METERING_PERMISSIONS.read]));

		const response = await call('/api/metering/meters');
		const body = (await response.json()) as {
			meters: readonly {
				meter: { key: string };
				month: string;
				used: number;
				limit: number | null;
			}[];
			warningPercent: number;
		};

		expect(response.status).toBe(200);
		expect(body.warningPercent).toBe(80);
		expect(
			body.meters.map((entry) => [
				entry.meter.key,
				entry.month,
				entry.used,
				entry.limit,
			]),
		).toEqual([[RUN_TOKENS_KEY, '2026-09', 250, 1_000]]);
	});

	it('answers the buckets of one meter over a range', async () => {
		await seed();
		const { call } = fixture(principal([METERING_PERMISSIONS.read]));

		const response = await call(
			`/api/metering/buckets?meter=${RUN_TOKENS_KEY}&from=2026-09-01&to=2026-09-30`,
		);
		const body = (await response.json()) as {
			buckets: readonly { day: string; amount: number; events: number }[];
		};

		expect(response.status).toBe(200);
		expect(
			body.buckets.map((bucket) => [bucket.day, bucket.amount, bucket.events]),
		).toEqual([['2026-09-11', 250, 1]]);
	});

	it('refuses a bucket read without a meter and one with an unusable range', async () => {
		const { call } = fixture(principal([METERING_PERMISSIONS.read]));

		expect((await call('/api/metering/buckets')).status).toBe(400);
		const reversed = await call(
			`/api/metering/buckets?meter=${RUN_TOKENS_KEY}&from=2026-09-30&to=2026-09-01`,
		);
		expect(reversed.status).toBe(400);
		const tooWide = await call(
			`/api/metering/buckets?meter=${RUN_TOKENS_KEY}&from=2020-01-01&to=2026-09-30`,
		);
		expect(tooWide.status).toBe(400);
		expect(
			((await tooWide.json()) as { error: { code: string } }).error.code,
		).toBe('INVALID_INPUT');
	});

	it('answers the limits of the workspace', async () => {
		await seed();
		const { call } = fixture(principal([METERING_PERMISSIONS.read]));

		const response = await call('/api/metering/limits');
		const body = (await response.json()) as {
			limits: readonly {
				meter: string;
				monthlyLimit: number;
				setBy: string;
			}[];
		};

		expect(response.status).toBe(200);
		expect(
			body.limits.map((limit) => [
				limit.meter,
				limit.monthlyLimit,
				limit.setBy,
			]),
		).toEqual([[RUN_TOKENS_KEY, 1_000, 'cli:operator']]);
	});

	it('publishes reads only, so no endpoint can change a limit', () => {
		const { runtime } = fixture(principal([METERING_PERMISSIONS.read]));
		const routes = createMeteringRoutes(authRuntime(new Map()), runtime);
		expect(routes.flatMap((route) => [...route.methods])).toEqual([
			'GET',
			'GET',
			'GET',
		]);
	});
});

describe('METERING-DENY', () => {
	it('denies an unauthenticated reader before the repository is reached', async () => {
		const { call } = fixture(
			principal([METERING_PERMISSIONS.read]),
			unreachableRepository(),
		);

		for (const path of [
			'/api/metering/meters',
			`/api/metering/buckets?meter=${RUN_TOKENS_KEY}`,
			'/api/metering/limits',
		]) {
			const response = await call(path, { authenticated: false });
			expect([path, response.status]).toEqual([path, 401]);
			expect([
				path,
				((await response.json()) as { error: { code: string } }).error.code,
			]).toEqual([path, 'UNAUTHENTICATED']);
		}
	});

	it('denies a member without the usage permission before the repository is reached', async () => {
		const { call } = fixture(
			principal(['catalog.items.read']),
			unreachableRepository(),
		);

		for (const path of [
			'/api/metering/meters',
			`/api/metering/buckets?meter=${RUN_TOKENS_KEY}`,
			'/api/metering/limits',
		]) {
			const response = await call(path);
			expect([path, response.status]).toEqual([path, 403]);
			expect([
				path,
				((await response.json()) as { error: { code: string } }).error.code,
			]).toEqual([path, 'FORBIDDEN']);
		}
	});
});
