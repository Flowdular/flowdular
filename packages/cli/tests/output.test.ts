import { describe, expect, it } from 'vitest';
import { success, failure } from '@flowdular/cli-protocol';
import { renderOutput } from '../src/output.ts';

describe('human CLI output', () => {
	it('keeps safety warnings and evidence visible', () => {
		const output = renderOutput(
			success(
				{ applied: false },
				{ warnings: ['Dry run only.'], evidence: ['spec/module.yaml'] },
			),
			false,
		);
		expect(output).toContain('WARNING Dry run only.');
		expect(output).toContain('EVIDENCE spec/module.yaml');
	});

	it('renders a capability descriptor list as a table', () => {
		const output = renderOutput(
			success({
				capabilities: [
					{ id: 'workspace.doctor', risk: 'read', summary: 'Check it.' },
				],
			}),
			false,
		);
		expect(output).toContain('workspace.doctor');
		expect(output).toContain('Check it.');
	});

	it('falls back to JSON when a command returns plain capability ids', () => {
		const output = renderOutput(
			success({ capabilities: ['sandbox.access.use'] }),
			false,
		);
		expect(output).toContain('"sandbox.access.use"');
	});
});

it('shows each failed doctor check in human output', () => {
	const output = renderOutput(
		failure('DOCTOR_FAILED', '1 workspace check failed.', {
			checks: [
				{
					id: 'policy.capabilities',
					status: 'fail',
					message: 'Policy is missing.',
				},
				{ id: 'runtime.node', status: 'pass', message: 'Node is available.' },
			],
		}),
		false,
	);
	expect(output).toContain('FAIL policy.capabilities  Policy is missing.');
	expect(output).not.toContain('PASS runtime.node');
});

it('renders a concise setup result and cancellation instead of internal JSON', () => {
	expect(renderOutput(success({ cancelled: true }), false)).toBe(
		'Setup cancelled.',
	);
	const output = renderOutput(
		success({ setup: 'postgresql', configured: true }),
		false,
	);
	expect(output).toContain('PostgreSQL settings saved to .env.');
	expect(output).not.toContain('"configured":');
});
