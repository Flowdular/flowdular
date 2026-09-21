import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ROLES } from '@flowdular/coding-agent';
import type { DecisionResult } from '@flowdular/ai-provider';
import { decisionSettings } from '../src/server/decision-settings.ts';
import { planWork } from '../src/server/planning.ts';
import type { DecisionAsk } from '../src/server/decisions-runtime.ts';

const MODULES = [
	{ id: 'auth.core', directory: 'auth', name: 'auth' },
	{ id: 'users.core', directory: 'users', name: 'users' },
	{ id: 'catalog.core', directory: 'catalog', name: 'catalog' },
];

/* A registry whose resolve always throws stands for "no coding agent is
   available": the planner turn cannot run, so whatever the test observes came
   from the decisions or from the rules. */
const NO_DRIVER = {
	resolve: () => {
		throw new Error('No driver in this test.');
	},
} as unknown as Parameters<typeof planWork>[0]['registry'];

function answers(
	result: Partial<DecisionResult['answers']>,
	record?: { state?: string; questions?: readonly string[] },
): DecisionAsk {
	return (request) => {
		if (record) {
			record.state = request.state;
			record.questions = Object.keys(request.questions);
		}
		return Promise.resolve({
			answers: result as DecisionResult['answers'],
			usage: { inputTokens: 300, outputTokens: 0 },
		});
	};
}

function choice(value: string, confidence: number) {
	return {
		type: 'choice' as const,
		choice: value,
		probabilities: { [value]: confidence },
		confidence,
	};
}

function plan(decide: DecisionAsk | undefined, brief: string) {
	return planWork({
		brief,
		driver: 'claude-code',
		registry: NO_DRIVER,
		roles: DEFAULT_AGENT_ROLES,
		modules: MODULES,
		...(decide ? { decide } : {}),
	});
}

