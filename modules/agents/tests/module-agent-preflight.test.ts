import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { defineAgent } from '../src/server/define-agent.ts';
import {
	agentRuntimeOptionsFromEnvironment,
	createAgentRuntime,
} from '../src/server/runtime.ts';
import { preflightModuleAgentDefinitions } from '../src/services/module-agent-preflight.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';

function definition(revision: number, name = `Catalog curator ${revision}`) {
	return defineAgent({
		moduleId: 'catalog.core',
		key: 'catalog-curator',
		definitionRevision: revision,
		name,
		description: 'Reviews and normalizes catalog records.',
		instructions: 'Use only the catalog tools explicitly granted to this run.',
		allowedTools: ['catalog.item.read'],
		limits: {
			maxSteps: 8,
			timeoutMs: 120_000,
			temperature: 0.2,
			maxOutputTokens: 4_096,
		},
	});
}

function databaseFixture(revision: number) {
	const directory = mkdtempSync(join(tmpdir(), 'module-agent-preflight-'));
	const path = join(directory, 'agents.db');
	const repository = new SqliteAgentRepository(path);
	repository.reconcileModuleAgents([definition(revision)], Date.now());
	repository.close();
	return { directory, path };
}

describe('module agent boot preflight', () => {
	it('uses a read-only connection and accepts an unchanged or newer definition', () => {
		const { directory, path } = databaseFixture(2);
		const before = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		const inspect = new DatabaseSync(path, { readOnly: true });
		const beforeTables = inspect
			.prepare(
				"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
			)
			.get();
		inspect.close();

		expect(preflightModuleAgentDefinitions(path, [definition(2)])).toHaveLength(
			1,
		);
		expect(preflightModuleAgentDefinitions(path, [definition(3)])).toHaveLength(
			1,
		);

		const afterInspect = new DatabaseSync(path, { readOnly: true });
		expect(
			afterInspect
				.prepare(
					"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
				)
				.get(),
		).toEqual(beforeTables);
		afterInspect.close();
		expect(readFileSync(path)).toEqual(before);
		expect(statSync(path).mtimeMs).toBe(beforeMtime);

		rmSync(directory, { recursive: true, force: true });
	});

	it('rejects drift and downgrade using the persisted high-water revision', () => {
		const { directory, path } = databaseFixture(2);
		expect(() => preflightModuleAgentDefinitions(path, [])).not.toThrow();
		expect(() =>
			preflightModuleAgentDefinitions(path, [definition(1)]),
		).toThrow(/MODULE_AGENT_REVISION_DOWNGRADE/);
		expect(() =>
			preflightModuleAgentDefinitions(path, [
				definition(2, 'Changed in place'),
			]),
		).toThrow(/MODULE_AGENT_REVISION_DRIFT/);

		rmSync(directory, { recursive: true, force: true });
	});

	it('keeps transactional reconciliation as a race-condition defense', async () => {
		const { directory, path } = databaseFixture(1);
		const base = agentRuntimeOptionsFromEnvironment(
			{ NODE_ENV: 'test' },
			process.cwd(),
		);
		const runtime = createAgentRuntime({
			...base,
			databasePath: path,
			moduleAgents: [definition(2)],
		});
		runtime.prepare();

		const competing = new SqliteAgentRepository(path);
		competing.reconcileModuleAgents([definition(3)], Date.now());
		competing.close();

		expect(() => runtime.start()).toThrow(/MODULE_AGENT_REVISION_DOWNGRADE/);
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	});
});
