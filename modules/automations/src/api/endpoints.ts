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
import { userActor } from '@flowdular/kernel';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import type { CreateAutomationScheduleInput } from '../domain/types.ts';
import { scheduleVariablesForScopes } from '../domain/variables.ts';
import type { AutomationsRuntime } from '../server/runtime.ts';
import { AutomationsServiceError } from '../services/automations-service.ts';
import {
	AUTOMATION_LIST_SORT_KEYS,
	type AutomationListCursor,
	type AutomationListQuery,
	type AutomationListSortKey,
} from '../services/repository.ts';
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
		cadence: requiredString(value, 'cadence', { min: 7, max: 200 }),
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

const LIST_PAGE_LIMIT = 50;
const MAX_LIST_PAGE_LIMIT = 200;
const MAX_LIST_SEARCH_LENGTH = 120;

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function invalidCursor(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

interface ListRequest {
	readonly query: AutomationListQuery;
	/* Travels inside the cursor, so a cursor answers only the request that
	   minted it: the same workspace, order and filters. */
	readonly scope: Record<string, string>;
}

function listRequest(
	url: URL,
	tenantId: string,
	cursorSecret: Uint8Array,
): ListRequest {
	const page = readPageQuery(url, {
		maxLimit: MAX_LIST_PAGE_LIMIT,
		defaultLimit: LIST_PAGE_LIMIT,
	});
	const sort = url.searchParams.get('sort') ?? 'label';
	if (!AUTOMATION_LIST_SORT_KEYS.includes(sort as AutomationListSortKey)) {
		throw invalid(
			`sort must be one of ${AUTOMATION_LIST_SORT_KEYS.join(', ')}.`,
		);
	}
	const direction = url.searchParams.get('direction') ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw invalid('direction must be asc or desc.');
	}
	const enabledValue = url.searchParams.get('enabled') ?? '';
	if (
		enabledValue !== '' &&
		enabledValue !== 'true' &&
		enabledValue !== 'false'
	) {
		throw invalid('enabled must be true or false.');
	}
	const search = (url.searchParams.get('q') ?? '').trim();
	if (search.length > MAX_LIST_SEARCH_LENGTH) {
		throw invalid(`q is at most ${MAX_LIST_SEARCH_LENGTH} characters.`);
	}
	const scope = {
		tenant: tenantId,
		sort,
		direction,
		enabled: enabledValue,
		q: search,
	};
	let after: AutomationListCursor | null = null;
	if (page.cursor) {
		const cursor = decodeCursor(page.cursor, cursorSecret);
		for (const [key, value] of Object.entries(scope)) {
			if (cursor[key] !== value) throw invalidCursor();
		}
		if (
			typeof cursor.id !== 'string' ||
			typeof cursor.value !== (sort === 'label' ? 'string' : 'number')
		) {
			throw invalidCursor();
		}
		after = { value: cursor.value!, id: cursor.id };
	}
	return {
		query: {
			sort: sort as AutomationListSortKey,
			direction,
			...(enabledValue === '' ? {} : { enabled: enabledValue === 'true' }),
			...(search === '' ? {} : { search }),
			limit: page.limit,
			after,
		},
		scope,
	};
}

function listResponse<Item>(
	page: {
		readonly items: readonly Item[];
		readonly next: AutomationListCursor | null;
	},
	request: ListRequest,
	cursorSecret: Uint8Array,
): Response {
	return pageResponse({
		items: page.items,
		limit: request.query.limit,
		nextCursor: page.next
			? encodeCursor(
					{ ...request.scope, value: page.next.value, id: page.next.id },
					cursorSecret,
				)
			: null,
	});
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
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own list, so a restart invalidating one costs a client the
	   first page. */
	const cursorSecret = randomBytes(32);
	const options = defineEndpoint({
		id: 'automations.options',
		path: '/api/automations/options',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			const schedules = await runtime.scheduleService();
			return jsonResponse({
				timeZone: schedules.timeZone(principal.tenantId),
				variables: scheduleVariablesForScopes(principal.scopes),
				agents: await schedules.agents(principal.tenantId),
				targets: await schedules.targetOptions(
					principal.tenantId,
					userActor(principal),
					principal.scopes,
				),
			});
		},
	});
	/* The trigger form's half of the options, so a principal holding only the
	   trigger permissions still gets its targets. */
	const triggerOptions = defineEndpoint({
		id: 'automations.triggers.options',
		path: '/api/automations/triggers/options',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: AUTOMATIONS_PERMISSIONS.triggersRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			const schedules = await runtime.scheduleService();
			return jsonResponse({
				agents: await schedules.agents(principal.tenantId),
				targets: await schedules.targetOptions(
					principal.tenantId,
					userActor(principal),
					principal.scopes,
				),
			});
		},
	});
	const listSchedules = defineEndpoint({
		id: 'automations.schedules.list',
		path: '/api/automations/schedules',
		methods: ['GET'],
		access: { kind: 'permission', permission: AUTOMATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const request = listRequest(
					new URL(octane.request.url),
					principal.tenantId,
					cursorSecret,
				);
				return listResponse(
					await (
						await runtime.scheduleService()
					).list(principal.tenantId, request.query),
					request,
					cursorSecret,
				);
			} catch (error) {
				return failure(error);
			}
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
						schedule: await (
							await runtime.scheduleService()
						).create(
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
					schedule: await (
						await runtime.scheduleService()
					).update(
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
				await (
					await runtime.scheduleService()
				).delete(
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
				const accepted = await (
					await runtime.scheduleService()
				).runNow(
					principal.tenantId,
					userActor(principal),
					requiredString(value, 'id', { max: 128 }),
					principal.scopes,
				);
				return jsonResponse({ run: { id: accepted.id } }, 202);
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
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const request = listRequest(
					new URL(octane.request.url),
					principal.tenantId,
					cursorSecret,
				);
				return listResponse(
					await (
						await runtime.triggerService()
					).list(principal.tenantId, request.query),
					request,
					cursorSecret,
				);
			} catch (error) {
				return failure(error);
			}
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
					await (
						await runtime.triggerService()
					).create(
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
					trigger: await (
						await runtime.triggerService()
					).update(
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
					await (
						await runtime.triggerService()
					).rotate(
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
				await (
					await runtime.triggerService()
				).delete(
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
				const run = await (
					await runtime.triggerService()
				).fire({
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
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				events: await runtime.listAuditEvents(principal.tenantId, 100),
				integrity: await runtime.verifyAudit(principal.tenantId),
			});
		},
	});
	return [
		options.serverRoute,
		listSchedules.serverRoute,
		createSchedule.serverRoute,
		updateSchedule.serverRoute,
		deleteSchedule.serverRoute,
		runSchedule.serverRoute,
		triggerOptions.serverRoute,
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
	'automations.options',
	'automations.schedules.list',
	'automations.schedules.create',
	'automations.schedules.update',
	'automations.schedules.delete',
	'automations.schedules.run',
	'automations.triggers.options',
	'automations.triggers.list',
	'automations.triggers.create',
	'automations.triggers.update',
	'automations.triggers.rotate',
	'automations.triggers.delete',
	'automations.triggers.fire',
	'automations.audit.list',
] as const;
