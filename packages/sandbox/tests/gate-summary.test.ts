import { describe, expect, it } from 'vitest';
import {
	MAX_GATE_ISSUES,
	summarizeGate,
	type GateResult,
} from '../src/server/gates.ts';

/* The envelope `flowdular spec validate --all --json` prints when a
   specification is invalid: one report per specification in the workspace,
   the read-only reference copies included. */
function envelope(reports: readonly unknown[]): string {
	return JSON.stringify({
		protocolVersion: 1,
		ok: false,
		error: {
			code: 'SPEC_VALIDATION_FAILED',
			message: 'One or more specifications are invalid.',
			details: { reports },
		},
	});
}

function failed(
	output: string,
	id: GateResult['id'] = 'spec-schema',
): GateResult {
	return { id, status: 'failed', durationMs: 1, command: 'pnpm', output };
}

const RESERVED = {
	code: 'SPEC_FIELD_RESERVED',
	message:
		'Field "equipment-item.createdAt" collides with the id, tenantId or createdAt column every tenant table owns.',
	path: '/entities/0/fields/7/id',
	severity: 'error',
};

describe('the gate summary a transcript shows', () => {
	it('keeps the errors of the failing reports and drops the valid ones', () => {
		const summary = summarizeGate(
			failed(
				envelope([
					{
						file: 'reference/example-module/spec/module.yaml',
						valid: true,
						issues: [
							{
								code: 'SPEC_V1',
								message: 'Version 1 specification.',
								severity: 'warning',
							},
						],
					},
					{
						file: 'modules/equipment/spec/module.yaml',
						valid: false,
						issues: [
							RESERVED,
							{
								code: 'SPEC_NO_WIDGETS',
								message: 'No widget is declared.',
								path: '/widgets',
								severity: 'warning',
							},
						],
					},
				]),
			),
		);

		expect(summary).toEqual({
			id: 'spec-schema',
			status: 'failed',
			issues: [
				{
					file: 'modules/equipment/spec/module.yaml',
					code: 'SPEC_FIELD_RESERVED',
					path: '/entities/0/fields/7/id',
					message: RESERVED.message,
				},
			],
		});
	});

	it('counts the errors past the bound instead of dropping them in silence', () => {
		const issues = Array.from({ length: MAX_GATE_ISSUES + 3 }, (_, index) => ({
			...RESERVED,
			path: `/entities/0/fields/${index}/id`,
		}));
		const summary = summarizeGate(
			failed(
				envelope([
					{ file: 'modules/a/spec/module.yaml', valid: false, issues },
				]),
			),
		);

		expect(summary.issues).toHaveLength(MAX_GATE_ISSUES);
		expect(summary.moreIssues).toBe(3);
	});

	it('names the envelope error when no report carries one', () => {
		const output = JSON.stringify({
			protocolVersion: 1,
			ok: false,
			error: {
				code: 'MODULE_MANIFEST_MISSING',
				message: 'Enabled module booking has no module.json.',
			},
		});

		expect(summarizeGate(failed(output, 'module-schema')).issues).toEqual([
			{
				code: 'MODULE_MANIFEST_MISSING',
				message: 'Enabled module booking has no module.json.',
			},
		]);
	});

	it('leaves output that is not a validation envelope to the raw details', () => {
		const cut = envelope([
			{ file: 'modules/a/spec/module.yaml', valid: false, issues: [RESERVED] },
		]).slice(0, 120);

		for (const output of [
			'FAIL tests/booking.test.ts > refuses overlap',
			cut,
		]) {
			const summary = summarizeGate(failed(output, 'tests'));
			expect(summary).toEqual({ id: 'tests', status: 'failed' });
		}
		expect(
			summarizeGate({
				id: 'spec-schema',
				status: 'passed',
				durationMs: 1,
				command: 'pnpm',
				output: '{"protocolVersion":1,"ok":true}',
			}),
		).toEqual({ id: 'spec-schema', status: 'passed' });
	});
});
