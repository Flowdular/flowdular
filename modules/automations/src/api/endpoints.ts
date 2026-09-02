import {
	defineEndpoint,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@coreloom/server';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@coreloom/module-auth/server';
import { userActor } from '@coreloom/kernel';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import type { CreateAutomationScheduleInput } from '../domain/types.ts';
import { scheduleVariablesForScopes } from '../domain/variables.ts';
import type { AutomationsRuntime } from '../server/runtime.ts';
import { AutomationsServiceError } from '../services/automations-service.ts';
import {
	MAX_TRIGGER_BODY_BYTES,
	TRIGGER_SIGNATURE_HEADER,
	TRIGGER_TIMESTAMP_HEADER,
	TriggerRejectedError,
} from '../services/trigger-service.ts';

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
	if (typeof value[key] !== 'boolean') {
		throw new AutomationsServiceError(
			'INVALID_INPUT',
			`${key} must be a boolean.`,
		);
	}
	return value[key];
}

function failure(error: unknown): Response {
	if (error instanceof AutomationsServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The automations operation failed.');
}

function scheduleInput(
	value: Record<string, unknown>,
): CreateAutomationScheduleInput {
	const targetKind =
		typeof value.targetKind === 'string'
			? requiredString(value, 'targetKind', { min: 2, max: 64 })
			: undefined;
	const targetKey =
		typeof value.targetKey === 'string'
			? requiredString(value, 'targetKey', { max: 128 })
			: undefined;
	const agentId =
		typeof value.agentId === 'string'
			? requiredString(value, 'agentId', { max: 128 })
			: undefined;
	return {
		...(targetKind ? { targetKind } : {}),
		...(targetKey ? { targetKey } : {}),
		...(agentId ? { agentId } : {}),
		label: requiredString(value, 'label', { min: 2, max: 120 }),
		inputTemplate: requiredString(value, 'inputTemplate', {
			min: 1,
			max: 10_000,
		}),
		cadence: requiredString(value, 'cadence', { min: 7, max: 32 }),
		enabled: requiredBoolean(value, 'enabled'),
	};
}

function targetInput(value: Record<string, unknown>) {
	const targetKind =
		typeof value.targetKind === 'string'
			? requiredString(value, 'targetKind', { min: 2, max: 64 })
			: undefined;
	const targetKey =
		typeof value.targetKey === 'string'
			? requiredString(value, 'targetKey', { max: 128 })
			: undefined;
	const agentId =
		typeof value.agentId === 'string'
			? requiredString(value, 'agentId', { max: 128 })
			: undefined;
	return {
		...(targetKind ? { targetKind } : {}),
		...(targetKey ? { targetKey } : {}),
		...(agentId ? { agentId } : {}),
	};
}

function optionalTargetInput(value: Record<string, unknown>) {
	const target = targetInput(value);
	return Object.keys(target).length === 0 ? undefined : target;
}

function triggerRejection(): Response {
	return jsonResponse(
		{
			error: {
				code: 'TRIGGER_REJECTED',
				message: 'The trigger request was rejected.',
			},
		},
		403,
	);
}

export function createAutomationsRoutes(
	auth: AuthRuntime,
	runtime: AutomationsRuntime,
) {
	const listSchedules = defineEndpoint({
		id: 'automations.schedules.list',
		path: '/api/automations/schedules',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				schedules: runtime.scheduleService().list(principal.tenantId),
				variables: scheduleVariablesForScopes(principal.scopes),
				agents: runtime.scheduleService().agents(principal.tenantId),
				targets: runtime
					.scheduleService()
					.targetOptions(
						principal.tenantId,
						userActor(principal),
						principal.scopes,
					),
			});
		},
	});
	const createSchedule = defineEndpoint({
		id: 'automations.schedules.create',
		path: '/api/automations/schedules',
		methods: ['POST'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 32 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					{
						schedule: runtime
							.scheduleService()
							.create(
								principal.tenantId,
								userActor(principal),
								scheduleInput(value),
								principal.scopes,
							),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const updateSchedule = defineEndpoint({
		id: 'automations.schedules.update',
		path: '/api/automations/schedules/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 32 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					schedule: runtime.scheduleService().update(
						principal.tenantId,
						userActor(principal),
						{
							...scheduleInput(value),
							id: requiredString(value, 'id', { max: 128 }),
						},
						principal.scopes,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const deleteSchedule = defineEndpoint({
		id: 'automations.schedules.delete',
		path: '/api/automations/schedules/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				runtime
					.scheduleService()
					.delete(
						principal.tenantId,
						principal.accountId,
						requiredString(value, 'id', { max: 128 }),
					);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const runSchedule = defineEndpoint({
		id: 'automations.schedules.run',
		path: '/api/automations/schedules/run',
		methods: ['POST'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					{
						run: await runtime
							.scheduleService()
							.runNow(
								principal.tenantId,
								userActor(principal),
								requiredString(value, 'id', { max: 128 }),
								principal.scopes,
							),
					},
					202,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const listTriggers = defineEndpoint({
		id: 'automations.triggers.list',
		path: '/api/automations/triggers',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: AUTOMATIONS_PERMISSIONS.triggersRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				triggers: runtime.triggerService().list(principal.tenantId),
				agents: runtime.scheduleService().agents(principal.tenantId),
				targets: runtime
					.scheduleService()
					.targetOptions(
						principal.tenantId,
						userActor(principal),
						principal.scopes,
					),
			});
		},
	});
	const createTrigger = defineEndpoint({
		id: 'automations.triggers.create',
		path: '/api/automations/triggers',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUTOMATIONS_PERMISSIONS.triggersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					runtime.triggerService().create(
						principal.tenantId,
						userActor(principal),
						{
							...targetInput(value),
							label: requiredString(value, 'label', { min: 2, max: 120 }),
							enabled: requiredBoolean(value, 'enabled'),
						},
						principal.scopes,
					),
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const updateTrigger = defineEndpoint({
		id: 'automations.triggers.update',
		path: '/api/automations/triggers/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUTOMATIONS_PERMISSIONS.triggersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 8 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					trigger: runtime
						.triggerService()
						.update(
							principal.tenantId,
							userActor(principal),
							requiredString(value, 'id', { max: 128 }),
							requiredString(value, 'label', { min: 2, max: 120 }),
							requiredBoolean(value, 'enabled'),
							principal.scopes,
							optionalTargetInput(value),
						),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const rotateTrigger = defineEndpoint({
		id: 'automations.triggers.rotate',
		path: '/api/automations/triggers/rotate',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUTOMATIONS_PERMISSIONS.triggersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					runtime
						.triggerService()
						.rotate(
							principal.tenantId,
							principal.accountId,
							requiredString(value, 'id', { max: 128 }),
						),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const deleteTrigger = defineEndpoint({
		id: 'automations.triggers.delete',
		path: '/api/automations/triggers/delete',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: AUTOMATIONS_PERMISSIONS.triggersManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				const principal = principalFromContext(octane)!;
				runtime
					.triggerService()
					.delete(
						principal.tenantId,
						principal.accountId,
						requiredString(value, 'id', { max: 128 }),
					);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const fireTrigger = defineEndpoint({
		id: 'automations.triggers.fire',
		path: '/api/automations/triggers/:id/fire',
		methods: ['POST'],
		/* A signed webhook has no browser session. HMAC and freshness are its
		   authentication boundary, so CSRF does not apply. */
		access: { kind: 'public' },
		handler: async ({ octane }) => {
			try {
				const declared = Number(
					octane.request.headers.get('content-length') ?? 0,
				);
				if (Number.isFinite(declared) && declared > MAX_TRIGGER_BODY_BYTES) {
					return triggerRejection();
				}
				const run = await runtime.triggerService().fire({
					triggerId: octane.params.id ?? '',
					body: await octane.request.text(),
					signature: octane.request.headers.get(TRIGGER_SIGNATURE_HEADER),
					timestamp: octane.request.headers.get(TRIGGER_TIMESTAMP_HEADER),
				});
				return jsonResponse({ accepted: true, runId: run.id }, 202);
			} catch (error) {
				if (error instanceof TriggerRejectedError) return triggerRejection();
				return failure(error);
			}
		},
	});
	const listAudit = defineEndpoint({
		id: 'automations.audit.list',
		path: '/api/automations/audit',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				events: runtime.listAuditEvents(principal.tenantId, 100),
				integrity: runtime.verifyAudit(principal.tenantId),
			});
		},
	});
	return [
		listSchedules.serverRoute,
		createSchedule.serverRoute,
		updateSchedule.serverRoute,
		deleteSchedule.serverRoute,
		runSchedule.serverRoute,
		listTriggers.serverRoute,
		createTrigger.serverRoute,
		updateTrigger.serverRoute,
		rotateTrigger.serverRoute,
		deleteTrigger.serverRoute,
		fireTrigger.serverRoute,
		listAudit.serverRoute,
	] as const;
}

export const endpoints = [
	'automations.schedules.list',
	'automations.schedules.create',
	'automations.schedules.update',
	'automations.schedules.delete',
	'automations.schedules.run',
	'automations.triggers.list',
	'automations.triggers.create',
	'automations.triggers.update',
	'automations.triggers.rotate',
	'automations.triggers.delete',
	'automations.triggers.fire',
	'automations.audit.list',
] as const;
