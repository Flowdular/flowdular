export const RESEARCH_PERMISSIONS = {
	read: 'research.evidence.read',
	run: 'research.run',
	settings: 'research.settings.manage',
} as const;

export const permissions = Object.freeze(Object.values(RESEARCH_PERMISSIONS));
