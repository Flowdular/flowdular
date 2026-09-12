import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	requiredString,
} from '@flowdular/server';
import type { AuthPrincipal } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { SEARCH_PERMISSIONS } from '../acl/permissions.ts';
import { SEARCH_PROVIDER_LIMITS } from '../domain/providers.ts';
import { SEARCH_LIMITS, type SearchCursor } from '../domain/types.ts';
import type { SearchRuntime } from '../server/runtime.ts';
import { normalizeQuery } from '../services/search-service.ts';
import { SearchServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof SearchServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The search operation failed.');
}

function searchPrincipal(principal: AuthPrincipal) {
	return {
		accountId: principal.accountId,
		tenantId: principal.tenantId,
		scopes: principal.scopes,
	};
}

/* A provider key travels in a query string, so it is bounded and shaped before
   it is compared against the registry. */
function providerFilter(url: URL): string | undefined {
	const raw = url.searchParams.get('provider');
	if (raw === null || raw === '') return undefined;
	if (raw.length > SEARCH_PROVIDER_LIMITS.key) {
		throw new HttpProblem('INVALID_INPUT', 'provider is too long.', 400);
	}
	return raw;
}

function readCursor(
	value: string | null,
	secret: Uint8Array,
): SearchCursor | null {
	if (value === null) return null;
	const payload = decodeCursor(value, secret);
	const provider = String(payload.p ?? '');
	const cursor = String(payload.c ?? '');
	const skip = Number(payload.s ?? 0);
	if (
		provider === '' ||
		provider.length > SEARCH_PROVIDER_LIMITS.key ||
		cursor.length > SEARCH_PROVIDER_LIMITS.cursor ||
		!Number.isSafeInteger(skip) ||
		skip < 0
	) {
		throw new SearchServiceError(
			'CURSOR_INVALID',
			'The page cursor is not valid.',
		);
	}
	return { provider, cursor, skip };
}

export function createSearchRoutes(auth: AuthRuntime, runtime: SearchRuntime) {
	/* Module-owned and never stored: a cursor is short-lived, so a restart
	   invalidating one costs a client the first page, not correctness. */
	const cursorSecret = randomBytes(32);

	const search = defineEndpoint({
		id: 'search.records.search',
		path: '/api/search',
		methods: ['GET'],
		access: { kind: 'permission', permission: SEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, {
					maxLimit: SEARCH_LIMITS.pageMaximum,
					defaultLimit: SEARCH_LIMITS.pageLimit,
				});
				const result = await (
					await runtime.service()
				).search({
					principal: searchPrincipal(principal),
					query: normalizeQuery(url.searchParams.get('q') ?? ''),
					limit: page.limit,
					provider: providerFilter(url),
					cursor: readCursor(page.cursor, cursorSecret),
					remember: url.searchParams.get('remember') === '1',
				});
				return jsonResponse({
					items: result.hits,
					page: {
						limit: page.limit,
						nextCursor: result.nextCursor
							? encodeCursor(
									{
										p: result.nextCursor.provider,
										c: result.nextCursor.cursor,
										s: result.nextCursor.skip,
									},
									cursorSecret,
								)
							: null,
					},
					providers: result.providers,
					unavailable: result.unavailable,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listRecent = defineEndpoint({
		id: 'search.recent.list',
		path: '/api/search/recent',
		methods: ['GET'],
		access: { kind: 'permission', permission: SEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					items: await (
						await runtime.service()
					).recent(principal.tenantId, principal.accountId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Recall for a hit the member opened. The screen is navigating away when it
	   asks, so this is the smallest write that survives the unload; re-running
	   the search to set its flag would race the page it is leaving. */
	const rememberRecent = defineEndpoint({
		id: 'search.recent.remember',
		path: '/api/search/recent',
		methods: ['POST'],
		access: { kind: 'permission', permission: SEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const body = await readJsonObject(octane.request);
				return jsonResponse({
					recorded: await (
						await runtime.service()
					).remember(
						searchPrincipal(principal),
						normalizeQuery(
							requiredString(body, 'q', {
								max: SEARCH_LIMITS.queryMaximum * 4,
							}),
						),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const clearRecent = defineEndpoint({
		id: 'search.recent.clear',
		path: '/api/search/recent/clear',
		methods: ['POST'],
		access: { kind: 'permission', permission: SEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					cleared: await (
						await runtime.service()
					).clearRecent(principal.tenantId, principal.accountId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		search.serverRoute,
		listRecent.serverRoute,
		rememberRecent.serverRoute,
		clearRecent.serverRoute,
	] as const;
}

export const endpoints = [
	'search.records.search',
	'search.recent.list',
	'search.recent.remember',
	'search.recent.clear',
] as const;
