import { describe, expect, it } from 'vitest';
import { AiProviderError } from '../src/errors.ts';
import {
	askDecisions,
	probeDecisionProvider,
	type DecisionProviderConfiguration,
} from '../src/decisions.ts';

function provider(
	handler: (request: Request) => Response | Promise<Response>,
	overrides: Partial<DecisionProviderConfiguration> = {},
): DecisionProviderConfiguration {
	return {
		kind: 'typesafe',
		model: 'jev-latest',
		credential: 'sk-test',
		fetch: (input, init) =>
			Promise.resolve(handler(new Request(input as string, init))),
		...overrides,
	};
}

function answered(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

const CHOICE = {
	kind: {
		type: 'choice' as const,
		instruction: 'Does the request change an existing module?',
		options: ['new-module', 'edit-module'],
	},
};

describe('askDecisions', () => {
	it('sends one request for every question and reads the typed answers', async () => {
		let seen: { url: string; body: string; authorization: string } | undefined;

		const result = await askDecisions(
			provider(async (request) => {
				seen = {
					url: request.url,
					body: await request.text(),
					authorization: request.headers.get('authorization') ?? '',
				};
				return answered({
					model: 'jev-1.13.0',
					answers: {
						kind: {
							type: 'choice',
							choice: 'edit-module',
							probabilities: { 'edit-module': 0.91, 'new-module': 0.09 },
							confidence: 0.88,
						},
					},
					usage: { input_tokens: 412, output_tokens: 0 },
				});
			}),
			{ state: 'Add a due date to invoices.', questions: CHOICE },
		);

		expect(seen?.url).toBe('https://api.typesafe.ai/v1/systemone');
		expect(seen?.authorization).toBe('Bearer sk-test');
		/* The wire contract from docs.typesafe.ai/primitives: the answer set is
		   `criteria`, an option map for a choice and an ordered array for a
		   score, and the question text is `instructions`. */
		expect(JSON.parse(seen?.body ?? '{}')).toEqual({
			model: 'jev-latest',
			state: 'Add a due date to invoices.',
			questions: {
				kind: {
					type: 'choice',
					instructions: 'Does the request change an existing module?',
					criteria: { 'new-module': null, 'edit-module': null },
				},
			},
		});
		expect(result.answers.kind).toEqual({
			type: 'choice',
			choice: 'edit-module',
			probabilities: { 'edit-module': 0.91, 'new-module': 0.09 },
			confidence: 0.88,
		});
		expect(result.usage).toEqual({ inputTokens: 412, outputTokens: 0 });
	});

	it('sends a score rubric as the ordered criteria array', async () => {
		let body = '{}';

		await askDecisions(
			provider(async (request) => {
				body = await request.text();
				return answered({
					answers: {
						severity: { type: 'score', score: 1.4, confidence: 0.42 },
					},
				});
			}),
			{
				state: 'The export button crashes the settings page.',
				questions: {
					severity: {
						type: 'score',
						instruction: 'How severe is the reported issue?',
						levels: ['Cosmetic', 'Workaround exists', 'Blocking'],
					},
				},
			},
		);

		expect(JSON.parse(body).questions.severity).toEqual({
			type: 'score',
			instructions: 'How severe is the reported issue?',
			criteria: ['Cosmetic', 'Workaround exists', 'Blocking'],
		});
	});

	it('reads a yes or no answer as its probability', async () => {
		const result = await askDecisions(
			provider(() =>
				answered({ answers: { ready: { type: 'noul', noul: 0.97 } } }),
			),
			{
				state: 'The brief names one module and one field.',
				questions: {
					ready: { type: 'noul', instruction: 'Is the brief specific?' },
				},
			},
		);

		expect(result.answers.ready).toEqual({ type: 'noul', noul: 0.97 });
	});

	it('classifies a rejected credential without echoing it', async () => {
		await expect(
			askDecisions(
				provider(
					() => new Response('{"error":"bad key sk-test"}', { status: 401 }),
				),
				{ state: 'anything', questions: CHOICE },
			),
		).rejects.toMatchObject({
			code: 'PROVIDER_AUTHENTICATION_FAILED',
			detail: expect.not.stringContaining('sk-test'),
		});
	});

	it('classifies the rate limit and the overloaded service apart', async () => {
		for (const [status, code] of [
			[429, 'PROVIDER_RATE_LIMITED'],
			[529, 'PROVIDER_UNAVAILABLE'],
			[422, 'PROVIDER_REQUEST_REJECTED'],
		] as const) {
			await expect(
				askDecisions(
					provider(() => new Response('', { status })),
					{
						state: 'anything',
						questions: CHOICE,
					},
				),
			).rejects.toMatchObject({ code });
		}
	});

	it('refuses an answer shape it cannot act on', async () => {
		await expect(
			askDecisions(
				provider(() =>
					answered({ answers: { kind: { type: 'choice', choice: '' } } }),
				),
				{ state: 'anything', questions: CHOICE },
			),
		).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
	});

	/* A question set or state that grew without a bound would be billed before
	   anything noticed, so the refusal happens before the request. */
	it('refuses an unbounded state, an empty option set and a bad name', async () => {
		const unreachable = provider(() => {
			throw new Error('The request must not be sent.');
		});

		await expect(
			askDecisions(unreachable, {
				state: 'x'.repeat(32_001),
				questions: CHOICE,
			}),
		).rejects.toBeInstanceOf(AiProviderError);
		await expect(
			askDecisions(unreachable, {
				state: 'anything',
				questions: {
					kind: { type: 'choice', instruction: 'Which?', options: ['only'] },
				},
			}),
		).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIGURATION' });
		await expect(
			askDecisions(unreachable, {
				state: 'anything',
				questions: {
					'Not A Name': { type: 'noul', instruction: 'Is it?' },
				},
			}),
		).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIGURATION' });
	});

	it('refuses a plaintext base URL that is not on loopback', async () => {
		await expect(
			askDecisions(
				provider(() => answered({ answers: {} }), {
					baseURL: 'http://decisions.example.com',
				}),
				{ state: 'anything', questions: CHOICE },
			),
		).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIGURATION' });
	});
});

describe('probeDecisionProvider', () => {
	it('reports a healthy provider with its latency', async () => {
		const readiness = await probeDecisionProvider(
			provider(() =>
				answered({ answers: { ready: { type: 'noul', noul: 0.99 } } }),
			),
		);

		expect(readiness).toMatchObject({ healthy: true, errorCode: null });
	});

	it('reports the classified failure instead of throwing', async () => {
		const readiness = await probeDecisionProvider(
			provider(() => new Response('', { status: 401 })),
		);

		expect(readiness).toMatchObject({
			healthy: false,
			errorCode: 'PROVIDER_AUTHENTICATION_FAILED',
		});
	});
});
