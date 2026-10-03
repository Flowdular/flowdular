# RFC 0007: Cache and search index extension ports

- Status: proposed
- Date: 2026-10-02
- Relates to: RFC 0002 G7, RFC 0004 H2 and H9, `search.core` 0.1.7

## Decision

Flowdular prepares two optional adapter seams. Neither names a vendor in a
module contract or changes the database as the source of truth.

1. `CacheAdapter` supplies disposable, short-lived values to a `CachePort`
   already bound to one deployment, module, tenant and key generation. Redis
   can implement this port later. It is a cache, not a general durable KV store.
2. `SearchIndexAdapter` supplies candidate record references to a
   `SearchCandidateIndex` bound to one generation of a module-owned tenant
   projection. A Meilisearch adapter can implement it later. The owner must
   load and authorize every candidate before returning a `SearchHit` through the
   existing `search.providers.v1` capability.

The public type-only contracts are in `packages/contracts/src/cache.ts` and
`packages/contracts/src/search-index.ts`. This RFC does not register a runtime
adapter, change the `search.core` specification, add external services to the
default Compose stack, or make setup depend on either service. The ports are
ready for a later host binding and adapter implementation. A module cannot use
them through `PlatformServerContext` yet.

## Why these boundaries

`search.core` already fans out to module-owned providers under the caller's
permission and a time budget. Its approved specification and RFC 0002 reject a
central index that owns copies of every module's records. A candidate index
behind one provider preserves that contract. The external service may host
several physical indexes, but each logical projection belongs to one module
and tenant. `search.core` remains unaware of the engine.

The cache boundary is deliberately narrower than Redis. It exposes get, put
with a mandatory TTL, and delete. Redis locks, queues, rate limits, sessions,
idempotency records and durable business state need separate contracts with
their own guarantees. Cache eviction or outage must never decide authorization
or whether a business write happened.

## Cache contract

The future host creates `CacheScope` from the deployed application id, the
composed module id, and a tenant id taken from the authenticated principal or
a persisted background job. A request parameter cannot choose any of them.
The host hands only the resulting `CachePort` to module code. The adapter
encodes all scope parts into physical keys and must prevent a key in one scope
from reading another. `generation` changes the namespace after a cached value
format changes, without scanning Redis.

`get` returns a copied byte array on a hit and `null` on a genuine miss. A
backend outage rejects, so a caller can fall back to its authoritative read
and record the degraded cache. `put` requires a TTL. `delete` is best-effort
invalidation; callers that need read-after-write correctness should use a
versioned key or read the database. The eventual runtime binder should enforce
these bounds before calling an adapter:

| Field       |                    Proposed bound |
| ----------- | --------------------------------: |
| Logical key |              1 to 128 UTF-8 bytes |
| Value       |                    At most 64 KiB |
| TTL         |              1 second to 24 hours |
| Scope part  | Nonempty, at most 128 UTF-8 bytes |

