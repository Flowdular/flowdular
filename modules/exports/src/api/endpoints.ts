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
import { EXPORTS_PERMISSIONS } from '../acl/permissions.ts';
import {
	EXPORT_JOB_STATUSES,
	EXPORT_LIMITS,
	exportJobView,
	type ExportJobStatus,
} from '../domain/types.ts';
import type { ExportsRuntime } from '../server/runtime.ts';
import {
	exportCatalogue,
	ExportServiceError,
} from '../services/export-service.ts';
import { ExportListError } from '../services/list-registry.ts';
import type { ExportJobCursor } from '../services/repository.ts';

function failure(error: unknown): Response {
	if (error instanceof ExportServiceError || error instanceof ExportListError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The export operation failed.');
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function queryStatus(url: URL): ExportJobStatus | undefined {
	const raw = url.searchParams.get('status');
	if (raw === null || raw === '') return undefined;
	if (!(EXPORT_JOB_STATUSES as readonly string[]).includes(raw)) {
		throw invalid(`status must be one of: ${EXPORT_JOB_STATUSES.join(', ')}.`);
	}
	return raw as ExportJobStatus;
}

function readJobCursor(
	cursor: string | null,
	secret: Uint8Array,
): ExportJobCursor | undefined {
	if (cursor === null) return undefined;
	const decoded = decodeCursor(cursor, secret);
	return { startedAt: Number(decoded['s']), id: String(decoded['i']) };
}

export function createExportRoutes(auth: AuthRuntime, runtime: ExportsRuntime) {
	/* Module-owned and never stored: a cursor is short-lived, so a restart
	   invalidating one costs a client the first page, not correctness. */
	const cursorSecret = randomBytes(32);

	const listJobs = defineEndpoint({
		id: 'exports.jobs.list',
		path: '/api/exports/jobs',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPORTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, { maxLimit: EXPORT_LIMITS.page });
				const result = await (
					await runtime.service()
				).jobs(principalFromContext(octane)!.tenantId, {
					status: queryStatus(url),
					limit: page.limit,
					cursor: readJobCursor(page.cursor, cursorSecret),
				});
				return pageResponse({
					items: result.items.map(exportJobView),
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

	/* What a reader may start, answered from the sealed catalogue rather than
	   from a list a screen hard-codes: a module that registers an export appears
	   here without exports.core or its screen knowing the list exists. */
	const listCatalogue = defineEndpoint({
		id: 'exports.lists.catalogue',
		path: '/api/exports/lists',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPORTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) =>
			jsonResponse({
				lists: exportCatalogue(runtime.lists, principalFromContext(octane)!),
			}),
	});

	const getJob = defineEndpoint({
		id: 'exports.jobs.get',
		path: '/api/exports/jobs/:id',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPORTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				return jsonResponse({
					job: exportJobView(
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

	const start = defineEndpoint({
		id: 'exports.jobs.start',
		path: '/api/exports/start',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPORTS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				/* The list's own permission is checked inside `start`, on the live
				   principal, before a job row exists. */
				const job = await service.start(
					principalFromContext(octane)!,
					requiredString(value, 'list', { max: EXPORT_LIMITS.listId }),
				);
				return jsonResponse({ job: exportJobView(job) }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const readUrl = defineEndpoint({
		id: 'exports.jobs.read-url',
		path: '/api/exports/jobs/read-url',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPORTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				/* The exported list's own permission is checked inside `readUrl`,
				   on the live principal, before a signed route is minted. */
				return jsonResponse({
					url: await service.readUrl(
						principalFromContext(octane)!,
						requiredString(value, 'id', { max: EXPORT_LIMITS.id }),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* The literal job route is declared before `/api/exports/jobs/:id`, so a
	   mutation path is never taken for a job id. */
	return [
		listJobs.serverRoute,
		listCatalogue.serverRoute,
		start.serverRoute,
		readUrl.serverRoute,
		getJob.serverRoute,
	] as const;
}

export const endpoints = [
	'exports.jobs.list',
	'exports.jobs.get',
	'exports.jobs.start',
	'exports.jobs.read-url',
	'exports.lists.catalogue',
] as const;
