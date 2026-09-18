import { t } from '@flowdular/client/i18n';
import { ApiError } from './api.ts';

/* The document the platform serves is OpenAPI, which nests operations under a
   path and a method. A screen lists operations, so it is flattened once here
   and never re-walked while rendering. */
export interface ApiOperation {
	readonly id: string;
	readonly method: string;
	readonly path: string;
	readonly summary: string;
	readonly description: string;
	readonly moduleId: string;
	readonly permission: string | null;
	readonly needsWriteToken: boolean;
	readonly documented: boolean;
	readonly parameters: readonly ApiOperationParameter[];
	readonly requestBody: unknown;
	readonly responses: readonly ApiOperationResponse[];
}

export interface ApiOperationParameter {
	readonly name: string;
	readonly in: string;
	readonly required: boolean;
	readonly description: string;
}

export interface ApiOperationResponse {
	readonly status: string;
	readonly description: string;
}

export interface ApiDescription {
	readonly title: string;
	readonly version: string;
	readonly serverUrl: string;
	readonly operations: readonly ApiOperation[];
}

interface RawOperation {
	readonly operationId?: string;
	readonly summary?: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly parameters?: readonly {
		readonly name?: string;
		readonly in?: string;
		readonly required?: boolean;
		readonly description?: string;
	}[];
	readonly requestBody?: {
		readonly content?: Record<string, { readonly schema?: unknown }>;
	};
	readonly responses?: Record<string, { readonly description?: string }>;
	readonly 'x-flowdular-module'?: string;
	readonly 'x-flowdular-permission'?: string;
	readonly 'x-flowdular-token-write'?: boolean;
	readonly 'x-flowdular-documented'?: boolean;
}

interface RawDocument {
	readonly info?: { readonly title?: string; readonly version?: string };
	readonly servers?: readonly { readonly url?: string }[];
	readonly paths?: Record<string, Record<string, RawOperation>>;
	readonly error?: { readonly message?: string };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

export function describeApi(document: RawDocument): ApiDescription {
	const operations: ApiOperation[] = [];
	for (const [path, methods] of Object.entries(document.paths ?? {})) {
		for (const method of METHODS) {
			const operation = methods[method];
			if (!operation) continue;
			operations.push({
				id: operation.operationId ?? `${method}:${path}`,
				method: method.toUpperCase(),
				path,
				summary: operation.summary ?? path,
				description: operation.description ?? '',
				moduleId: operation.tags?.[0] ?? operation['x-flowdular-module'] ?? '',
				permission: operation['x-flowdular-permission'] ?? null,
				needsWriteToken: operation['x-flowdular-token-write'] === true,
				documented: operation['x-flowdular-documented'] !== false,
				parameters: (operation.parameters ?? []).map((parameter) => ({
					name: parameter.name ?? '',
					in: parameter.in ?? 'query',
					required: parameter.required === true,
					description: parameter.description ?? '',
				})),
				requestBody:
					operation.requestBody?.content?.['application/json']?.schema ?? null,
				responses: Object.entries(operation.responses ?? {}).map(
					([status, response]) => ({
						status,
						description: response.description ?? '',
					}),
				),
			});
		}
	}
	operations.sort((left, right) =>
		left.path === right.path
			? left.method.localeCompare(right.method)
			: left.path.localeCompare(right.path),
	);
	return {
		title: document.info?.title ?? '',
		version: document.info?.version ?? '',
		serverUrl: document.servers?.[0]?.url ?? '',
		operations,
	};
}

export async function loadApiDescription(): Promise<ApiDescription> {
	const response = await fetch('/api/openapi.json', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const document = (await response.json()) as RawDocument;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			document.error?.message ?? t('system.api.error.load'),
		);
	}
	return describeApi(document);
}

/** A call a reader can paste, with the token left as a placeholder. */
export function curlExample(
	operation: ApiOperation,
	serverUrl: string,
): string {
	const lines = [
		`curl -X ${operation.method} '${serverUrl}${operation.path}' \\`,
		"  -H 'authorization: Bearer $FLOWDULAR_TOKEN'",
	];
	if (operation.requestBody !== null) {
		lines[lines.length - 1] += ' \\';
		lines.push("  -H 'content-type: application/json' \\", "  -d '{}'");
	}
	return lines.join('\n');
}
