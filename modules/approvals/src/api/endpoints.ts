import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
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
import { APPROVAL_STATUSES, type ApprovalStatus } from '../domain/types.ts';
import type { ApprovalsRuntime } from '../server/runtime.ts';
import { ApprovalsServiceError } from '../services/service-error.ts';

/** Which requests a list answers with; `all` needs the manage permission. */
const LIST_SCOPES = ['mine', 'decidable', 'all'] as const;
type ListScope = (typeof LIST_SCOPES)[number];

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

function optionalComment(value: Record<string, unknown>): string | null {
	const comment = value.comment;
	if (comment === undefined || comment === null || comment === '') return null;
	return requiredString(value, 'comment', { max: APPROVAL_LIMITS.comment });
}

export function createApprovalsRoutes(
	auth: AuthRuntime,
	runtime: ApprovalsRuntime,
) {
	const grantsOf = (scopes: readonly string[]) => ({
		decide: scopes.includes(APPROVALS_PERMISSIONS.decide),
		manage: scopes.includes(APPROVALS_PERMISSIONS.manage),
	});

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
				const service = await runtime.service();
				return jsonResponse({
					requests: await service.list(principal.tenantId, {
						status: queryOneOf<ApprovalStatus>(
							octane.request,
							'status',
							APPROVAL_STATUSES,
						),
						...(scope === 'mine'
							? { requesterAccountId: principal.accountId }
							: {}),
						...(scope === 'decidable'
							? { decidableBy: principal.accountId }
							: {}),
					}),
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
		cancel.serverRoute,
		getRequest.serverRoute,
	] as const;
}

export const endpoints = [
	'approvals.requests.list',
	'approvals.requests.pending-count',
	'approvals.requests.approve',
	'approvals.requests.reject',
	'approvals.requests.cancel',
	'approvals.requests.get',
] as const;
