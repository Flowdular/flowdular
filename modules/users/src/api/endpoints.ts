import { createHash, randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	HttpProblem,
	jsonResponse,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	requiredString,
	type EndpointExecutionContext,
} from '@flowdular/server';
import type { TenantMemberSort } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	AuthServiceError,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
	TENANT_MEMBER_SEARCH_TERM_LENGTH,
	TENANT_MEMBER_SORTS,
} from '@flowdular/module-auth/server';
import { USER_PERMISSIONS } from '../acl/permissions.ts';
import {
	UsersService,
	MEMBER_BULK_LIMIT,
	type CreateUserInput,
	type MemberListInput,
	type MemberStatusFilter,
} from '../services/users-service.ts';

type Context = EndpointExecutionContext['octane'];

/** The default page of the Members screen, and the most it may ask for. */
export const MEMBER_PAGE_LIMIT = 50;
export const MEMBER_PAGE_MAX_LIMIT = 200;

/** The query parameters of one member page read, before the cursor. */
interface MemberListQuery {
	readonly sort: TenantMemberSort;
	readonly direction: 'asc' | 'desc';
	readonly query: string;
	readonly status: MemberStatusFilter;
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function cursorInvalid(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

function membershipStatus(
	value: Record<string, unknown>,
): 'active' | 'disabled' {
	const status = requiredString(value, 'status', { max: 16 });
	if (status !== 'active' && status !== 'disabled') {
		throw invalid('status must be active or disabled.');
	}
	return status;
}

function accountIds(value: Record<string, unknown>): readonly string[] {
	const raw = value.accountIds;
	if (!Array.isArray(raw)) throw invalid('accountIds must be an array.');
	if (raw.length < 1 || raw.length > MEMBER_BULK_LIMIT) {
		throw invalid(
			`accountIds must name between 1 and ${MEMBER_BULK_LIMIT} members.`,
		);
	}
	const ids = raw.map((entry) =>
		requiredString({ accountId: entry }, 'accountId', { max: 128 }),
	);
	if (new Set(ids).size !== ids.length) {
		throw invalid('accountIds must not repeat an id.');
	}
	return ids;
}

function memberListQuery(url: URL): MemberListQuery {
	const sort = url.searchParams.get('sort') ?? 'displayName';
	if (!(TENANT_MEMBER_SORTS as readonly string[]).includes(sort)) {
		throw invalid(`sort must be one of ${TENANT_MEMBER_SORTS.join(', ')}.`);
	}
	const direction = url.searchParams.get('direction') ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw invalid('direction must be asc or desc.');
	}
	const query = url.searchParams.get('q') ?? '';
	if (query.length > TENANT_MEMBER_SEARCH_TERM_LENGTH) {
		throw invalid(
			`q must contain at most ${TENANT_MEMBER_SEARCH_TERM_LENGTH} characters.`,
		);
	}
	const status = url.searchParams.get('status') ?? '';
	if (status !== '' && status !== 'active' && status !== 'disabled') {
		throw invalid('status must be active or disabled.');
	}
	return {
		sort: sort as TenantMemberSort,
		direction,
		query,
		status: status === '' ? null : status,
	};
}

/* The filters travel as a digest: a term of 200 multibyte characters beside a
   full-length address would push the signed cursor past its length bound. */
function filtersDigest(query: MemberListQuery): string {
	return createHash('sha256')
		.update(JSON.stringify([query.query, query.status ?? '']))
		.digest('hex')
		.slice(0, 32);
}

/* The cursor names the position and the listing it belongs to: the workspace,
   the sort, the direction and the filters. A cursor presented with any of them
   changed would splice two listings, so it is refused rather than reused. */
function cursorPayload(
	tenantId: string,
	query: MemberListQuery,
	keyset: { readonly sortValue: string; readonly accountId: string },
): Record<string, string> {
	return {
		t: tenantId,
		s: query.sort,
		d: query.direction,
		f: filtersDigest(query),
		v: keyset.sortValue,
		id: keyset.accountId,
	};
}

function keysetFromCursor(
	cursor: string,
	secret: Uint8Array,
	tenantId: string,
	query: MemberListQuery,
): MemberListInput['after'] {
	const payload = decodeCursor(cursor, secret);
	const expected = cursorPayload(tenantId, query, {
		sortValue: '',
		accountId: '',
	});
	for (const key of ['t', 's', 'd', 'f'] as const) {
		if (payload[key] !== expected[key]) throw cursorInvalid();
	}
	const sortValue = payload.v;
	const accountId = payload.id;
	if (typeof sortValue !== 'string' || typeof accountId !== 'string') {
		throw cursorInvalid();
	}
	return { sortValue, accountId };
}

function errorResponse(error: unknown): Response {
	return error instanceof AuthServiceError
		? jsonResponse(
				{ error: { code: error.code, message: error.message } },
				error.status,
			)
		: problemResponse(error, 'User operation failed.');
}

function scopes(value: Record<string, unknown>): readonly string[] {
	const result = value.scopes;
	if (
		!Array.isArray(result) ||
		result.length > 256 ||
		result.some((entry) => typeof entry !== 'string')
	) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'scopes must be an array of scope identifiers.',
			400,
		);
	}
	return result as readonly string[];
}

