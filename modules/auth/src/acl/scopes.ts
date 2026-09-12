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
	providersRead: 'auth.providers.read',
	providersManage: 'auth.providers.manage',
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
	agentDefinitionsRead: 'agents.definitions.read',
	agentDefinitionsManage: 'agents.definitions.manage',
	agentRunsRead: 'agents.runs.read',
	agentRunsExecute: 'agents.runs.execute',
	agentProvidersRead: 'agents.providers.read',
	agentProvidersManage: 'agents.providers.manage',
	agentProvidersTest: 'agents.providers.test',
	agentSkillsRead: 'agents.skills.read',
	agentSkillsManage: 'agents.skills.manage',
	notificationsInboxRead: 'notifications.inbox.read',
	notificationsInboxManage: 'notifications.inbox.manage',
	notificationsWebhooksRead: 'notifications.webhooks.read',
	notificationsWebhooksManage: 'notifications.webhooks.manage',
	notificationsDeliveriesRead: 'notifications.deliveries.read',
	sandboxAccessUse: 'sandbox.access.use',
	sandboxAccessManage: 'sandbox.access.manage',
	sandboxSessionsRead: 'sandbox.sessions.read',
	sandboxPreviewData: 'sandbox.preview.data',
	sandboxModulesEject: 'sandbox.modules.eject',
	directoryTokensRead: 'directory.tokens.read',
	directoryTokensManage: 'directory.tokens.manage',
	directoryProvisioningRead: 'directory.provisioning.read',
	auditRegistryRead: 'audit.registry.read',
	auditRetentionManage: 'audit.retention.manage',
	auditHoldsManage: 'audit.holds.manage',
	approvalsRequestsRead: 'approvals.requests.read',
	approvalsRequestsDecide: 'approvals.requests.decide',
	approvalsRequestsManage: 'approvals.requests.manage',
	documentsFilesRead: 'documents.files.read',
	documentsFilesManage: 'documents.files.manage',
	meteringUsageRead: 'metering.usage.read',
	importJobsRead: 'import.jobs.read',
	importJobsManage: 'import.jobs.manage',
	searchRecordsRead: 'search.records.read',
	connectorsInstancesRead: 'connectors.instances.read',
	connectorsInstancesManage: 'connectors.instances.manage',
	workflowsDefinitionsRead: 'workflows.definitions.read',
	workflowsDefinitionsManage: 'workflows.definitions.manage',
	workflowsDefinitionsPublish: 'workflows.definitions.publish',
	workflowsRunsRead: 'workflows.runs.read',
	workflowsRunsExecute: 'workflows.runs.execute',
	workflowsRunsCancel: 'workflows.runs.cancel',
	automationsSchedulesRead: 'automations.schedules.read',
	automationsSchedulesManage: 'automations.schedules.manage',
	automationsTriggersRead: 'automations.triggers.read',
	automationsTriggersManage: 'automations.triggers.manage',
	profileSelfManage: 'profile.self.manage',
	reportsWorkspaceRead: 'reports.workspace.read',
	exportsListsRead: 'exports.lists.read',
	exportsListsManage: 'exports.lists.manage',
	accessReviewRead: 'access.review.read',
	accessReviewManage: 'access.review.manage',
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
	BUNDLED_MODULE_SCOPES.agentDefinitionsRead,
	BUNDLED_MODULE_SCOPES.agentRunsRead,
	BUNDLED_MODULE_SCOPES.agentRunsExecute,
	BUNDLED_MODULE_SCOPES.agentSkillsRead,
	BUNDLED_MODULE_SCOPES.notificationsInboxRead,
	BUNDLED_MODULE_SCOPES.notificationsInboxManage,
	BUNDLED_MODULE_SCOPES.notificationsWebhooksRead,
	BUNDLED_MODULE_SCOPES.documentsFilesRead,
	BUNDLED_MODULE_SCOPES.documentsFilesManage,
	BUNDLED_MODULE_SCOPES.searchRecordsRead,
	BUNDLED_MODULE_SCOPES.connectorsInstancesRead,
	BUNDLED_MODULE_SCOPES.approvalsRequestsRead,
	BUNDLED_MODULE_SCOPES.approvalsRequestsDecide,
	BUNDLED_MODULE_SCOPES.profileSelfManage,
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
