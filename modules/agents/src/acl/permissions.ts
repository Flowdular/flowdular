export const AGENT_PERMISSIONS = {
	definitionsRead: 'agents.definitions.read',
	definitionsManage: 'agents.definitions.manage',
	runsRead: 'agents.runs.read',
	runsExecute: 'agents.runs.execute',
	providersRead: 'agents.providers.read',
	providersManage: 'agents.providers.manage',
	providersTest: 'agents.providers.test',
	/* Product term is Procedures. The identifiers keep their skill-era
	   spelling so existing tenant grants stay valid. */
	proceduresRead: 'agents.skills.read',
	proceduresManage: 'agents.skills.manage',
} as const;
