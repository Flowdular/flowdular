export interface TaskSkillContext {
	readonly role: string;
	readonly sessionKind: 'new-module' | 'edit-module';
	readonly blueprint: string;
	readonly task: string;
	/* The text an explicit $skill may come from. Defaults to the request text.
	   A turn whose request also carries words a specialist wrote narrows it to
	   the operator's own, so a question can never choose the skill that answers
	   it; empty means this turn has no operator text to scan. The keyword
	   defaults keep reading `task`, which is the whole request either way. */
	readonly explicitSkillSource?: string;
	readonly available: readonly string[];
	/* Whether the operator has approved the exact current specification of the
	   module this turn works on. Absent counts as not approved, so a new module
	   starts with the interview instead of the implementation skill. */
	readonly specApproved?: boolean;
}

/* A single deterministic selection. Discovery is not injected into the prompt.
   Only skills this specialist can use are eligible for an explicit $skill. */
export const ROLE_SKILLS: Readonly<Record<string, readonly string[]>> = {
	'business-manager': [
		'spec-interview',
		'module-new',
		'module-update',
		'translations-i18n',
	],
	'backend-engineer': [
		'module-new',
		'module-update',
		'database-adapter',
		'migration-authoring',
		'bug-hunt',
		'test-hardening',
		'auth-security-review',
		'cli-extension',
		'perf-audit',
	],
	'frontend-engineer': [
		'ux-design',
		'module-update',
		'translations-i18n',
		'variables',
		'workflow-development',
		'bug-hunt',
		'test-hardening',
	],
	'ux-designer': ['ux-design', 'translations-i18n'],
	'agentic-engineer': [
		'agent-tool-design',
		'business-agent-design',
		'workflow-development',
		'variables',
		'test-hardening',
	],
};

/* Review is read-only and is available to custom registered specialists too, so
   it is eligible for every role without appearing in any role's list. */
export const ALWAYS_ELIGIBLE_SKILLS: readonly string[] = ['auto-review'];

export function selectTaskSkill(context: TaskSkillContext): string | null {
	const eligible = [
		...(ROLE_SKILLS[context.role] ?? []),
		...ALWAYS_ELIGIBLE_SKILLS,
	];
	const available = new Set(context.available);
	const installed = (skill: string) =>
		eligible.includes(skill) && available.has(skill);
	const explicit = [
		...(context.explicitSkillSource ?? context.task).matchAll(
			/\$([a-z][a-z0-9-]*)\b/g,
		),
	]
		.map((match) => match[1]!)
		.find(installed);
	if (explicit) return explicit;
	const blueprint = context.blueprint.split('@')[0];
	const focused =
		blueprint === 'add-migration'
			? 'migration-authoring'
			: blueprint === 'bug-fix'
				? 'bug-hunt'
				: null;
	if (focused && installed(focused)) return focused;
	/* A new module starts as an interview, not as an implementation: until the
	   operator approves the exact spec there is nothing to implement from. */
	if (
		context.role === 'business-manager' &&
		context.sessionKind === 'new-module' &&
		context.specApproved !== true &&
		installed('spec-interview')
	)
		return 'spec-interview';
	const moduleSkill =
		context.sessionKind === 'new-module' ? 'module-new' : 'module-update';
	const defaultSkill =
		context.role === 'agentic-engineer'
			? /\b(workflow|pipeline|dag)\b/i.test(context.task)
				? 'workflow-development'
				: /\b(defineAgent|business agent|agent biznesowy)\b/i.test(context.task)
					? 'business-agent-design'
					: 'agent-tool-design'
			: context.role === 'frontend-engineer' || context.role === 'ux-designer'
				? 'ux-design'
				: moduleSkill;
	return installed(defaultSkill) ? defaultSkill : null;
}
