import { describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

interface Reports {
	readonly reports: readonly { file: string; valid: boolean }[];
}

/* These run against this repository, so they lock the gates the workspace
   depends on: blueprints must be discoverable and every spec kind validated. */
describe('workspace validation commands', () => {
	it('lists the blueprints under .ai', async () => {
		const result = await runCommand(parseArguments(['blueprint', 'list']));
		expect(result.ok).toBe(true);
		expect((result.data as { blueprints: string[] }).blueprints).toEqual(
			expect.arrayContaining([
				'.ai/blueprints/author-spec/blueprint.json',
				'.ai/blueprints/new-module/blueprint.json',
			]),
		);
	});

	it('validates every discovered blueprint', async () => {
		const result = await runCommand(
			parseArguments(['blueprint', 'validate', '--all']),
		);
		expect(result.ok).toBe(true);
		const files = (result.data as Reports).reports.map((report) => report.file);
		expect(files).toContain('.ai/blueprints/new-module/blueprint.json');
		expect(files).toContain('.ai/blueprints/author-spec/blueprint.json');
	});

	it('validates platform specs only with --all', async () => {
		const modulesOnly = await runCommand(parseArguments(['spec', 'validate']));
		expect(modulesOnly.ok).toBe(true);
		const moduleFiles = (modulesOnly.data as Reports).reports.map(
			(report) => report.file,
		);
		expect(moduleFiles).toContain('modules/profile/spec/module.yaml');
		expect(moduleFiles.some((file) => file.startsWith('specs/'))).toBe(false);

		const all = await runCommand(parseArguments(['spec', 'validate', '--all']));
		expect(all.ok).toBe(true);
		const files = (all.data as Reports).reports.map((report) => report.file);
		expect(files).toContain('modules/profile/spec/module.yaml');
		expect(files).toContain('specs/platform.yaml');
	});

	it('validates module manifests against their sources', async () => {
		const result = await runCommand(parseArguments(['module', 'validate']));
		expect(result.ok).toBe(true);
		expect((result.data as { order: string[] }).order).toContain(
			'profile.core',
		);
	});

	it('reports composition drift and blueprint discovery in doctor', async () => {
		const result = await runCommand(parseArguments(['doctor']));
		expect(result.ok).toBe(true);
		const checks = (result.data as { checks: { id: string; status: string }[] })
			.checks;
		expect(checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'blueprints.discovered',
					status: 'pass',
				}),
				expect.objectContaining({
					id: 'composition.generated',
					status: 'pass',
				}),
			]),
		);
	});
});
