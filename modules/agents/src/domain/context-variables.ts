import type { VariableDefinition } from '@coreloom/contracts';

/* Always-available run context. These resolve from the run's principal and
   tenant with no extra scope, so an author can embed them in instructions and
   the run snapshot carries real values. Business-data variables (for example
   party.name) are the documented extension: they carry a scope and resolve
   through the agent tools under the run's grants. */
export const AGENT_CONTEXT_VARIABLES: readonly VariableDefinition[] = [
	{
		key: 'context.tenantName',
		label: 'Tenant name',
		kind: 'text',
		sample: 'Acme Manufacturing',
		description: 'The active tenant the run acts for.',
	},
	{
		key: 'context.today',
		label: 'Today (UTC)',
		kind: 'date',
		sample: '2026-09-01',
		description: 'The UTC date the run was queued.',
	},
	{
		key: 'context.user.displayName',
		label: 'User name',
		kind: 'text',
		sample: 'Ada Lovelace',
		description: 'Display name of the principal who requested the run.',
	},
	{
		key: 'context.user.email',
		label: 'User email',
		kind: 'identifier',
		sample: 'ada@acme.test',
		description: 'Email of the principal who requested the run.',
	},
];

export interface AgentContextInput {
	readonly tenantName: string;
	readonly userDisplayName: string;
	readonly userEmail: string;
	readonly now: number;
}

/* The run identity a caller supplies; the service adds the queue timestamp. */
export type AgentRunContext = Omit<AgentContextInput, 'now'>;

export function agentContextValues(
	input: AgentContextInput,
): Record<string, string> {
	return {
		'context.tenantName': input.tenantName,
		'context.today': new Date(input.now).toISOString().slice(0, 10),
		'context.user.displayName': input.userDisplayName,
		'context.user.email': input.userEmail,
	};
}
