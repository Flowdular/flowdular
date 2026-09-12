import type { ConnectorDefinition, ConnectorOperation } from './types.ts';

export const HTTP_JSON_DEFINITION_KEY = 'http-json';

const PATH = {
	type: 'string',
	maxLength: 1024,
} as const;

const QUERY = {
	type: 'object',
	description: 'Flat query parameters appended to the path.',
} as const;

const BODY = {
	type: 'object',
	description: 'JSON request body.',
} as const;

const OUTPUT = {
	type: 'object',
	description: 'The parsed JSON response of the external system.',
} as const;

function operation(
	key: string,
	label: string,
	method: ConnectorOperation['method'],
	body: boolean,
): ConnectorOperation {
	return {
		key,
		label,
		method,
		/* The whole path comes from the call, so the template is one reserved
		   expansion: the generic connector has no fixed resource of its own. */
		path: '{+path}',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['path'],
			properties: body
				? { path: PATH, query: QUERY, body: BODY }
				: { path: PATH, query: QUERY },
		},
		outputSchema: OUTPUT,
	};
}

/**
 * The connector the platform ships so a workspace can reach a JSON API without
 * a module of its own. It fixes no host: the instance base URL, its allowlist
 * and the egress policy are the only bounds.
 */
export const HTTP_JSON_DEFINITION: ConnectorDefinition = {
	key: HTTP_JSON_DEFINITION_KEY,
	moduleId: 'connectors.core',
	label: 'Generic HTTP JSON',
	authKinds: ['none', 'api-key', 'bearer', 'oauth2-client-credentials'],
	operations: [
		operation('get', 'GET', 'GET', false),
		operation('post', 'POST', 'POST', true),
		operation('put', 'PUT', 'PUT', true),
		operation('patch', 'PATCH', 'PATCH', true),
		operation('delete', 'DELETE', 'DELETE', false),
	],
	defaultAllowedHosts: [],
};
