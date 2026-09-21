import {
	TYPED_DECISION_LIMITS,
	type JsonValue,
	type WorkflowTypedDecisionNodeV1,
} from '../domain/types.ts';

/* The agents.core typed-decision contract, declared here rather than imported.
   agents.core is a declared module dependency, but this capability is optional:
   a workspace that never turned typed decisions on, and a deployment whose
   agents.core predates them, still composes, publishes and runs every graph
   without a typed-decision node. This mirror is the contract agents.core owns
   and must not drift from it. */
export const AGENT_DECISIONS_CAPABILITY = 'agents.decisions.v1';

export type DecisionQuestion =
	| {
			readonly type: 'choice';
			readonly instruction: string;
			readonly options: readonly string[];
	  }
	| { readonly type: 'noul'; readonly instruction: string }
	| {
			readonly type: 'score';
			readonly instruction: string;
			readonly levels: readonly string[];
	  };

export interface ChoiceAnswer {
	readonly type: 'choice';
	readonly choice: string;
	readonly probabilities: Readonly<Record<string, number>>;
	readonly confidence: number;
}

export interface NoulAnswer {
	readonly type: 'noul';
	readonly noul: number;
}

export interface ScoreAnswer {
	readonly type: 'score';
	readonly score: number;
	readonly confidence: number;
}

export type DecisionAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface DecisionResult {
	readonly answers: Readonly<Record<string, DecisionAnswer>>;
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
	};
}

export interface AgentDecisionAsk {
	readonly tenantId: string;
	readonly caller: { readonly moduleId: string; readonly ref?: string };
	readonly state: string;
	readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/* The answers with the connection that produced them, which the attempt
   records so a reader of a run can tell which provider answered. */
export interface AgentDecisionAnswers extends DecisionResult {
	readonly connection: { readonly id: string; readonly key: string };
}

export interface AgentDecisions {
	available(tenantId: string): Promise<boolean>;
	ask(request: AgentDecisionAsk): Promise<AgentDecisionAnswers>;
}

/* Read at the point of use, never at composition time: the platform may
   register the capability after workflows.core, or never. */
export type DecisionsResolver = () => AgentDecisions | null;

/**
 * The question set a node pins, in the shape the capability takes. Only the
 * node decides what is asked; nothing is added at run time.
 */
export function typedDecisionQuestions(
	node: WorkflowTypedDecisionNodeV1,
): Readonly<Record<string, DecisionQuestion>> {
	return Object.fromEntries(
		node.questions.map((question) => [
			question.key,
			question.kind === 'choice'
				? {
						type: 'choice' as const,
						instruction: question.instruction,
						options: question.answers ?? [],
					}
				: question.kind === 'score'
					? {
							type: 'score' as const,
							instruction: question.instruction,
							levels: question.answers ?? [],
						}
					: { type: 'noul' as const, instruction: question.instruction },
		]),
	);
}

function atPath(value: JsonValue, path: string): JsonValue | undefined {
	let current: JsonValue | undefined = value;
	for (const segment of path.split('.')) {
		if (!current || typeof current !== 'object' || Array.isArray(current))
			return undefined;
		current = (current as { [key: string]: JsonValue })[segment];
	}
	return current;
}

/**
 * The state the questions are asked about, built from the pinned paths of the
 * node input alone, so a field the node did not name never travels. The result
 * is bounded here as well as by agents.core.
 */
export function typedDecisionState(
	node: WorkflowTypedDecisionNodeV1,
	input: JsonValue,
): string {
	const lines = node.statePaths
		.map((path) => {
			const value = atPath(input, path);
			if (value === undefined || value === null) return null;
			return `${path}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
		})
		.filter((line): line is string => line !== null);
	return lines.join('\n').slice(0, TYPED_DECISION_LIMITS.stateLength).trim();
}
