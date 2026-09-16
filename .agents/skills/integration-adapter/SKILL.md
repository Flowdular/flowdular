---
name: integration-adapter
description: >-
  Add a source or sink adapter for a named external service from its API
  documentation: the connector definition, the port, the mapping, the recorded
  fixture, the consent check and the call and row records.
---
# Add an integration adapter

An adapter moves records between this module and a service the business already runs (an accounting package, a CRM, a bank feed, a listing portal). A **source** pulls pages from the service and writes them through an import port; a **sink** pushes the pages of a list export to the service. Every call leaves through `connectors.core`, so the egress policy, the sealed credentials, the owner's consent and the call log apply without code of your own.

## 1. Read exactly this

1. The approved spec: its `adapters[]` entry (`id`, `direction`, `connector`, `operation`, `port`, `schedule`, `mapping`, `recorded`) and the entity the port writes. `pnpm flowdular spec validate` already checked that the id starts with the module id, that a source port belongs to this module or a declared dependency and that `schedule` is a five-field cron; in a sandbox session the `spec-schema` gate also refuses an adapter without `recorded` (`SANDBOX_LIVE_ADAPTER_REFUSED`).
2. The service's API documentation the brief or the session attachments supply: base URL, authentication, the list or push endpoint, its paging parameters, one example response.
3. `.ai/platform-capabilities.md`, the Connectors, Import, List export and Background work entries.
4. `src/adapters/<name>.ts` and the recorded fixture stub, which the scaffold wrote from the spec entry.

Anything the documentation does not settle (which field is the natural key, what a missing value means, how deep paging goes) is a spec defect: hand it back, never guess.

## 2. The connector definition

Use the shipped `http-json` definition (operations `get`, `post`, `put`, `patch`, `delete`, the whole path from the call input) unless the spec names a definition of this module. A definition of your own is registered while the module composes, through `connectors.definitions.v1` (`modules/connectors/src/domain/definitions.ts`):

```ts
context.capabilities
	.get<ConnectorDefinitionRegistry>(CONNECTORS_DEFINITIONS_CAPABILITY)
	?.register({
		key: 'erp-vendors', // the spec's connector, ^[a-z][a-z0-9-]{0,95}$
		moduleId: 'vendors.core',
		label: 'ERP vendors',
		authKinds: ['bearer'], // what the documentation offers
		operations: [
			{
				key: 'list-vendors', // the spec's operation
				label: 'List vendors',
				method: 'GET',
				path: '/api/v2/vendors', // {name} expands one segment, {+name} a whole path
				inputSchema: {
					type: 'object',
					additionalProperties: false,
					properties: { query: { type: 'object' } },
				},
				outputSchema: { type: 'object' },
			},
		],
		defaultAllowedHosts: ['erp.example.com'], // the API host only
	});
```

Declare `connectors.definitions.v1` and `connectors.calls.v1` under `requires` (optional when the module works without the connector) and `connectors.core` with its range under `dependencies` in the spec and `module.json`, plus `@flowdular/module-connectors` in `package.json` for the types. The base URL, the credential and the host allowlist are the owner's instance, created after delivery; no key, token or URL of a tenant ever sits in code, a fixture or a log line.

## 3. The port

- **Source.** The rows land through an import port (`modules/import/src/domain/ports.ts`), the same `validate` then `write` contract `import.core` drives: `fields`, a `naturalKey` that makes a repeated pull idempotent, per-row outcomes `created`, `updated`, `skipped` or `failed` under `create-only`, `update-existing` or `skip-existing`. The spec's `port` is `<module id>.<key>`. A port of this module is registered through `import.ports.v1` (`modules/users/src/services/member-import.ts` is the reference) and the adapter calls the same port object directly, so both paths share one set of invariants. A port of a dependency has no public write path yet; report that instead of reaching into the other module.
- **Sink.** The spec's `port` is a list export id of this module (`defineListExport`, `packages/server/src/export/`, reference `modules/users/src/services/member-export.ts`). The adapter walks the declaration's own `page(principal, cursor, limit)` and pushes each page as one call.

## 4. The mapping

Keep the declaration the scaffold wrote and add one pure function beside it, `mapErpVendorsRow(row)`, that applies the spec's `mapping` in order and answers `{ values }` or a refusal:

- `rename`: copy the service field `from` to the port field `to`.
- `constant`: write `value` to `to`.
- `format`: parse `from` with the named format in `value` (a date layout, a decimal separator) and refuse the row with a stable reason when it does not parse.
- `lookup`: resolve `from` against this module's own records through its service, keyed as `value` says; an unmatched lookup refuses the row. Never read another module's tables.

Values reach an import port as text, and a field the mapping does not name stays absent, never empty.

## 5. The run

A pull or a push is a job, not a request: persist a run row in the module's own table, then let a `createJobRunner` loop (`packages/server/src/jobs/`) claim it with a lease. The perform step:

1. `consented(tenantId, instanceId, caller)` on `connectors.calls.v1`. The instance id is a tenant setting of this module the owner fills in; the caller is `workflow` for a scheduled or workflow-started run and `agent` only inside an agent run. Without consent the run ends as refused and nothing is called.
2. `call({ tenantId, instanceId, operation, input, caller, callerRef: runId, idempotencyKey })` with a bounded page size, the key derived from the run id and the page cursor so a reclaimed run never repeats a push.
3. Map the page, `validate`, `write` in batches, record the per-row outcomes and the next cursor on the run row in one tenant transaction, then take the next page. An interrupted run resumes from the stored cursor.

A `schedule` in the spec is the cadence `cron:<schedule>` the owner gives an `automations.core` schedule after delivery; the schedule starts the workflow or module action that enqueues the run. The module never keeps a timer of its own.

## 6. The recorded fixture

`recorded` names `adapters/<name>.recorded.json`: the answers of the connector operation the tests and the sandbox preview replay instead of calling `connectors.calls.v1`. `module new` writes it as `{ adapter, operation, calls: [{ input, body }] }` with one empty call; each call pairs an operation `input` with the `body` the connector answers. Write it from the documentation's example responses or the session's sample data, trimmed to a few rows that exercise every mapping rule, including one row each rule refuses. It never holds a credential, a live tenant's data or a response recorded from a production system. In a sandbox session it is the only way the adapter runs.

## 7. What the records must show

- Consent: a run without the instance's consent for its caller kind ends refused, and `connectors.core` logs the call with outcome `refused` and error class `consent-missing`.
- Calls: one `connectors.core` call log row per call with the instance, the operation, the caller, `callerRef` set to the run id, the outcome, the status, the error class, the duration and the byte counts; never a body.
- Rows: the run row with its adapter id, start and end, the cursor and the counts, and one outcome per source row with its reason, so a person can answer which record came from where.

## 8. Tests

Against the recorded fixture and a fake `ConnectorCallCapability`, never the network:

- the mapping, rule by rule, including each refusal;
- a repeated pull writes nothing new (natural key) and a reclaimed run resumes from the stored cursor;
- a run without consent calls nothing and records the refusal;
- tenant isolation of runs and outcomes;
- a sink push sends each page once under the idempotency key.

## Pitfalls

- `risk: 'external'` is refused by the runner and the harness; an adapter is a module action or job that calls a consented connector, never an external action of its own.
- The egress policy refuses redirects and private addresses; a documentation example on `http://` or a local host will not run.
- An unbounded page size or an unbounded loop over pages is a defect: cap both and persist progress per page.
- A connector `outputSchema` of `{ type: 'object' }` checks nothing; the mapping function is where a changed response is refused.
