import {
	moduleReviewRevision,
	recordAutoReview,
} from '../../src/server/auto-review.ts';
import {
	modulePathOf,
	sessionPaths,
	type SandboxSession,
} from '../../src/server/sessions.ts';
import type { GateId, GateResult } from '../../src/server/gates.ts';

/* Synthetic model output for orchestration/delivery fixtures, not a review of
   production code. Regression tests exercise the independent gate boundary. */
export const REVIEW_RESPONSE =
	'```auto-review\n' +
	JSON.stringify({
		verdict: 'pass',
		checks: Object.fromEntries(
			[
				'correctness',
				'security',
				'compatibility',
				'lifecycle',
				'tests',
				'ui',
			].map((key) => [
				key,
				`Synthetic ${key} evidence for this orchestration fixture.`,
			]),
		),
		findings: [],
	}) +
	'\n```\nHANDOFF: none - reviewed fixture';

export async function reviewFixture(
	root: string,
	session: SandboxSession,
): Promise<void> {
	const paths = sessionPaths(root, session.id, session.moduleSuffix);
	for (const module of session.modules) {
		if (
			!(await recordAutoReview(
				paths,
				module,
				await moduleReviewRevision(modulePathOf(paths, module.directory)),
				REVIEW_RESPONSE,
			))
		)
			throw new Error('Fixture review failed');
	}
}

export function fixtureGates(
	session: SandboxSession,
	gates: readonly string[],
	status: 'passed' | 'failed' = 'passed',
): GateResult[] {
	return gates.flatMap((id) =>
		(id === 'spec-schema' || id === 'module-schema'
			? [undefined]
			: session.modules.map((module) => module.directory)
		).map((module) => ({
			id: id as GateId,
			...(module ? { module } : {}),
			status,
			command: id,
			durationMs: 0,
			output: status === 'failed' ? `${id} failed` : '',
		})),
	);
}
