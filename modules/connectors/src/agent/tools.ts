import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import type {
	AgentTool,
	AgentToolConsentDecision,
	AgentToolContext,
} from '@flowdular/harness/runtime';
import { CONNECTORS_PERMISSIONS } from '../acl/permissions.ts';
import type { ConnectorCaller } from '../domain/types.ts';
import type { ConnectorsRuntime } from '../server/runtime.ts';
import { ConnectorsServiceError } from '../services/service-error.ts';

/** Characters of a response body one tool call hands back to the model. */
export const MAX_TOOL_BODY_CHARACTERS = 16_384;

export const CONNECTORS_TOOL_CONSENT_ID = 'connectors.instance-consent';

/**
 * The identity the tool is published under. There is no server route behind it:
 * the harness runs `execute` in this process, and a credentialed egress route
 * under the read permission would have handed every member the call itself.
 */
export const CONNECTORS_CALL_TOOL_TARGET = 'connectors.calls.agent';

function instanceId(input: unknown): string | null {
	const value = (input ?? {}) as Record<string, unknown>;
	return typeof value.instanceId === 'string' && value.instanceId.length > 0
		? value.instanceId
		: null;
}

/**
 * Which consent flag of the instance admits this call. The invocation kind is
 * the caller's own statement, so a workflow node is answered by allowWorkflows
 * and a model turn by allowAgents; an absent kind is an agent run, because the
 * workflow action runtime always states it.
 */
function callerOf(context: AgentToolContext): ConnectorCaller {
	return context.invocation === 'workflow-action' ? 'workflow' : 'agent';
}

/**
 * Raises this tool's ceiling per instance instead of per declaration: the call
 * is admitted only while the workspace owner keeps the consent flag of this
 * caller kind on for the instance named, and the call capability enforces the
 * same flag again before anything leaves the process.
 */
function consentGate(runtime: ConnectorsRuntime) {
	return {
		id: CONNECTORS_TOOL_CONSENT_ID,
		async check(
			input: unknown,
			context: AgentToolContext,
		): Promise<AgentToolConsentDecision> {
			const id = instanceId(input);
			if (!id) {
				return { granted: false, reason: 'CONNECTOR_INSTANCE_UNKNOWN' };
			}
			const calls = await runtime.calls();
			return (await calls.consented(context.tenantId, id, callerOf(context)))
				? { granted: true }
				: { granted: false, reason: 'CONNECTOR_CONSENT_MISSING' };
		},
	};
}

/**
 * The whole contract a workflow action needs on top of an agent tool: a
 * version, an output schema, a required key backed by the call ledger, and a
 * cancellation answer. Without every one of them agents.core declines to
 * publish the tool as an action, which would leave the workflow consent flag
 * unreachable however the workspace set it.
 */
export const CONNECTORS_CALL_CONTRACT_VERSION = 1;

const CALL_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [
		'callId',
		'outcome',
		'status',
		'errorClass',
		'durationMs',
		'responseBytes',
		'bodyOmitted',
		'replayed',
		'body',
	],
	properties: {
		callId: { type: 'string' },
		outcome: { type: 'string', enum: ['succeeded', 'failed'] },
		status: { type: ['integer', 'null'] },
		errorClass: { type: ['string', 'null'] },
		durationMs: { type: 'integer' },
		responseBytes: { type: 'integer' },
		bodyOmitted: { type: 'boolean' },
		replayed: { type: 'boolean' },
		body: {},
	},
} as const;

export function connectorsAgentTools(
	runtime: ConnectorsRuntime,
): readonly AgentTool[] {
	return [
		defineApiAgentTool({
			id: 'connectors.call',
			endpointId: CONNECTORS_CALL_TOOL_TARGET,
			contractVersion: CONNECTORS_CALL_CONTRACT_VERSION,
			description:
				'Call one operation of a connector instance the workspace has consented to for agents.',
			requiredPermissions: [CONNECTORS_PERMISSIONS.read],
			risk: 'workspace-write',
			idempotency: 'required',
			/* connectors_call_keys binds the key to one call before anything
			   leaves the process and answers that call on a repeat. */
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			consent: consentGate(runtime),
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['instanceId', 'operation'],
				properties: {
					instanceId: { type: 'string' },
					operation: { type: 'string' },
					input: { type: 'object' },
				},
			},
			outputSchema: CALL_OUTPUT_SCHEMA,
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				if (!context.idempotencyKey) {
					throw new ConnectorsServiceError(
						'CONNECTOR_IDEMPOTENCY_KEY_REQUIRED',
						'A connector call requires a durable idempotency key.',
						409,
					);
				}
				const calls = await runtime.calls();
				const result = await calls.call({
					/* Tenant and run identity come from the run, never from input. */
					tenantId: context.tenantId,
					instanceId: String(value.instanceId ?? ''),
					operation: String(value.operation ?? ''),
					input:
						value.input && typeof value.input === 'object'
							? (value.input as Record<string, unknown>)
							: {},
					caller: callerOf(context),
					callerRef: context.runId,
					idempotencyKey: context.idempotencyKey,
					signal: context.signal,
				});
				if (result.outcome === 'refused') {
					throw new ConnectorsServiceError(
						'CONNECTOR_CALL_REFUSED',
						`The connector call was refused: ${result.errorClass}.`,
					);
				}
				const serialized =
					result.body === null ? '' : JSON.stringify(result.body);
				const omitted = serialized.length > MAX_TOOL_BODY_CHARACTERS;
				return {
					callId: result.callId,
					outcome: result.outcome,
					status: result.status,
					errorClass: result.errorClass,
					durationMs: result.durationMs,
					responseBytes: result.responseBytes,
					/* A body too large for one run window is dropped whole rather than
					   handed to the model as truncated JSON. */
					bodyOmitted: omitted,
					replayed: result.replayed,
					body: omitted ? null : result.body,
				};
			},
		}),
	];
}
