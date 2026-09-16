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
import { ADAPTERS_PERMISSIONS } from '../acl/permissions.ts';
import { AdapterMappingError } from '../domain/mapping.ts';
import { ADAPTER_LIMITS, adapterRunView } from '../domain/types.ts';
import type { AdaptersRuntime } from '../server/runtime.ts';
import { AdapterRegistryError } from '../services/registry.ts';
import type { RunPosition } from '../services/repository.ts';
import { AdaptersServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (
		error instanceof AdaptersServiceError ||
		error instanceof AdapterMappingError
	) {
		const status = error instanceof AdaptersServiceError ? error.status : 400;
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			status,
		);
	}
	if (error instanceof AdapterRegistryError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The adapters operation failed.');
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

/* A binding carries a mapping of at most 32 KB and a few bounded fields. */
const BINDING_BODY_BYTES = 40_960;

function nullableString(
	value: Record<string, unknown>,
	key: string,
	max: number,
	allowEmpty: boolean,
): string | null {
	const raw = value[key];
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'string') throw invalid(`${key} must be text or null.`);
	const trimmed = raw.trim();
	if (trimmed === '' && !allowEmpty) throw invalid(`${key} is empty.`);
	if (trimmed.length > max) throw invalid(`${key} is too long.`);
	return trimmed;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
	const raw = value[key];
	if (typeof raw !== 'boolean') throw invalid(`${key} must be true or false.`);
	return raw;
}

function mappingOf(value: Record<string, unknown>): unknown {
	const raw = value['mapping'];
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw))
		throw invalid('mapping must be a list of rules or null.');
	return raw;
}

