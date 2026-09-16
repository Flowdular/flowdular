---
name: integration-adapter
description: >-
  Add a source or sink adapter for a named external service from its API
  documentation: the connector definition, the port, the mapping, the recorded
  fixture, the consent check and the call and row records.
roles:
  - backend-engineer
  - module-executor
when: An approved spec declares adapters[], or a brief asks to pull records from or push records to a named service.
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

- **Source.** The rows land through an import port (`modules/import/src/domain/ports.ts`): `fields`, a `naturalKey` that makes a repeated pull idempotent, per-row outcomes under `create-only`, `update-existing` or `skip-existing`. The spec's `port` is `<module id>.<key>` of this module or a declared dependency. `adapters.core` writes through `import.write.v1` (`modules/import/src/domain/write.ts`), which checks the port's permission on the run's principal and calls the port's own `validate` and `write`; the module never calls its port for an adapter itself.
- **Sink.** The spec's `port` is a list export id of this module (`defineListExport`, `packages/server/src/export/`, reference `modules/users/src/services/member-export.ts`). `adapters.core` finds it through `exports.lists.v1` and walks its `page` under the run's principal, which must hold the list's permission.

## 4. The registration and the mapping

Register the adapter while the module composes, sources through `adapters.sources.v1` and sinks through `adapters.sinks.v1` (`modules/adapters/src/domain/registry.ts`), and add both with `optional: true` under `requires`, calling again from `start` when the capability was not there yet (the `exports.lists.v1` pattern in `.ai/references/catalog/src/platform.ts`):

```ts
import fixture from '../adapters/erp-vendors.recorded.json' with { type: 'json' };

sources.register('vendors.core', [
	{
		...ERP_VENDORS_ADAPTER, // the scaffolded declaration: id, direction, connector, operation, port, schedule, mapping
		label: 'ERP vendors',
		recorded: fixture, // the parsed fixture, not its path
		input: { path: '/api/v2/vendors', query: { limit: 100 } }, // every call starts from this
		items: 'data', // the record array in the answer; '' is the answer itself
		paging: { kind: 'cursor', param: 'query.cursor', next: 'meta.next_cursor' }, // or { kind: 'page', param: 'query.page', start: 1 }
		mode: 'update-existing',
	},
]);
```

A sink names `items` as the input path a batch goes to (`body.records`) and `batchSize` (1 to 200, default 50) instead of `paging` and `mode`. The id must start with the module id, a sink port must be this module's own list, and a malformed cron, mapping, path, paging or fixture throws `ADAPTER_REGISTRATION_INVALID` at boot.

The mapping is data: the spec's rules as registered, or the override an owner saves on the Data adapters screen. `from` is a dotted path into the service record (a list column key for a sink), `to` a port field id (a dotted path of the pushed record for a sink):

- `rename`: copy the value; a missing or null value leaves the field absent.
- `constant`: write `value`.
- `format`: parse with `value` set to `trim`, `lower`, `upper`, `integer`, `decimal`, `boolean`, `iso-date` or `date:<layout>` over `YYYY`, `MM` and `DD`; a value that does not parse refuses the row with `MAPPING_FORMAT_INVALID`.
- `lookup`: replace the value through the rule's `table`, which the owner fills on the screen; an unmatched value refuses the row with `MAPPING_LOOKUP_UNMATCHED`. The import port contract has no lookup of its own, so a lookup against the target's records is not available.

A value that is not text, a number or a boolean, or is longer than 2000 characters, refuses the row with `MAPPING_VALUE_INVALID`.

## 5. The run

`adapters.core` runs the adapter; the module keeps no run table, job or timer. An owner binds a `connectors.core` instance of the declared definition, checks the mapping with a dry run and enables the adapter. A run is a row claimed by the shared job runner: every call goes through `connectors.calls.v1` with caller `workflow` and `callerRef` set to the run id after `consented` admitted it, each page is tried three times with full jitter and `Retry-After`, the outcomes and the next cursor commit once per page, a process that dies is taken over from the stored cursor, and a failed page keeps its cursor for Resume. A sink stores its row position, re-walks the list to it after a restart (so the list's order must be stable) and pushes under an idempotency key per run chain, row position and slot. A `schedule` runs on its cron in the workspace zone through `adapters.core` itself.

## 6. The recorded fixture

`recorded` names `adapters/<name>.recorded.json`: `{ adapter, operation, calls: [{ input, body }] }`, where `adapter` and `operation` equal the registration's. A call answers the `body` of the first recorded call whose `input` equals the call input, else of the first whose `input` is contained in it (every key it names, at every depth, with the same value), and `ADAPTER_RECORDED_CALL_MISSING` otherwise. Record one call per page with the exact input the paging produces (`{ path, query: { limit } }`, then `{ path, query: { limit, cursor } }`), and a sink push by the keys that matter (`{ path: '/import' }`). The fixture answers only while the adapter is bound to no instance and the platform is not in production. Write it from the documentation's example responses or the session's sample data, trimmed to a few rows that exercise every mapping rule, including one row each rule refuses. It never holds a credential, a live tenant's data or a response recorded from a production system. In a sandbox session it is the only way the adapter runs.

## 7. What the records must show

- Consent: a run without the instance's `allowWorkflows` fails with `ADAPTER_CONSENT_MISSING` and calls nothing.
- Calls: one `connectors.core` call log row per call with the instance, the operation, the caller `workflow`, `callerRef` set to the run id, the outcome, the status, the error class, the duration and the byte counts; never a body.
- Rows: `adapter_runs` with the adapter, the trigger, the cursor and the counts, and one `adapter_run_rows` outcome per record with its natural key and reason, so a person can answer which record came from where.

## 8. Tests

Against the recorded fixture, never the network:

- the registration composes (`adapters.sources.v1` or `adapters.sinks.v1` accepts it with the fixture);
- the fixture answers every page the paging asks for, and every mapping rule writes or refuses a row as intended (a dry run through `POST /api/adapters/dry-run` shows it);
- the port refuses what the module refuses, so a repeated pull updates or skips by the natural key.

## Pitfalls

- `risk: 'external'` is refused by the runner and the harness; an adapter is a registration `adapters.core` runs through a consented connector, never an external action of its own.
- The egress policy refuses redirects and private addresses; a documentation example on `http://` or a local host will not run.
- A page answers at most 1000 records and a run reads at most 1000 pages (`ADAPTER_PAGE_TOO_LARGE`, `ADAPTER_PAGES_EXCEEDED`); set the page size in `input` well below that.
- A connector `outputSchema` of `{ type: 'object' }` checks nothing; the mapping function is where a changed response is refused.
