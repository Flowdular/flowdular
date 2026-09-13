import type { CapabilityRisk } from '@flowdular/contracts';
import type {
	AgentTool,
	AgentToolConsent,
	AgentToolContext,
} from './runtime.ts';

interface AgentToolBase {
	readonly id: string;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema?: Readonly<Record<string, unknown>>;
	readonly contractVersion?: number;
	readonly outputSchema?: Readonly<Record<string, unknown>>;
	readonly risk?: 'read' | 'workspace-write' | 'external' | 'destructive';
	/* Asked per call, after input validation, by every caller that runs the
	   tool: the harness and the workflow action runtime. */
	readonly consent?: AgentToolConsent;
	readonly idempotency?: 'required';
	readonly idempotencyProtection?: 'target-ledger';
	readonly cancellation?: 'cooperative' | 'not-supported';
	execute(input: unknown, context: AgentToolContext): Promise<unknown>;
}

export interface ApiAgentToolDefinition extends AgentToolBase {
	readonly endpointId: string;
}

export interface CliAgentToolDefinition extends AgentToolBase {
	readonly capability: {
		readonly id: string;
		readonly risk: CapabilityRisk;
		readonly localOnly?: boolean;
	};
}

function dottedIdentifier(value: string, field: string): string {
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value)) {
		throw new Error(`${field} must be a lowercase dot-separated identifier.`);
	}
	return value;
}

/* An external tool builds as any other; the harness offers and runs it only
   under an approval grant naming the tool and the input. */
export function defineApiAgentTool(
	definition: ApiAgentToolDefinition,
): AgentTool {
	return Object.freeze({
		id: dottedIdentifier(definition.id, 'Tool id'),
		transport: 'api' as const,
		target: dottedIdentifier(definition.endpointId, 'Endpoint id'),
		description: definition.description,
		requiredPermissions: [...definition.requiredPermissions],
		...(definition.contractVersion === undefined
			? {}
			: { contractVersion: definition.contractVersion }),
		...(definition.outputSchema === undefined
			? {}
			: { outputSchema: definition.outputSchema }),
		...(definition.risk === undefined ? {} : { risk: definition.risk }),
		...(definition.consent === undefined
			? {}
			: { consent: definition.consent }),
		...(definition.idempotency === undefined
			? {}
			: { idempotency: definition.idempotency }),
		...(definition.idempotencyProtection === undefined
			? {}
			: { idempotencyProtection: definition.idempotencyProtection }),
		...(definition.cancellation === undefined
			? {}
			: { cancellation: definition.cancellation }),
		...(definition.inputSchema === undefined
			? {}
			: { inputSchema: definition.inputSchema }),
		execute: definition.execute,
	});
}

/* An external or destructive capability builds as any other; the harness runs
   the tool only under an approval grant naming the tool and the input. */
export function defineCliAgentTool(
	definition: CliAgentToolDefinition,
): AgentTool {
	return Object.freeze({
		id: dottedIdentifier(definition.id, 'Tool id'),
		transport: 'cli' as const,
		target: dottedIdentifier(definition.capability.id, 'Capability id'),
		description: definition.description,
		requiredPermissions: [...definition.requiredPermissions],
		...(definition.contractVersion === undefined
			? {}
			: { contractVersion: definition.contractVersion }),
		...(definition.outputSchema === undefined
			? {}
			: { outputSchema: definition.outputSchema }),
		...(definition.risk === undefined ? {} : { risk: definition.risk }),
		...(definition.capability.localOnly === true ? { localOnly: true } : {}),
		...(definition.consent === undefined
			? {}
			: { consent: definition.consent }),
		...(definition.idempotency === undefined
			? {}
			: { idempotency: definition.idempotency }),
		...(definition.idempotencyProtection === undefined
			? {}
			: { idempotencyProtection: definition.idempotencyProtection }),
		...(definition.cancellation === undefined
			? {}
			: { cancellation: definition.cancellation }),
		...(definition.inputSchema === undefined
			? {}
			: { inputSchema: definition.inputSchema }),
		execute: definition.execute,
	});
}
