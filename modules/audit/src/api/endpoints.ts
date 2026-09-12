import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	optionalString,
	readJsonObject,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { AUDIT_PERMISSIONS } from '../acl/permissions.ts';
import { DATA_CLASS_LIMITS } from '../domain/data-classes.ts';
import {
	EXPORT_STATUSES,
	HOLD_SCOPE_KINDS,
	HOLD_STATUSES,
	RETENTION_MODES,
	SWEEP_STATUSES,
	type ExportStatus,
	type HoldScopeKind,
	type HoldStatus,
	type RetentionMode,
	type SweepStatus,
} from '../domain/types.ts';
import { HOLD_LIMITS } from '../services/hold-service.ts';
import type { AuditRuntime } from '../server/runtime.ts';
import { AuditServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof AuditServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The audit operation failed.');
}

function bodyOneOf<T extends string>(
	value: Record<string, unknown>,
	key: string,
	values: readonly T[],
): T {
	const text = requiredString(value, key, { max: 32 });
	if (!(values as readonly string[]).includes(text)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be one of: ${values.join(', ')}.`,
			400,
		);
	}
	return text as T;
}

/** Absent stays absent; a present value must be a whole number. */
function optionalInteger(
	value: Record<string, unknown>,
	key: string,
): number | null {
	const result = value[key];
	if (result === undefined || result === null) return null;
	if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be a whole number.`,
			400,
		);
	}
	return result;
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

export function createAuditRoutes(auth: AuthRuntime, runtime: AuditRuntime) {
	const listRegistry = defineEndpoint({
		id: 'audit.registry.list',
		path: '/api/audit/data-classes',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUDIT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const tenantId = principalFromContext(octane)!.tenantId;
				const retention = await runtime.retention();
				return jsonResponse({
					modules: await retention.listRegistry(tenantId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const setRetention = defineEndpoint({
		id: 'audit.retention.set',
		path: '/api/audit/data-classes/set-retention',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUDIT_PERMISSIONS.retentionManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const retention = await runtime.retention();
				return jsonResponse({
					dataClass: await retention.setRetention(
						principal.tenantId,
						principal.accountId,
						{
							classId: requiredString(value, 'classId', {
								max: DATA_CLASS_LIMITS.classId,
							}),
							mode: bodyOneOf<RetentionMode>(value, 'mode', RETENTION_MODES),
							days: optionalInteger(value, 'days'),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listSweeps = defineEndpoint({
		id: 'audit.sweeps.list',
		path: '/api/audit/sweeps',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUDIT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const retention = await runtime.retention();
				return jsonResponse({
					sweeps: await retention.listSweepRuns(
						principalFromContext(octane)!.tenantId,
						queryOneOf<SweepStatus>(octane.request, 'status', SWEEP_STATUSES),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listExports = defineEndpoint({
		id: 'audit.exports.list',
		path: '/api/audit/exports',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUDIT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const retention = await runtime.retention();
				return jsonResponse({
					exports: await retention.listExportRuns(
						principalFromContext(octane)!.tenantId,
						queryOneOf<ExportStatus>(octane.request, 'status', EXPORT_STATUSES),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* A hold names the account it covers and the reason it was placed, which is
	   the matter behind it. Reading the registry does not entitle a principal to
	   that, so the list is gated on the same permission as placing one. */
	const listHolds = defineEndpoint({
		id: 'audit.holds.list',
		path: '/api/audit/holds',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: AUDIT_PERMISSIONS.holdsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const holds = await runtime.holds();
				return jsonResponse({
					holds: await holds.list(
						principalFromContext(octane)!.tenantId,
						queryOneOf<HoldStatus>(octane.request, 'status', HOLD_STATUSES),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const placeHold = defineEndpoint({
		id: 'audit.holds.place',
		path: '/api/audit/holds/place',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUDIT_PERMISSIONS.holdsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const holds = await runtime.holds();
				return jsonResponse({
					hold: await holds.place(principal.tenantId, principal.accountId, {
						scopeKind: bodyOneOf<HoldScopeKind>(
							value,
							'scopeKind',
							HOLD_SCOPE_KINDS,
						),
						accountId: optionalString(
							value,
							'accountId',
							HOLD_LIMITS.accountId,
						),
						classId: optionalString(
							value,
							'classId',
							DATA_CLASS_LIMITS.classId,
						),
						fromAt: optionalInteger(value, 'fromAt'),
						toAt: optionalInteger(value, 'toAt'),
						reason: requiredString(value, 'reason', {
							max: HOLD_LIMITS.reason,
						}),
					}),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const liftHold = defineEndpoint({
		id: 'audit.holds.lift',
		path: '/api/audit/holds/lift',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUDIT_PERMISSIONS.holdsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const holds = await runtime.holds();
				return jsonResponse({
					hold: await holds.lift(principal.tenantId, principal.accountId, {
						id: requiredString(value, 'id', { max: 64 }),
						reason: requiredString(value, 'reason', {
							max: HOLD_LIMITS.reason,
						}),
					}),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		listRegistry.serverRoute,
		setRetention.serverRoute,
		listSweeps.serverRoute,
		listExports.serverRoute,
		listHolds.serverRoute,
		placeHold.serverRoute,
		liftHold.serverRoute,
	] as const;
}

export const endpoints = [
	'audit.registry.list',
	'audit.retention.set',
	'audit.sweeps.list',
	'audit.exports.list',
	'audit.holds.list',
	'audit.holds.place',
	'audit.holds.lift',
] as const;
