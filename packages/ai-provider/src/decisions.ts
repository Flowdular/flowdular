import { AiProviderError, redactSecrets } from './errors.ts';
import type { ProviderReadinessResult } from './model.ts';

/**
 * A decision provider answers typed questions about a state instead of
 * generating text. It drives no tools and streams nothing, so it never
 * replaces a language model: it answers the conditionals around one.
 */
export const DECISION_PROVIDER_KINDS = ['typesafe'] as const;

export type DecisionProviderKind = (typeof DECISION_PROVIDER_KINDS)[number];

export const DECISION_PROVIDER_CATALOG: Readonly<
	Record<
		DecisionProviderKind,
		{
			readonly label: string;
			readonly defaultModel: string;
			readonly defaultBaseURL: string;
			readonly credentialVariable: string;
		}
	>
> = Object.freeze({
	typesafe: {
		label: 'TypeSafe (Jev)',
		defaultModel: 'jev-latest',
		defaultBaseURL: 'https://api.typesafe.ai',
		credentialVariable: 'TYPESAFE_API_KEY',
	},
});

export interface DecisionProviderConfiguration {
	readonly kind: DecisionProviderKind;
	readonly model: string;
	readonly credential: string;
	readonly baseURL?: string | undefined;
	readonly fetch?: typeof globalThis.fetch | undefined;
	readonly timeoutMs?: number | undefined;
}

export type DecisionQuestion =
	/* One of a closed set of answers, with the probability of each. */
	| {
			readonly type: 'choice';
			readonly instruction: string;
			readonly options: readonly string[];
	  }
	/* A yes or no, answered as a probability between 0 and 1. */
	| { readonly type: 'noul'; readonly instruction: string }
	/* A position on an ordered rubric, answered as a weighted value. */
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

export interface DecisionUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export interface DecisionResult {
	readonly answers: Readonly<Record<string, DecisionAnswer>>;
	readonly usage: DecisionUsage;
}

/* Bounds the sandbox and the platform both rely on. The vendor allows 255
   options and a 32k token state; these are the smaller limits this platform
   sends, so a runaway state or question set fails here and not in a bill. */
export const DECISION_LIMITS = Object.freeze({
	questions: 16,
	options: 64,
	instructionLength: 2_000,
	optionLength: 200,
	stateLength: 32_000,
	credentialLength: 16_384,
});

const DEFAULT_TIMEOUT_MS = 10_000;

function invalid(message: string): AiProviderError {
	return new AiProviderError('INVALID_PROVIDER_CONFIGURATION', message);
}

function assertText(value: string, field: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum) {
		throw invalid(`${field} is invalid.`);
	}
	return normalized;
}

export function assertDecisionConfiguration(
	configuration: DecisionProviderConfiguration,
): void {
	if (!DECISION_PROVIDER_KINDS.includes(configuration.kind)) {
		throw invalid('decision provider kind is unknown.');
	}
	assertText(configuration.model, 'model', 160);
	assertText(
		configuration.credential,
		'credential',
		DECISION_LIMITS.credentialLength,
	);
	const baseURL = configuration.baseURL?.trim();
	if (baseURL) {
		let url: URL;
		try {
			url = new URL(baseURL);
		} catch {
			throw invalid('baseURL must be an absolute URL.');
		}
		const loopback =
			url.hostname === 'localhost' ||
			url.hostname === '[::1]' ||
			/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
			throw invalid('baseURL must use HTTPS unless it is on loopback.');
		}
		if (url.username || url.password) {
			throw invalid('baseURL must not contain URL credentials.');
		}
	}
}

function assertQuestions(
	questions: Readonly<Record<string, DecisionQuestion>>,
): void {
	const names = Object.keys(questions);
	if (names.length === 0 || names.length > DECISION_LIMITS.questions) {
		throw invalid(
			`a request carries between 1 and ${DECISION_LIMITS.questions} questions.`,
		);
	}
	for (const name of names) {
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
			throw invalid(`question name ${name} is invalid.`);
		}
		const question = questions[name]!;
		assertText(
			question.instruction,
			`${name} instruction`,
			DECISION_LIMITS.instructionLength,
		);
		if (question.type === 'choice' || question.type === 'score') {
			const values =
				question.type === 'choice' ? question.options : question.levels;
			if (values.length < 2 || values.length > DECISION_LIMITS.options) {
				throw invalid(
					`${name} needs between 2 and ${DECISION_LIMITS.options} answers.`,
				);
			}
			for (const value of values) {
				assertText(value, `${name} answer`, DECISION_LIMITS.optionLength);
			}
			if (new Set(values).size !== values.length) {
				throw invalid(`${name} repeats an answer.`);
			}
		}
	}
}

function requestBody(
	configuration: DecisionProviderConfiguration,
	state: string,
	questions: Readonly<Record<string, DecisionQuestion>>,
): string {
	return JSON.stringify({
		model: configuration.model.trim(),
		state,
		questions: Object.fromEntries(
			Object.entries(questions).map(([name, question]) => [
				name,
				/* Both answer sets travel as `criteria`: an option map for a
				   choice, an ordered level array for a score. */
				question.type === 'choice'
					? {
							type: 'choice',
							instructions: question.instruction,
							criteria: Object.fromEntries(
								question.options.map((option) => [option, null]),
							),
						}
					: question.type === 'score'
						? {
								type: 'score',
								instructions: question.instruction,
								criteria: question.levels,
							}
						: { type: 'noul', instructions: question.instruction },
			]),
		),
	});
}

/* A provider body can echo what was sent. The generic pass only knows common
   key shapes, so the credential of this very request is removed by value. */
