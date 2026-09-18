---
name: spec-interview
description: >-
  Turn a business request into a schema-valid v2 module specification by
  proposing a platform default for every decision and asking only what cannot be
  inferred, so implementation never has to guess or scan the repository.
---
# Interview a request into a specification

The specification is the contract implementation reads instead of the repository. Everything an engineer would otherwise have to guess belongs in it: entities, fields, screens, actions, settings, tools, and what was deliberately left out. A missing decision costs a round trip later, so surface it now.

Work closed-world. `.ai/platform-capabilities.md` is the complete list of what the platform can deliver. Anything outside it is `outOfScope` with the business decision that replaces it, never a promise.

## 1. Read exactly this

1. `.ai/platform-capabilities.md`, the capability card (in a session: `reference/platform-capabilities.md`).
2. `packages/contracts/schemas/module-spec.schema.json`, the shape and the enums (in a session: `reference/packages/contracts/schemas/module-spec.schema.json`).
3. `.ai/references/catalog/spec/module.yaml`, a written example (in a session: `reference/example-module/spec/module.yaml`).

For an edit, also read the module's current `spec/module.yaml` and write the smallest delta. Do not open `modules/` or `packages/` for anything else; the card carries what you need, and a fact it lacks is a question, not a search.

## 2. Decision checklist

One pass, in this order. For each row, write the default from the card into the spec and record it as a `decisions[]` entry with `decidedBy: default`. Ask only where the answer is a business fact that no default can supply.

| Decision               | Default to propose                                                                                                                                                                                  | Lands in                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Actors                 | Owner manages, member reads                                                                                                                                                                         | `permissions`, `invariants`              |
| Entities and fields    | One primary entity; `name` required, `maxLength` 120; no field the request did not name                                                                                                             | `entities[]`                             |
| Uniqueness             | The human-facing code is `unique: tenant`; everything else `none`                                                                                                                                   | `entities[].fields[].unique`             |
| States and transitions | `active` and `archived`, every transition behind the manage permission                                                                                                                              | `entities[].states`                      |
| Who sees what          | Both permissions in the same navigation entry; the manage action hidden without the scope                                                                                                           | `permissions`, `screens[]`, `invariants` |
| What is denied         | Unauthenticated 401, missing permission 403, cross-tenant read returns nothing                                                                                                                      | `acceptanceScenarios`                    |
| Failure behaviour      | A duplicate returns a stable conflict and changes nothing; bounds return 400                                                                                                                        | `invariants`, `acceptanceScenarios`      |
| Cross-module reads     | None. A read of another module goes through its public capability and a declared dependency                                                                                                         | `dependencies`, `dataOwnership`          |
| Screens                | One `list` screen with the entity's identifying columns                                                                                                                                             | `screens[]`                              |
| Widgets                | None. A count belongs on `dashboard.metrics` only when the request asks for it                                                                                                                      | `widgets[]`                              |
| Settings               | None. A number the business may change later is `scope: tenant` with a stated default                                                                                                               | `settings[]`                             |
| Feature flags          | Ask for one whenever a change alters behaviour a workspace already relies on, or is hard to undo: `kind: flag`, boolean, `scope: tenant`, a stated default, and the behaviour named in an invariant | `settings[]`                             |
| Agent tools            | None. A tool is a later phase and `risk` may only be `read` or `workspace-write`                                                                                                                    | `agentTools[]`                           |
| Outside sources        | None. A named public source is `research`, with the entity its findings attach to                                                                                                                   | `research`                               |
| Other systems          | None. A named system is one `source` adapter per record kind, run on demand                                                                                                                         | `adapters[]`                             |
| Documents              | None. A named document is one `templates[]` entry on the record it describes                                                                                                                        | `templates[]`                            |
| Reports                | None. There is no export, no PDF and no search; a report is a screen or it is out of scope                                                                                                          | `outOfScope[]`                           |
| Out of scope           | Every item from the card's gap list the request touched, each with its business decision                                                                                                            | `outOfScope[]`, `decisions[]`            |

