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
import { CONNECTORS_PERMISSIONS } from '../acl/permissions.ts';
import type { ConnectorCallResult } from '../domain/calls.ts';
import {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_CALL_OUTCOMES,
	type ConnectorAuthKind,
	type ConnectorCallOutcome,
} from '../domain/types.ts';
import type { ConnectorsRuntime } from '../server/runtime.ts';
import { MAX_ALLOWED_HOSTS } from '../services/connectors-service.ts';
import { ConnectorsServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof ConnectorsServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The connectors operation failed.');
}

function jsonObject(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const nested = value[key];
	if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
		throw new HttpProblem('INVALID_INPUT', `${key} must be an object.`, 400);
	}
	return nested as Record<string, unknown>;
}

function optionalJsonObject(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	return value[key] === undefined ? undefined : jsonObject(value, key);
}

function hostList(
	value: Record<string, unknown>,
	key: string,
): readonly string[] {
	const nested = value[key];
	if (nested === undefined) return [];
	if (!Array.isArray(nested) || nested.length > MAX_ALLOWED_HOSTS) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be an array of at most ${MAX_ALLOWED_HOSTS} host names.`,
			400,
		);
	}
	return nested.map((entry, index) => {
		if (typeof entry !== 'string') {
			throw new HttpProblem(
				'INVALID_INPUT',
				`${key}[${index}] must be a string.`,
				400,
			);
		}
		return entry;
	});
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
	const nested = value[key];
	if (typeof nested !== 'boolean') {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a boolean.`, 400);
	}
	return nested;
}

function authKind(value: Record<string, unknown>): ConnectorAuthKind {
	const kind = requiredString(value, 'authKind', { max: 32 });
	if (!(CONNECTOR_AUTH_KINDS as readonly string[]).includes(kind)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'authKind must be a supported authentication kind.',
			400,
		);
	}
	return kind as ConnectorAuthKind;
}

/** The diagnosis view: the classes and the truncated text, never the body. */
function diagnosis(result: ConnectorCallResult) {
	return {
		callId: result.callId,
		outcome: result.outcome,
		status: result.status,
		errorClass: result.errorClass,
		durationMs: result.durationMs,
		requestBytes: result.requestBytes,
		responseBytes: result.responseBytes,
		bodyPreview: result.bodyPreview,
	};
}

