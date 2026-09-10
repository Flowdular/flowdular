export interface TaskSkillContext {
	readonly role: string;
	readonly sessionKind: 'new-module' | 'edit-module';
	readonly blueprint: string;
	readonly task: string;
	readonly available: readonly string[];
}

/* A single deterministic selection. Discovery is not injected into the prompt.
   Only skills this specialist can use are eligible for an explicit $skill. */
const ROLE_SKILLS: Readonly<Record<string, readonly string[]>> = {
	'business-manager': ['module-new', 'module-update'],
	'backend-engineer': [
		'module-new',
		'module-update',
		'database-adapter',
		'migration-authoring',
		'bug-hunt',
		'test-hardening',
		'auth-security-review',
		'perf-audit',
	],
	'frontend-engineer': [
		'ux-design',
		'module-update',
		'variables',
		'workflow-development',
		'bug-hunt',
		'test-hardening',
	],
	'ux-designer': ['ux-design'],
	'agentic-engineer': [
		'agent-tool-design',
		'business-agent-design',
		'workflow-development',
		'variables',
		'test-hardening',
	],
};

export function selectTaskSkill(context: TaskSkillContext): string | null {
	// Review is read-only and is available to custom registered specialists too.
	const eligible = [...(ROLE_SKILLS[context.role] ?? []), 'auto-review'];
	const available = new Set(context.available);
	const installed = (skill: string) =>
		eligible.includes(skill) && available.has(skill);
	const explicit = [...context.task.matchAll(/\$([a-z][a-z0-9-]*)\b/g)]
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
