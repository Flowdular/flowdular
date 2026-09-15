# RFC 0006: Research, documents and case work as reusable building blocks

- Status: proposed on 2026-09-15, waiting for the owner's decision on the
  order and the open questions below
- Date: 2026-09-15
- Follows: RFC 0005 (lists, distribution and debt, delivered 2026-09-13 and
  2026-09-15), RFC 0004 (platform services)
- Relates to: ADR 0006 (agentic workflows), ADR 0007 (module-owned agents),
  ADR 0005 (sandbox runtime), `docs/deferred.md` (H10, PDF generation)

## Why this document exists

The owner asked whether the sandbox would build an application for
insurance agents today: agents research a company from public sources,
write a report from a template, and run calculations for the people who
sell the policy. The same shape appears in every vertical the platform is
meant for: a developer's team researching apartment prices in a district, a
finance operations team screening vendors and invoices for fraud, a
purchasing team qualifying a supplier. Each is a **case**: gather evidence
from outside and inside the workspace, let an agent read and decide, compute
deterministically, produce a document, keep the record defensible.

The platform already owns the governance such work needs: connectors with an
egress policy and per-instance consent, signed approval grants for
destructive or external tool calls, a hash-chained audit trail, data classes
with retention and legal holds, metering with budgets, row-level security on
every tenant table. What it lacks is five building blocks, none specific to
insurance. This document reads the tree as it stands on the date above and
proposes them as generic ERP blocks, each with the verticals it serves.

The verdicts follow RFC 0002 to 0005: **module** (its own tables,
permissions, screens, an approved spec), **platform capability** (a seam in
`packages/*` or `platform/*`), **distribution** (the official module
repository and the registry) or **documentation**.

## What exists today, read out of the tree

- Outbound calls: `connectors.core` ships `http-json`, an egress policy
  (https only, no private addresses, no redirects, timeout and size caps), a
  host allowlist per instance, sealed credentials, a call log without bodies,
  and consent flags `allowWorkflows` and `allowAgents`. The agent tool
  `connectors.call` carries the full action contract. There is no tool that
  opens a web page, queries a search engine, or turns HTML into text, and no
  record of where a fact came from.
- Documents: `documents.core` stores PDF, images, text, CSV and Office files
  encrypted on the storage port and hands a module the bytes of its own
  record's attachments through `documents.attachments.v1`. Nothing reads the
  text out of a PDF or a `.docx`, so an agent cannot read a policy, an
  invoice or a listing a member uploaded.
- Generation: nothing renders a document. PDF generation is deferred (H10)
  until a business module names the document it needs; DOCX was never
  planned. Notifications render mail from a locale bundle, which is the only
  templating in the tree.
- Agents: providers `vercel`, `azure`, `openai`, `openai-compatible`,
  `anthropic` and the local simulation (`modules/agents`); structured output
  through `outputSchema` in the harness; procedures as versioned instruction
  bundles; a tool registry with consent gates and approval grants; run
  history with costs and budgets through `metering.core`. The harness gives
  a provider `availableTools` and `invokeTool`; it has no notion of a tool
  the model provider executes on its own side (a provider-native web search).
- Workflows: nine node kinds including `agent`, `agent-decision`,
  `validator`, `approval`, `module` actions, schedules and signed webhooks.
  A deterministic calculation is a module action today, which is the right
  place for it.
- Search and reports: `search.core` fans out over providers that scan their
  own tables; `reports.core` composes rollups. Both are internal to the
  workspace.
- Sandbox: sessions have no network and no git; the preview composes agents
  and workflows on an ephemeral database with the local simulation provider;
  the pinned reference module (`.ai/references/catalog`) is a CRUD module
  with history, an agent tool and a list export. There is no reference for
  a module whose center is an agent working a case.

## Gaps

### J1. Web search and retrieval for agents

Verdict: module (`research.core`, optional) plus one platform seam in the
harness.

- **Search with adapters.** A public capability `research.search.v1`
  answers `search({ tenantId, query, limit, freshness?, site? })` with
  `{ results: [{ url, title, snippet, publishedAt?, source }] }` through the
  adapter the workspace selected. The default adapter is **model-native**:
  the harness passes a provider-executed web search tool to the model
  (Anthropic and OpenAI both ship one) and records the citations the
  provider returns as results. Further adapters are connector-backed (a
  search API behind `connectors.core`: instance, sealed key, allowlist,
  consent) and a **recorded** adapter that answers from fixtures, used by
  tests and the sandbox (J5). An owner picks the adapter per workspace in
  the module settings, with an allowlist and a denylist of domains, and a
  monthly budget on the meter `research.queries`.
- **Fetch to text.** `research.fetch.v1` opens one URL under the connectors
  egress policy (https, public addresses, no redirects beyond one, size and
  time caps), respects `robots.txt`, turns HTML into readable text, hands a
  PDF to J2, caches by URL and content hash with a TTL, and refuses binary
  and executable content. Bounded: at most 2 MB and 20 seconds per fetch,
  at most 64 fetches per run.
- **Evidence.** Every result an agent kept and every page it read becomes a
  row of `research_evidence`: tenant, URL, retrieved at, content sha256,
  title, an excerpt of at most 4 KB, the run that produced it, and
  optionally the stored full text as a document. A module attaches evidence
  ids to its own record through `research.evidence.v1`
  (`attach(tenantId, ownerModule, recordRef, evidenceIds)`,
  `list(tenantId, ownerModule, recordRef)`), which is what makes a report
  citeable and an audit answerable. The data class is exportable and
  erasable with a default retention of 180 days; legal holds apply.
