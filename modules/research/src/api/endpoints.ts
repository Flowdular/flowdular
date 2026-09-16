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
	optionalString,
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { RESEARCH_PERMISSIONS } from '../acl/permissions.ts';
import type { ResearchFreshness } from '../domain/capability.ts';
import { RESEARCH_LIMITS, type ResearchPosition } from '../domain/types.ts';
import type { ResearchRuntime } from '../server/runtime.ts';
import { ResearchServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof ResearchServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The research operation failed.');
}

type ListKind = 'evidence' | 'queries';

export function createResearchRoutes(
	auth: AuthRuntime,
	runtime: ResearchRuntime,
) {
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own list, and a restart costs a reader the first page. */
	const cursorSecret = randomBytes(32);

	const position = (
		cursor: string | null,
		list: ListKind,
	): ResearchPosition | null => {
		if (cursor === null) return null;
		const value = decodeCursor(cursor, cursorSecret);
		if (
			value.list !== list ||
			!Number.isSafeInteger(value.at) ||
			typeof value.id !== 'string'
		) {
			throw new HttpProblem(
				'CURSOR_INVALID',
				'The page cursor is not valid.',
				400,
			);
		}
		return { at: value.at as number, id: value.id };
	};

	const nextCursor = (
		next: ResearchPosition | null,
		list: ListKind,
	): string | null =>
		next === null
			? null
			: encodeCursor({ list, at: next.at, id: next.id }, cursorSecret);

	const listEvidence = defineEndpoint({
		id: 'research.evidence.list',
		path: '/api/research/evidence',
		methods: ['GET'],
		access: { kind: 'permission', permission: RESEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const page = readPageQuery(new URL(octane.request.url), {
					maxLimit: RESEARCH_LIMITS.listMax,
					defaultLimit: RESEARCH_LIMITS.listDefault,
				});
				const result = await (
					await runtime.service()
				).listEvidence(
					principalFromContext(octane)!.tenantId,
					page.limit,
					position(page.cursor, 'evidence'),
				);
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor: nextCursor(result.next, 'evidence'),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const evidence = defineEndpoint({
		id: 'research.evidence.get',
		path: '/api/research/evidence/:id',
		methods: ['GET'],
		access: { kind: 'permission', permission: RESEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				return jsonResponse({
					evidence: await (
						await runtime.service()
					).evidenceDetail(
						principalFromContext(octane)!.tenantId,
						octane.params.id ?? '',
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listQueries = defineEndpoint({
		id: 'research.queries.list',
		path: '/api/research/queries',
		methods: ['GET'],
		access: { kind: 'permission', permission: RESEARCH_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const page = readPageQuery(new URL(octane.request.url), {
					maxLimit: RESEARCH_LIMITS.listMax,
					defaultLimit: RESEARCH_LIMITS.listDefault,
				});
				const result = await (
					await runtime.service()
				).listQueries(
					principalFromContext(octane)!.tenantId,
					page.limit,
					position(page.cursor, 'queries'),
				);
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor: nextCursor(result.next, 'queries'),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const search = defineEndpoint({
		id: 'research.search.run',
		path: '/api/research/search',
		methods: ['POST'],
		access: { kind: 'permission', permission: RESEARCH_PERMISSIONS.run },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const freshness = optionalString(value, 'freshness', 8);
				const site = optionalString(value, 'site', RESEARCH_LIMITS.site);
				const answer = await (
					await runtime.service()
				).search(
					{
						tenantId: principal.tenantId,
						query: requiredString(value, 'query', {
							max: RESEARCH_LIMITS.query,
						}),
						...(value.limit === undefined
							? {}
							: {
									limit: requiredInteger(value, 'limit', {
										min: 1,
										max: RESEARCH_LIMITS.searchMax,
									}),
								}),
						...(freshness === null
							? {}
							: { freshness: freshness as ResearchFreshness }),
						...(site === null ? {} : { site }),
						caller: 'member',
						callerRef: principal.accountId,
						signal: octane.request.signal,
					},
					principal.accountId,
				);
				return jsonResponse(answer);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const fetchPage = defineEndpoint({
		id: 'research.fetch.run',
		path: '/api/research/fetch',
		methods: ['POST'],
		access: { kind: 'permission', permission: RESEARCH_PERMISSIONS.run },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const page = await (
					await runtime.service()
				).fetch(
					{
						tenantId: principal.tenantId,
						url: requiredString(value, 'url', { max: RESEARCH_LIMITS.url }),
						caller: 'member',
						callerRef: principal.accountId,
						signal: octane.request.signal,
					},
					principal.accountId,
				);
				return jsonResponse({
					page: {
						...page,
						text: page.text.slice(0, RESEARCH_LIMITS.memberFetchText),
						truncated:
							page.truncated ||
							page.text.length > RESEARCH_LIMITS.memberFetchText,
					},
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const attach = defineEndpoint({
		id: 'research.evidence.attach',
		path: '/api/research/evidence/attach',
		methods: ['POST'],
		access: { kind: 'permission', permission: RESEARCH_PERMISSIONS.run },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const ownerModule = requiredString(value, 'ownerModule', {
					max: RESEARCH_LIMITS.ownerModule,
				});
				/* The capability trusts the module that calls it; a member naming a
				   record of another module must hold a scope of that module, so a
				   citation cannot be planted on records the member cannot reach. */
				const namespace = ownerModule.split('.')[0] + '.';
				if (!principal.scopes.some((scope) => scope.startsWith(namespace))) {
					throw new ResearchServiceError(
						'RESEARCH_ATTACH_FORBIDDEN',
						`Attaching evidence to ${ownerModule} records needs a permission of that module.`,
						403,
					);
				}
				const ids = value.evidenceIds;
				if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
					throw new HttpProblem(
						'INVALID_INPUT',
						'evidenceIds must be a list of evidence ids.',
						400,
					);
				}
				await (
					await runtime.service()
				).attach(
					principal.tenantId,
					ownerModule,
					requiredString(value, 'recordRef', {
						max: RESEARCH_LIMITS.recordRef,
					}),
					ids as string[],
				);
				return jsonResponse({ attached: ids.length });
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		listEvidence.serverRoute,
		attach.serverRoute,
		evidence.serverRoute,
		listQueries.serverRoute,
		search.serverRoute,
		fetchPage.serverRoute,
	] as const;
}

export const endpoints = [
	'research.evidence.list',
	'research.evidence.attach',
	'research.evidence.get',
	'research.queries.list',
	'research.search.run',
	'research.fetch.run',
] as const;
