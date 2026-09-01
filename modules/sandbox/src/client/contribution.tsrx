import type { ModuleClientContribution } from '@coreloom/client';
import { SANDBOX_PERMISSIONS } from '../acl/permissions.ts';
import { SandboxAccessView } from './SandboxAccessView.tsrx';

export interface SandboxClientContributionOptions {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export function createSandboxClientContribution(
	options: SandboxClientContributionOptions,
): ModuleClientContribution {
	return {
		moduleId: 'sandbox.core',
		navigation: [
			{
				id: 'sandbox.navigation.access',
				viewId: 'sandbox',
				group: 'Development',
				label: 'Sandbox',
				glyph: 'flask',
				description: 'Access and module sessions',
				scope: SANDBOX_PERMISSIONS.manage,
				order: 50,
			},
		],
		views: [
			{
				id: 'sandbox',
				render: () =>
					<SandboxAccessView
						csrfToken={options.csrfToken}
						canReadSessions={options.scopes.includes(
							SANDBOX_PERMISSIONS.sessionsRead,
						)}
					/>,
			},
		],
	};
}
