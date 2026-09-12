/**
 * The SCIM 2.0 wire contract directory.core answers on: schema identifiers,
 * the error and list envelopes, the supported filter grammar and the PATCH
 * shape. Nothing here touches persistence or auth.core.
 */
import { DIRECTORY_REASONS } from './types.ts';

export const SCIM_SCHEMAS = {
	error: 'urn:ietf:params:scim:api:messages:2.0:Error',
	listResponse: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
	patchOp: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
	user: 'urn:ietf:params:scim:schemas:core:2.0:User',
	group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
	serviceProviderConfig:
		'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
	resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
	schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

/**
 * The scimType values this module emits. RFC 7644 pairs each with 400 except
 * `uniqueness`, which is a 409; the status travels with the error so the two
 * can never drift apart.
 */
export type ScimType =
	| 'invalidFilter'
	| 'invalidValue'
	| 'mutability'
	| 'noTarget'
	| 'tooMany'
	| 'uniqueness';

/**
 * Every refusal the SCIM surface answers with. `reason` is the module's stable
 * code: it is what the provisioning log records and what an operator matches
 * on, because `scimType` is too coarse to tell two refusals apart.
 */
export class ScimError extends Error {
	constructor(
		readonly status: number,
		readonly scimType: ScimType | null,
		readonly reason: string,
		detail: string,
	) {
		super(detail);
		this.name = 'ScimError';
	}

	/* A deliberate extension of the RFC envelope: `reason` is additive, and a
	   client that only knows the standard fields reads the same error. */
	body(): Record<string, unknown> {
		return {
			schemas: [SCIM_SCHEMAS.error],
			status: String(this.status),
			...(this.scimType ? { scimType: this.scimType } : {}),
			detail: this.message,
			reason: this.reason,
		};
	}
}

export function scimResponse(body: unknown, status = 200): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: {
			...(status === 204 ? {} : { 'content-type': 'application/scim+json' }),
			'cache-control': 'no-store',
		},
	});
}

export function scimErrorResponse(error: ScimError): Response {
	return scimResponse(error.body(), error.status);
}

export interface ScimPage {
	readonly startIndex: number;
	readonly count: number;
}

export function listResponse(input: {
	readonly totalResults: number;
	readonly startIndex: number;
	readonly resources: readonly unknown[];
}): Record<string, unknown> {
	return {
		schemas: [SCIM_SCHEMAS.listResponse],
		totalResults: input.totalResults,
		startIndex: input.startIndex,
		itemsPerPage: input.resources.length,
		Resources: input.resources,
	};
}

/**
 * `startIndex` is 1-based per RFC 7644 and `count` is clamped to the platform
 * maximum rather than refused, so a provider asking for more than the
 * deployment allows still makes progress instead of failing every page.
 */
export function parsePage(url: URL, pageSizeMax: number): ScimPage {
	const startIndex = boundedNumber(url.searchParams.get('startIndex'), 1, 1);
	const count = boundedNumber(
		url.searchParams.get('count'),
		pageSizeMax,
		0,
		pageSizeMax,
	);
	return { startIndex, count };
}

function boundedNumber(
	raw: string | null,
	fallback: number,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (raw === null || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new ScimError(
			400,
			'invalidValue',
			DIRECTORY_REASONS.invalidValue,
			'startIndex and count must be integers.',
		);
	}
	if (value < minimum) return minimum;
	return value > maximum ? maximum : value;
}

export interface ScimFilter {
	readonly attribute: string;
	readonly value: string;
}

/* The attribute and the operator are both case-insensitive per RFC 7644. */
const FILTER_PATTERN =
	/^\s*([A-Za-z][A-Za-z0-9_$-]*)\s+(eq)\s+"((?:[^"\\]|\\.)*)"\s*$/i;
const MAX_FILTER_LENGTH = 512;

/**
 * Only `<attribute> eq "<value>"` over the attributes a resource declares.
 * Anything else is refused: answering a full listing to a filter the server
 * does not understand would hand the provider the wrong resource to act on.
 */
export function parseFilter(
	raw: string | null,
	allowed: readonly string[],
): ScimFilter | null {
	if (raw === null || raw.trim() === '') return null;
	const unsupported = (): never => {
		throw new ScimError(
			400,
			'invalidFilter',
			DIRECTORY_REASONS.unsupportedFilter,
			`Only ${allowed.map((name) => `${name} eq`).join(', ')} filters are supported.`,
		);
	};
	if (raw.length > MAX_FILTER_LENGTH) unsupported();
	const match = FILTER_PATTERN.exec(raw);
	if (!match) unsupported();
	const attribute = allowed.find(
		(name) => name.toLowerCase() === match![1]!.toLowerCase(),
	);
	if (!attribute) unsupported();
	return {
		attribute: attribute!,
		value: match![3]!.replaceAll(/\\(.)/g, '$1'),
	};
}

export type ScimPatchOperationKind = 'add' | 'replace' | 'remove';

export interface ScimPatchOperation {
	readonly op: ScimPatchOperationKind;
	readonly path: string | null;
	readonly value: unknown;
}

const MAX_PATCH_OPERATIONS = 100;

