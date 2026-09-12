import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
	ALWAYS_ELIGIBLE_SKILLS,
	DEFAULT_AGENT_ROLES,
	ROLE_SKILLS,
	selectTaskSkill,
} from '../src/index.ts';

const SKILLS = new URL('../../../.ai/skills/', import.meta.url);

/* The front matter says who reads a skill and the routing table says who can be
   given it. In the sandbox those are the same claim, so a role named in one and
   missing from the other is a routing lie the operator cannot see. */
async function declaredRoles(): Promise<
	ReadonlyMap<string, readonly string[]>
> {
	const entries = await readdir(SKILLS, { withFileTypes: true });
	const declared = new Map<string, readonly string[]>();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const document = await readFile(
			new URL(`${entry.name}/SKILL.md`, SKILLS),
			'utf8',
		);
		const block = /^roles:\n((?: {2}- [a-z][a-z0-9-]*\n)+)/m.exec(document);
		expect(block, `${entry.name} declares no roles`).not.toBeNull();
		declared.set(
			entry.name,
			[...block![1]!.matchAll(/ {2}- ([a-z][a-z0-9-]*)/g)].map(
				(match) => match[1]!,
			),
		);
	}
	expect(declared.size).toBeGreaterThan(0);
	return declared;
}

const sandboxRoles = DEFAULT_AGENT_ROLES.map((role) => role.id);

describe('sandbox skill routing', () => {
	it('gives every sandbox role a skill list', () => {
		for (const role of sandboxRoles) expect(ROLE_SKILLS[role]).toBeDefined();
	});

	it('routes only skills that declare the role', async () => {
		const declared = await declaredRoles();
		for (const role of sandboxRoles) {
			for (const skill of ROLE_SKILLS[role]!) {
				expect(declared.get(skill), `${skill} has no SKILL.md`).toBeDefined();
				expect(
					declared.get(skill),
					`${skill} is routed to ${role} but does not declare it`,
				).toContain(role);
			}
		}
	});

	it('routes every skill that declares a sandbox role', async () => {
		for (const [skill, roles] of await declaredRoles()) {
			for (const role of roles) {
				if (!sandboxRoles.includes(role)) continue;
				if (ALWAYS_ELIGIBLE_SKILLS.includes(skill)) continue;
				expect(
					ROLE_SKILLS[role],
					`${skill} declares ${role} but is not routed to it`,
				).toContain(skill);
			}
		}
	});

	it('keeps the always-eligible skills out of the per-role lists', () => {
		for (const role of sandboxRoles)
			for (const skill of ALWAYS_ELIGIBLE_SKILLS)
				expect(ROLE_SKILLS[role]).not.toContain(skill);
	});

	it('scans only the operator text for an explicit skill', () => {
		const context = {
			role: 'agentic-engineer',
			sessionKind: 'edit-module' as const,
			blueprint: 'edit-module@1.0.0',
			available: ['agent-tool-design', 'workflow-development', 'variables'],
		};
		/* An answered turn: the decisions are the specialist's own words read
		   back, and only what the operator typed may name a skill. */
		const decisions =
			'Decisions:\n- Q-1: Which workflow reads $variables? -> The nightly one';
		expect(
			selectTaskSkill({ ...context, task: decisions, explicitSkillSource: '' }),
		).toBe('workflow-development');
		expect(
			selectTaskSkill({
				...context,
				task: `${decisions}\n\nUse $variables for it.`,
				explicitSkillSource: 'Use $variables for it.',
			}),
		).toBe('variables');
		/* Without a narrower source the whole request names the skill. */
		expect(selectTaskSkill({ ...context, task: 'Wire $variables in.' })).toBe(
			'variables',
		);
	});

	it('interviews a new module and implements an approved one', () => {
		const context = {
			role: 'business-manager',
			sessionKind: 'new-module' as const,
			blueprint: 'new-module@1.0.0',
			task: 'We need to track service orders.',
			available: ['spec-interview', 'module-new', 'module-update'],
		};
		expect(selectTaskSkill(context)).toBe('spec-interview');
		expect(selectTaskSkill({ ...context, specApproved: false })).toBe(
			'spec-interview',
		);
		expect(selectTaskSkill({ ...context, specApproved: true })).toBe(
			'module-new',
		);
		expect(selectTaskSkill({ ...context, sessionKind: 'edit-module' })).toBe(
			'module-update',
		);
		/* A workspace without the skill installed keeps the old default. */
		expect(selectTaskSkill({ ...context, available: ['module-new'] })).toBe(
			'module-new',
		);
		expect(selectTaskSkill({ ...context, role: 'backend-engineer' })).toBe(
			'module-new',
		);
	});
});
