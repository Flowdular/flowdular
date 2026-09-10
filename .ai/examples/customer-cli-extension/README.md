# Module CLI extension example

`commands.json` is the catalog (`module.json` `cli.catalog`, validated against `packages/contracts/schemas/cli-extension.schema.json` without running code) and `index.ts` is the implementation (`cli.entry`, imported only when the command runs). The module manifest declares both:

```json
{
	"capabilities": ["api", "cli"],
	"cli": { "catalog": "src/cli/commands.json", "entry": "src/cli/index.ts" }
}
```

Rules from `packages/cli/src/extensions.ts`: the command path starts with the module namespace (`customer` for `customer.core`), the capability id starts with `customer.`, the module must be enabled in `flowdular.json`, and `path` plus the whole `capability` object must be identical in both files. `requiresApprovedSpec: true` means `pnpm flowdular customer export --spec modules/customer/spec/module.yaml` (and `--apply` to write). Full procedure: `.ai/skills/cli-extension/SKILL.md`. Real modules: `modules/auth/src/cli`, `modules/agents/src/cli`, `modules/sandbox/src/cli`.

Not compiled or tested here; `packages/cli/tests/extensions.test.ts` covers the catalog rules.