export function createConnectorsRoutes(
	auth: AuthRuntime,
	runtime: ConnectorsRuntime,
) {
	const listDefinitions = defineEndpoint({
		id: 'connectors.definitions.list',
		path: '/api/connectors/definitions',
		methods: ['GET'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async () => {
			const service = await runtime.service();
			return jsonResponse({ definitions: service.definitions() });
		},
	});

	const listInstances = defineEndpoint({
		id: 'connectors.instances.list',
		path: '/api/connectors/instances',
		methods: ['GET'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const service = await runtime.service();
			return jsonResponse({
				instances: await service.list(principalFromContext(octane)!.tenantId),
			});
		},
	});

	const createInstance = defineEndpoint({
		id: 'connectors.instances.create',
		path: '/api/connectors/instances',
		methods: ['POST'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse(
					{
						instance: await service.create(
							principal.tenantId,
							principal.accountId,
							{
								definitionKey: requiredString(value, 'definitionKey', {
									max: 96,
								}),
								name: requiredString(value, 'name', { max: 120 }),
								baseUrl: requiredString(value, 'baseUrl', { max: 2_048 }),
								authKind: authKind(value),
								credentials: optionalJsonObject(value, 'credentials') ?? {},
								allowedHosts: hostList(value, 'allowedHosts'),
							},
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const updateInstance = defineEndpoint({
		id: 'connectors.instances.update',
		path: '/api/connectors/instances/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					instance: await service.update(
						principal.tenantId,
						principal.accountId,
						requiredString(value, 'id', { max: 128 }),
						{
							name: requiredString(value, 'name', { max: 120 }),
							baseUrl: requiredString(value, 'baseUrl', { max: 2_048 }),
							allowedHosts: hostList(value, 'allowedHosts'),
							credentials: optionalJsonObject(value, 'credentials'),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const consentInstance = defineEndpoint({
		id: 'connectors.instances.consent',
		path: '/api/connectors/instances/consent',
		methods: ['POST'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					instance: await service.consent(
						principal.tenantId,
						principal.accountId,
						requiredString(value, 'id', { max: 128 }),
						{
							allowWorkflows: requiredBoolean(value, 'allowWorkflows'),
							allowAgents: requiredBoolean(value, 'allowAgents'),
							confirmed: requiredBoolean(value, 'confirmed'),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const testCall = defineEndpoint({
		id: 'connectors.instances.test-call',
		path: '/api/connectors/instances/test-call',
		methods: ['POST'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const calls = await runtime.calls();
				const result = await calls.call({
					tenantId: principalFromContext(octane)!.tenantId,
					instanceId: requiredString(value, 'id', { max: 128 }),
					operation: requiredString(value, 'operation', { max: 64 }),
					input: optionalJsonObject(value, 'input') ?? {},
					caller: 'test',
				});
				return jsonResponse({ result: diagnosis(result) });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const statusEndpoint = (
		id: string,
		path: string,
		apply: (
			tenantId: string,
			actorId: string,
			instanceId: string,
		) => Promise<unknown>,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					const principal = principalFromContext(octane)!;
					return jsonResponse(
						await apply(
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

	const enableInstance = statusEndpoint(
		'connectors.instances.enable',
		'/api/connectors/instances/enable',
		async (tenantId, actorId, id) => ({
			instance: await (await runtime.service()).enable(tenantId, actorId, id),
		}),
	);

	const disableInstance = statusEndpoint(
		'connectors.instances.disable',
		'/api/connectors/instances/disable',
		async (tenantId, actorId, id) => ({
			instance: await (await runtime.service()).disable(tenantId, actorId, id),
		}),
	);

	const deleteInstance = statusEndpoint(
		'connectors.instances.delete',
		'/api/connectors/instances/delete',
		async (tenantId, actorId, id) => {
			await (await runtime.service()).remove(tenantId, actorId, id);
			return { deleted: true };
		},
	);

	const listCalls = defineEndpoint({
		id: 'connectors.calls.list',
		path: '/api/connectors/calls',
		methods: ['GET'],
		access: { kind: 'permission', permission: CONNECTORS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const outcome = url.searchParams.get('outcome');
				const instanceId = url.searchParams.get('instanceId');
				if (
					outcome !== null &&
					!(CONNECTOR_CALL_OUTCOMES as readonly string[]).includes(outcome)
				) {
					throw new HttpProblem(
						'INVALID_INPUT',
						'outcome must be a known call outcome.',
						400,
					);
				}
				const service = await runtime.service();
				return jsonResponse({
					calls: await service.listCalls(
						principalFromContext(octane)!.tenantId,
						{
							outcome: (outcome as ConnectorCallOutcome | null) ?? undefined,
							instanceId: instanceId ?? undefined,
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* There is deliberately no route for the agent tool. The harness runs the
	   tool's execute in this process, so a route would only add a second way in:
	   one under connectors.instances.read, which every member holds, that makes
	   a credentialed outbound call and hands the parsed response back. The tool
	   keeps connectors.calls.agent as its identity and nothing serves it. */
	return [
		listDefinitions.serverRoute,
		listInstances.serverRoute,
		createInstance.serverRoute,
		updateInstance.serverRoute,
		consentInstance.serverRoute,
		testCall.serverRoute,
		enableInstance.serverRoute,
		disableInstance.serverRoute,
		deleteInstance.serverRoute,
		listCalls.serverRoute,
	] as const;
}

export const endpoints = [
	'connectors.definitions.list',
	'connectors.instances.list',
	'connectors.instances.create',
	'connectors.instances.update',
	'connectors.instances.consent',
	'connectors.instances.test-call',
	'connectors.instances.enable',
	'connectors.instances.disable',
	'connectors.instances.delete',
	'connectors.calls.list',
] as const;
