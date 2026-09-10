/* In a module this is src/cli/index.ts. Every field of `capability` and the
   `path` must equal the entry in commands.json; packages/cli/src/extensions.ts
   (loadCliCommand) refuses the command otherwise. */
import { defineCliExtension } from '@flowdular/cli-protocol';

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'customer.core',
	commands: [
		{
			path: ['customer', 'export'],
			capability: {
				id: 'customer.export',
				version: 1,
				summary:
					'Export tenant-scoped customer records to an approved workspace path.',
				risk: 'workspace-write' as const,
				requiresApprovedSpec: true,
				supportsDryRun: true,
			},
			execute: ({ apply, arguments: arguments_, workspaceRoot }) => ({
				data: {
					applied: apply,
					format: arguments_[0] ?? 'json',
					target: `${workspaceRoot}/.flowdular/data/exports/customers.${arguments_[0] ?? 'json'}`,
				},
				evidence: ['modules/customer/spec/module.yaml'],
				warnings: apply
					? []
					: ['Dry run only. Pass --apply after reviewing the target.'],
			}),
		},
	],
});

export default cliExtension;
