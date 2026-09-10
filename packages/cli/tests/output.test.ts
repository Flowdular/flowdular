import { describe, expect, it } from 'vitest';
import { success } from '@flowdular/cli-protocol';
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
