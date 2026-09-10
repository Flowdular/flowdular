import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AGENT_ROLES,
	SANDBOX_AGENT_CONTRACT,
	composeInstruction,
	selectTaskSkill,
} from '../src/index.ts';

const available = [
	'auto-review',
	'module-new',
	'module-update',
	'ux-design',
	'agent-tool-design',
	'business-agent-design',
	'workflow-development',
	'migration-authoring',
	'bug-hunt',
	'test-hardening',
	'spec-approval',
];
const context = {
	role: 'backend-engineer',
	sessionKind: 'edit-module' as const,
	blueprint: 'edit-module@1.0.0',
	task: 'Add a field.',
	available,
};

describe('one task skill and bounded always-on instructions', () => {
	it.each([
		['business-manager', 'module-update'],
		['backend-engineer', 'module-update'],
		['frontend-engineer', 'ux-design'],
		['ux-designer', 'ux-design'],
		['agentic-engineer', 'agent-tool-design'],
	])('selects one installed skill for %s', (role, expected) => {
		expect(selectTaskSkill({ ...context, role })).toBe(expected);
	});
	it('prefers an eligible explicit skill, then a focused blueprint', () => {
		expect(
			selectTaskSkill({ ...context, blueprint: 'add-migration@1.0.0' }),
		).toBe('migration-authoring');
		expect(selectTaskSkill({ ...context, blueprint: 'bug-fix@1.0.0' })).toBe(
			'bug-hunt',
		);
		expect(
			selectTaskSkill({
				...context,
				blueprint: 'bug-fix@1.0.0',
				task: '$test-hardening and $bug-hunt',
			}),
		).toBe('test-hardening');
		expect(selectTaskSkill({ ...context, sessionKind: 'new-module' })).toBe(
			'module-new',
		);
		expect(
			selectTaskSkill({
				...context,
				role: 'agentic-engineer',
				task: 'Build a workflow DAG.',
			}),
		).toBe('workflow-development');
		expect(
			selectTaskSkill({
				...context,
				role: 'agentic-engineer',
				task: 'Ship a business agent.',
			}),
		).toBe('business-agent-design');
	});
	it.each([
		'business-manager',
		'backend-engineer',
		'frontend-engineer',
		'ux-designer',
		'agentic-engineer',
		'custom-role',
	])('routes auto-review explicitly for %s', (role) => {
		expect(
			selectTaskSkill({ ...context, role, task: 'Run $auto-review.' }),
		).toBe('auto-review');
	});
	it('never grants sandbox spec approval or loads a catalog on a missing match', () => {
		expect(selectTaskSkill({ ...context, task: '$spec-approval' })).toBe(
			'module-update',
		);
		expect(selectTaskSkill({ ...context, available: [] })).toBeNull();
		expect(selectTaskSkill({ ...context, role: 'custom-role' })).toBeNull();
	});
	it('keeps every composed role within a character budget, with exactly one skill path', () => {
		expect(SANDBOX_AGENT_CONTRACT.length).toBeLessThanOrEqual(3_000);
		for (const role of DEFAULT_AGENT_ROLES) {
			const instruction = composeInstruction(role, {
				moduleId: 'catalog.core',
				modulePath: 'modules/catalog',
				sessionKind: 'edit-module',
				blueprint: 'edit-module@1.0.0',
				allowedPaths: ['modules/catalog/src/**'],
				skill: selectTaskSkill({ ...context, role: role.id }),
			});
			expect(instruction.length).toBeLessThanOrEqual(5_500);
			expect(
				instruction.match(/reference\/skills\/[a-z-]+\/SKILL\.md/g),
			).toHaveLength(1);
		}
	});
	it('keeps the canonical root short and the detailed contract opt-in', async () => {
		const root = await readFile(
			new URL('../../../.ai/rules/flowdular.md', import.meta.url),
			'utf8',
		);
		expect(root.length).toBeLessThanOrEqual(4_200);
		expect(root).toContain('docs/agent-contract.md` (lookup only)');
		expect(root).toContain('Do not recursively');
	});
});
