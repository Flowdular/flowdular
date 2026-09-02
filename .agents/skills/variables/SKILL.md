---
name: variables
description: Build variable-aware fields and templates on the {{ }} contract, the scope mask, and server-side resolution, with agents.core as the worked example.
roles:
  - frontend-engineer
  - ux-designer
  - agentic-engineer
  - backend-engineer
  - module-executor
when: A field must let a value embed {{ variable }} tokens filled from other fields, the request context, or another module.
---

# Variables (templating and linked fields)

A variable field lets a stored value embed `{{ key }}` tokens that are filled at
run time from context or another module's data. The contract is pure and lives
in `@coreloom/contracts` (`packages/contracts/src/variables.ts`); the fields are
presentational primitives in `@coreloom/ui`; resolution happens on the server
before the consumer sees the text. `agents.core` is the worked example: an agent
author writes instructions as a template and the run snapshot carries the
resolved text.

## The `{{ }}` contract

`VariableDefinition { key, label, kind, scope?, sample?, description? }` is one
offerable variable. `kind` is `text | number | date | money | identifier`.
`key` is a dot path whose segments start lowercase and may continue in
camelCase (`context.user.displayName`), matched by `VARIABLE_KEY_PATTERN` /
`isVariableKey`.

- `extractVariables(template)`: the distinct trimmed `{{ key }}` tokens, in
  first-seen order.
- `validateTemplate(template, available, allowedScopes?)`: `{ unknown, forbidden }`.
  `unknown` are tokens not in `available`; `forbidden` are tokens whose def
  declares a `scope` not present in `allowedScopes` (omit `allowedScopes` to skip
  the scope check).
- `resolveTemplate(template, values, { onMissing })`: substitutes each
  `{{ key }}` with `values[key]`. `onMissing` is `keep` (default, leave the token
  verbatim) or `blank`.
- `tokenizeTemplate(template)`: the segments the UI overlay highlights; the
  `text` fields concatenate back to the exact input.

Rules the resolver guarantees: tokens are `{{ key }}` with optional inner spaces;
`\{{` outputs a literal `{{`; substitution is a single pass, so a value that
itself looks like a token is emitted verbatim (never recursive); only own,
string keys resolve, so prototype keys (`__proto__`, `toString`) never resolve.
No eval, no expressions, only key substitution.

## The scope mask

`VariableDefinition.scope` is the permission required to read the source. A
variable is offered and resolved only when the principal holds that scope:

- The UI fields never fetch and never check scopes. The caller passes
  `variables` already filtered to what this principal may use, so a variable the
  principal cannot read is simply absent from the menu and highlights as an error
  pill if typed.
- On the server, filter the definition list by the principal's scopes before
  building `values`, or call `validateTemplate(..., allowedScopes)` and refuse a
  template whose `forbidden` is non-empty. A scope-less variable
  (`context.*`) is always allowed.

## The UI fields (`@coreloom/ui`)

`VariableTextarea` (multiline), `VariableInput` (single line), and
`VariableSelect` (one literal option or one variable token) are presentational.
All take `value`, `onInput`, `variables: readonly VariableDefinition[]`, optional
`sampleValues?: Record<string,string>`, required translated `label` (accessible
name), `name` (so a `FormData` submit still captures it), `required`, `disabled`,
and `error`. Input and textarea also require translated `insertLabel`,
`variablesLabel`, and `emptyLabel`; the shared primitive has no English copy to
fall back to. Select takes `options: readonly VariableSelectLiteralOption[]` and
requires translated `literalGroupLabel` and `variablesGroupLabel`. A caller also
localizes every `VariableDefinition.label` before passing the definitions, since
that label is visible in the picker.

- The `braces` affordance (a `{}` icon in `ICON_PATHS`) opens a menu of the
  available variables with label, key, and current or sample value; picking one
  inserts `{{ key }}` at the caret. Typing `{{` opens the same menu filtered by
  what follows; ArrowUp/Down and Enter pick, Escape closes.
- Tokens are highlighted by an overlay layer (`tokenizeTemplate`) sitting behind
  a transparent control, so `{{ key }}` reads as a pill while the real value
  stays plain text; an unknown or forbidden token gets the error pill. All
  color comes from tokens; measurement is client-only in an effect, so SSR is
  safe. See `packages/ui/src/components/VariableField.tsrx` and its wrappers.
- `VariableSelect` stays a native `<select>`. Literal values and allowed
  `{{ key }}` tokens are real `<option>` values, so keyboard navigation,
  validation, disabled state, accessible naming, and `FormData` submission keep
  browser semantics. Samples appear only in option labels. The component never
  resolves the selected token.

Keep the fields presentational: the caller supplies `variables` and
`sampleValues`, the component never fetches.

The platform variable registry currently registers and filters definitions but
does not resolve execution-time values. A select whose stored value may be a
cross-module token therefore still needs a server-side resolver owned by the
consumer. A shared cross-module resolver requires a typed source contract that
obtains the value through the owning module's public capability under the
principal's tenant and scopes. Do not fetch it from the field or read the owning
module's database directly.

## Server-side resolution rule

Resolve the template before the consumer sees it, and keep the raw template
stored. The stored record keeps the `{{ }}` template; the run or send snapshot
carries the resolved text. Never resolve in the client and never store the
resolved text back onto the definition.

Worked example in `agents.core`:

- `modules/agents/src/domain/context-variables.ts` declares
  `AGENT_CONTEXT_VARIABLES` (`context.tenantName`, `context.today`,
  `context.user.displayName`, `context.user.email`, all scope-less) and
  `agentContextValues(input)` that builds their values from the run's
  tenant/principal/date.
- `AgentService.enqueueRun` (`services/agent-service.ts`) resolves
  `agent.instructions` with `resolveTemplate` against those values before it
  builds the instruction snapshot; the stored definition is untouched. The
  endpoint (`api/endpoints.ts`) supplies the tenant name and principal from the
  request; `today` comes from the queue timestamp.
- `AgentDefinitionForm.tsrx` feeds `VariableTextarea` the context variable list
  and sample values, so an author gets the menu and highlighting.

## Adding a variable source via a tool (cross-module extension)

Business-data variables (for example `{{ party.name }}`) are the documented
extension. They resolve through the agent tools already registered on the tool
registry (`packages/kernel/src/tool-registry.ts`), under the run's scopes:

1. Declare the `VariableDefinition` with `scope` equal to the source tool's
   `requiredPermissions` (`AgentTool` in `packages/harness/src/runtime.ts`). The
   tool's permission is the mask: one source of truth, no parallel table.
2. Offer it only when the principal holds that scope (filter the list; the UI
   fields take the filtered list).
3. Resolve it by invoking the owning tool with the run's grants and mapping the
   result to a string, then merge into the `values` passed to `resolveTemplate`.
   The tool enforces tenant and ACL, so a variable can never read data the run
   is not authorized to read.

Register a new tool with the `agent-tool-design` skill; this skill covers only
how its output becomes a resolvable variable.
