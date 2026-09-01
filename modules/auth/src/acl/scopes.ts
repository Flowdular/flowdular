export const AUTH_SCOPES = {
	profileRead: 'auth.profile.read',
	sessionManage: 'auth.session.manage',
	accountManage: 'auth.account.manage',
	tenantSwitch: 'auth.tenant.switch',
	tokensRead: 'auth.tokens.read',
	tokensManage: 'auth.tokens.manage',
	rolesRead: 'auth.roles.read',
	rolesManage: 'auth.roles.manage',
	auditRead: 'auth.audit.read',
} as const;

export const PLATFORM_SCOPES = {
	workspaceAccess: 'system.workspace.access',
	modulesRead: 'system.modules.read',
	specsRead: 'system.specs.read',
	runsRead: 'system.runs.read',
	settingsRead: 'system.settings.read',
	settingsManage: 'system.settings.manage',
} as const;

export const BUNDLED_MODULE_SCOPES = {
	usersRead: 'users.members.read',
	usersManage: 'users.members.manage',
	partiesRead: 'parties.records.read',
	partiesManage: 'parties.records.manage',
	catalogRead: 'catalog.items.read',
	catalogManage: 'catalog.items.manage',
	agentDefinitionsRead: 'agents.definitions.read',
	agentDefinitionsManage: 'agents.definitions.manage',
	agentRunsRead: 'agents.runs.read',
	agentRunsExecute: 'agents.runs.execute',
	agentProvidersRead: 'agents.providers.read',
	agentProvidersManage: 'agents.providers.manage',
	agentProvidersTest: 'agents.providers.test',
	agentSkillsRead: 'agents.skills.read',
	agentSkillsManage: 'agents.skills.manage',
	sandboxAccessUse: 'sandbox.access.use',
	sandboxAccessManage: 'sandbox.access.manage',
	sandboxSessionsRead: 'sandbox.sessions.read',
	sandboxPreviewData: 'sandbox.preview.data',
	sandboxModulesEject: 'sandbox.modules.eject',
} as const;

export const OWNER_SCOPES = Object.freeze([
	...Object.values(AUTH_SCOPES),
	...Object.values(PLATFORM_SCOPES),
	...Object.values(BUNDLED_MODULE_SCOPES),
]);

export const MEMBER_SCOPES = Object.freeze([
	AUTH_SCOPES.profileRead,
	AUTH_SCOPES.sessionManage,
	AUTH_SCOPES.tenantSwitch,
	AUTH_SCOPES.rolesRead,
	PLATFORM_SCOPES.workspaceAccess,
	BUNDLED_MODULE_SCOPES.usersRead,
	BUNDLED_MODULE_SCOPES.partiesRead,
	BUNDLED_MODULE_SCOPES.catalogRead,
	BUNDLED_MODULE_SCOPES.agentDefinitionsRead,
	BUNDLED_MODULE_SCOPES.agentRunsRead,
	BUNDLED_MODULE_SCOPES.agentRunsExecute,
	BUNDLED_MODULE_SCOPES.agentSkillsRead,
]);

/* Built-in roles; every tenant gets a row per entry in auth_roles. */
export const BUILTIN_ROLES = Object.freeze([
	{
		key: 'owner',
		name: 'Owner',
		description:
			'Full workspace administration, module management, and operational access.',
		scopes: OWNER_SCOPES,
	},
	{
		key: 'member',
		name: 'Member',
		description:
			'Standard workspace access with read-only access to bundled records.',
		scopes: MEMBER_SCOPES,
	},
] as const);

export type AuthScope =
	| (typeof OWNER_SCOPES)[number]
	| (typeof MEMBER_SCOPES)[number];
