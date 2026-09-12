import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	jsonResponse,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	optionalString,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { ACCESS_PERMISSIONS } from '../acl/permissions.ts';
import {
	ACCESS_LIMITS,
	type AccessWindow,
	type AttestationPosition,
	type AuditPosition,
} from '../domain/types.ts';
import type { AccessRuntime } from '../server/runtime.ts';
import { AccessServiceError, parseWindow } from '../services/access-service.ts';
import type { AccessReportKind } from '../services/changes.ts';

function failure(error: unknown): Response {
	if (error instanceof AccessServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The access review operation failed.');
}

function windowOf(url: URL): AccessWindow {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	if (from === null || to === null) {
		throw new AccessServiceError('INVALID_INPUT', 'from and to are required.');
	}
	return parseWindow(from, to);
}

export function createAccessRoutes(auth: AuthRuntime, runtime: AccessRuntime) {
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own report, so a restart invalidating one costs a reader the
	   first page. */
	const cursorSecret = randomBytes(32);

	/* Every cursor this module answers is signed with the same secret, so a
	   cursor from one report reaches another report's reader. Each one checks
	   the shape it needs rather than trusting the signature alone. */
	const invalidCursor = (): never => {
		throw new AccessServiceError(
			'CURSOR_INVALID',
			'The page cursor is not valid.',
		);
	};

	const auditCursor = (cursor: string | null): AuditPosition | null => {
		if (cursor === null) return null;
		const value = decodeCursor(cursor, cursorSecret);
		const occurredAt = value.occurredAt;
		const id = value.id;
		if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(id)) {
			invalidCursor();
		}
		return { occurredAt: occurredAt as number, id: id as number };
	};

	const attestationCursor = (
		cursor: string | null,
	): AttestationPosition | null => {
		if (cursor === null) return null;
		const value = decodeCursor(cursor, cursorSecret);
		const createdAt = value.createdAt;
		const id = value.id;
		if (!Number.isSafeInteger(createdAt) || typeof id !== 'string') {
			invalidCursor();
		}
		return { createdAt: createdAt as number, id: id as string };
	};

	/* Both reports answer the same body: the matched changes, the window they
	   were read over, and the position the next request resumes from. */
	const changes = (id: string, path: string, kind: AccessReportKind) =>
		defineEndpoint({
			id,
			path,
			methods: ['GET'],
			access: { kind: 'permission', permission: ACCESS_PERMISSIONS.read },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				try {
					const url = new URL(octane.request.url);
					const window = windowOf(url);
					const page = readPageQuery(url, {
						maxLimit: ACCESS_LIMITS.reportLimit,
						defaultLimit: ACCESS_LIMITS.reportDefault,
					});
					const result = await (
						await runtime.service()
					).changes(principalFromContext(octane)!.tenantId, kind, window, {
						limit: page.limit,
						after: auditCursor(page.cursor),
					});
					return jsonResponse({
						items: result.items,
						page: {
							nextCursor:
								result.next === null
									? null
									: encodeCursor({ ...result.next }, cursorSecret),
							limit: page.limit,
						},
						window: {
							from: result.window.from,
							to: result.window.to,
						},
						/* The trail this report covers. Holds and erasures live in
						   audit.core's own trail, which publishes no read capability,
						   so a later source is added here rather than silently. */
						source: 'auth.core',
					});
				} catch (error) {
					return failure(error);
				}
			},
		});

	const review = defineEndpoint({
		id: 'access.review.get',
		path: '/api/access/review',
		methods: ['GET'],
		access: { kind: 'permission', permission: ACCESS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				return jsonResponse({
					review: await service.review(principalFromContext(octane)!.tenantId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const diff = changes('access.diff.get', '/api/access/diff', 'diff');
	const activity = changes(
		'access.activity.get',
		'/api/access/activity',
		'activity',
	);

	const attest = defineEndpoint({
		id: 'access.attestations.create',
		path: '/api/access/attest',
		methods: ['POST'],
		access: { kind: 'permission', permission: ACCESS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const window = parseWindow(
					requiredString(value, 'from', { min: 10, max: 10 }),
					requiredString(value, 'to', { min: 10, max: 10 }),
				);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				/* The reviewer is the acting principal and the counts are the
				   server's own reading; the body carries the period and the note
				   and nothing that could dress up the evidence. */
				const attestation = await service.attest(
					principal.tenantId,
					{ accountId: principal.accountId, label: principal.email },
					{
						window,
						note: optionalString(value, 'note', ACCESS_LIMITS.note),
					},
				);
				return jsonResponse({ attestation }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const attestations = defineEndpoint({
		id: 'access.attestations.list',
		path: '/api/access/attestations',
		methods: ['GET'],
		access: { kind: 'permission', permission: ACCESS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const page = readPageQuery(new URL(octane.request.url), {
					maxLimit: ACCESS_LIMITS.attestationLimit,
					defaultLimit: ACCESS_LIMITS.attestationDefault,
				});
				const result = await (
					await runtime.service()
				).attestations(principalFromContext(octane)!.tenantId, {
					limit: page.limit,
					after: attestationCursor(page.cursor),
				});
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor:
						result.next === null
							? null
							: encodeCursor({ ...result.next }, cursorSecret),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		review.serverRoute,
		diff.serverRoute,
		activity.serverRoute,
		attest.serverRoute,
		attestations.serverRoute,
	] as const;
}

export const endpoints = [
	'access.review.get',
	'access.diff.get',
	'access.activity.get',
	'access.attestations.create',
	'access.attestations.list',
] as const;
