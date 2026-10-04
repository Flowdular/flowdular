import { createHash, randomUUID } from 'node:crypto';
import {
	AgentHarnessError,
	boundToolOutput,
	toolTimeoutMs,
	validateJsonValue,
	validateToolInput,
	validateToolOutput,
	type AgentTool,
	type AgentToolAccessAuthorizer,
	type AgentToolContext,
	type JsonValue,
	type WorkflowActionTemplateMetadata,
} from '@flowdular/harness';
import {
	actorsEqual,
	normalizeActor,
	type Actor,
	type UserActor,
} from '@flowdular/kernel';
import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
	serverLogger,
	type Tracer,
} from '@flowdular/server';
import type { AgentActionInvocation } from '../domain/types.ts';
import {
	DuplicateActionIdempotencyKeyError,
	type AgentRepository,
} from '../services/repository.ts';

export const AGENT_ACTION_EXECUTION_CAPABILITY = 'agents.actions.v1';
export const AGENT_ACTION_EXECUTION_CAPABILITY_V2 = 'agents.actions.v2';

export interface VersionedActionDescriptor {
	readonly id: string;
	readonly contractVersion: number;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly outputSchema: Readonly<Record<string, unknown>>;
	readonly timeoutMs: number;
	readonly idempotency: 'required';
	readonly risk: 'read' | 'workspace-write';
	readonly cancellation: 'cooperative' | 'not-supported';
}

export interface VersionedActionDescriptorV2 extends VersionedActionDescriptor {
	readonly idempotencyProtection?: 'target-ledger';
	readonly workflowTemplate?: WorkflowActionTemplateMetadata;
}

export interface ActionCancellationResult {
	readonly actionInvocationId: string;
	readonly state: 'acknowledged' | 'not-acknowledged' | 'not-supported';
}

export interface ActionInvocationAccepted {
	readonly actionInvocationId: string;
	readonly created: boolean;
}

export interface ActionExecutionResult {
	readonly actionInvocationId: string;
	readonly status: 'succeeded' | 'failed' | 'refused' | 'cancelled';
	readonly output?: JsonValue;
	readonly code?: string;
}

export interface AgentActionChildContext {
	readonly tenantId: string;
	readonly workflowRunId: string;
	readonly actor: Actor;
	readonly authorizationSubject?: UserActor;
	readonly permissionSnapshot: readonly string[];
}

export interface AgentActionStartContext extends AgentActionChildContext {
	readonly nodeRunId: string;
	readonly signal: AbortSignal;
}

export interface AgentActionExecutionCapability {
	listWorkflowActions(): Promise<readonly VersionedActionDescriptor[]>;
	start(
		request: {
			readonly actionId: string;
			readonly contractVersion: number;
			readonly input: JsonValue;
			/** Deduplicates this one workflow attempt. */
			readonly idempotencyKey: string;
			/** Reused by the external tool across attempts; defaults to idempotencyKey. */
			readonly sideEffectIdempotencyKey?: string;
		},
		context: AgentActionStartContext,
	): Promise<ActionInvocationAccepted>;
	getResult(
		actionInvocationId: string,
		context: AgentActionChildContext,
	): Promise<ActionExecutionResult | null>;
	requestCancel(
		actionInvocationId: string,
		context: AgentActionChildContext,
	): Promise<ActionCancellationResult>;
}

export interface AgentActionExecutionCapabilityV2
	extends Omit<AgentActionExecutionCapability, 'listWorkflowActions'> {
	listWorkflowActions(): Promise<readonly VersionedActionDescriptorV2[]>;
}

export class AgentActionCapabilityError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AgentActionCapabilityError';
	}
}

