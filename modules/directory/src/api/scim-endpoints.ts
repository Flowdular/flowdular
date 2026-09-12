import {
	defineEndpoint,
	serverLogger,
	type EndpointExecutionContext,
} from '@flowdular/server';
import type { ModuleSettingsRuntime } from '@flowdular/kernel';
import { AuthServiceError } from '@flowdular/module-auth/server';
import {
	resourceTypes,
	schemas,
	scimErrorResponse,
	ScimError,
	scimResponse,
	serviceProviderConfig,
	SCIM_SCHEMAS,
} from '../domain/scim.ts';
import { DIRECTORY_REASONS } from '../domain/types.ts';
import type { DirectoryAuthPort } from '../services/auth-port.ts';
import {
	MAX_GROUP_MEMBERS,
	type ScimRequestContext,
} from '../services/provisioning-service.ts';
import { scimTokenFingerprint } from '../services/token-service.ts';
import { directoryDefaultRole, directoryPageSizeMax } from '../settings.ts';
import type { DirectoryRuntime } from '../server/runtime.ts';

type Context = EndpointExecutionContext['octane'];

/**
 * The SCIM surface is mounted under `/api` rather than the bare `/scim/v2` the
 * specification names, for two routing facts. A deployment with no database yet
 * answers JSON under `/api/*` for every method and an HTML redirect to the
 * installer everywhere else, which a SCIM client cannot read. And `api` is a
 * reserved web-surface prefix, so no operator mount can ever shadow these
 * routes, while `scim` is not reserved and could be mounted over.
 */
export const SCIM_BASE_PATH = '/api/scim/v2/:workspace';

/** The ceiling `readJsonObject` applies to every other module body. */
const MAX_SCIM_ENVELOPE_BYTES = 16_384;
/**
 * A group write carries its whole membership, so the body ceiling admits
 * `MAX_GROUP_MEMBERS` entries at the size of the widest one a provider sends,
 * `{ value, display, $ref }` with an absolute `$ref` of this surface, plus the
 * platform body limit for everything around the array. A ceiling below this
 * would refuse a group the service provider configuration advertises as legal.
 * At the values below that is 1000 * 512 + 16384 = 528_384 bytes.
 */
const MAX_SCIM_MEMBER_BYTES = 512;
const MAX_SCIM_BODY_BYTES =
	MAX_GROUP_MEMBERS * MAX_SCIM_MEMBER_BYTES + MAX_SCIM_ENVELOPE_BYTES;
const SCIM_MEDIA_TYPES = ['application/scim+json', 'application/json'];
const ADDRESS_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;

function unauthorized(): ScimError {
	return new ScimError(
		401,
		null,
		DIRECTORY_REASONS.unauthorized,
		'A valid SCIM token of this workspace is required.',
	);
}

function bearerToken(header: string | null): string | null {
	if (!header) return null;
	const [scheme, value] = header.split(' ');
	return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/* Octane hands a route a Web Request without the socket address, so the caller
   address is known only behind a reverse proxy this deployment trusts to set
   it, exactly as auth.core reads one. An address read from an untrusted header
   would let a flood pick a new window per request, so without a trusted proxy
   the caller is unidentified: every caller of a workspace shares one window,
   which then bounds the evidence kept rather than cutting anyone off. */
function callerAddress(request: Request, trustProxy: boolean): string {
	if (!trustProxy) return '';
	const first =
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
	return ADDRESS_PATTERN.test(first) ? first.toLowerCase() : '';
}

/**
 * The SCIM media type is `application/scim+json`, which `readJsonObject` does
 * not accept, so the bounds it enforces are repeated here against both types:
 * 415 on anything else, 413 above 16 KB declared or actual.
 */
async function readScimBody(
	request: Request,
): Promise<Record<string, unknown>> {
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
	if (!SCIM_MEDIA_TYPES.some((type) => contentType.startsWith(type))) {
		throw new ScimError(
			415,
			null,
			DIRECTORY_REASONS.invalidValue,
			'Expected application/scim+json.',
		);
	}
	const declared = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(declared) && declared > MAX_SCIM_BODY_BYTES) {
		throw new ScimError(
			413,
			null,
			DIRECTORY_REASONS.invalidValue,
			'The request body is too large.',
		);
	}
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_SCIM_BODY_BYTES) {
		throw new ScimError(
			413,
			null,
			DIRECTORY_REASONS.invalidValue,
			'The request body is too large.',
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body) as unknown;
	} catch {
		throw new ScimError(
			400,
			'invalidValue',
			DIRECTORY_REASONS.invalidValue,
			'The request body is not valid JSON.',
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ScimError(
			400,
			'invalidValue',
			DIRECTORY_REASONS.invalidValue,
			'Expected a JSON object.',
		);
	}
	return parsed as Record<string, unknown>;
}