- **Agent tools.** `research.search` and `research.fetch`, both
  `workspace-read`, both behind the harness consent gate the connectors tool
  already uses, both metered. A run without the workspace's consent sees
  neither tool.
- **Harness seam.** `AgentProviderContext` gains `nativeTools`: tools the
  provider executes itself, declared by the module that owns them, with a
  result event that carries the provider's citations into the run record.
  The local simulation provider answers native tools from the recorded
  adapter, so a workflow dry run stays offline.
- **Screens.** Research settings (adapter, allowlist, budget) in the module
  drawer; a Research log in Administration listing queries, fetches and
  costs per run without page bodies; an evidence viewer opened from the
  owning record.

Serves: an underwriter checking a company (registries, sanctions lists,
press), a developer comparing listing prices in a district, finance
operations screening a vendor, purchasing qualifying a supplier.

### J2. Text out of documents

Verdict: module capability inside `documents.core`.

- `documents.text.v1`: `extract(tenantId, ownerModule, recordRef, id, {
pages? })` answers `{ text, pages, truncated }` for PDF (text layer),
  `.docx`, `.xlsx`, CSV and plain text, bounded to 200 pages and 2 MB of
  text, cached on the storage object by checksum so a second read costs
  nothing. OCR for scanned PDFs and images is a deployment seam like the
  malware scanner: a configured OCR endpoint fills the text, and without one
  the answer says `unscanned` rather than pretending.
- Agent tool `documents.read-text`, `workspace-read`, admitted only for a
  record the run's permissions already let it read; page ranges keep a long
  document inside the model window.
- Serves: policies and claims, invoices and contracts for fraud review,
  listing brochures, supplier certificates.

### J3. Documents from templates

Verdict: module capability inside `documents.core` and a deployment seam;
reopens H10 and adds DOCX.

- Templates are tenant records: a name, a version, a body in Markdown with
  placeholders and table blocks, a declared input schema, and the module
  that owns them. `documents.templates.v1` renders `{ templateId, input }` to
  PDF or DOCX as a background job on the job runner, stores the result as an
  attachment of the requesting record, and answers the document id.
- Rendering is deterministic and server side. PDF needs a renderer the
  deployment provides (a Chromium sidecar in the container image, or a
  pure JavaScript renderer with a smaller feature set); the choice is an
  open question below. DOCX is generated in process.
- Agent tool `documents.render`, `workspace-write`, so a workflow can end
  with a document; a template edit is versioned and a rendered document
  names the version it came from.
- Screens: Templates in Administration with a preview on sample input.
- Serves: the risk report and the offer, a monthly fraud summary, a price
  analysis memo, a supplier qualification letter.

### J4. A reference module for case work

Verdict: distribution and documentation.

- An official module `casework.core`: a **case** with a subject (a record of
  another module or free text), a status, evidence attached through J1,
  documents through J2, **findings** as structured output from an agent
  (a declared JSON schema per case type), **calculations** as a versioned
  table of inputs and results computed by a module action, never by the
  model, and a **report** rendered through J3. Case types are data: a name,
  the findings schema, the calculation the type uses, the template.
- The same module is pinned as a second reference under `.ai/references`,
  beside the catalog, so a sandbox session that builds "underwriting",
  "valuation" or "investigation" copies a working shape: agent reads,
  evidence cited, numbers computed, document rendered, approval before the
  result leaves.
- The `business-agent-design` and `agent-tool-design` skills gain the
  recipe: which tool for which step, where consent and grants sit, how to
  keep the model out of arithmetic.

### J5. Fixtures for the sandbox preview

Verdict: sandbox platform.

- The recorded adapters of J1 and a recorded connector: a session workspace
  carries fixture files (queries and pages, connector operations and
  answers), the preview composes `research.core` and `connectors.core` on
  them, and a gate refuses a session that declares a live adapter. The
  simulation provider already answers agent turns offline; this makes the
  whole case flow demonstrable in the preview without a network.
- The generator copies a fixture set with `casework.core` when a spec
  declares research, so a new session starts with a working example.

## What this is not

- Not a scraper for sites that forbid it: `robots.txt`, the allowlist and
  the denylist are enforced, and a page is fetched once per TTL.
- Not a rules engine: a calculation is a module action with versioned
  tables. A shared decision-table block is a possible J6 once two modules
  need the same thing.
- Not a vector search: evidence is stored with hashes and excerpts;
  embeddings and semantic retrieval are a later RFC when a case type needs
  them.

## Proposed order

1. **J1 with the model-native adapter and the evidence store.** The
   smallest step that makes research citeable; the harness seam and the
   recorded adapter land with it.
2. **J5 alongside J1.** Without fixtures the sandbox cannot show the flow.
3. **J2.** Reading what members uploaded is needed by every case type.
4. **J3.** The document at the end, with the renderer decision made.
5. **J4.** Once J1 to J3 exist; the official module and the second reference
   are one delivery.

## Open questions for the owner

1. **Default adapter.** Model-native search sends the query to the model
   provider. Acceptable as the default, or should a workspace opt in and the
   default be "no research until an owner picks an adapter"?
2. **PDF renderer.** A Chromium sidecar renders any HTML and costs an image
   layer and memory; a pure JavaScript renderer is light and limited to the
   template blocks we define. Which trade-off?
3. **Evidence bodies.** Store the full page text as a document (complete
   audit, more storage, more personal data under retention) or only the
   hash and a 4 KB excerpt (lighter, weaker replay)?
4. **J4 shape.** An official module in the registry, a reference only, or
   both as proposed?
5. **Fraud scoring.** Finance operations will want scores from rules over
   many records. Is a decision-table block (J6) wanted in this wave, or does
   the first fraud module carry its own rules?
