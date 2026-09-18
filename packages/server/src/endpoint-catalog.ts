import type { ServerRoute } from '@octanejs/app-core';

/**
 * What one endpoint tells an external caller about itself. Every field is
 * optional for the endpoint that declares none: a module that documents
 * nothing still appears in the catalogue with its address, its methods and the
 * permission it demands, which is what a caller needs to reach it at all.
 */
export interface EndpointParameterDocumentation {
	readonly name: string;
	readonly in: 'query' | 'path';
	readonly description?: string;
	readonly required?: boolean;
	/** JSON Schema for the value, copied into the document as declared. */
	readonly schema?: Readonly<Record<string, unknown>>;
}

export interface EndpointBodyDocumentation {
	readonly description?: string;
	readonly schema?: Readonly<Record<string, unknown>>;
}

export interface EndpointResponseDocumentation {
	readonly status: number;
	readonly description: string;
	readonly schema?: Readonly<Record<string, unknown>>;
}

export interface EndpointDocumentation {
	readonly summary: string;
	readonly description?: string;
	readonly parameters?: readonly EndpointParameterDocumentation[];
	readonly body?: EndpointBodyDocumentation;
	readonly responses?: readonly EndpointResponseDocumentation[];
	readonly deprecated?: boolean;
}

export type EndpointAccess =
	| { readonly kind: 'public' }
	| { readonly kind: 'permission'; readonly permission: string };

export interface CatalogedEndpoint {
	readonly id: string;
	readonly path: string;
	readonly methods: readonly string[];
	readonly access: EndpointAccess;
	readonly documentation: EndpointDocumentation | null;
	/**
	 * The route the endpoint serves on. It is the key the platform's module
	 * binding answers, so the catalogue can name the owning module and ask
	 * whether it is active in a workspace without a module restating either.
	 */
	readonly route: ServerRoute;
}

export interface EndpointCatalog {
	/** Replaces the entry of the same id; a composition may run many times. */
	record(entry: CatalogedEndpoint): void;
	/** Drops every entry, before a new generation composes its modules. */
	beginGeneration(): void;
	list(): readonly CatalogedEndpoint[];
}

/* A deployment that composes more endpoints than this stops recording rather
   than growing without a bound. Nothing about serving an endpoint depends on
   the catalogue, so a refused entry costs its documentation, never its route. */
const MAX_ENDPOINTS = 4_096;
const MAX_SUMMARY = 160;
const MAX_DESCRIPTION = 1_024;
const MAX_PARAMETERS = 32;
const MAX_RESPONSES = 16;
/* Serialized JSON Schema bound, per schema. A schema is copied into the
   document as declared, so this is what keeps one module from making the
   document unservable. */
const MAX_SCHEMA_BYTES = 16_384;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function invalid(id: string, message: string): never {
	throw new Error(`Endpoint "${id}" documentation is invalid: ${message}`);
}

function text(id: string, value: unknown, max: number, field: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max) {
		invalid(id, `${field} must be 1 to ${max} characters.`);
	}
	return value;
}

function schema(
	id: string,
	value: unknown,
	field: string,
): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		invalid(id, `${field} must be a JSON Schema object.`);
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		invalid(id, `${field} must be JSON-serializable.`);
	}
	if (
		serialized === undefined ||
		new TextEncoder().encode(serialized).length > MAX_SCHEMA_BYTES
	) {
		invalid(
			id,
			`${field} must serialize to at most ${MAX_SCHEMA_BYTES} bytes.`,
		);
	}
	return Object.freeze(JSON.parse(serialized) as Record<string, unknown>);
}

/**
 * Validates and freezes what an endpoint declares about itself. It runs at
 * definition time, so a malformed declaration fails the composition rather
 * than the request that reads the document.
 */