export interface ScimRoutesOptions {
	readonly now?: () => number;
	/** Honor x-forwarded-for; only behind a reverse proxy that sets it. */
	readonly trustProxy?: boolean;
}

export function createScimRoutes(
	authPort: DirectoryAuthPort,
	runtime: DirectoryRuntime,
	settings: ModuleSettingsRuntime,
	options: ScimRoutesOptions = {},
) {
	const now = options.now ?? Date.now;
	const trustProxy = options.trustProxy ?? false;

	const rateLimited = (detail: string): ScimError =>
		new ScimError(429, null, DIRECTORY_REASONS.rateLimited, detail);

	/**
	 * Authentication happens before anything reads the body: the credential, the
	 * per-token limit, the workspace and the token row, in that order. Every
	 * refusal answers the same 401, so an unknown token cannot be told apart
	 * from a revoked, expired or foreign one, and every one of them is charged
	 * to the caller rather than to the invented credential it presented. The
	 * caller's budget is read only once a credential has failed to resolve, so
	 * no flood can refuse a credential that does resolve; what one credential
	 * costs the token store is bounded by its own window instead.
	 */
	const authenticate = async (octane: Context): Promise<ScimRequestContext> => {
		const presented = bearerToken(octane.request.headers.get('authorization'));
		const workspace = octane.params.workspace ?? '';
		const at = now();
		const address = callerAddress(octane.request, trustProxy);
		const caller = 'caller:' + workspace.slice(0, 128) + '|' + address;
		/* The spent budget answers 429 only to a caller a trusted proxy named:
		   an unidentified one shares its window with everyone else calling this
		   workspace, so cutting it off would be the refusal this budget exists to
		   prevent. Either way the budget bounds the evidence, so a flood cannot
		   fill the log with lines that all say the same thing. */
		const refuse = (reason: string): ScimError => {
			runtime.limiter.recordRefusal(caller, at);
			if (runtime.limiter.withinRefusalBudget(caller, at)) {
				return refused(workspace, reason);
			}
			return address === ''
				? unauthorized()
				: rateLimited('Too many refused SCIM credentials from this caller.');
		};
		if (!presented || presented.length > 256) {
			throw refuse('missing-credential');
		}
		/* Keyed by the fingerprint the credential derives to, so the window map
		   never holds a token value and one provider's traffic is budgeted on its
		   own credential rather than on whoever shares its address. */
		if (
			!runtime.limiter.allow('token:' + scimTokenFingerprint(presented), at)
		) {
			throw rateLimited('Too many SCIM requests for this token.');
		}
		const tenantId =
			workspace.length > 0 && workspace.length <= 128
				? await authPort.findTenantId(workspace)
				: null;
		if (!tenantId) throw refuse('unknown-workspace');
		const token = await (
			await runtime.tokens()
		).authenticate(tenantId, presented);
		if (!token) throw refuse('rejected-credential');
		const url = new URL(octane.request.url);
		return {
			tenantId,
			token,
			baseUrl: `${url.origin}/api/scim/v2/${encodeURIComponent(workspace)}`,
			pageSizeMax: directoryPageSizeMax(settings),
			defaultRole: directoryDefaultRole(settings, tenantId),
		};
	};

	/* A refusal is evidence, but it has no token row to hang a provisioning
	   event on, so it is reported here without the credential or its digest.
	   The workspace reference is caller-supplied text; the logger bounds and
	   strips it, and it is truncated again here. */
	const refused = (workspace: string, reason: string): ScimError => {
		serverLogger().warn('scim request refused', {
			module: 'directory.core',
			fields: { workspace: workspace.slice(0, 128), reason },
		});
		return unauthorized();
	};

	const route = (
		id: string,
		path: string,
		methods: readonly string[],
		handler: (
			context: ScimRequestContext,
			octane: Context,
		) => Promise<Response>,
	) =>
		defineEndpoint({
			id,
			path: SCIM_BASE_PATH + path,
			methods: [...methods],
			/* A SCIM client holds no browser session and no member permission. Its
			   own bearer token, checked above before any body read, is the whole
			   authentication boundary, so CSRF does not apply. */
			access: { kind: 'public' },
			handler: async ({ octane }) => {
				try {
					return await handler(await authenticate(octane), octane);
				} catch (error) {
					if (error instanceof ScimError) return scimErrorResponse(error);
					/* A driver or provider error can carry bound values in its message,
					   so only the endpoint, the error name and auth.core's own stable
					   code are reported; the code is a fixed identifier, never a value
					   from the request. */
					serverLogger().error('scim operation failed', {
						module: 'directory.core',
						endpoint: id,
						err: { name: error instanceof Error ? error.name : 'non-error' },
						...(error instanceof AuthServiceError
							? { fields: { authCode: error.code } }
							: {}),
					});
					return scimErrorResponse(
						new ScimError(
							500,
							null,
							'INTERNAL_ERROR',
							'The request could not be completed.',
						),
					);
				}
			},
		});

	const listUsers = route(
		'directory.scim.users.list',
		'/Users',
		['GET'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).listUsers(context, new URL(octane.request.url)),
			),
	);

	const createUser = route(
		'directory.scim.users.create',
		'/Users',
		['POST'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).createUser(context, await readScimBody(octane.request)),
				201,
			),
	);

	const getUser = route(
		'directory.scim.users.get',
		'/Users/:id',
		['GET'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).getUser(context, octane.params.id ?? ''),
			),
	);

	const replaceUser = route(
		'directory.scim.users.replace',
		'/Users/:id',
		['PUT'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).replaceUser(
					context,
					octane.params.id ?? '',
					await readScimBody(octane.request),
				),
			),
	);

	const patchUser = route(
		'directory.scim.users.patch',
		'/Users/:id',
		['PATCH'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).patchUser(
					context,
					octane.params.id ?? '',
					await readScimBody(octane.request),
				),
			),
	);

	const deleteUser = route(
		'directory.scim.users.delete',
		'/Users/:id',
		['DELETE'],
		async (context, octane) => {
			await (
				await runtime.provisioning()
			).deleteUser(context, octane.params.id ?? '');
			return scimResponse(null, 204);
		},
	);

	const listGroups = route(
		'directory.scim.groups.list',
		'/Groups',
		['GET'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).listGroups(context, new URL(octane.request.url)),
			),
	);

	const createGroup = route(
		'directory.scim.groups.create',
		'/Groups',
		['POST'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).createGroup(context, await readScimBody(octane.request)),
				201,
			),
	);

	const getGroup = route(
		'directory.scim.groups.get',
		'/Groups/:id',
		['GET'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).getGroup(context, octane.params.id ?? ''),
			),
	);

	const replaceGroup = route(
		'directory.scim.groups.replace',
		'/Groups/:id',
		['PUT'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).replaceGroup(
					context,
					octane.params.id ?? '',
					await readScimBody(octane.request),
				),
			),
	);

	const patchGroup = route(
		'directory.scim.groups.patch',
		'/Groups/:id',
		['PATCH'],
		async (context, octane) =>
			scimResponse(
				await (
					await runtime.provisioning()
				).patchGroup(
					context,
					octane.params.id ?? '',
					await readScimBody(octane.request),
				),
			),
	);

	const deleteGroup = route(
		'directory.scim.groups.delete',
		'/Groups/:id',
		['DELETE'],
		async (context, octane) => {
			await (
				await runtime.provisioning()
			).deleteGroup(context, octane.params.id ?? '');
			return scimResponse(null, 204);
		},
	);

	const providerConfig = route(
		'directory.scim.service-provider-config',
		'/ServiceProviderConfig',
		['GET'],
		async (context) =>
			scimResponse(serviceProviderConfig(context.baseUrl, context.pageSizeMax)),
	);

	const types = route(
		'directory.scim.resource-types',
		'/ResourceTypes',
		['GET'],
		async (context) => {
			const resources = resourceTypes(context.baseUrl);
			return scimResponse({
				schemas: [SCIM_SCHEMAS.listResponse],
				totalResults: resources.length,
				startIndex: 1,
				itemsPerPage: resources.length,
				Resources: resources,
			});
		},
	);

	const schemaList = route(
		'directory.scim.schemas',
		'/Schemas',
		['GET'],
		async (context) => {
			const resources = schemas(context.baseUrl);
			return scimResponse({
				schemas: [SCIM_SCHEMAS.listResponse],
				totalResults: resources.length,
				startIndex: 1,
				itemsPerPage: resources.length,
				Resources: resources,
			});
		},
	);

	return [
		listUsers.serverRoute,
		createUser.serverRoute,
		getUser.serverRoute,
		replaceUser.serverRoute,
		patchUser.serverRoute,
		deleteUser.serverRoute,
		listGroups.serverRoute,
		createGroup.serverRoute,
		getGroup.serverRoute,
		replaceGroup.serverRoute,
		patchGroup.serverRoute,
		deleteGroup.serverRoute,
		providerConfig.serverRoute,
		types.serverRoute,
		schemaList.serverRoute,
	] as const;
}

export const scimEndpoints = [
	'directory.scim.users.list',
	'directory.scim.users.create',
	'directory.scim.users.get',
	'directory.scim.users.replace',
	'directory.scim.users.patch',
	'directory.scim.users.delete',
	'directory.scim.groups.list',
	'directory.scim.groups.create',
	'directory.scim.groups.get',
	'directory.scim.groups.replace',
	'directory.scim.groups.patch',
	'directory.scim.groups.delete',
	'directory.scim.service-provider-config',
	'directory.scim.resource-types',
	'directory.scim.schemas',
] as const;
