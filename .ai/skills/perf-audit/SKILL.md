---
name: perf-audit
description: >-
  Find the hot paths of a module or platform package, state their cost, and
  change only what a measurement justifies.
roles:
  - backend-engineer
  - module-executor
  - reviewer
when: A screen or endpoint is slow, a list grows, or a review asks whether the change scales.
---

# Performance audit

Measure first. A micro-rewrite without a number is not a performance change and does not belong in the diff.

## 1. Inventory the hot paths

Server (per request):

- Queries are asynchronous and pooled, so the cost is round trips, not a blocked event loop. A query inside a loop, an N+1 read after a list, or one transaction per row multiplies the round trip by the row count; do the work in one statement. A list endpoint that returns a tenant's whole table is still O(rows) per request, so paginate or filter in SQL, never in JavaScript after the rows arrive.
- A lease or a transaction held longer than the work needs starves the pool. Open the transaction around the statements it protects and release it; never hold one across a fetch, an agent call, or a sleep.
- `list(tenantId)` orders by a column: the index must cover `(tenant_id, <order column>, id)` (`.ai/references/catalog/src/services/migration.ts` has `catalog_items_tenant_sku_idx`). Without it PostgreSQL adds a sort node over the tenant's rows on every call.
- `readJsonObject` caps bodies at 16 KB and reads the whole text once; do not raise the cap for one field, add an endpoint.
- `defineEndpoint` allocates a request id and a Set of permissions per request through `endpointIdentityFromContext` (`new Set(principal.scopes)`); this is fine at current sizes and not a target.
- The runtime checks the migration ledger once, behind a short `purpose: 'migration'` lease, and then holds one runtime lease for the repository (`src/server/runtime.ts` shares a single initialization promise). Acquiring a lease or building a repository per request adds a ledger read and a pool acquisition to every request.

Client (per render):

- `items.filter(...)` and `toLocaleLowerCase` run on every render in `CatalogView.tsrx`. With a few hundred rows this is invisible; past that, derive once with `store.derive((get) => ...)` from `segment-state` or filter in the effect that loads data.
- One store per component (`useMemo(() => createXClientState(), [])`) is the intended shape; a shared module-level store would leak between screens.
- Widgets in `dashboard.metrics` each fetch on mount. Five widgets are five requests on the dashboard; a widget that needs a count should not load the whole list once an endpoint can count.

Bundle:

- `packages/ui/src/index.ts` imports the Plex fonts and `styles/index.css` at the top, so every consumer of `@flowdular/ui` pulls them once. A module must not import fonts or global CSS again.
- Module CSS is allowed only for module-specific composites (`modules/agents/src/client/agents.css`).

Agent runtime (`modules/agents`, `packages/harness`):

- Bounds that exist: `maxSteps` 1 to 32 and `timeoutMs` 250 to 86400000 per agent definition (`modules/agents/src/services/agent-service.ts`), worker concurrency `FD_AGENT_WORKER_CONCURRENCY` (1 to 16, default 2) and lease `FD_AGENT_WORKER_LEASE_MS` (`modules/agents/src/server/runtime.ts`).
- Tool calls have a deadline (`timeoutMs`, default 30 seconds, bounded from 250 to 600000 ms) and serialized output is capped at 32 KB by the harness. A list tool must still page or limit rows so useful data fits inside that cap.

## 2. Measure

- Server: a vitest `bench` or a script against the module's `tests/support/database.ts` provider seeded with 10k rows for one tenant and 10k for another; time `list(tenantId)` before and after an index. `await database.query({ text: 'EXPLAIN (ANALYZE, BUFFERS) SELECT ...' })` shows an `Index Scan` or the `Seq Scan` plus `Sort` pair that means the index is not covering the order.
- Client: count renders with a counter in the component during development, or `store.stats()` for commit counts. Remove the instrumentation before the handoff.
- Bundle: `pnpm --filter @flowdular/platform build` prints chunk sizes.

Record the number, the input size and the machine in the handoff or PR body.

## 2b. Bench recipe

```ts
// tests/list.bench.ts (vitest bench; run with: pnpm --filter @flowdular/module-catalog exec vitest bench)
import { bench, describe } from 'vitest';
import { CatalogService } from '../src/services/catalog-service.ts';
import { createCatalogTestDatabase } from './support/database.ts';

const database = await createCatalogTestDatabase();
const service = new CatalogService(database.repository);
for (let index = 0; index < 10_000; index += 1) {
	for (const tenant of ['tenant-a', 'tenant-b']) {
		await service.create(tenant, {
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
	bench('list one tenant (10k of 20k rows)', async () => {
		await service.list('tenant-a');
	});
});
```

Keep bench files out of `tests/**/*.test.ts` so the `tests` gate does not run them; name them `*.bench.ts`. Delete the file or keep it only when the number is worth tracking.

## 2c. Report template

```text
Path:        GET /api/catalog/items -> CatalogService.list -> DatabaseCatalogRepository.list
Complexity:  O(rows of tenant) time and space per request; ORDER BY covered by catalog_items_tenant_sku_idx
Measurement: 10k rows per tenant, embedded PGlite, Node 24: 3.1 ms per call before, 3.0 ms after (no change)
Decision:    no code change; add pagination when a tenant exceeds ~50k items
```

## 3. Change only what the number justifies

Allowed without a benchmark: adding a missing covering index; moving a filter from JavaScript into the SQL `WHERE`; removing a duplicate fetch. Everything else (loop style, hoisting, memoization of cheap values, replacing `Array.prototype` calls) needs a before and after measurement in the same environment.

Complexity to state in the review: for each new data structure and loop on a request or render path, its time and space in terms of rows, tenants, or items. Unbounded growth (a Map keyed by tenant that is never pruned, a list of listeners never detached) is a defect even when each entry is small.

## Pitfalls

- `LIKE` or `=` against `lower(column)` cannot use a plain `(tenant_id, column)` index; store a normalized column (`sku_normalized`) as `.ai/references/catalog` does, or add an expression index on `lower(column)`.
- `ORDER BY lower(name)` (`Flowdular/official-modules`, `modules/parties`) cannot use the `(tenant_id, name, id)` index for the sort; acceptable at current sizes, name it if parties grow.
- A `Kpi` that shows `items.length` after loading the full list is O(rows) network per dashboard load.
- Never change behaviour in a performance commit; keep the functional tests green and add none that assert internal call counts.