export function validateEndpointDocumentation(
	id: string,
	value: EndpointDocumentation,
): EndpointDocumentation {
	if (!value || typeof value !== 'object') invalid(id, 'it must be an object.');
	const parameters = value.parameters ?? [];
	if (!Array.isArray(parameters) || parameters.length > MAX_PARAMETERS) {
		invalid(id, `parameters must name at most ${MAX_PARAMETERS} values.`);
	}
	const names = new Set<string>();
	for (const parameter of parameters) {
		if (
			!parameter ||
			typeof parameter.name !== 'string' ||
			!PARAMETER_NAME.test(parameter.name) ||
			(parameter.in !== 'query' && parameter.in !== 'path')
		) {
			invalid(id, 'a parameter needs a name and in of query or path.');
		}
		if (names.has(`${parameter.in}:${parameter.name}`)) {
			invalid(id, `parameter ${parameter.name} is named twice.`);
		}
		names.add(`${parameter.in}:${parameter.name}`);
	}
	const responses = value.responses ?? [];
	if (!Array.isArray(responses) || responses.length > MAX_RESPONSES) {
		invalid(id, `responses must name at most ${MAX_RESPONSES} statuses.`);
	}
	const statuses = new Set<number>();
	for (const response of responses) {
		if (
			!response ||
			!Number.isInteger(response.status) ||
			response.status < 100 ||
			response.status > 599
		) {
			invalid(id, 'a response needs an HTTP status between 100 and 599.');
		}
		if (statuses.has(response.status)) {
			invalid(id, `response ${response.status} is declared twice.`);
		}
		statuses.add(response.status);
	}
	return Object.freeze({
		summary: text(id, value.summary, MAX_SUMMARY, 'summary'),
		...(value.description === undefined
			? {}
			: {
					description: text(
						id,
						value.description,
						MAX_DESCRIPTION,
						'description',
					),
				}),
		...(value.deprecated === undefined
			? {}
			: { deprecated: value.deprecated === true }),
		...(parameters.length === 0
			? {}
			: {
					parameters: Object.freeze(
						parameters.map((parameter) =>
							Object.freeze({
								name: parameter.name,
								in: parameter.in,
								...(parameter.description === undefined
									? {}
									: {
											description: text(
												id,
												parameter.description,
												MAX_DESCRIPTION,
												'a parameter description',
											),
										}),
								...(parameter.required === undefined
									? {}
									: { required: parameter.required === true }),
								...(parameter.schema === undefined
									? {}
									: {
											schema: schema(
												id,
												parameter.schema,
												`parameter ${parameter.name} schema`,
											),
										}),
							}),
						),
					),
				}),
		...(value.body === undefined
			? {}
			: {
					body: Object.freeze({
						...(value.body.description === undefined
							? {}
							: {
									description: text(
										id,
										value.body.description,
										MAX_DESCRIPTION,
										'the body description',
									),
								}),
						...(value.body.schema === undefined
							? {}
							: { schema: schema(id, value.body.schema, 'the body schema') }),
					}),
				}),
		...(responses.length === 0
			? {}
			: {
					responses: Object.freeze(
						responses.map((response) =>
							Object.freeze({
								status: response.status,
								description: text(
									id,
									response.description,
									MAX_DESCRIPTION,
									`response ${response.status} description`,
								),
								...(response.schema === undefined
									? {}
									: {
											schema: schema(
												id,
												response.schema,
												`response ${response.status} schema`,
											),
										}),
							}),
						),
					),
				}),
	});
}

export function createEndpointCatalog(): EndpointCatalog {
	const entries = new Map<string, CatalogedEndpoint>();
	return Object.freeze({
		record(entry: CatalogedEndpoint) {
			if (!entries.has(entry.id) && entries.size >= MAX_ENDPOINTS) return;
			entries.set(entry.id, entry);
		},
		beginGeneration() {
			entries.clear();
		},
		list: () => Object.freeze([...entries.values()]),
	});
}

let processCatalog: EndpointCatalog | undefined;

/**
 * Every endpoint this process defined. `defineEndpoint` records itself here,
 * so a module that was never changed for it is described too and a module a
 * sandbox session wrote is described the moment it composes. A new generation
 * clears it before the modules compose again, so a disabled module leaves no
 * operation behind.
 */
export function serverEndpointCatalog(): EndpointCatalog {
	return (processCatalog ??= createEndpointCatalog());
}