/* Passwords pass through here only as request input on the way to auth.core;
   they are never stored, logged, or echoed by users.core. */
function passwordField(value: Record<string, unknown>, key: string): string {
	const result = value[key];
	if (typeof result !== 'string') {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a string.`, 400);
	}
	return result;
}

export function createUserRoutes(auth: AuthRuntime) {
	const users = new UsersService(auth);
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own list, so a restart invalidating one costs a client the
	   first page. */
	const cursorSecret = randomBytes(32);

	const mutation = (
		id: string,
		path: string,
		handle: (
			octane: Context,
			payload: Record<string, unknown>,
		) => Promise<Response> | Response,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: USER_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					return await handle(octane, await readJsonObject(octane.request));
				} catch (error) {
					return errorResponse(error);
				}
			},
		});

	const list = defineEndpoint({
		id: 'users.members.list',
		path: '/api/users',
		methods: ['GET'],
		access: { kind: 'permission', permission: USER_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, {
					maxLimit: MEMBER_PAGE_MAX_LIMIT,
					defaultLimit: MEMBER_PAGE_LIMIT,
				});
				const query = memberListQuery(url);
				const result = await users.list(principal, {
					...query,
					limit: page.limit,
					after: page.cursor
						? keysetFromCursor(
								page.cursor,
								cursorSecret,
								principal.tenantId,
								query,
							)
						: null,
				});
				return pageResponse({
					items: result.members,
					limit: page.limit,
					nextCursor: result.next
						? encodeCursor(
								cursorPayload(principal.tenantId, query, result.next),
								cursorSecret,
							)
						: null,
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const context = defineEndpoint({
		id: 'users.members.context',
		path: '/api/users/context',
		methods: ['GET'],
		access: { kind: 'permission', permission: USER_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				return jsonResponse(await users.context(principalFromContext(octane)!));
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const create = mutation(
		'users.members.create',
		'/api/users',
		async (octane, payload) => {
			const input: CreateUserInput = {
				email: requiredString(payload, 'email', { max: 254 }),
				password: passwordField(payload, 'password'),
				displayName: requiredString(payload, 'displayName', { max: 80 }),
				role: requiredString(payload, 'role', { max: 32 }),
			};
			return jsonResponse(
				{ user: await users.create(principalFromContext(octane)!, input) },
				201,
			);
		},
	);

	const update = mutation(
		'users.members.update',
		'/api/users/update',
		async (octane, payload) =>
			jsonResponse({
				user: await users.rename(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					requiredString(payload, 'displayName', { max: 80 }),
				),
			}),
	);

	const role = mutation(
		'users.members.role',
		'/api/users/role',
		async (octane, payload) =>
			jsonResponse({
				user: await users.assignRole(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					requiredString(payload, 'role', { max: 32 }),
				),
			}),
	);

	const status = mutation(
		'users.members.status',
		'/api/users/status',
		async (octane, payload) =>
			jsonResponse({
				user: await users.setStatus(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					membershipStatus(payload),
				),
			}),
	);

	const statusMany = mutation(
		'users.members.status-many',
		'/api/users/status-many',
		async (octane, payload) =>
			jsonResponse({
				outcomes: await users.setMembershipStatusMany(
					principalFromContext(octane)!,
					accountIds(payload),
					membershipStatus(payload),
				),
			}),
	);

	const roleMany = mutation(
		'users.members.role-many',
		'/api/users/role-many',
		async (octane, payload) =>
			jsonResponse({
				outcomes: await users.assignRoleMany(
					principalFromContext(octane)!,
					accountIds(payload),
					requiredString(payload, 'role', { max: 32 }),
				),
			}),
	);

	const remove = mutation(
		'users.members.remove',
		'/api/users/remove',
		async (octane, payload) => {
			await users.remove(
				principalFromContext(octane)!,
				requiredString(payload, 'accountId', { max: 128 }),
			);
			return jsonResponse({ removed: true });
		},
	);

	const resetPassword = mutation(
		'users.members.password-reset',
		'/api/users/password-reset',
		async (octane, payload) =>
			jsonResponse({
				user: await users.resetPassword(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					passwordField(payload, 'temporaryPassword'),
				),
			}),
	);

	const setScopes = mutation(
		'users.members.scopes',
		'/api/users/scopes',
		async (octane, payload) =>
			jsonResponse({
				user: await users.setScopes(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					scopes(payload),
				),
			}),
	);

	return [
		list.serverRoute,
		context.serverRoute,
		create.serverRoute,
		update.serverRoute,
		role.serverRoute,
		status.serverRoute,
		statusMany.serverRoute,
		roleMany.serverRoute,
		remove.serverRoute,
		resetPassword.serverRoute,
		setScopes.serverRoute,
	] as const;
}

export const endpoints = [
	'users.members.list',
	'users.members.context',
	'users.members.create',
	'users.members.update',
	'users.members.role',
	'users.members.status',
	'users.members.status-many',
	'users.members.role-many',
	'users.members.remove',
	'users.members.password-reset',
	'users.members.scopes',
] as const;
