import { defineAgent } from '../server/define-agent.ts';
import type { ModuleAgentDefinition } from '../domain/types.ts';

export const ASSISTANT_AGENT_KEY = 'workspace-assistant';

/** The identity `defineAgent` derives, named here so callers need no string. */
export const ASSISTANT_AGENT_ID = `module-agent:agents.core:${ASSISTANT_AGENT_KEY}`;

/* Bumped whenever the text, the limits or the allowlist source below change.
   The registered tool ids are the deployment's, not this module's source, so
   they are deliberately outside the content this revision pins. */
export const ASSISTANT_DEFINITION_REVISION = 1;

const ASSISTANT_INSTRUCTIONS = `You are the workspace assistant of {{ context.tenantName }}.

You act for {{ context.user.displayName }}, the signed-in member who is talking
to you, and never above them. Today is {{ context.today }}.

Work this way:
- Before you use a tool, say in one short sentence what you are about to do and
  which record it touches. Then do it.
- Every tool runs under that member's own permissions. When a tool refuses,
  state the refusal plainly, name what was refused, and stop. Do not retry the
  same call, look for another route to the same result, or guess at the answer
  the refused tool would have given.
- Answer from what the tools returned. When you do not have a fact, say so.
- Keep answers short and concrete, and prefer the member's own words for the
  records they name.`;

/**
 * The agent behind every assistant turn. Its ceiling is the tools the platform
 * registry holds, so the assistant can reach whatever the other modules
 * registered, while the member's own permission snapshot and the owning
 * module's service decide what any single call may actually do.
 *
 * Provider, model, paused state and the reduced enabled tools remain tenant
 * binding data, exactly as for any other module-owned agent.
 */
export function assistantAgentDefinition(
	registeredTools: readonly string[],
): ModuleAgentDefinition {
	return defineAgent({
		moduleId: 'agents.core',
		key: ASSISTANT_AGENT_KEY,
		definitionRevision: ASSISTANT_DEFINITION_REVISION,
		name: 'Workspace assistant',
		description:
			'Answers a member from the header and acts for them through the tools their permissions already allow.',
		instructions: ASSISTANT_INSTRUCTIONS,
		allowedTools: [...new Set(registeredTools)],
		allowlistSource: 'registry',
		limits: {
			maxSteps: 12,
			timeoutMs: 120_000,
			temperature: 0.2,
			maxOutputTokens: 4_096,
		},
	});
}