export function createAdaptersRoutes(
	auth: AuthRuntime,
	runtime: AdaptersRuntime,
) {
	/* Module-owned and never stored: a restart costs a reader the first page. */
	const cursorSecret = randomBytes(32);

	const runPosition = (cursor: string | null): RunPosition | null => {
		if (cursor === null) return null;
		const value = decodeCursor(cursor, cursorSecret);
		if (
			value.k !== 'runs' ||
			!Number.isSafeInteger(value.q) ||
			typeof value.i !== 'string'
		) {
			throw new HttpProblem(
				'CURSOR_INVALID',
				'The page cursor is not valid.',
				400,
			);
		}
		return { queuedAt: value.q as number, id: value.i };
	};

	const list = defineEndpoint({
		id: 'adapters.list',
		path: '/api/adapters',
		methods: ['GET'],
		access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const adapters = await (
					await runtime.service()
				).overview(principalFromContext(octane)!.tenantId);
				return jsonResponse({
					adapters: adapters.map((adapter) => ({
						...adapter,
						lastRun: adapter.lastRun ? adapterRunView(adapter.lastRun) : null,
					})),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listRuns = defineEndpoint({
		id: 'adapters.runs.list',
		path: '/api/adapters/runs',
		methods: ['GET'],
		access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, { maxLimit: ADAPTER_LIMITS.page });
				const adapterId = url.searchParams.get('adapterId') ?? '';
				if (adapterId.length > ADAPTER_LIMITS.id) {
					throw invalid('adapterId is too long.');
				}
				const result = await (
					await runtime.service()
				).runs(principalFromContext(octane)!.tenantId, {
					...(adapterId === '' ? {} : { adapterId }),
					limit: page.limit,
					after: runPosition(page.cursor),
				});
				return pageResponse({
					items: result.items.map(adapterRunView),
					limit: page.limit,
					nextCursor:
						result.next === null
							? null
							: encodeCursor(
									{ k: 'runs', q: result.next.queuedAt, i: result.next.id },
									cursorSecret,
								),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const getRun = defineEndpoint({
		id: 'adapters.runs.get',
		path: '/api/adapters/runs/:id',
		methods: ['GET'],
		access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const run = await (
					await runtime.service()
				).run(
					principalFromContext(octane)!.tenantId,
					(octane.params.id ?? '').slice(0, ADAPTER_LIMITS.runId),
				);
				return jsonResponse({ run: adapterRunView(run) });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listRows = defineEndpoint({
		id: 'adapters.runs.rows',
		path: '/api/adapters/runs/:id/rows',
		methods: ['GET'],
		access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, { maxLimit: ADAPTER_LIMITS.page });
				let after: number | null = null;
				if (page.cursor !== null) {
					const value = decodeCursor(page.cursor, cursorSecret);
					if (value.k !== 'rows' || !Number.isSafeInteger(value.r)) {
						throw new HttpProblem(
							'CURSOR_INVALID',
							'The page cursor is not valid.',
							400,
						);
					}
					after = value.r as number;
				}
				const result = await (
					await runtime.service()
				).rows(
					principalFromContext(octane)!.tenantId,
					(octane.params.id ?? '').slice(0, ADAPTER_LIMITS.runId),
					page.limit,
					after,
				);
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor:
						result.next === null
							? null
							: encodeCursor({ k: 'rows', r: result.next }, cursorSecret),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const bind = defineEndpoint({
		id: 'adapters.bind',
		path: '/api/adapters/bind',
		methods: ['POST'],
		access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, BINDING_BODY_BYTES);
				const binding = await (
					await runtime.service()
				).bind(principalFromContext(octane)!, {
					adapterId: requiredString(value, 'adapterId', {
						max: ADAPTER_LIMITS.id,
					}),
					instanceId: nullableString(
						value,
						'instanceId',
						ADAPTER_LIMITS.instanceId,
						false,
					),
					enabled: requiredBoolean(value, 'enabled'),
					mapping: mappingOf(value),
					schedule: nullableString(
						value,
						'schedule',
						ADAPTER_LIMITS.schedule,
						true,
					),
				});
				const { tenantId: _tenant, ...view } = binding;
				return jsonResponse({ binding: view });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const dryRun = defineEndpoint({
		id: 'adapters.dry-run',
		path: '/api/adapters/dry-run',
		methods: ['POST'],
		access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, BINDING_BODY_BYTES);
				const result = await (
					await runtime.service()
				).dryRun(
					principalFromContext(octane)!,
					requiredString(value, 'adapterId', { max: ADAPTER_LIMITS.id }),
					mappingOf(value),
				);
				return jsonResponse({ dryRun: result });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const runAction = (
		id: string,
		path: string,
		act: (
			service: Awaited<ReturnType<AdaptersRuntime['service']>>,
			principal: NonNullable<ReturnType<typeof principalFromContext>>,
			value: Record<string, unknown>,
		) => Promise<Parameters<typeof adapterRunView>[0]>,
		status: number,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: ADAPTERS_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					const run = await act(
						await runtime.service(),
						principalFromContext(octane)!,
						value,
					);
					return jsonResponse({ run: adapterRunView(run) }, status);
				} catch (error) {
					return failure(error);
				}
			},
		});

	const start = runAction(
		'adapters.runs.start',
		'/api/adapters/runs/start',
		(service, principal, value) =>
			service.start(
				principal,
				requiredString(value, 'adapterId', { max: ADAPTER_LIMITS.id }),
			),
		201,
	);
	const resume = runAction(
		'adapters.runs.resume',
		'/api/adapters/runs/resume',
		(service, principal, value) =>
			service.resume(
				principal,
				requiredString(value, 'runId', { max: ADAPTER_LIMITS.runId }),
			),
		201,
	);
	const cancel = runAction(
		'adapters.runs.cancel',
		'/api/adapters/runs/cancel',
		(service, principal, value) =>
			service.cancel(
				principal,
				requiredString(value, 'runId', { max: ADAPTER_LIMITS.runId }),
			),
		200,
	);

	/* The literal run routes are declared before `/api/adapters/runs/:id`, so
	   a mutation path is never taken for a run id. */
	return [
		list.serverRoute,
		listRuns.serverRoute,
		bind.serverRoute,
		dryRun.serverRoute,
		start.serverRoute,
		resume.serverRoute,
		cancel.serverRoute,
		listRows.serverRoute,
		getRun.serverRoute,
	] as const;
}

export const endpoints = [
	'adapters.list',
	'adapters.runs.list',
	'adapters.runs.get',
	'adapters.runs.rows',
	'adapters.bind',
	'adapters.dry-run',
	'adapters.runs.start',
	'adapters.runs.resume',
	'adapters.runs.cancel',
] as const;
