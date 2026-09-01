---
name: perf-audit
description: Find the hot paths of a module or platform package, state their cost, and change only what a measurement justifies.
roles:
  - backend-engineer
  - frontend-engineer
  - module-executor
  - reviewer
when: A screen or endpoint is slow, a list grows, or a review asks whether the change scales.
---

# Performance audit

Measure first. A micro-rewrite without a number is not a performance change and does not belong in the diff.

## 1. Inventory the hot paths

Server (per request):

- `DatabaseSync` from `node:sqlite` is synchronous. Every query blocks the event loop for its duration; a list endpoint that returns a tenant's whole table is O(rows) per request and holds the loop for all of it. Paginate or filter in SQL before it matters, never in JavaScript after `all()`.
- `list(tenantId)` orders by a column: the index must cover `(tenant_id, <order column>, id)` (`modules/catalog/src/services/migration.ts` has `catalog_items_tenant_sku_idx`). Without it SQLite sorts the tenant's rows on every call.
- `readJsonObject` caps bodies at 16 KB and reads the whole text once; do not raise the cap for one field, add an endpoint.
- `defineEndpoint` allocates a request id and a Set of permissions per request through `endpointIdentityFromContext` (`new Set(principal.scopes)`); this is fine at current sizes and not a target.
- The repository constructor runs the migration constant on every open. Runtimes create the repository once (`service ??= ...` in `src/server/runtime.ts`); a code path that constructs a repository per request re-runs the migration per request.

Client (per render):

- `items.filter(...)` and `toLocaleLowerCase` run on every render in `CatalogView.tsrx`. With a few hundred rows this is invisible; past that, derive once with `store.derive((get) => ...)` from `segment-state` or filter in the effect that loads data.
- One store per component (`useMemo(() => createXClientState(), [])`) is the intended shape; a shared module-level store would leak between screens.
- Widgets in `dashboard.metrics` each fetch on mount. Five widgets are five requests on the dashboard; a widget that needs a count should not load the whole list once an endpoint can count.

Bundle:

- `packages/ui/src/index.ts` imports the Plex fonts and `styles/index.css` at the top, so every consumer of `@coreloom/ui` pulls them once. A module must not import fonts or global CSS again.
- Module CSS is allowed only for module-specific composites (`modules/agents/src/client/agents.css`).

Agent runtime (`modules/agents`, `packages/harness`):

- Bounds that exist: `maxSteps` 1 to 32 and `timeoutMs` 250 to 86400000 per agent definition (`modules/agents/src/services/agent-service.ts`), worker concurrency `OERP_AGENT_WORKER_CONCURRENCY` (1 to 16, default 2) and lease `OERP_AGENT_WORKER_LEASE_MS` (`modules/agents/src/server/runtime.ts`).
- Bounds that do not exist: per-tool timeout and tool output size (`packages/harness/src/runtime.ts`, `invokeTool` returns the raw tool output to the model). Name this when a tool can return a list.

## 2. Measure

- Server: a vitest `bench` or a script against `new SqliteXRepository(':memory:')` seeded with 10k rows for one tenant and 10k for another; time `list(tenantId)` before and after an index. `EXPLAIN QUERY PLAN` through `database.prepare('EXPLAIN QUERY PLAN SELECT ...').all()` shows `USING INDEX` or `TEMP B-TREE`.
- Client: count renders with a counter in the component during development, or `store.stats()` for commit counts. Remove the instrumentation before the handoff.
- Bundle: `pnpm --filter @coreloom/platform build` prints chunk sizes.

Record the number, the input size and the machine in the handoff or PR body.

## 2b. Bench recipe

```ts
// tests/list.bench.ts (vitest bench; run with: pnpm --filter @coreloom/module-catalog exec vitest bench)
import { bench, describe } from 'vitest';
import { CatalogService } from '../src/services/catalog-service.ts';
import { SqliteCatalogRepository } from '../src/services/sqlite-repository.ts';

const service = new CatalogService(new SqliteCatalogRepository(':memory:'));
for (let index = 0; index < 10_000; index += 1) {
	for (const tenant of ['tenant-a', 'tenant-b']) {
		service.create(tenant, {
			sku: `SKU-${index}`,
			name: `Item ${index}`,
			kind: 'product',
			unit: 'each',
			basePriceMinor: index,
			currency: 'EUR',
		});
	}
}

describe('catalog list', () => {
	bench('list one tenant (10k of 20k rows)', () => {
		service.list('tenant-a');
	});
});
```

Keep bench files out of `tests/**/*.test.ts` so the `tests` gate does not run them; name them `*.bench.ts`. Delete the file or keep it only when the number is worth tracking.

## 2c. Report template

```text
Path:        GET /api/catalog/items -> CatalogService.list -> SqliteCatalogRepository.list
Complexity:  O(rows of tenant) time and space per request; ORDER BY covered by catalog_items_tenant_sku_idx
Measurement: 10k rows per tenant, ':memory:', Node 24: 3.1 ms per call before, 3.0 ms after (no change)
Decision:    no code change; add pagination when a tenant exceeds ~50k items
```

## 3. Change only what the number justifies

Allowed without a benchmark: adding a missing covering index; moving a filter from JavaScript into the SQL `WHERE`; removing a duplicate fetch. Everything else (loop style, hoisting, memoization of cheap values, replacing `Array.prototype` calls) needs a before and after measurement in the same environment.

Complexity to state in the review: for each new data structure and loop on a request or render path, its time and space in terms of rows, tenants, or items. Unbounded growth (a Map keyed by tenant that is never pruned, a list of listeners never detached) is a defect even when each entry is small.

## Pitfalls

- SQLite `LIKE` on a lower-cased column defeats the index; store a normalized column (`sku_normalized`) as `modules/catalog` does.
- `ORDER BY lower(name)` (`modules/parties`) cannot use the `(tenant_id, name, id)` index for the sort; acceptable at current sizes, name it if parties grow.
- A `Kpi` that shows `items.length` after loading the full list is O(rows) network per dashboard load.
- Never change behaviour in a performance commit; keep the functional tests green and add none that assert internal call counts.
