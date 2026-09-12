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
import { IMPORT_PERMISSIONS } from '../acl/permissions.ts';
import { IMPORT_MODES, type ImportMode } from '../domain/ports.ts';
import {
	IMPORT_JOB_STATUSES,
	IMPORT_LIMITS,
	importJobView,
	type ImportJobStatus,
} from '../domain/types.ts';
import type { ImportRuntime } from '../server/runtime.ts';
import { ImportServiceError } from '../services/import-service.ts';
import { ImportPortError } from '../services/port-registry.ts';
import { ImportSourceError } from '../services/csv-source.ts';
import type { JobCursor } from '../services/repository.ts';

function failure(error: unknown): Response {
	if (
		error instanceof ImportServiceError ||
		error instanceof ImportSourceError ||
		error instanceof ImportPortError
	) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The import operation failed.');
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
	const raw = value[key];
	if (typeof raw !== 'boolean') throw invalid(`${key} must be true or false.`);
	return raw;
}

function requiredMode(value: Record<string, unknown>): ImportMode {
	const raw = requiredString(value, 'mode', { max: 32 });
	if (!(IMPORT_MODES as readonly string[]).includes(raw)) {
		throw invalid(`mode must be one of: ${IMPORT_MODES.join(', ')}.`);
	}
	return raw as ImportMode;
}

/**
 * The column mapping as the request carries it: field id to CSV header. Both
 * sides are bounded before anything is stored, so a hostile body cannot grow
 * the column a job persists.
 */
function requiredColumns(
	value: Record<string, unknown>,
): Record<string, string> {
	const raw = value['columns'];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw invalid('columns must be an object of field id to column header.');
	}
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0 || entries.length > IMPORT_LIMITS.page) {
		throw invalid('columns must name 1 to 200 fields.');
	}
	const columns: Record<string, string> = {};
	for (const [field, header] of entries) {
		if (field.length === 0 || field.length > IMPORT_LIMITS.field) {
			throw invalid('A column field id is longer than 64 characters.');
		}
		if (
			typeof header !== 'string' ||
			header.length === 0 ||
			header.length > IMPORT_LIMITS.reason
		) {
			throw invalid(`The column header for ${field} is not bounded text.`);
		}
		columns[field] = header;
	}
	return columns;
}

function queryValue(url: URL, key: string, max: number): string | undefined {
	const raw = url.searchParams.get(key);
	if (raw === null || raw === '') return undefined;
	if (raw.length > max) throw invalid(`${key} is too long.`);
	return raw;
}

function queryStatus(url: URL): ImportJobStatus | undefined {
	const raw = queryValue(url, 'status', 32);
	if (raw === undefined) return undefined;
	if (!(IMPORT_JOB_STATUSES as readonly string[]).includes(raw)) {
		throw invalid(`status must be one of: ${IMPORT_JOB_STATUSES.join(', ')}.`);
	}
	return raw as ImportJobStatus;
}

function readJobCursor(
	cursor: string | null,
	secret: Uint8Array,
): JobCursor | undefined {
	if (cursor === null) return undefined;
	const decoded = decodeCursor(cursor, secret);
	return { startedAt: Number(decoded['s']), id: String(decoded['i']) };
}