The caller owns serialization and schema versioning. No credential, permission
decision, session, or unredacted sensitive record goes into this cache. An
adapter must copy byte buffers across the boundary, honor cancellation where
its driver allows it, close idempotently, and avoid logging keys or values.
Each put and delete is atomic for one key. A read may observe either side of a
concurrent write. An entry may disappear before its TTL through eviction, but
must not be served after expiration. The contract gives no multi-key
transaction, compare-and-set, scan, or cross-process invalidation guarantee.
Redis has native expiration on `SET` and configurable eviction; both are
implementation details behind this port, not persistence guarantees
([SET](https://redis.io/docs/latest/commands/set/),
[eviction](https://redis.io/docs/latest/develop/reference/eviction/)).

## Search index contract

The future host creates `SearchIndexScope` with deployment, module, tenant,
projection id, schema version, and generation. The scope is immutable for one
handle. The adapter must apply all parts to every query and write. A schema
change or rebuild creates a new generation, so a late task from the old one
cannot overwrite its replacement. The owner records the active generation in
durable state and switches readers only after the replacement has caught up
with source changes. Old generations must then be removed through the
host-only `destroyScope` operation.

`search` returns ranked, opaque references and a bounded cursor. It never
returns a title, snippet, route, permission, or authoritative record. The
provider uses its own tenant-scoped database capability to fetch candidates in
one bounded query, checks the live principal's permission and row visibility,
and builds `SearchHit` values itself. Missing, deleted, stale, or denied
references disappear. The provider may request another bounded candidate page
to fill a result page; it must still respect the existing per-provider time
budget. An index outage makes that provider unavailable through the existing
`search.core` behavior, or the provider can use its existing PostgreSQL search.

`submit` accepts repeatable upserts and deletes from one module-owned durable
job and returns a receipt. Receipt creation does not mean indexing completed.
The worker calls `status` and advances its durable checkpoint only after
`applied`. A failed task stays retryable or is sent to an operator-visible
failure state. A gap, a projection version change, or an uncertain source
cursor triggers a rebuild from the owner's tables. The owner must persist the
change in its database transaction before acknowledging the business write;
an external index update cannot be part of that transaction. RFC 0004 H9's
shared outbox is still deferred, so an initial adapter must use a module-owned
durable job and checkpoint rather than assuming that platform outbox exists.
An engine can prune its task history. `status` then returns `unknown`; the
worker never advances its checkpoint on that outcome. Its safe default is to
build a new generation from the owner's database and durable change stream,
catch up to a recorded source cursor, then switch readers. Old tasks remain
confined to the old generation. Replay into the same generation is allowed
only when the adapter can prove the original task is terminal or guarantees
that every original and retried task finishes in submission order before any
newer owner revision is applied. A worker sends at most one pending batch per
tenant projection generation. An adapter may index a change more than once,
but repeating the same idempotency key and change must converge to the same
visible document state. Reusing an idempotency key with different changes must
reject.

Search visibility is eventual, and the owner's live database read decides
what the member can see.

Meilisearch writes use asynchronous tasks, which is why this contract separates
submission from application
([task documentation](https://www.meilisearch.com/docs/learn/async/paginating_tasks)).

The future runtime binder and adapter should enforce:

| Field                          |                                        Proposed bound |
| ------------------------------ | ----------------------------------------------------: |
| Query                          | 2 to 200 characters after `search.core` normalization |
| Candidate page                 |                                   1 to 100 references |
| Reference                      |                                   1 to 200 characters |
| Cursor                         |                                At most 256 characters |
| Text per upsert                |                                        At most 16 KiB |
| Write batch                    |                                      1 to 100 changes |
| Idempotency key and receipt id |                                   1 to 128 characters |
| Scope part                     |                                  1 to 128 UTF-8 bytes |
| Projection version             |                                 Positive safe integer |

Projection text is an explicit, reviewed copy of owner data. The module must
declare which fields may be indexed, remove documents when records or tenants
are erased, and rebuild after an index schema change. Tenant filtering inside
the adapter and reauthorization in the owner are separate safeguards. A stale
index must never make a revoked record visible.

`destroyScope` is a host operation, never a module capability. It fences new
queries and submissions for that exact scope, waits for accepted writes to
finish or be fenced, and resolves only after the backend confirms that all
documents and index metadata in the scope are gone. It is idempotent. Tenant
deletion and old-generation cleanup must be persisted as retryable work before
the owner acknowledges the operation; individual `delete` changes cannot
replace this cleanup because the owner may no longer know every indexed ref.
The host keeps a durable tombstone for the retired generation, so a late job
cannot reopen it after a restart. It also keeps enough trusted scope metadata
to retry cleanup after a crash. An adapter that cannot prove complete deletion
cannot satisfy this contract.

## Adapter and agent contract for the next slice

A `cache-adapter` agent should implement a host binder plus one backend. The
binder validates bounds and derives scope only from trusted runtime context.
The adapter passes a shared suite covering TTL expiry, copy semantics, key
generation, tenant and module isolation, outage fallback, cancellation and
idempotent close. A Redis implementation also needs connection bounds,
timeouts, TLS/credential handling, a memory limit and an eviction policy.

A `search-index` agent should implement an adapter behind one module-owned
`search.providers.v1` provider. Its suite covers cross-tenant denial, live
permission revocation, stale and deleted references, bounded overfetch, task
pending/failure/unknown, durable checkpoint recovery, generation rebuild,
scope deletion after pending writes, and index outage. It must prove that the
API response contains only records the owner reloaded and authorized. The
adapter's credentials belong to the operator, never to a sandbox specialist
or a module specification.

The first implementation should use one real module as a pilot. Its spec must
be updated and explicitly approved for the chosen external index before code
is written. The current approved `search.core` spec describes PostgreSQL
full-text indexes and excludes a search service; this RFC does not supersede
that decision. The pilot must either satisfy that spec with PostgreSQL as the
authoritative search path and gain approval for an optional index, or amend
the relevant spec before changing the path. Add runtime binding, adapter
selection, deployment settings and health reporting with that pilot, so the
port is exercised by a real consumer. Redis and Meilisearch remain optional;
neither is needed for a new Flowdular installation.