export function parsePatch(
	body: Record<string, unknown>,
): readonly ScimPatchOperation[] {
	const operations = body.Operations ?? body.operations;
	if (
		!Array.isArray(operations) ||
		operations.length === 0 ||
		operations.length > MAX_PATCH_OPERATIONS
	) {
		throw new ScimError(
			400,
			'invalidValue',
			DIRECTORY_REASONS.invalidValue,
			`Operations must be an array of 1 to ${MAX_PATCH_OPERATIONS} entries.`,
		);
	}
	return operations.map((entry: unknown) => {
		const record = (entry ?? {}) as Record<string, unknown>;
		const op = String(record.op ?? '').toLowerCase();
		if (op !== 'add' && op !== 'replace' && op !== 'remove') {
			throw new ScimError(
				400,
				'invalidValue',
				DIRECTORY_REASONS.unsupportedOperation,
				'op must be add, replace or remove.',
			);
		}
		const path = record.path;
		if (path !== undefined && (typeof path !== 'string' || path.length > 256)) {
			throw new ScimError(
				400,
				'noTarget',
				DIRECTORY_REASONS.unsupportedPath,
				'path must be an attribute name.',
			);
		}
		return {
			op,
			path: typeof path === 'string' && path.trim() !== '' ? path.trim() : null,
			value: record.value,
		};
	});
}

export interface ScimMeta {
	readonly resourceType: 'User' | 'Group';
	readonly created: string;
	readonly lastModified: string;
	readonly location: string;
}

export function scimMeta(input: {
	readonly resourceType: 'User' | 'Group';
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly baseUrl: string;
	readonly id: string;
}): ScimMeta {
	return {
		resourceType: input.resourceType,
		created: new Date(input.createdAt).toISOString(),
		lastModified: new Date(input.updatedAt).toISOString(),
		location: `${input.baseUrl}/${input.resourceType}s/${input.id}`,
	};
}

/** The discovery answers; every capability this version does not implement is declared false. */
export function serviceProviderConfig(
	baseUrl: string,
	maxResults: number,
): Record<string, unknown> {
	return {
		schemas: [SCIM_SCHEMAS.serviceProviderConfig],
		documentationUri: `${baseUrl}/ServiceProviderConfig`,
		patch: { supported: true },
		bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
		filter: { supported: true, maxResults },
		changePassword: { supported: false },
		sort: { supported: false },
		etag: { supported: false },
		authenticationSchemes: [
			{
				type: 'oauthbearertoken',
				name: 'OAuth Bearer Token',
				description:
					'A workspace-scoped SCIM token sent as Authorization: Bearer.',
				primary: true,
			},
		],
		meta: {
			resourceType: 'ServiceProviderConfig',
			location: `${baseUrl}/ServiceProviderConfig`,
		},
	};
}

export function resourceTypes(baseUrl: string): readonly unknown[] {
	return (['User', 'Group'] as const).map((name) => ({
		schemas: [SCIM_SCHEMAS.resourceType],
		id: name,
		name,
		endpoint: `/${name}s`,
		description: `${name} resources of this workspace.`,
		schema: name === 'User' ? SCIM_SCHEMAS.user : SCIM_SCHEMAS.group,
		meta: {
			resourceType: 'ResourceType',
			location: `${baseUrl}/ResourceTypes/${name}`,
		},
	}));
}

/* The minimal declaration of the attributes this version actually reads and
   writes. An attribute absent here is one the provider must not expect back. */
export function schemas(baseUrl: string): readonly unknown[] {
	const attribute = (
		name: string,
		type: 'string' | 'boolean' | 'complex',
		mutability: 'readWrite' | 'readOnly' | 'immutable',
		multiValued = false,
	) => ({
		name,
		type,
		multiValued,
		required: false,
		caseExact: false,
		mutability,
		returned: 'default',
		uniqueness: 'none',
	});
	return [
		{
			schemas: [SCIM_SCHEMAS.schema],
			id: SCIM_SCHEMAS.user,
			name: 'User',
			description: 'A workspace member provisioned by an identity provider.',
			attributes: [
				attribute('userName', 'string', 'immutable'),
				attribute('externalId', 'string', 'readWrite'),
				attribute('displayName', 'string', 'readWrite'),
				attribute('name', 'complex', 'readWrite'),
				attribute('emails', 'complex', 'readOnly', true),
				attribute('active', 'boolean', 'readWrite'),
			],
			meta: {
				resourceType: 'Schema',
				location: `${baseUrl}/Schemas/${SCIM_SCHEMAS.user}`,
			},
		},
		{
			schemas: [SCIM_SCHEMAS.schema],
			id: SCIM_SCHEMAS.group,
			name: 'Group',
			description: 'A provider group, optionally mapped to a workspace role.',
			attributes: [
				attribute('displayName', 'string', 'readWrite'),
				attribute('externalId', 'string', 'readWrite'),
				attribute('members', 'complex', 'readWrite', true),
			],
			meta: {
				resourceType: 'Schema',
				location: `${baseUrl}/Schemas/${SCIM_SCHEMAS.group}`,
			},
		},
	];
}
