import {
	askDecisions,
	type DecisionQuestion,
	type DecisionResult,
} from '@flowdular/ai-provider';
import { readDecisionCredential } from './ai-environment.ts';
import { openSecret, type SandboxConfiguration } from './config.ts';

/**
 * Asks one set of typed questions. The sandbox passes this to the planner
 * instead of the provider itself, so planning stays a pure function of its
 * inputs and tests drive it without a network.
 */
export type DecisionAsk = (request: {
	readonly state: string;
	readonly questions: Readonly<Record<string, DecisionQuestion>>;
}) => Promise<DecisionResult>;

/**
 * The decision caller for this workspace, or null when the operator has not
 * turned typed decisions on or no credential is available. A missing provider
 * is never an error: every caller has a deterministic path without one.
 */
export async function buildDecisionAsk(
	workspaceRoot: string,
	configuration: SandboxConfiguration,
): Promise<DecisionAsk | null> {
	const decisions = configuration.decisions;
	if (!decisions?.enabled) return null;
	const credential = decisions.credential
		? await openSecret(workspaceRoot, decisions.credential)
		: await readDecisionCredential(decisions.kind, workspaceRoot);
	if (!credential) return null;
	const provider = {
		kind: decisions.kind,
		model: decisions.model,
		credential,
	};
	return (request) => askDecisions(provider, request);
}