A default you propose is still a decision: it goes into `decisions[]` so the operator can see and overturn it, and so the next agent never re-derives it.

## 3. Ask only what you cannot infer

Ask when the answer is a business fact: who may see a price, whether a code is unique across the company or per branch, what happens to an order whose customer is deleted. Never ask what the card already answers, and never ask two questions where one choice settles both. Keep it under about six questions per turn.

In the sandbox, end the reply with exactly one fenced block tagged `questions`, nothing after it:

````text
```questions
{
	"questions": [
		{
			"id": "Q-1",
			"question": "Is the item code unique for the whole workspace or per warehouse?",
			"options": ["Unique per workspace", "Unique per warehouse"],
			"recommended": "Unique per workspace",
			"allowFreeText": true
		}
	]
}
```
````

The sandbox renders it as a form and the answers return in the next turn as a `Decisions` section. Outside the sandbox: in Claude Code ask through the question tool with the same options, and in Codex ask in plain text with the options numbered. In every host, `recommended` is the default from the card, and an unanswered question stays a question, never a guess.

When the answers come back, copy each one into `decisions[]` with `decidedBy: user` and the answer text, and update whatever the answer changed.

### Outside sources, other systems and documents

Ask these only when the brief names one; each answer is a decision like any other.

- **An outside source** ("check the company in the registry", "compare listing prices"): which sources are trusted (`allowDomains`) or refused (`denyDomains`), which record the findings belong to (`evidenceOwner`, an entity of this spec), and whether the monthly budget differs from the default of 500 queries. Propose `adapter: model-native` outside the sandbox; in a sandbox session write `adapter: recorded`, because the preview refuses a live adapter, and record the adapter the owner will choose after delivery as a decision. Every finding an agent keeps cites its evidence, so write a scenario where a finding without evidence is refused.
- **Another system** ("pull customers from X", "push invoices to Y"): the system and the operation its documentation names, the direction, which entity the rows become (a source writes through this module's import port `<module id>.<key>`), the field mapping (`rename`, `constant`, `format`, `lookup`), and whether it runs on demand or on a five-field cron. Consent and credentials are the owner's connector instance after delivery, never a spec value. In a sandbox session every adapter names `recorded: adapters/<name>.recorded.json`; the `spec-schema` gate refuses one without it with `SANDBOX_LIVE_ADAPTER_REFUSED`.
- **A document** ("a risk report", "an offer letter"): its title, the record it describes (`inputEntity`), `pdf` or `docx`, and the sections the body needs. The module renders it through `documents.templates.v1` and stores it as an attachment of that record, so write a scenario where a render without the module's permission on the record is refused.

A number the case needs (a score, a premium, a price per square metre) is an `actions[]` entry the module computes, never a value an agent writes.

## 4. Write the specification

`modules/<dir>/spec/module.yaml`, `schemaVersion: 2`, `status: draft`. Keep the v1 keys (`id`, `specVersion`, `name`, `description`, `profile`, `capabilities`, `dependencies`, `tenancy`, `locales`, `invariants`, `permissions`, `dataOwnership`, `acceptanceScenarios`) and add the v2 arrays:

- `entities[]`: `{ id, name, fields[], states? }`. A field is `{ id, type, required?, unique?, maxLength?, values?, reference?, description? }`. `type` is one of `string`, `text`, `integer`, `decimal`, `boolean`, `date`, `datetime`, `enum`, `reference`, `json`; `unique` is `tenant` or `none`. `enum` needs `values`, `reference` needs `reference`. Entity and screen ids are `^[a-z][a-z0-9-]*$`; field and setting keys are `^[a-z][a-zA-Z0-9]*$`. Money is `integer` minor units plus an explicit currency field, never `decimal`.
- `screens[]`: `{ id, kind: list|record|form|dashboard, entity?, title?, columns?, filters?, navigationGroup? }`. `navigationGroup` is one of the six values on the card.
- `actions[]`: `{ id, entity?, permission, kind: create|update|delete|custom, risk, idempotent, description }`. `risk: external` is refused by the platform, so an action may not declare it.
- `widgets[]`: `{ id, slot, entity?, description }`; `slot` is one of the four workspace slots.
- `settings[]`: `{ key, type: string|integer|boolean|enum, scope: tenant|platform, kind?: setting|flag, default?, values?, description }`. A `flag` is boolean, `scope: tenant` and carries a default; owners switch it per workspace on the Flags tab of Administration, Modules, and every change is audited. Ask whether the new behaviour ships behind one: a change to something a workspace already does, an outward-facing action, a costly or slow path, or anything a business would want to turn off without a deployment. Say what the module does with the flag off, as an invariant.
- `agentTools[]`: `{ id, permission, description, risk: read|workspace-write }`.
- `outOfScope[]`: plain sentences, each naming the gap and the decision taken instead.
- `decisions[]`: `{ id, question, answer, decidedBy: user|default }`; ids match `^[A-Z][A-Z0-9-]+$`, for example `D-UNIQUE-SKU`.
- `research`: `{ adapter: model-native|searxng|firecrawl|connector|recorded, allowDomains?, denyDomains?, monthlyQueryBudget?, evidenceOwner }`; domains are lower-case host names and `evidenceOwner` names an entity.
- `adapters[]`: `{ id, direction: source|sink, connector, operation, port, schedule?, mapping[], recorded? }`. `id` starts with the module id (`sales.core.crm-customers`); `connector` and `operation` are connector definition and operation keys (`^[a-z][a-z0-9-]*$`); a source `port` is an import port of this module or a declared dependency; `schedule` is a five-field cron or `null`; a mapping entry is `{ from?, to, transform: rename|constant|format|lookup, value? }` where only `constant` omits `from` and only `rename` omits `value`; `recorded` is `adapters/<name>.recorded.json` and required in a sandbox session.
- `templates[]`: `{ id, title, inputEntity, format: pdf|docx, body }`; `inputEntity` names an entity and `body` is `templates/<name>.md`.

Put the primary entity's read and manage permissions first: the scaffold builds that entity and later permissions become constants only. Every `acceptanceScenarios[]` entry stays observable (given, when, then) and covers success, denial and the cross-tenant case, because each one becomes at least one test. The schema rejects unknown keys.

## 5. Validate

```bash
pnpm flowdular spec validate --all --json
```

In the sandbox this is the `spec-schema` gate and runs for you. Fix every issue before ending the turn; a spec that does not validate cannot be approved.

## 6. Close the turn

End with the decision list: each decision, the answer, and whether it came from the user or from a platform default. Then state plainly that implementation cannot start until the operator approves this exact specification, and that any later edit invalidates that approval. In the sandbox the operator approves the exact hash; on a host, approval is recorded only through `spec-approval` after an explicit user instruction.

Sandbox handoff: `HANDOFF: none - <the open questions>` while questions are outstanding, otherwise the next specialist with the reason.

## Refusals

- Never write `status: approved`, and never claim a spec is approved. Approval is the operator's act.
- Never write TypeScript, `module.json`, `package.json` or any implementation file. This skill produces `spec/module.yaml` and, where the role allows, `translations/**`.
- Never invent a business fact. An unanswered question is `decisions[]` left open plus a question, not a plausible answer.
- Never promise a capability the card lists as missing. It goes to `outOfScope[]`.

## Pitfalls

- A field nobody asked for is a cost forever. If the request did not name it, leave it out and record the omission.
- `unique: tenant` without a stated conflict behaviour produces an undefined error path; pair it with an acceptance scenario.
- `states` without `transitions` lets any state reach any other. Name the legal moves and their permission.
- A screen with no `columns` gives the engineer nothing to build; list the identifying fields in display order.
- An `enum` field with values that are really a lookup table wants its own entity instead.
- Bumping `specVersion` is part of an edit, not an afterthought; the delivery gate compares it.