export function createImportRoutes(auth: AuthRuntime, runtime: ImportRuntime) {
	/* Module-owned and never stored: a cursor is short-lived, so a restart
	   invalidating one costs a client the first page, not correctness. */
	const cursorSecret = randomBytes(32);

	const targets = defineEndpoint({
		id: 'import.targets.list',
		path: '/api/import/targets',
		methods: ['GET'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				return jsonResponse({
					targets: service.targets(principalFromContext(octane)!),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listJobs = defineEndpoint({
		id: 'import.jobs.list',
		path: '/api/import/jobs',
		methods: ['GET'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, { maxLimit: IMPORT_LIMITS.page });
				const result = await (
					await runtime.service()
				).jobs(principalFromContext(octane)!.tenantId, {
					status: queryStatus(url),
					target: queryValue(url, 'target', IMPORT_LIMITS.target),
					limit: page.limit,
					cursor: readJobCursor(page.cursor, cursorSecret),
				});
				return pageResponse({
					items: result.items.map(importJobView),
					limit: page.limit,
					nextCursor: result.nextCursor
						? encodeCursor(
								{ s: result.nextCursor.startedAt, i: result.nextCursor.id },
								cursorSecret,
							)
						: null,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const getJob = defineEndpoint({
		id: 'import.jobs.get',
		path: '/api/import/jobs/:id',
		methods: ['GET'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				return jsonResponse({
					job: importJobView(
						await service.job(
							principalFromContext(octane)!.tenantId,
							octane.params.id ?? '',
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listRows = defineEndpoint({
		id: 'import.jobs.rows',
		path: '/api/import/jobs/:id/rows',
		methods: ['GET'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, { maxLimit: IMPORT_LIMITS.page });
				const after =
					page.cursor === null
						? undefined
						: Number(decodeCursor(page.cursor, cursorSecret)['r']);
				const result = await (
					await runtime.service()
				).rows(
					principalFromContext(octane)!.tenantId,
					octane.params.id ?? '',
					page.limit,
					after,
				);
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor:
						result.nextCursor === null
							? null
							: encodeCursor({ r: result.nextCursor }, cursorSecret),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const start = defineEndpoint({
		id: 'import.jobs.start',
		path: '/api/import/jobs/start',
		methods: ['POST'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				const job = await service.start(principalFromContext(octane)!, {
					target: requiredString(value, 'target', {
						max: IMPORT_LIMITS.target,
					}),
					documentId: requiredString(value, 'documentId', {
						max: IMPORT_LIMITS.documentId,
					}),
					documentRef: requiredString(value, 'documentRef', {
						max: IMPORT_LIMITS.recordRef,
					}),
					mode: requiredMode(value),
					dryRun: requiredBoolean(value, 'dryRun'),
					columns: requiredColumns(value),
				});
				return jsonResponse({ job: importJobView(job) }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const proceed = defineEndpoint({
		id: 'import.jobs.continue',
		path: '/api/import/jobs/continue',
		methods: ['POST'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				return jsonResponse({
					job: importJobView(
						await service.continue(
							principalFromContext(octane)!,
							requiredString(value, 'id', { max: IMPORT_LIMITS.id }),
							requiredBoolean(value, 'validOnly'),
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const cancel = defineEndpoint({
		id: 'import.jobs.cancel',
		path: '/api/import/jobs/cancel',
		methods: ['POST'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				return jsonResponse({
					job: importJobView(
						await service.cancel(
							principalFromContext(octane)!,
							requiredString(value, 'id', { max: IMPORT_LIMITS.id }),
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const getMapping = defineEndpoint({
		id: 'import.mappings.get',
		path: '/api/import/mappings',
		methods: ['GET'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const target = queryValue(url, 'target', IMPORT_LIMITS.target);
				if (target === undefined) throw invalid('target is required.');
				const service = await runtime.service();
				return jsonResponse({
					mapping: await service.mapping(
						principalFromContext(octane)!.tenantId,
						target,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const saveMapping = defineEndpoint({
		id: 'import.mappings.save',
		path: '/api/import/mappings/save',
		methods: ['POST'],
		access: { kind: 'permission', permission: IMPORT_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				return jsonResponse({
					mapping: await service.saveMapping(
						principalFromContext(octane)!,
						requiredString(value, 'target', { max: IMPORT_LIMITS.target }),
						requiredColumns(value),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* The literal job routes are declared before `/api/import/jobs/:id`, so a
	   mutation path is never taken for a job id. */
	return [
		targets.serverRoute,
		listJobs.serverRoute,
		start.serverRoute,
		proceed.serverRoute,
		cancel.serverRoute,
		getMapping.serverRoute,
		saveMapping.serverRoute,
		listRows.serverRoute,
		getJob.serverRoute,
	] as const;
}

export const endpoints = [
	'import.targets.list',
	'import.jobs.list',
	'import.jobs.get',
	'import.jobs.rows',
	'import.jobs.start',
	'import.jobs.continue',
	'import.jobs.cancel',
	'import.mappings.get',
	'import.mappings.save',
] as const;
