# Module CLI extensions

The core CLI is the controlled automation boundary for developers, agents, and CI. An enabled ERP module may add commands inside its own namespace. A `customer.core` module can provide `customer export`, but it cannot claim `module`, `spec`, or another core command group.

## Contract

A module with the `cli` capability declares two paths in `module.json`:

```json
{
	"capabilities": ["cli"],
	"cli": {
		"catalog": "src/cli/commands.json",
		"entry": "src/cli/index.ts"
	}
}
```

`commands.json` is the discovery and policy surface. It is schema-validated without executing module code:

```json
{
	"protocolVersion": 1,
	"moduleId": "customer.core",
	"commands": [
		{
			"path": ["customer", "export"],
			"capability": {
				"id": "customer.export",
				"version": 1,
				"summary": "Export tenant-scoped customer records.",
				"risk": "workspace-write",
				"requiresApprovedSpec": true,
				"supportsDryRun": true
			}
		}
	]
}
```

The implementation exports the matching versioned command:

```ts
import { defineCliExtension } from '@flowdular/cli-protocol';

export default defineCliExtension({
	protocolVersion: 1,
	moduleId: 'customer.core',
	commands: [
		{
			path: ['customer', 'export'],
			capability: {
				id: 'customer.export',
				version: 1,
				summary: 'Export tenant-scoped customer records.',
				risk: 'workspace-write',
				requiresApprovedSpec: true,
				supportsDryRun: true,
			},
			execute: ({ apply, arguments: args }) => ({
				data: { applied: apply, format: args[0] ?? 'json' },
			}),
		},
	],
});
```

The CLI imports this code only after the exact command or capability is invoked. It rejects catalog and implementation drift before calling the handler.

## Execution rules

- Command paths and capability IDs must start with the first segment of the module ID.
- The module must be enabled in `flowdular.json`.
- Catalog and entry paths must resolve inside the module, including through symlinks.
- A command marked `requiresApprovedSpec` requires `--spec <path>` and an approved, schema-valid spec.
- Non-read commands are dry-run by default when supported. Other non-read commands require `--apply`.
- External and non-local destructive module capabilities remain disabled until a signed approval verifier is configured.
- A workspace-local destructive capability must declare `localOnly` and a typed confirmation token. It remains dry-run unless both `--apply` and the exact `--confirm` value are present, and it is blocked outside development and test.
- `capability list`, `capability describe`, and `capability run` use the same descriptors and handlers as direct commands.
- Core commands may reuse an extension: `module enable <id> --apply` runs the `auth.scopes.sync` capability of `auth.core` after regenerating the composition, so a freshly enabled module is visible to workspace owners without a second command.

The complete customer example is in `.ai/examples/customer-cli-extension`. New module scaffolds include the catalog and implementation files when the approved spec declares the `cli` capability.