export interface AgentActionRuntime {
	readonly capability: AgentActionExecutionCapability;
	readonly capabilityV2: AgentActionExecutionCapabilityV2;
	start(): void;
	stop(): void;
	dispose(): Promise<void>;
}

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
) {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AgentActionCapabilityError(
			'ACTION_INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	return normalized;
}

function canonical(value: JsonValue): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
		.join(',')}}`;
}

function workflowSchema(
	value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | null {
	if (!value || Array.isArray(value) || typeof value !== 'object') return null;
	try {
		validateJsonValue(value, 'ACTION_SCHEMA_INVALID', 'Action schema');
		const serialized = JSON.stringify(value);
		if (serialized.length > 32_768) return null;
		return JSON.parse(serialized) as Record<string, unknown>;
	} catch {
		return null;
	}
}

const WORKFLOW_SCHEMA_KEYS = new Set([
	'$id',
	'title',
	'description',
	'type',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'enum',
	'const',
	'minLength',
	'maxLength',
	'minimum',
	'maximum',
	'writeOnly',
	'x-flowdular-secret',
	'x-coreloom-secret',
	'x-flowdular-read-permission',
]);
const WORKFLOW_SCHEMA_ROOT_KEYS = new Set(
	[...WORKFLOW_SCHEMA_KEYS].filter(
		(key) =>
			![
				'writeOnly',
				'x-flowdular-secret',
				'x-coreloom-secret',
				'x-flowdular-read-permission',
			].includes(key),
	),
);

function workflowTemplateSchemaSupported(
	value: Readonly<Record<string, unknown>>,
): boolean {
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) return false;
	const depthSupported = (entry: unknown, depth: number): boolean => {
		if (depth > 12) return false;
		if (Array.isArray(entry))
			return entry.every((child) => depthSupported(child, depth + 1));
		if (entry !== null && typeof entry === 'object')
			return Object.values(entry).every((child) =>
				depthSupported(child, depth + 1),
			);
		return true;
	};
	const schemaSupported = (schema: unknown, root = false): boolean => {
		if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
			return false;
		const record = schema as Readonly<Record<string, unknown>>;
		const allowed = root ? WORKFLOW_SCHEMA_ROOT_KEYS : WORKFLOW_SCHEMA_KEYS;
		if (Object.keys(record).some((key) => !allowed.has(key))) return false;
		const supportedType = (candidate: unknown): boolean =>
			typeof candidate === 'string' &&
			[
				'null',
				'string',
				'number',
				'integer',
				'boolean',
				'array',
				'object',
			].includes(candidate);
		if (
			(record.type !== undefined &&
				(Array.isArray(record.type)
					? record.type.length === 0 || !record.type.every(supportedType)
					: !supportedType(record.type))) ||
			(record.required !== undefined &&
				(!Array.isArray(record.required) ||
					!record.required.every((name) => typeof name === 'string'))) ||
			(record.additionalProperties !== undefined &&
				typeof record.additionalProperties !== 'boolean') ||
			(record.items !== undefined && !schemaSupported(record.items)) ||
			(record.properties !== undefined &&
				(record.properties === null ||
					typeof record.properties !== 'object' ||
					Array.isArray(record.properties) ||
					!Object.values(record.properties).every((child) =>
						schemaSupported(child),
					))) ||
			(record.enum !== undefined &&
				(!Array.isArray(record.enum) ||
					!record.enum.every(
						(entry) => entry === null || typeof entry !== 'object',
					))) ||
			['writeOnly', 'x-flowdular-secret', 'x-coreloom-secret'].some(
				(key) => key in record && typeof record[key] !== 'boolean',
			) ||
			(record['x-flowdular-read-permission'] !== undefined &&
				typeof record['x-flowdular-read-permission'] !== 'string') ||
			['minLength', 'maxLength'].some(
				(key) =>
					key in record &&
					(!Number.isSafeInteger(record[key]) || (record[key] as number) < 0),
			) ||
			['minimum', 'maximum'].some(
				(key) => key in record && typeof record[key] !== 'number',
			)
		)
			return false;
		return true;
	};
	return depthSupported(value, 0) && schemaSupported(value, true);
}

const SECRET_SCHEMA_MARKERS = [
	'writeOnly',
	'x-flowdular-secret',
	'x-coreloom-secret',
] as const;
const SECRET_SCHEMA_VALUE_KEYS = [
	'default',
	'const',
	'enum',
	'example',
	'examples',
] as const;
const SAME_INSTANCE_SCHEMA_KEYS = ['allOf'] as const;
const OPAQUE_SECRET_SCHEMA_KEYS = [
	'anyOf',
	'oneOf',
	'if',
	'then',
	'else',
	'not',
	'dependentSchemas',
	'dependentRequired',
	'$ref',
	'$dynamicRef',
	'$recursiveRef',
] as const;
const SCHEMA_VALUE_RELATIONSHIP_KEYS = new Set([
	'$defs',
	'definitions',
	'$ref',
	'$dynamicRef',
	'$recursiveRef',
	'properties',
	'patternProperties',
	'additionalProperties',
	'unevaluatedProperties',
	'items',
	'prefixItems',
	'additionalItems',
	'unevaluatedItems',
	'contains',
	'allOf',
	'anyOf',
	'oneOf',
	'if',
	'then',
	'else',
	'not',
	'dependentSchemas',
]);

function containsSecretMarker(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretMarker);
	if (!value || typeof value !== 'object') return false;
	const schema = value as Record<string, unknown>;
	if (SECRET_SCHEMA_MARKERS.some((marker) => schema[marker] === true)) {
		return true;
	}
	return Object.entries(schema).some(
		([name, child]) =>
			!SECRET_SCHEMA_VALUE_KEYS.includes(
				name as (typeof SECRET_SCHEMA_VALUE_KEYS)[number],
			) && containsSecretMarker(child),
	);
}

function containsOpaqueSecretSchema(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsOpaqueSecretSchema);
	if (!value || typeof value !== 'object') return false;
	const schema = value as Record<string, unknown>;
	if (
		OPAQUE_SECRET_SCHEMA_KEYS.some((key) => key in schema) &&
		containsSecretMarker(schema)
	) {
		return true;
	}
	return Object.entries(schema).some(
		([name, child]) =>
			!SECRET_SCHEMA_VALUE_KEYS.includes(
				name as (typeof SECRET_SCHEMA_VALUE_KEYS)[number],
			) && containsOpaqueSecretSchema(child),
	);
}

function referencedSchema(root: unknown, reference: string): unknown {
	if (!reference.startsWith('#/')) return undefined;
	let current = root;
	for (const encoded of reference.slice(2).split('/')) {
		const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function schemaValueContainsSecret(
	schemaValue: unknown,
	instanceValue: unknown,
	root: unknown,
	depth = 0,
): boolean {
	if (
		!schemaValue ||
		typeof schemaValue !== 'object' ||
		Array.isArray(schemaValue)
	) {
		return false;
	}
	const schema = schemaValue as Record<string, unknown>;
	if (SECRET_SCHEMA_MARKERS.some((marker) => schema[marker] === true)) {
		return true;
	}
	if (depth >= 64) return containsSecretMarker(schema);
	for (const key of ['$ref', '$dynamicRef', '$recursiveRef'] as const) {
		if (typeof schema[key] === 'string') {
			const target = referencedSchema(root, schema[key]);
			if (target === undefined) return containsSecretMarker(root);
			if (schemaValueContainsSecret(target, instanceValue, root, depth + 1)) {
				return true;
			}
		}
	}
	for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
		const alternatives = schema[key];
		if (
			Array.isArray(alternatives) &&
			alternatives.some((child) =>
				schemaValueContainsSecret(child, instanceValue, root, depth + 1),
			)
		) {
			return true;
		}
	}
	for (const key of ['if', 'then', 'else', 'not'] as const) {
		if (
			schemaValueContainsSecret(schema[key], instanceValue, root, depth + 1)
		) {
			return true;
		}
	}
	if (Array.isArray(instanceValue)) {
		const prefixItems = schema.prefixItems;
		for (let index = 0; index < instanceValue.length; index++) {
			const tuple = Array.isArray(prefixItems)
				? prefixItems
				: Array.isArray(schema.items)
					? schema.items
					: null;
			const child =
				tuple && index < tuple.length
					? tuple[index]
					: Array.isArray(schema.items)
						? schema.additionalItems
						: schema.items;
			if (
				schemaValueContainsSecret(child, instanceValue[index], root, depth + 1)
			) {
				return true;
			}
			if (
				schemaValueContainsSecret(
					schema.unevaluatedItems,
					instanceValue[index],
					root,
					depth + 1,
				)
			) {
				return true;
			}
			if (
				schemaValueContainsSecret(
					schema.contains,
					instanceValue[index],
					root,
					depth + 1,
				)
			) {
				return true;
			}
		}
	}
	if (
		instanceValue &&
		typeof instanceValue === 'object' &&
		!Array.isArray(instanceValue)
	) {
		const values = instanceValue as Record<string, unknown>;
		const dependentSchemas = schema.dependentSchemas;
		if (
			dependentSchemas &&
			typeof dependentSchemas === 'object' &&
			!Array.isArray(dependentSchemas)
		) {
			for (const [name, childSchema] of Object.entries(dependentSchemas)) {
				if (
					name in values &&
					schemaValueContainsSecret(childSchema, instanceValue, root, depth + 1)
				) {
					return true;
				}
			}
		}
		const properties = schema.properties;
		const propertySchemas =
			properties && typeof properties === 'object' && !Array.isArray(properties)
				? (properties as Record<string, unknown>)
				: {};
		for (const [name, childValue] of Object.entries(values)) {
			if (
				schemaValueContainsSecret(
					propertySchemas[name],
					childValue,
					root,
					depth + 1,
				)
			) {
				return true;
			}
			if (
				!(name in propertySchemas) &&
				schemaValueContainsSecret(
					schema.additionalProperties,
					childValue,
					root,
					depth + 1,
				)
			) {
				return true;
			}
			if (
				schemaValueContainsSecret(
					schema.unevaluatedProperties,
					childValue,
					root,
					depth + 1,
				)
			) {
				return true;
			}
		}
		if (
			Object.keys(values).length > 0 &&
			containsSecretMarker(schema.patternProperties)
		) {
			return true;
		}
	}
	for (const [name, child] of Object.entries(schema)) {
		if (
			SCHEMA_VALUE_RELATIONSHIP_KEYS.has(name) ||
			SECRET_SCHEMA_VALUE_KEYS.includes(
				name as (typeof SECRET_SCHEMA_VALUE_KEYS)[number],
			)
		) {
			continue;
		}
		if (containsSecretMarker(child)) return true;
	}
	return false;
}

function composedRequiredNames(
	value: unknown,
	names = new Set<string>(),
): Set<string> {
	if (Array.isArray(value)) {
		for (const child of value) composedRequiredNames(child, names);
		return names;
	}
	if (!value || typeof value !== 'object') return names;
	const schema = value as Record<string, unknown>;
	if (Array.isArray(schema.required)) {
		for (const name of schema.required) {
			if (typeof name === 'string') names.add(name);
		}
	}
	for (const key of SAME_INSTANCE_SCHEMA_KEYS) {
		composedRequiredNames(schema[key], names);
	}
	return names;
}

function secretSchemaIssue(
	value: unknown,
	required = false,
	inheritedRequiredNames?: ReadonlySet<string>,
	root: unknown = value,
): 'value' | 'required-input' | null {
	if (Array.isArray(value)) {
		for (const child of value) {
			const issue = secretSchemaIssue(
				child,
				required,
				inheritedRequiredNames,
				root,
			);
			if (issue) return issue;
		}
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const schema = value as Record<string, unknown>;
	const secret = SECRET_SCHEMA_MARKERS.some(
		(marker) => schema[marker] === true,
	);
	if (secret && SECRET_SCHEMA_VALUE_KEYS.some((key) => key in schema)) {
		return 'value';
	}
	if (
		SECRET_SCHEMA_VALUE_KEYS.some((key) => {
			if (!(key in schema)) return false;
			if (
				(key === 'enum' || key === 'examples') &&
				!Array.isArray(schema[key])
			) {
				return containsSecretMarker(schema);
			}
			const candidates =
				key === 'enum' || key === 'examples' ? schema[key] : [schema[key]];
			return (
				Array.isArray(candidates) &&
				candidates.some((candidate) =>
					schemaValueContainsSecret(schema, candidate, root),
				)
			);
		})
	) {
		return 'value';
	}
	if (secret && required) return 'required-input';
	const requiredNames = composedRequiredNames(schema);
	for (const name of inheritedRequiredNames ?? []) requiredNames.add(name);
	const properties = schema.properties;
	if (
		properties &&
		typeof properties === 'object' &&
		!Array.isArray(properties)
	) {
		for (const [name, child] of Object.entries(properties)) {
			const issue = secretSchemaIssue(
				child,
				required && requiredNames.has(name),
				undefined,
				root,
			);
			if (issue) return issue;
		}
	}
	for (const [name, child] of Object.entries(schema)) {
		if (
			name === 'properties' ||
			name === 'required' ||
			SECRET_SCHEMA_VALUE_KEYS.includes(
				name as (typeof SECRET_SCHEMA_VALUE_KEYS)[number],
			)
		) {
			continue;
		}
		const issue = secretSchemaIssue(
			child,
			required,
			SAME_INSTANCE_SCHEMA_KEYS.includes(
				name as (typeof SAME_INSTANCE_SCHEMA_KEYS)[number],
			)
				? requiredNames
				: undefined,
			root,
		);
		if (issue) return issue;
	}
	return null;
}

function validatedWorkflowTemplate(
	value: unknown,
): WorkflowActionTemplateMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new AgentActionCapabilityError(
			'ACTION_TEMPLATE_INVALID',
			'Workflow action template metadata is invalid.',
		);
	}
	const metadata = value as Record<string, unknown>;
	const validText = (text: unknown, maximum: number): text is string =>
		typeof text === 'string' &&
		text.trim().length > 0 &&
		text.length <= maximum &&
		!text.includes('{{') &&
		!text.includes('${') &&
		![...text].some((character) => {
			const point = character.codePointAt(0)!;
			return point < 32 || point === 127;
		});
	if (
		Object.keys(metadata).some(
			(key) => key !== 'label' && key !== 'description' && key !== 'effect',
		) ||
		!validText(metadata.label, 80) ||
		!validText(metadata.description, 240) ||
		(metadata.effect !== 'local' && metadata.effect !== 'connector-egress')
	) {
		throw new AgentActionCapabilityError(
			'ACTION_TEMPLATE_INVALID',
			'Workflow action template metadata is invalid.',
		);
	}
	return {
		label: metadata.label,
		description: metadata.description,
		effect: metadata.effect,
	};
}

/* Match the harness and CLI runner's FD_ENV ceiling for local capabilities. */
function localOnlyRefused(tool: AgentTool): boolean {
	const environment =
		process.env.FD_ENV ?? process.env.NODE_ENV ?? 'development';
	return (
		tool.localOnly === true &&
		environment !== 'development' &&
		environment !== 'test'
	);
}

function descriptor(tool: AgentTool): VersionedActionDescriptorV2 | null {
	if (localOnlyRefused(tool)) return null;
	const inputSchema = workflowSchema(tool.inputSchema);
	const outputSchema = workflowSchema(tool.outputSchema);
	if (
		!Number.isSafeInteger(tool.contractVersion) ||
		(tool.contractVersion ?? 0) < 1 ||
		!inputSchema ||
		!outputSchema ||
		(tool.risk !== 'read' && tool.risk !== 'workspace-write') ||
		tool.idempotency !== 'required' ||
		(tool.risk === 'workspace-write' &&
			tool.idempotencyProtection !== 'target-ledger') ||
		(tool.cancellation !== 'cooperative' &&
			tool.cancellation !== 'not-supported')
	) {
		if (tool.workflowTemplate !== undefined) {
			throw new AgentActionCapabilityError(
				'ACTION_TEMPLATE_INELIGIBLE',
				'Workflow action template requires a complete eligible action contract.',
			);
		}
		return null;
	}
	if (
		secretSchemaIssue(inputSchema) === 'value' ||
		secretSchemaIssue(outputSchema) === 'value'
	) {
		throw new AgentActionCapabilityError(
			'ACTION_SCHEMA_SECRET_VALUE',
			'Workflow action schema embeds a value on a secret field.',
		);
	}
	const workflowTemplate =
		tool.workflowTemplate === undefined
			? undefined
			: validatedWorkflowTemplate(tool.workflowTemplate);
	if (workflowTemplate && containsOpaqueSecretSchema(inputSchema)) {
		throw new AgentActionCapabilityError(
			'ACTION_TEMPLATE_SECRET_SCHEMA_UNPROVEN',
			'Workflow action template cannot prove a complex secret input optional.',
		);
	}
	if (
		workflowTemplate &&
		secretSchemaIssue(inputSchema, true) === 'required-input'
	) {
		throw new AgentActionCapabilityError(
			'ACTION_TEMPLATE_SECRET_INPUT',
			'Workflow action template requires a raw secret input.',
		);
	}
	if (
		workflowTemplate &&
		(!workflowTemplateSchemaSupported(inputSchema) ||
			!workflowTemplateSchemaSupported(outputSchema))
	) {
		throw new AgentActionCapabilityError(
			'ACTION_TEMPLATE_SCHEMA_UNSUPPORTED',
			'Workflow action template schema exceeds the workflow schema subset or limits.',
		);
	}
	return {
		id: tool.id,
		contractVersion: tool.contractVersion!,
		description: tool.description,
		requiredPermissions: [...tool.requiredPermissions],
		inputSchema,
		outputSchema,
		timeoutMs: toolTimeoutMs(tool.timeoutMs),
		idempotency: 'required',
		risk: tool.risk,
		cancellation: tool.cancellation,
		...(tool.idempotencyProtection === undefined
			? {}
			: { idempotencyProtection: tool.idempotencyProtection }),
		...(workflowTemplate === undefined ? {} : { workflowTemplate }),
	};
}

function legacyDescriptor(
	action: VersionedActionDescriptorV2,
): VersionedActionDescriptor {
	return {
		id: action.id,
		contractVersion: action.contractVersion,
		description: action.description,
		requiredPermissions: [...action.requiredPermissions],
		inputSchema: structuredClone(action.inputSchema),
		outputSchema: structuredClone(action.outputSchema),
		timeoutMs: action.timeoutMs,
		idempotency: action.idempotency,
		risk: action.risk,
		cancellation: action.cancellation,
	};
}

function cloneDescriptorV2(
	action: VersionedActionDescriptorV2,
): VersionedActionDescriptorV2 {
	return {
		...legacyDescriptor(action),
		...(action.idempotencyProtection === undefined
			? {}
			: { idempotencyProtection: action.idempotencyProtection }),
		...(action.workflowTemplate === undefined
			? {}
			: { workflowTemplate: { ...action.workflowTemplate } }),
	};
}

function buildActionDescriptors(
	tools: readonly AgentTool[],
): readonly VersionedActionDescriptorV2[] {
	const actions = tools
		.map(descriptor)
		.filter((item): item is VersionedActionDescriptorV2 => item !== null)
		.sort((left, right) => left.id.localeCompare(right.id));
	for (let index = 1; index < actions.length; index++) {
		if (actions[index - 1]!.id === actions[index]!.id) {
			throw new AgentActionCapabilityError(
				'ACTION_TEMPLATE_DUPLICATE',
				'Workflow action identity is registered more than once.',
			);
		}
	}
	return actions;
}

/** Checked during platform prepare, after all modules registered their tools. */
export function validateWorkflowActionCatalog(
	tools: readonly AgentTool[],
): void {
	buildActionDescriptors(tools);
}

/**
 * The same run-time gate the harness asks before an agent calls the tool. A
 * workflow invocation asks it twice: once before the invocation is persisted,
 * and again before the queued call runs, because the workspace may withdraw its
 * consent while the invocation waits in the queue.
 */
async function assertConsent(
	tool: AgentTool,
	input: unknown,
	context: AgentToolContext,
): Promise<void> {
	if (!tool.consent) return;
	let granted = false;
	let reason: string | undefined;
	try {
		/* Foreign code: a throw is a refusal, never a crash. */
		const decision = await tool.consent.check(input, context);
		granted = decision.granted;
		reason = decision.reason;
	} catch {
		reason = 'ACTION_CONSENT_UNAVAILABLE';
	}
	if (!granted) {
		throw new AgentActionCapabilityError(
			reason !== undefined && /^[A-Z][A-Z0-9_]{2,63}$/.test(reason)
				? reason
				: 'ACTION_CONSENT_REFUSED',
			`Action ${tool.id} was not consented for this workspace.`,
		);
	}
}

function safeCode(error: unknown): string {
	if (
		error instanceof AgentHarnessError ||
		error instanceof AgentActionCapabilityError
	) {
		return error.code;
	}
	return 'ACTION_EXECUTION_FAILED';
}

function trustedAuthorizationSubject(
	actor: Actor,
	subject?: UserActor,
): UserActor {
	const supplied = subject ? normalizeActor(subject) : undefined;
	const derived =
		actor.kind === 'user'
			? actor
			: actor.kind === 'service'
				? actor.configuredBy
				: undefined;
	const trusted = supplied ?? derived;
	if (
		!trusted ||
		trusted.kind !== 'user' ||
		(derived !== undefined && trusted.id !== derived.id)
	) {
		throw new AgentActionCapabilityError(
			'ACTION_INVALID_DELEGATION',
			'The workflow action requires a trusted delegated user.',
		);
	}
	return trusted;
}

/**
 * The page the recovery read answers, and the invocations this worker performs
 * at once: the drain loop's own bound, now the runner's. A pass takes four
 * pages of claims, so a deep queue keeps draining rather than waiting out the
 * poll interval between passes, as the drain loop's own re-kick did.
 */
const ACTION_ROUTING_PAGE = 8;

export function createAgentActionExecutionRuntime(
	repository: AgentRepository,
	tools: readonly AgentTool[],
	options: {
		readonly workerId?: string;
		readonly leaseMs?: number;
		readonly now?: () => number;
		readonly authorizeToolAccess?: AgentToolAccessAuthorizer;
		/** Defaults to the process tracer, which is the one `context.tracer` carries. */
		readonly tracer?: Tracer;
	} = {},
): AgentActionRuntime {
	const now = options.now ?? Date.now;
	const leaseMs = options.leaseMs ?? 30_000;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
		throw new Error('Agent action lease must be between 1000 and 300000 ms.');
	}
	const workerId =
		options.workerId ?? `agent-action-worker:${process.pid}:${randomUUID()}`;
	const intervalMs = Math.max(1_000, Math.floor(leaseMs / 2));
	const actions = buildActionDescriptors(tools);
	const toolById = new Map(
		tools
			.filter((tool) => !localOnlyRefused(tool))
			.map((tool) => [tool.id, tool]),
	);
	const actionById = new Map(actions.map((action) => [action.id, action]));
	const visibleActions = () =>
		actions.filter((action) => !localOnlyRefused(toolById.get(action.id)!));
	const inFlight = new Map<string, AbortController>();
	const callerSignals = new Map<
		string,
		{ readonly signal: AbortSignal; readonly listener: () => void }
	>();
	let stopped = true;

	const detachCallerSignal = (id: string) => {
		const caller = callerSignals.get(id);
		if (!caller) return;
		caller.signal.removeEventListener('abort', caller.listener);
		callerSignals.delete(id);
	};

	const finish = (id: string) => {
		inFlight.delete(id);
		detachCallerSignal(id);
	};

	const execute = async (
		invocation: AgentActionInvocation,
		controller: AbortController,
	) => {
		const action = actionById.get(invocation.actionId);
		const tool = toolById.get(invocation.actionId);
		if (
			!action ||
			!tool ||
			action.contractVersion !== invocation.contractVersion
		) {
			const completedAt = now();
			await repository.failAction(
				invocation.tenantId,
				invocation.id,
				workerId,
				'ACTION_VERSION_MISSING',
				completedAt,
				{
					tenantId: invocation.tenantId,
					actorId: invocation.actor.id,
					action: 'agent-action.failed',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: {
						actionId: invocation.actionId,
						code: 'ACTION_VERSION_MISSING',
					},
					occurredAt: completedAt,
				},
			);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectAbort: (() => void) | undefined;
		try {
			if (localOnlyRefused(tool)) {
				throw new AgentActionCapabilityError(
					'TOOL_LOCAL_ONLY',
					`Tool ${tool.id} is a local-only capability and cannot run in this environment.`,
				);
			}
			const currentlyHeld = new Set(
				invocation.authorizationSubject
					? await (options.authorizeToolAccess?.({
							tenantId: invocation.tenantId,
							actor: invocation.authorizationSubject,
							signal: controller.signal,
						}) ?? [])
					: [],
			);
			const permissions = new Set(
				invocation.permissionSnapshot.filter((permission) =>
					currentlyHeld.has(permission),
				),
			);
			if (
				action.requiredPermissions.some(
					(permission) => !permissions.has(permission),
				)
			) {
				throw new AgentActionCapabilityError(
					'ACTION_PERMISSION_REVOKED',
					'The workflow actor no longer has permission for this action.',
				);
			}
			const toolContext: AgentToolContext = {
				runId: invocation.workflowRunId,
				tenantId: invocation.tenantId,
				requestedBy: invocation.actor.id,
				invocation: 'workflow-action',
				actor: invocation.actor,
				...(invocation.authorizationSubject
					? { authorizationSubject: invocation.authorizationSubject }
					: {}),
				...(invocation.actor.kind === 'agent'
					? {
							agentId: invocation.actor.id,
							agentName: invocation.actor.label,
						}
					: {}),
				idempotencyKey: invocation.sideEffectIdempotencyKey,
				permissions,
				signal: controller.signal,
			};
			await assertConsent(tool, invocation.input, toolContext);
			const aborted = new Promise<never>((_, reject) => {
				rejectAbort = () =>
					reject(
						new AgentActionCapabilityError(
							'ACTION_EXECUTION_ABORTED',
							'Action execution was aborted.',
						),
					);
				if (controller.signal.aborted) rejectAbort();
				else
					controller.signal.addEventListener('abort', rejectAbort, {
						once: true,
					});
			});
			const result = await Promise.race([
				tool.execute(invocation.input, toolContext),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(
							new AgentActionCapabilityError(
								'ACTION_TIMEOUT',
								`Action ${action.id} exceeded ${action.timeoutMs} ms.`,
							),
						);
						controller.abort('timeout');
					}, action.timeoutMs);
				}),
				aborted,
			]);
			validateJsonValue(result, 'ACTION_OUTPUT_INVALID', 'Action output');
			validateToolOutput(action.outputSchema, result);
			const boundedOutput = boundToolOutput(result);
			if (boundedOutput.truncated) {
				throw new AgentActionCapabilityError(
					'ACTION_OUTPUT_TOO_LARGE',
					'Action output exceeds the 32768 character limit.',
				);
			}
			const completedAt = now();
			await repository.completeAction(
				invocation.tenantId,
				invocation.id,
				workerId,
				result as JsonValue,
				completedAt,
				{
					tenantId: invocation.tenantId,
					actorId: invocation.actor.id,
					action: 'agent-action.succeeded',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: {
						actionId: invocation.actionId,
						contractVersion: invocation.contractVersion,
						workflowRunId: invocation.workflowRunId,
					},
					occurredAt: completedAt,
				},
			);
		} catch (error) {
			if (
				controller.signal.reason === 'cancelled' ||
				controller.signal.reason === 'worker-shutdown' ||
				controller.signal.reason === 'lease-lost'
			) {
				return;
			}
			const code = safeCode(error);
			const completedAt = now();
			await repository.failAction(
				invocation.tenantId,
				invocation.id,
				workerId,
				code,
				completedAt,
				{
					tenantId: invocation.tenantId,
					actorId: invocation.actor.id,
					action: 'agent-action.failed',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: { actionId: invocation.actionId, code },
					occurredAt: completedAt,
				},
			);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (rejectAbort)
				controller.signal.removeEventListener('abort', rejectAbort);
		}
	};

	/* The recovery read answers routing columns alone, so the page is kept here
	   and refilled only once it is drained: a pass reads the queue once per page
	   however many invocations it claims. */
	let queue: { readonly tenantId: string; readonly invocationId: string }[] =
		[];
	let refillable = true;

	const runner = createJobRunner<AgentActionInvocation>({
		name: 'agents.core.actions',
		intervalMs,
		staleAfterMs: leaseMs,
		/* No `heartbeatEveryMs`: the runner's default is a third of the lease, so
		   a renewal the database refuses once is asked again inside the window. */
		backoff: jobBackoff(intervalMs),
		concurrency: ACTION_ROUTING_PAGE,
		batchLimit: ACTION_ROUTING_PAGE * 4,
		logger: serverLogger,
		now,
		onEvent: createJobTraceSink(
			options.tracer ? { tracer: options.tracer } : {},
		),
		claim: async (at) => {
			if (stopped) return null;
			if (queue.length === 0) {
				if (!refillable) {
					refillable = true;
					return null;
				}
				const page = await repository.listRecoverableActions(
					at,
					ACTION_ROUTING_PAGE,
				);
				refillable = page.length === ACTION_ROUTING_PAGE;
				queue = [...page];
			}
			for (;;) {
				const candidate = queue.shift();
				if (!candidate) {
					refillable = true;
					return null;
				}
				/* A row this worker is already performing is not work to take. */
				if (inFlight.has(candidate.invocationId)) continue;
				const invocation = await repository.claimAction(
					candidate.tenantId,
					candidate.invocationId,
					workerId,
					at,
					at + leaseMs,
					{
						tenantId: candidate.tenantId,
						actorId: workerId,
						action: 'agent-action.claimed',
						subjectType: 'agent-action',
						subjectId: candidate.invocationId,
						metadata: {},
						occurredAt: at,
					},
				);
				if (!invocation) continue;
				/* The stop landed while this claim was still in the database. No work
				   starts under it, so the claim goes back to the queue at once rather
				   than holding a lease nothing renews, and dispose cannot be left
				   draining an invocation its abort never reached. */
				if (stopped) {
					await repository.releaseAction(
						invocation.tenantId,
						invocation.id,
						workerId,
					);
					return null;
				}
				inFlight.set(invocation.id, new AbortController());
				return invocation;
			}
		},
		heartbeat: async (invocation, at) =>
			repository.renewActionLease(
				invocation.tenantId,
				invocation.id,
				workerId,
				at + leaseMs,
			),
		perform: async (invocation, signal) => {
			const controller = inFlight.get(invocation.id)!;
			/* The fence aborts the controller the module already tracks, so a lease
			   another process took stops the work where a cancellation does. */
			const lost = () => controller.abort('lease-lost');
			signal.addEventListener('abort', lost, { once: true });
			try {
				await execute(invocation, controller);
			} catch (error) {
				/* A transactional settle can fail with the row still claimed. Keep the
				   process alive so the loop retries after the database recovers. */
				console.error(
					`[agents] worker failed to settle action ${invocation.id}:`,
					error instanceof Error ? error.message : error,
				);
			} finally {
				signal.removeEventListener('abort', lost);
				finish(invocation.id);
			}
			/* A row another process reclaimed is contention rather than work this
			   pass performed, and the pass learns which by the stage raising. */
			signal.throwIfAborted();
		},
	});

	/* The enqueue that just landed is invisible to a pass already reading the
	   queue, so the loop is woken rather than ticked: a tick would join that pass
	   and leave the invocation waiting out the poll interval. */
	const kick = () => {
		if (stopped) return;
		runner.wake();
	};

	const cancellation = async (
		actionInvocationId: string,
		context: AgentActionChildContext,
	): Promise<ActionCancellationResult> => {
		const invocation = await repository.getAction(
			context.tenantId,
			actionInvocationId,
		);
		const actor = normalizeActor(context.actor);
		const action = invocation ? actionById.get(invocation.actionId) : undefined;
		if (
			!invocation ||
			invocation.workflowRunId !== context.workflowRunId ||
			!actor ||
			!actorsEqual(actor, invocation.actor) ||
			!action ||
			action.requiredPermissions.some(
				(permission) => !context.permissionSnapshot.includes(permission),
			)
		) {
			return { actionInvocationId, state: 'not-acknowledged' };
		}
		if (action?.cancellation !== 'cooperative') {
			return { actionInvocationId, state: 'not-supported' };
		}
		const cancelledAt = now();
		const previous = await repository.cancelAction(
			invocation.tenantId,
			invocation.id,
			cancelledAt,
			{
				tenantId: invocation.tenantId,
				actorId: context.actor.id,
				action: 'agent-action.cancelled',
				subjectType: 'agent-action',
				subjectId: invocation.id,
				metadata: { actionId: invocation.actionId },
				occurredAt: cancelledAt,
			},
		);
		if (previous === null) {
			return { actionInvocationId, state: 'not-acknowledged' };
		}
		inFlight.get(invocation.id)?.abort('cancelled');
		detachCallerSignal(invocation.id);
		return { actionInvocationId, state: 'acknowledged' };
	};

	const capability: AgentActionExecutionCapability = {
		listWorkflowActions: async () => visibleActions().map(legacyDescriptor),
		async start(request, context) {
			if (context.signal.aborted) {
				throw new AgentActionCapabilityError(
					'ACTION_CANCELLED',
					'Action invocation was cancelled before enqueue.',
				);
			}
			const actor = normalizeActor(context.actor);
			if (!actor) {
				throw new AgentActionCapabilityError(
					'ACTION_INVALID_ACTOR',
					'Action actor is invalid.',
				);
			}
			const tenantId = bounded(context.tenantId, 'tenantId', 1, 128);
			const authorizationSubject = trustedAuthorizationSubject(
				actor,
				context.authorizationSubject,
			);
			const actionId = bounded(request.actionId, 'actionId', 3, 128);
			const action = actionById.get(actionId);
			if (!action || action.contractVersion !== request.contractVersion) {
				throw new AgentActionCapabilityError(
					'ACTION_VERSION_MISSING',
					'Action contract version is unavailable.',
				);
			}
			const tool = toolById.get(action.id)!;
			if (localOnlyRefused(tool)) {
				throw new AgentActionCapabilityError(
					'TOOL_LOCAL_ONLY',
					`Tool ${tool.id} is a local-only capability and cannot run in this environment.`,
				);
			}
			if (
				action.requiredPermissions.some(
					(permission) => !context.permissionSnapshot.includes(permission),
				)
			) {
				throw new AgentActionCapabilityError(
					'ACTION_PERMISSION_DENIED',
					'The workflow actor lacks permission for this action.',
				);
			}
			let authorized: readonly string[];
			try {
				authorized = await (options.authorizeToolAccess?.({
					tenantId,
					actor: authorizationSubject,
					signal: context.signal,
				}) ?? []);
			} catch {
				throw new AgentActionCapabilityError(
					'ACTION_AUTHORIZATION_UNAVAILABLE',
					'Live action authorization is unavailable.',
				);
			}
			const livePermissions = new Set(authorized);
			if (
				action.requiredPermissions.some(
					(permission) => !livePermissions.has(permission),
				)
			) {
				throw new AgentActionCapabilityError(
					'ACTION_PERMISSION_REVOKED',
					'The workflow actor no longer has permission for this action.',
				);
			}
			try {
				validateJsonValue(
					request.input,
					'ACTION_INPUT_INVALID',
					'Action input',
				);
				validateToolInput(action.inputSchema, request.input);
			} catch (error) {
				throw new AgentActionCapabilityError(
					'ACTION_INPUT_INVALID',
					error instanceof Error ? error.message : 'Action input is invalid.',
				);
			}
			const inputJson = canonical(request.input);
			if (inputJson.length > 32_768) {
				throw new AgentActionCapabilityError(
					'ACTION_INPUT_TOO_LARGE',
					'Action input exceeds the 32768 character limit.',
				);
			}
			const workflowRunId = bounded(
				context.workflowRunId,
				'workflowRunId',
				1,
				128,
			);
			const nodeRunId = bounded(context.nodeRunId, 'nodeRunId', 1, 128);
			const idempotencyKey = bounded(
				request.idempotencyKey,
				'idempotencyKey',
				8,
				128,
			);
			const sideEffectIdempotencyKey = bounded(
				request.sideEffectIdempotencyKey ?? idempotencyKey,
				'sideEffectIdempotencyKey',
				8,
				128,
			);
			const permissions = [...new Set(context.permissionSnapshot)].sort();
			const requestHash = createHash('sha256')
				.update(
					JSON.stringify([
						action.id,
						action.contractVersion,
						inputJson,
						workflowRunId,
						nodeRunId,
						actor,
						authorizationSubject,
						permissions,
						/* Preserve the original hash for v1 and already-queued v2
						   invocations, whose external and invocation keys were equal. */
						...(sideEffectIdempotencyKey === idempotencyKey
							? []
							: [sideEffectIdempotencyKey]),
					]),
				)
				.digest('hex');
			/* A replay of a key this workspace already accepted answers with the
			   invocation it made, before the gate is asked: consent admits new work,
			   and a workflow retrying a node it already enqueued must reach the same
			   invocation however the workspace changed its mind since. The worker
			   asks the gate again before that invocation runs. */
			const existing = await repository.findActionByIdempotencyKey(
				tenantId,
				idempotencyKey,
			);
			if (existing) {
				if (existing.requestHash !== requestHash) {
					throw new AgentActionCapabilityError(
						'ACTION_IDEMPOTENCY_CONFLICT',
						'The idempotency key is bound to another action request.',
					);
				}
				return { actionInvocationId: existing.id, created: false };
			}
			/* Refused before the invocation is persisted, so an unconsented action
			   never occupies the queue; the worker asks again before it runs. */
			await assertConsent(tool, request.input, {
				runId: workflowRunId,
				tenantId,
				requestedBy: actor.id,
				invocation: 'workflow-action',
				actor,
				authorizationSubject,
				idempotencyKey: sideEffectIdempotencyKey,
				permissions: livePermissions,
				signal: context.signal,
			});
			const invocation: AgentActionInvocation = {
				id: randomUUID(),
				tenantId,
				workflowRunId,
				nodeRunId,
				actionId: action.id,
				contractVersion: action.contractVersion,
				actor,
				authorizationSubject,
				permissionSnapshot: permissions,
				input: request.input,
				idempotencyKey,
				sideEffectIdempotencyKey,
				requestHash,
				status: 'queued',
				output: null,
				code: null,
				attempt: 0,
				queuedAt: now(),
				startedAt: null,
				completedAt: null,
				leaseExpiresAt: null,
			};
			try {
				await repository.enqueueAction(invocation, {
					tenantId,
					actorId: actor.id,
					action: 'agent-action.queued',
					subjectType: 'agent-action',
					subjectId: invocation.id,
					metadata: {
						actionId: invocation.actionId,
						contractVersion: invocation.contractVersion,
						workflowRunId,
					},
					occurredAt: invocation.queuedAt,
				});
			} catch (error) {
				if (error instanceof DuplicateActionIdempotencyKeyError) {
					const raced = await repository.findActionByIdempotencyKey(
						tenantId,
						idempotencyKey,
					);
					if (raced?.requestHash === requestHash) {
						return { actionInvocationId: raced.id, created: false };
					}
					throw new AgentActionCapabilityError(
						'ACTION_IDEMPOTENCY_CONFLICT',
						'The idempotency key is bound to another action request.',
					);
				}
				throw error;
			}
			const listener = () => void cancellation(invocation.id, context);
			callerSignals.set(invocation.id, { signal: context.signal, listener });
			context.signal.addEventListener('abort', listener, { once: true });
			/* Abort may race with durable enqueue before the listener exists. Recheck
			   after registration so an already-aborted signal cannot leave queued work. */
			if (context.signal.aborted && callerSignals.has(invocation.id))
				listener();
			kick();
			return { actionInvocationId: invocation.id, created: true };
		},
		async getResult(actionInvocationId, context) {
			const invocation = await repository.getAction(
				bounded(context.tenantId, 'tenantId', 1, 128),
				bounded(actionInvocationId, 'actionInvocationId', 1, 128),
			);
			const actor = normalizeActor(context.actor);
			const action = invocation
				? actionById.get(invocation.actionId)
				: undefined;
			if (
				!invocation ||
				invocation.workflowRunId !== context.workflowRunId ||
				!actor ||
				!actorsEqual(actor, invocation.actor) ||
				!action ||
				action.requiredPermissions.some(
					(permission) => !context.permissionSnapshot.includes(permission),
				)
			) {
				return null;
			}
			if (invocation.status === 'queued' || invocation.status === 'running') {
				return null;
			}
			return {
				actionInvocationId: invocation.id,
				status: invocation.status,
				...(invocation.output === null ? {} : { output: invocation.output }),
				...(invocation.code === null ? {} : { code: invocation.code }),
			};
		},
		requestCancel: cancellation,
	};
	const capabilityV2: AgentActionExecutionCapabilityV2 = {
		...capability,
		listWorkflowActions: async () => visibleActions().map(cloneDescriptorV2),
	};

	return {
		capability,
		capabilityV2,
		start() {
			if (!stopped) return;
			stopped = false;
			runner.start();
		},
		stop() {
			stopped = true;
			runner.stop();
		},
		async dispose() {
			this.stop();
			for (const id of callerSignals.keys()) detachCallerSignal(id);
			for (const controller of inFlight.values()) {
				controller.abort('worker-shutdown');
			}
			await runner.dispose();
		},
	};
}