describe('planning with a decision provider', () => {
	it('routes to a module the brief never names', async () => {
		const seen: { state?: string; questions?: readonly string[] } = {};

		const result = await plan(
			answers(
				{
					module: choice('catalog.core', 0.93),
					spans_modules: { type: 'noul', noul: 0.04 },
					role: choice('backend-engineer', 0.81),
				},
				seen,
			),
			'Prices should carry a currency.',
		);

		expect(result).toMatchObject({
			kind: 'edit-module',
			moduleId: 'catalog.core',
			sourceModule: 'catalog',
			firstRole: 'backend-engineer',
			classifiedBy: 'decision',
		});
		expect(result.rationale).toContain('0.93');
		expect(seen.questions).toEqual(['module', 'spans_modules', 'role']);
		expect(seen.state).toContain('Prices should carry a currency.');
		expect(seen.state).toContain('catalog.core');
	});

	/* The rules would have invented a module id from the brief; the decision
	   only replaces the classification, never the naming. */
	it('keeps the rules plan when no existing module covers the request', async () => {
		const result = await plan(
			answers({
				module: choice('none_of_these', 0.95),
				spans_modules: { type: 'noul', noul: 0.02 },
				role: choice('business-manager', 0.9),
			}),
			'Teams should log time against a project.',
		);

		/* The modules came from the rules, so the transcript keeps crediting
		   them; only the first role came from the decision. */
		expect(result).toMatchObject({
			kind: 'new-module',
			firstRole: 'business-manager',
			classifiedBy: 'rules',
		});
		expect(result.moduleId).toMatch(/^[a-z][a-z0-9-]*\.core$/);
	});

	it('falls back to the rules below the module confidence threshold', async () => {
		const result = await plan(
			answers({
				module: choice('users.core', 0.55),
				spans_modules: { type: 'noul', noul: 0.1 },
				role: choice('backend-engineer', 0.99),
			}),
			'Something about invoices.',
		);

		expect(result.classifiedBy).toBe('rules');
	});

	/* One choice cannot name a set, so a multi-module brief is left to the
	   planner turn that can. */
	it('hands a brief that spans modules back to the planner turn', async () => {
		const result = await plan(
			answers({
				module: choice('auth.core', 0.97),
				spans_modules: { type: 'noul', noul: 0.88 },
				role: choice('backend-engineer', 0.9),
			}),
			'Add a field in auth and show it in the catalog screen.',
		);

		expect(result.classifiedBy).toBe('rules');
	});

	it('keeps the rules role when the role answer is not confident', async () => {
		const result = await plan(
			answers({
				module: choice('users.core', 0.9),
				spans_modules: { type: 'noul', noul: 0.05 },
				role: choice('frontend-engineer', 0.31),
			}),
			'Members should see who invited them.',
		);

		expect(result).toMatchObject({
			moduleId: 'users.core',
			firstRole: 'business-manager',
			classifiedBy: 'decision',
		});
	});

	it('ignores a role the workspace does not have', async () => {
		const result = await plan(
			answers({
				module: choice('users.core', 0.9),
				spans_modules: { type: 'noul', noul: 0.05 },
				role: choice('database-administrator', 0.99),
			}),
			'Members should see who invited them.',
		);

		expect(result.firstRole).toBe('business-manager');
	});

	/* A subset of the modules is worse than no question: the right one may not
	   be offered at all, and a confident wrong answer would be acted on. */
	it('asks nothing when the module list does not fit the option bound', async () => {
		let asked = false;
		const many = Array.from({ length: 64 }, (_, index) => ({
			id: `module${index}.core`,
			directory: `module${index}`,
			name: `module${index}`,
		}));

		const result = await planWork({
			brief: 'Something about invoices.',
			driver: 'claude-code',
			registry: NO_DRIVER,
			roles: DEFAULT_AGENT_ROLES,
			modules: many,
			decide: () => {
				asked = true;
				throw new Error('The decision provider must not be asked.');
			},
		});

		expect(asked).toBe(false);
		expect(result.classifiedBy).toBe('rules');
	});

	/* A provider that is down, rate limited or slow must not stop a session. */
	it('falls back to the rules when the provider fails', async () => {
		const result = await plan(
			() => Promise.reject(new Error('PROVIDER_RATE_LIMITED')),
			'Add custom roles to auth.core.',
		);

		expect(result).toMatchObject({
			moduleId: 'auth.core',
			classifiedBy: 'rules',
		});
	});

	it('asks nothing when no decision provider is configured', async () => {
		const result = await plan(undefined, 'Add custom roles to auth.core.');

		expect(result.classifiedBy).toBe('rules');
	});
});

describe('decision provider settings', () => {
	const root = process.cwd();

	it('says nothing changed when the request does not mention decisions', async () => {
		await expect(
			decisionSettings(root, { driver: 'byok' }, null),
		).resolves.toBeUndefined();
	});

	/* Sending a model or a key is configuration; sending the flag is consent. */
	it('leaves decisions off when the request only configures them', async () => {
		const settings = await decisionSettings(
			root,
			{ decisionsModel: 'jev-preview' },
			null,
		);

		expect(settings).toMatchObject({ enabled: false, model: 'jev-preview' });
	});

	it('defaults the kind and model when only the flag is sent', async () => {
		const settings = await decisionSettings(
			root,
			{ decisionsEnabled: true },
			null,
		);

		expect(settings).toMatchObject({
			enabled: true,
			kind: 'typesafe',
			model: 'jev-latest',
			credential: null,
		});
	});

	it('keeps the stored provider while the flag is turned off', async () => {
		const settings = await decisionSettings(
			root,
			{ decisionsEnabled: false },
			{
				enabled: true,
				kind: 'typesafe',
				model: 'jev-latest',
				credential: null,
			},
		);

		expect(settings).toMatchObject({ enabled: false, model: 'jev-latest' });
	});

	it('removes the provider on request', async () => {
		await expect(
			decisionSettings(root, { decisionsRemove: true }, null),
		).resolves.toBeNull();
	});

	it('refuses a provider it does not implement', async () => {
		await expect(
			decisionSettings(root, { decisionsKind: 'oracle' }, null),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});
});
