/* The decision port, re-exported so a module reaches it through the harness
   like every other provider contract. A decision provider answers typed
   questions; it generates no text and drives no tool, so it is never one of
   the language-model providers the runtime above executes. */
export {
	askDecisions,
	assertDecisionConfiguration,
	DECISION_LIMITS,
	DECISION_PROVIDER_CATALOG,
	DECISION_PROVIDER_KINDS,
	probeDecisionProvider,
} from '@flowdular/ai-provider/decisions';
export type {
	ChoiceAnswer,
	DecisionAnswer,
	DecisionProviderConfiguration,
	DecisionProviderKind,
	DecisionQuestion,
	DecisionResult,
	DecisionUsage,
	NoulAnswer,
	ScoreAnswer,
} from '@flowdular/ai-provider/decisions';
