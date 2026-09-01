import type { CapabilityRisk } from '@coreloom/contracts';
import type { AgentTool, AgentToolContext } from './runtime.ts';

interface AgentToolBase {
	readonly id: string;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema?: Readonly<Record<string, unknown>>;
	execute(input: unknown, context: AgentToolContext): Promise<unknown>;
}

export interface ApiAgentToolDefinition extends AgentToolBase {
	readonly endpointId: string;
}

export interface CliAgentToolDefinition extends AgentToolBase {
	readonly capability: {
		readonly id: string;
		readonly risk: CapabilityRisk;
	};
}

function dottedIdentifier(value: string, field: string): string {
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value)) {
		throw new Error(`${field} must be a lowercase dot-separated identifier.`);
	}
	return value;
}

export function defineApiAgentTool(
	definition: ApiAgentToolDefinition,
): AgentTool {
	return Object.freeze({
		id: dottedIdentifier(definition.id, 'Tool id'),
		transport: 'api' as const,
		target: dottedIdentifier(definition.endpointId, 'Endpoint id'),
		description: definition.description,
		requiredPermissions: [...definition.requiredPermissions],
		...(definition.inputSchema === undefined
			? {}
			: { inputSchema: definition.inputSchema }),
		execute: definition.execute,
	});
}

export function defineCliAgentTool(
	definition: CliAgentToolDefinition,
): AgentTool {
	if (
		definition.capability.risk === 'external' ||
		definition.capability.risk === 'destructive'
	) {
		throw new Error(
			`CLI capability ${definition.capability.id} requires an approval receipt and cannot be registered as an unattended agent tool.`,
		);
	}
	return Object.freeze({
		id: dottedIdentifier(definition.id, 'Tool id'),
		transport: 'cli' as const,
		target: dottedIdentifier(definition.capability.id, 'Capability id'),
		description: definition.description,
		requiredPermissions: [...definition.requiredPermissions],
		...(definition.inputSchema === undefined
			? {}
			: { inputSchema: definition.inputSchema }),
		execute: definition.execute,
	});
}
