import { randomBytes } from 'node:crypto';
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
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { APPROVALS_PERMISSIONS } from '../acl/permissions.ts';
import { APPROVAL_LIMITS } from '../domain/capability.ts';
import {
	APPROVAL_LIST_DIRECTIONS,
	APPROVAL_LIST_SORTS,
	APPROVAL_STATUSES,
	type ApprovalListDirection,
	type ApprovalListSort,
	type ApprovalStatus,
} from '../domain/types.ts';
import type { ApprovalsRuntime } from '../server/runtime.ts';
import { ApprovalsServiceError } from '../services/service-error.ts';

/** Which requests a list answers with; `all` needs the manage permission. */
const LIST_SCOPES = ['mine', 'decidable', 'all'] as const;
type ListScope = (typeof LIST_SCOPES)[number];

/** The default page of the inbox; `APPROVAL_LIMITS.listLimit` is the ceiling. */
const LIST_PAGE_LIMIT = 50;

/** What a list cursor is bound to besides the keyset of its last row. */
interface ListBinding {
	readonly tenantId: string;
	readonly accountId: string;
	readonly scope: ListScope;
	readonly status: ApprovalStatus | '';
	readonly sort: ApprovalListSort;
	readonly direction: ApprovalListDirection;
}

function failure(error: unknown): Response {
	if (error instanceof ApprovalsServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The approvals operation failed.');
}

/* A query filter is optional; an unknown value is a rejection rather than a
   silently ignored parameter. */
function queryOneOf<T extends string>(
	request: Request,
	key: string,
	values: readonly T[],
): T | undefined {
	const raw = new URL(request.url).searchParams.get(key);
	if (raw === null || raw === '') return undefined;
	if (!(values as readonly string[]).includes(raw)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be one of: ${values.join(', ')}.`,
			400,
		);
	}
	return raw as T;
}

const BULK_DECISIONS = ['approve', 'reject'] as const;

/* One outcome answers one id, so an id is named once; the count and each id
   are bounded like the single decision's. */
function requiredIds(
	value: Record<string, unknown>,
	key: string,
): readonly string[] {
	const raw = value[key];
	if (!Array.isArray(raw)) {
		throw new HttpProblem('INVALID_INPUT', `${key} must be an array.`, 400);
	}
	if (raw.length < 1 || raw.length > APPROVAL_LIMITS.decideMany) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must name between 1 and ${APPROVAL_LIMITS.decideMany} requests.`,
			400,
		);
	}
	const ids = raw.map((entry) =>
		requiredString({ id: entry }, 'id', { max: 128 }),
	);
	if (new Set(ids).size !== ids.length) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must not repeat an id.`,
			400,
		);
	}
	return ids;
}

function optionalComment(value: Record<string, unknown>): string | null {
	const comment = value.comment;
	if (comment === undefined || comment === null || comment === '') return null;
	return requiredString(value, 'comment', { max: APPROVAL_LIMITS.comment });
}

function cursorInvalid(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

/* A cursor names a position in one member's view of one workspace under one
   order. Used with any other request it would answer a page of a different
   list, so it is refused rather than reinterpreted. */
function cursorKeyset(
	cursor: Record<string, string | number>,
	binding: ListBinding,
): { readonly createdAt: number; readonly id: string } {
	for (const [key, value] of Object.entries(binding)) {
		if (cursor[key] !== value) throw cursorInvalid();
	}
	if (typeof cursor.createdAt !== 'number' || typeof cursor.id !== 'string') {
		throw cursorInvalid();
	}
	return { createdAt: cursor.createdAt, id: cursor.id };
}

export function createApprovalsRoutes(
	auth: AuthRuntime,
	runtime: ApprovalsRuntime,
) {
	const grantsOf = (scopes: readonly string[]) => ({
		decide: scopes.includes(APPROVALS_PERMISSIONS.decide),
		manage: scopes.includes(APPROVALS_PERMISSIONS.manage),
	});
	/* Module-owned and never stored: a restart invalidating every cursor costs
	   a client the first page again. */
	const cursorSecret = randomBytes(32);

	const listRequests = defineEndpoint({
		id: 'approvals.requests.list',
		path: '/api/approvals/requests',
		methods: ['GET'],
		access: { kind: 'permission', permission: APPROVALS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const scope =
					queryOneOf<ListScope>(octane.request, 'scope', LIST_SCOPES) ??
					'decidable';
				/* The read permission covers the member's own two views. Every
				   request of the workspace is the manage permission's answer. */
				if (
					scope === 'all' &&
					!principal.scopes.includes(APPROVALS_PERMISSIONS.manage)
				) {
					throw new ApprovalsServiceError(
						'FORBIDDEN',
						'Reading every request of this workspace needs the manage permission.',
						403,
					);
				}
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, {
					maxLimit: APPROVAL_LIMITS.listLimit,
					defaultLimit: LIST_PAGE_LIMIT,
				});
				const binding: ListBinding = {
					tenantId: principal.tenantId,
					accountId: principal.accountId,
					scope,
					status:
						queryOneOf<ApprovalStatus>(
							octane.request,
							'status',
							APPROVAL_STATUSES,
						) ?? '',
					sort:
						queryOneOf<ApprovalListSort>(
							octane.request,
							'sort',
							APPROVAL_LIST_SORTS,
						) ?? 'createdAt',
					direction:
						queryOneOf<ApprovalListDirection>(
							octane.request,
							'direction',
							APPROVAL_LIST_DIRECTIONS,
						) ?? 'desc',
				};
				const after =
					page.cursor === null
						? null
						: cursorKeyset(decodeCursor(page.cursor, cursorSecret), binding);
				const service = await runtime.service();
				const items = await service.listPage(
					principal.tenantId,
					{
						...(binding.status === '' ? {} : { status: binding.status }),
						...(scope === 'mine'
							? { requesterAccountId: principal.accountId }
							: {}),
						...(scope === 'decidable'
							? { decidableBy: principal.accountId }
							: {}),
					},
					{
						limit: page.limit,
						sort: binding.sort,
						direction: binding.direction,
						after,
					},
				);
				const last = items.at(-1);
				return pageResponse({
					items,
					limit: page.limit,
					/* A full page may still be the last one; the client stops when
					   the cursor stops, at the cost of one empty page. */
					nextCursor:
						last && items.length === page.limit
							? encodeCursor(
									{ ...binding, createdAt: last.createdAt, id: last.id },
									cursorSecret,
								)
							: null,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const pendingCount = defineEndpoint({
		id: 'approvals.requests.pending-count',
		path: '/api/approvals/pending-count',
		methods: ['GET'],
		access: { kind: 'permission', permission: APPROVALS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					pending: await service.countDecidable(
						principal.tenantId,
						principal.accountId,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const getRequest = defineEndpoint({
		id: 'approvals.requests.get',
		path: '/api/approvals/requests/:id',
		methods: ['GET'],
		access: { kind: 'permission', permission: APPROVALS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				const detail = await service.detail(
					principal.tenantId,
					octane.params.id ?? '',
				);
				if (!detail) {
					throw new ApprovalsServiceError(
						'APPROVAL_NOT_FOUND',
						'The approval request was not found.',
						404,
					);
				}
				/* A member who neither asked nor may decide learns nothing about a
				   request, not even that it exists; manage widens that to the whole
				   workspace. */
				const readable = await service.canRead(
					detail.request,
					principal.accountId,
					principal.scopes.includes(APPROVALS_PERMISSIONS.manage),
				);
				if (!readable) {
					throw new ApprovalsServiceError(
						'APPROVAL_NOT_FOUND',
						'The approval request was not found.',
						404,
					);
				}
				return jsonResponse({
					...detail,
					viewer: await service.viewerRights(
						detail.request,
						principal.accountId,
						grantsOf(principal.scopes),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const decision = (id: string, path: string, kind: 'approve' | 'reject') =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: APPROVALS_PERMISSIONS.decide },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					const principal = principalFromContext(octane)!;
					const service = await runtime.service();
					const detail = await service.decide(
						principal.tenantId,
						requiredString(value, 'id', { max: 128 }),
						principal.accountId,
						kind,
						optionalComment(value),
						{ manage: principal.scopes.includes(APPROVALS_PERMISSIONS.manage) },
					);
					return jsonResponse({
						...detail,
						viewer: await service.viewerRights(
							detail.request,
							principal.accountId,
							grantsOf(principal.scopes),
						),
					});
				} catch (error) {
					return failure(error);
				}
			},
		});

	const approve = decision(
		'approvals.requests.approve',
		'/api/approvals/requests/approve',
		'approve',
	);
	const reject = decision(
		'approvals.requests.reject',
		'/api/approvals/requests/reject',
		'reject',
	);

	const decideMany = defineEndpoint({
		id: 'approvals.requests.decide-many',
		path: '/api/approvals/decide-many',
		methods: ['POST'],
		access: { kind: 'permission', permission: APPROVALS_PERMISSIONS.decide },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const decision = requiredString(value, 'decision', { max: 16 });
				if (!(BULK_DECISIONS as readonly string[]).includes(decision)) {
					throw new HttpProblem(
						'INVALID_INPUT',
						`decision must be one of: ${BULK_DECISIONS.join(', ')}.`,
						400,
					);
				}
				const service = await runtime.service();
				const outcomes = await service.decideMany(
					principal.tenantId,
					requiredIds(value, 'ids'),
					principal.accountId,
					decision as (typeof BULK_DECISIONS)[number],
					optionalComment(value),
					{ manage: principal.scopes.includes(APPROVALS_PERMISSIONS.manage) },
				);
				return jsonResponse({ outcomes });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const cancel = defineEndpoint({
		id: 'approvals.requests.cancel',
		path: '/api/approvals/requests/cancel',
		/* The requester cancels their own request, so the endpoint sits on the
		   read permission and the service decides between requester and manage. */
		methods: ['POST'],
		access: { kind: 'permission', permission: APPROVALS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				const detail = await service.cancel(
					principal.tenantId,
					requiredString(value, 'id', { max: 128 }),
					principal.accountId,
					{ manage: principal.scopes.includes(APPROVALS_PERMISSIONS.manage) },
				);
				return jsonResponse({
					...detail,
					viewer: await service.viewerRights(
						detail.request,
						principal.accountId,
						grantsOf(principal.scopes),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		listRequests.serverRoute,
		pendingCount.serverRoute,
		approve.serverRoute,
		reject.serverRoute,
		decideMany.serverRoute,
		cancel.serverRoute,
		getRequest.serverRoute,
	] as const;
}

export const endpoints = [
	'approvals.requests.list',
	'approvals.requests.pending-count',
	'approvals.requests.approve',
	'approvals.requests.reject',
	'approvals.requests.decide-many',
	'approvals.requests.cancel',
	'approvals.requests.get',
] as const;
