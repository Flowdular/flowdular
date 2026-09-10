import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AGENT_ROLES,
	SANDBOX_ROLE_DIRECTORY,
	composeInstruction,
	findRole,
	loadAgentRoles,
	materializeAgentRoles,
	parseHandoff,
	parseRoleDocument,
	renderRoleDocument,
} from '../src/index.ts';

async function workspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'flowdular-roles-'));
}

describe('agent roles', () => {
	it('ships specialists with disjoint responsibilities', () => {
		const ids = DEFAULT_AGENT_ROLES.map((role) => role.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain('business-manager');
		expect(ids).toContain('backend-engineer');
		expect(
			findRole(DEFAULT_AGENT_ROLES, 'business-manager').allowedPaths,
		).not.toContain('src/api/**');
	});

	it('round-trips a role document', () => {
		const role = findRole(DEFAULT_AGENT_ROLES, 'frontend-engineer');
		expect(parseRoleDocument(renderRoleDocument(role))).toEqual(role);
	});

	it('rejects a document without front matter', () => {
		expect(() => parseRoleDocument('# just markdown')).toThrow(/front matter/);
	});

	it('lets a workspace override a bundled role by id', async () => {
		const root = await workspace();
		await mkdir(join(root, SANDBOX_ROLE_DIRECTORY), { recursive: true });
		await writeFile(
			join(root, SANDBOX_ROLE_DIRECTORY, 'backend-engineer.md'),
			[
				'---',
				'id: backend-engineer',
				'name: Backend engineer',
				'purpose: Workspace specific rules.',
				'allowedPaths:',
				"  - 'src/api/**'",
				'gates:',
				'  - tests',
				'handoff: []',
				'---',
				'',
				'Follow the workspace playbook.',
			].join('\n'),
			'utf8',
		);
		const roles = await loadAgentRoles(root);
		expect(findRole(roles, 'backend-engineer').instruction).toBe(
			'Follow the workspace playbook.',
		);
		expect(roles).toHaveLength(DEFAULT_AGENT_ROLES.length);
	});

	it('materializes the bundled roles for editing', async () => {
		const root = await workspace();
		const written = await materializeAgentRoles(root);
		expect(written).toHaveLength(DEFAULT_AGENT_ROLES.length);
		const roles = await loadAgentRoles(root);
		expect(roles.map((role) => role.id).sort()).toEqual(
			DEFAULT_AGENT_ROLES.map((role) => role.id).sort(),
		);
	});

	it('names the team a role may hand off to', () => {
		const instruction = composeInstruction(
			findRole(DEFAULT_AGENT_ROLES, 'business-manager'),
			{
				moduleId: 'sales.orders',
				modulePath: 'modules/sales-orders',
				sessionKind: 'new-module',
				blueprint: 'new-module@1.0.0',
				allowedPaths: [],
				team: ['backend-engineer: Implement the server.'],
			},
		);
		expect(instruction).toContain('HANDOFF: <role-id>');
		expect(instruction).toContain('Team you can hand off to');
		expect(instruction).toContain('backend-engineer: Implement the server.');
	});

	it('composes an instruction with the contract, role, and session facts', () => {
		const instruction = composeInstruction(
			findRole(DEFAULT_AGENT_ROLES, 'backend-engineer'),
			{
				moduleId: 'sales.orders',
				modulePath: 'modules/sales-orders',
				sessionKind: 'new-module',
				blueprint: 'new-module@1.0.0',
				allowedPaths: [],
			},
		);
		expect(instruction).toContain('Never install packages');
		expect(instruction).toContain('Role: Backend engineer');
		expect(instruction).toContain('Target module: sales.orders');
		expect(instruction).toContain('src/services/**');
		expect(instruction).toContain('operator approval of the exact spec hash');
		expect(instruction).toContain('applied SQL is immutable');
		expect(instruction).toContain('shared Table and TableCard');
		expect(instruction).toContain('translated copy');
		expect(instruction).toContain('public capabilities or registered tools');
		expect(instruction).toContain('No runtime superuser/BYPASSRLS');
	});

	it('requires an approved exact spec delta before an edit-module implementation', () => {
		const instruction = composeInstruction(
			findRole(DEFAULT_AGENT_ROLES, 'backend-engineer'),
			{
				moduleId: 'parties.core',
				modulePath: 'modules/parties',
				sessionKind: 'edit-module',
				blueprint: 'edit-module@1.0.0',
				allowedPaths: ['src/services/**'],
			},
		);
		expect(instruction).toContain(
			'author its spec delta first, then wait for operator approval of the exact spec hash before implementation',
		);
		expect(instruction).toContain(
			'Any later spec edit, request for changes, or added module invalidates the approval',
		);
	});
});

describe('handoff line', () => {
	it('reads the specialist and the reason', () => {
		expect(
			parseHandoff(
				'The spec is written.\n\nHANDOFF: backend-engineer - the API is next',
			),
		).toEqual({ role: 'backend-engineer', reason: 'the API is next' });
	});

	it('reads a finished turn', () => {
		expect(
			parseHandoff('Done.\nHANDOFF: none - the request is satisfied'),
		).toEqual({ role: null, reason: 'the request is satisfied' });
	});

	it('survives decoration and takes the last line', () => {
		expect(
			parseHandoff(
				'I will end with `HANDOFF: ux-designer`.\n\n**HANDOFF: frontend-engineer** \u2014 the screen is missing',
			),
		).toEqual({ role: 'frontend-engineer', reason: 'the screen is missing' });
	});

	it('answers nothing when the line is absent', () => {
		expect(parseHandoff('I changed the endpoint and added a test.')).toBeNull();
	});

	it('forgives a trailing full stop and a display name', () => {
		expect(parseHandoff('All good.\nHANDOFF: none.')).toEqual({
			role: null,
			reason: '',
		});
		expect(
			parseHandoff('HANDOFF: Backend Engineer - the API comes next.'),
		).toEqual({ role: 'backend-engineer', reason: 'the API comes next' });
		expect(
			parseHandoff('HANDOFF: frontend engineer: build the screen'),
		).toEqual({ role: 'frontend-engineer', reason: 'build the screen' });
	});
});