function failureFor(
	status: number,
	body: string,
	credential: string,
): AiProviderError {
	const detail =
		redactSecrets(body.split(credential).join('[redacted]')).slice(0, 300) ||
		null;
	if (status === 401 || status === 403) {
		return new AiProviderError(
			'PROVIDER_AUTHENTICATION_FAILED',
			'The decision provider rejected the configured credential.',
			detail,
		);
	}
	if (status === 422) {
		return new AiProviderError(
			'PROVIDER_REQUEST_REJECTED',
			'The decision provider rejected the questions as invalid.',
			detail,
		);
	}
	if (status === 429) {
		return new AiProviderError(
			'PROVIDER_RATE_LIMITED',
			'The decision provider rate limit prevented the request.',
			detail,
		);
	}
	if (status >= 500) {
		return new AiProviderError(
			'PROVIDER_UNAVAILABLE',
			'The decision provider reported a server-side failure.',
			detail,
		);
	}
	return new AiProviderError(
		'PROVIDER_REQUEST_FAILED',
		'The decision provider request failed.',
		detail,
	);
}

function numberAt(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new AiProviderError(
			'PROVIDER_REQUEST_FAILED',
			`The decision provider answered without a usable ${field}.`,
		);
	}
	return value;
}

function probabilities(value: unknown): Readonly<Record<string, number>> {
	if (!value || typeof value !== 'object') return {};
	const entries = Object.entries(value as Record<string, unknown>).filter(
		(entry): entry is [string, number] => typeof entry[1] === 'number',
	);
	return Object.fromEntries(entries);
}

function parseAnswer(name: string, value: unknown): DecisionAnswer {
	const answer = (value ?? {}) as Record<string, unknown>;
	if (answer.type === 'choice') {
		if (typeof answer.choice !== 'string' || !answer.choice) {
			throw new AiProviderError(
				'PROVIDER_REQUEST_FAILED',
				`The decision provider answered ${name} without a choice.`,
			);
		}
		return {
			type: 'choice',
			choice: answer.choice,
			probabilities: probabilities(answer.probabilities),
			confidence: numberAt(answer.confidence, 'confidence'),
		};
	}
	if (answer.type === 'score') {
		return {
			type: 'score',
			score: numberAt(answer.score, 'score'),
			confidence: numberAt(answer.confidence, 'confidence'),
		};
	}
	if (answer.type === 'noul') {
		return { type: 'noul', noul: numberAt(answer.noul, 'noul') };
	}
	throw new AiProviderError(
		'PROVIDER_REQUEST_FAILED',
		`The decision provider answered ${name} with an unknown answer type.`,
	);
}

/**
 * Evaluates every question against one state in a single request. The state is
 * the text the questions are about; it never carries a credential, and the
 * caller owns what it may contain.
 */
export async function askDecisions(
	configuration: DecisionProviderConfiguration,
	request: {
		readonly state: string;
		readonly questions: Readonly<Record<string, DecisionQuestion>>;
	},
): Promise<DecisionResult> {
	assertDecisionConfiguration(configuration);
	assertQuestions(request.questions);
	const state = request.state.trim();
	if (!state || state.length > DECISION_LIMITS.stateLength) {
		throw invalid(
			`state is empty or longer than ${DECISION_LIMITS.stateLength} characters.`,
		);
	}
	const base =
		configuration.baseURL?.trim() ||
		DECISION_PROVIDER_CATALOG[configuration.kind].defaultBaseURL;
	const call = configuration.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await call(new URL('/v1/systemone', base), {
			method: 'POST',
			headers: {
				authorization: `Bearer ${configuration.credential.trim()}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: requestBody(configuration, state, request.questions),
			signal: AbortSignal.timeout(
				configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			),
		});
	} catch (error) {
		throw new AiProviderError(
			error instanceof Error && error.name === 'TimeoutError'
				? 'PROVIDER_TIMEOUT'
				: 'PROVIDER_REQUEST_FAILED',
			'The decision provider could not be reached.',
			error instanceof Error
				? redactSecrets(error.message).slice(0, 300)
				: null,
		);
	}
	if (!response.ok) {
		throw failureFor(
			response.status,
			await response.text().catch(() => ''),
			configuration.credential.trim(),
		);
	}
	let payload: Record<string, unknown>;
	try {
		payload = (await response.json()) as Record<string, unknown>;
	} catch {
		throw new AiProviderError(
			'PROVIDER_REQUEST_FAILED',
			'The decision provider answered with a body that is not JSON.',
		);
	}
	const answers = (payload.answers ?? {}) as Record<string, unknown>;
	const usage = (payload.usage ?? {}) as Record<string, unknown>;
	return {
		answers: Object.fromEntries(
			Object.keys(request.questions).map((name) => [
				name,
				parseAnswer(name, answers[name]),
			]),
		),
		usage: {
			inputTokens:
				typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
			outputTokens:
				typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
		},
	};
}

/** The same shape the language-model probe reports, for one cheap question. */
export async function probeDecisionProvider(
	configuration: DecisionProviderConfiguration,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderReadinessResult> {
	const startedAt = Date.now();
	try {
		await askDecisions(
			{ ...configuration, timeoutMs },
			{
				state: 'The sandbox is checking that this credential answers.',
				questions: {
					ready: { type: 'noul', instruction: 'Is this text in English?' },
				},
			},
		);
		return {
			healthy: true,
			latencyMs: Date.now() - startedAt,
			errorCode: null,
			detail: null,
		};
	} catch (error) {
		const failure =
			error instanceof AiProviderError
				? error
				: new AiProviderError(
						'PROVIDER_REQUEST_FAILED',
						'The decision provider probe failed.',
					);
		return {
			healthy: false,
			latencyMs: Date.now() - startedAt,
			errorCode: failure.code,
			detail: failure.detail,
		};
	}
}
