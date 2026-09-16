# RFC 0006 wave 2b, Stream G: text out of documents (2026-09-16)

Branch `feat/documents-text`. RFC 0006 J2 in `modules/documents`, with the PDF
path of `modules/research` and the composition lists of the platform and the
create-flowdular template.

## What landed

- `documents.text.v1` (`modules/documents/src/domain/text.ts`, browser safe).
  `extract(tenantId, ownerModule, recordRef, id, { pages? })` for a document of
  the caller's reference pair, null for every reference `open` answers null
  for, and `extractBytes({ contentType, bytes, pages?, signal? })` for bytes
  that are not stored. Both answer
  `{ status, reason, text, pages, from, to, truncated, contentSha256 }`; the
  status union is `ok | unscanned | unsupported | too-large | pending`
  (`pending` added, answered by `extract` only), the text is the answered pages
  joined by a form feed, and `contentSha256` is the hex digest of the bytes
  read.
- Readers (`src/services/text/`, server only). PDF text layer page by page
  through `unpdf` (`pdf.ts`); DOCX body, PPTX slides in presentation order and
  XLSX sheets in workbook order (sheet name, then rows as tab separated cells:
  shared and inline strings, booleans, errors and cached formula values) through
  the module's own ZIP reader and a strict SAX reader (`zip.ts`, `xml.ts`,
  `ooxml.ts`); CSV and plain text with line ends normalized. A page is the
  format's own page or slide; DOCX, CSV, plain text and each sheet are cut into
  pages of at most 10000 characters at a line end. `.doc` and `.xls` answer
  `unsupported` (`DOCUMENT_TEXT_FORMAT`), bytes that do not match their type or
  do not parse `DOCUMENT_TEXT_UNREADABLE`, a password protected PDF
  `DOCUMENT_TEXT_ENCRYPTED`.
- Bounds (`DOCUMENT_TEXT_LIMITS`): 200 pages and 2 MiB of UTF-8 text kept,
  `truncated` beyond; 25 MiB of input, `too-large` beyond, checked before a
  parser or the store is touched; 4096 ZIP entries; 32 MiB of bytes actually
  inflated per package, counted on the inflater's output and shared by every
  part, so a part that lies about its size stops at the same bound.
- OCR seam (`text/ocr.ts`). `FD_DOCUMENTS_OCR_URL` (https, port 443, a public
  host name, no credentials, refused at boot otherwise) and
  `FD_DOCUMENTS_OCR_TOKEN` (bearer). A PDF without text on any page read and a
  PNG, JPEG, GIF or WebP image are posted as bytes with their content type after
  `connectors.egress.v1` checked the host on that call, over an agent pinned to
  the verified addresses, no redirect followed, 60 s, at most 8 MiB of answer.
  The answer is `{ pages: string[] }` or `{ text }` with form feeds. Without the
  URL or the egress capability the status is `unscanned` with
  `DOCUMENT_OCR_UNCONFIGURED`; a refused host, a failed call or a wrong shape is
  `unscanned` with `DOCUMENT_OCR_FAILED`.
- Cache and job. Migration 0004 (mirrored) adds `documents_text`, primary key
  `(tenant_id, document_id)`, with the content sha256, status, reason, text,
  pages, truncated, attempts, request, claim token and times, forced row
  security, a checksum index, a pending index, and a background policy and
  column grant for `tenant_id, document_id, status, requested_at` of pending
  rows. A second read reads the row; a document without a row copies a settled
  row of the same checksum; the row goes in the transaction that marks its
  document deleted. A stored document over 2 MiB, or one that needs OCR while OCR
  is available, is inserted pending and extracted by the job runner
  `documents.core.text` (`text-runner.ts`): routing read on the background role,
  claim by token with a five minute stale window, heartbeat, settle and release
  fenced on the token, three attempts then `unsupported` with
  `DOCUMENT_TEXT_FAILED`, and the row of a document deleted meanwhile removed.
  `extractBytes` always reads within the call, OCR included, under the caller's
  signal.
- Data class `documents.core.text`: kept as long as its document, no sweep, not
  exportable (the documents class exports the rows the text was read from).
- Routes. `POST /api/documents/text` (`documents.files.read`, id and optional
  range, answers the text plus `ocrAvailable`) and `POST /api/documents/text/retry`
  (`documents.files.manage`, unscanned text while OCR is available, else
  `DOCUMENT_TEXT_NOT_RETRYABLE` 409), both CSRF first with bounded bodies.
- Agent tool `documents.read-text`: risk `read`, `documents.files.read`, input
  `{ ownerModule, recordRef, documentId, pages? }`, the workspace from the run,
  text cut to 20000 UTF-8 bytes at a character with `truncated` set.
- Screen. A Details row action opens the document details drawer with a Details
  tab and a Text tab: loading, pending (read again every 3 s while open),
  failed with Try again, denied, status tag with page count, truncation and the
  reason, the text page by page ten pages at a time, an empty state, and Retry
  with OCR for a manager while OCR is available. en and pl.
- research.core 0.2.1. The direct reader hands a PDF (by content type or the
  `%PDF-` signature) to `documents.text.v1` `extractBytes` with the fetch
  signal when documents.core is composed; an `ok` answer becomes the page text
  with pages separated by a blank line and the URL host and path as the title,
  anything else stays `RESEARCH_CONTENT_UNSUPPORTED` 415, and without the
  capability every PDF answers as before. `documents.text.v1` is an optional
  requirement declared structurally in `services/capabilities.ts`, so research
  takes no package dependency on documents.
- Versions: documents.core 0.2.0 (minor, through the CLI, which retargeted
  import.core's range to `^0.2.0` in its manifest and spec), research.core 0.2.1.
  `pnpm flowdular module sync --apply` regenerated the platform composition; the
  create-flowdular template composition carries the same lists. No package
  under `packages/` changed, so the platform API snapshot stays 0.1.18.

## Dependencies

- `unpdf` 1.8.1 (MIT, 2.1 MB unpacked, no runtime dependencies, released
  2026-08-13, unjs). It bundles pdf.js 6.1.200 (Apache-2.0) built for servers.
  Chosen over `pdfjs-dist` (34.8 MB) for size. Security: the bundle carries no
  `eval` or `new Function` (checked in the tarball; PostScript functions compile
  to WebAssembly or are interpreted, and `useWasm` is off here), and the reader
  asks only for text content with font faces, system fonts, XFA, range and
  stream loading and worker fetch off, so nothing renders, runs or fetches.
- `sax` 1.6.1 (Blue Oak Model License 1.0.0, 62 KB, no dependencies, released
  2026-07-24, isaacs). Chosen over `htmlparser2` (four dependencies, three
  majors in 2026), `saxes` (last release 2022) and `fast-xml-parser` (builds a
  tree, six dependencies). Security: strict mode with the five XML entities
  only, no DTD parser at all, and a document type declaration refuses the whole
  part, so no entity, internal or external, is ever expanded.
- `@types/sax` 1.2.7 (MIT, dev only).
- No ZIP library. `fflate`'s synchronous unzip grows its output past the size an
  entry declares, so the bound would not hold; the central directory reader is
  about 200 lines over `node:zlib`'s streaming raw inflate, which yields chunks
  the reader counts and stops.

pnpm installed every version without a `minimumReleaseAgeExclude` entry.

## Where the contract did not match the tree

- The document screen had no details view, so the Text tab lives in a new
  details drawer opened from a row action.
- A tool that throws reaches the model as `TOOL_EXECUTION_FAILED` with the
  tool's message (`packages/harness/src/runtime.ts`, `toolFailure`), so
  `DOCUMENT_NOT_FOUND` from `documents.read-text` is visible as its message, not
  as a code.
- `@flowdular/database` parameters carry no boolean, so `truncated` is written
  as text cast in SQL.
- The documents test support used PGlite unconditionally; it now uses
  `createTestDatabaseProvider`, so the suite runs on the PostgreSQL cluster
  `FD_TEST_DATABASE_ADAPTER` names.

## Decisions the contract left open

- A range over more than 200 pages cannot answer more than the 200 pages kept,
  so `truncated` marks a range that reaches the last kept page of a document
  that was cut, rather than every wide range.
- Pages beyond the first 200 are never read; a range past them answers no text
  with `truncated` set.
- A damaged PDF page is read as empty rather than failing the document.
- Retry needs `documents.files.manage`, since it spends the deployment's OCR.
- OCR follows the connectors address rules through `connectors.egress.v1`
  instead of a fourth copy of the address block, so a deployment without
  connectors.core has no OCR.
- The claim is a random token rather than the claim time, so a heartbeat
  moving the time never breaks the fence of the settle that follows.
- A text row copied by checksum belongs to its own document and survives the
  deletion of the document it was copied from.
- Extraction runs in the platform process. A worker thread with its own memory
  limit would isolate a hostile file better, but the production server is one
  bundle without a worker entry.

Spec hashes (sha256), under the owner's advance approval of spec changes
relayed by the coordinator: documents.core 0.2.0
`8d2fec1d45525189607e6b0788976f9e1c1c2c99351bf176c11f917b01810bc2`,
research.core 0.2.1
`6a34b95892e10a6c0b6ae93036110657bc8e6cbcd31e459961b39daeacf1c635`, and
import.core 0.2.x after the CLI range retarget
`f47b6767c238efaeaa45687a3a32c34c43f9fc580b52c340f6513b0b14461889`.

## Verification

- documents.core: typecheck; 18 files and 133 tests on PGlite and on the local
  PostgreSQL 17 cluster with the CI roles. New suites `text-extraction` (every
  format, bounds, flow pages, the inflation bound, DTD and entity refusal,
  encrypted PDF, broken and encrypted archives), `text-service` (the capability,
  ranges, cache by checksum, deletion, pending, stale takeover with the late
  settle refused, three attempts, tenant isolation, the background grant),
  `text-ocr` (configuration refusals, an https stub behind a pinned egress
  check receiving the bytes, content type and bearer token, retry, a failing
  stub, a refused host), `text-agent-tool` (a range through the harness, the
  20000 byte cut, the harness denial) and `composition`; endpoints, migrations
  (indexes, grant, partial adoption), data classes, translations and client
  presentation extended. Every fixture is built by the test from literal text.
- Thirteen mutations each failed a test and were restored: the inflation
  budget, the DTD refusal, strict entities, the copy by checksum, the text
  delete with its document, the settle fence, the attempts bound, honouring an
  egress refusal, the tool cut, the page bound, research reading a PDF through
  the capability, the research deadline around the read, and the retry
  permission.
- research.core: typecheck; 16 files and 76 tests on PGlite and PostgreSQL 17,
  `fetch` extended with RESEARCH-FETCH-PDF (a fake capability, the old refusal
  without it, a read past the fetch deadline answering
  `RESEARCH_FETCH_TIMEOUT`).
- storage 45, import 110, agents 249, automations 109, metering 92, users 72,
  workflows 165, platform 112 tests pass.
- `pnpm verify`: rules, reference, capabilities, platform-api (0.1.18) and
  typecheck pass; the test step ran every suite up to `packages/sandbox`, whose
  12 `preview-worker` tests fail inside `.claude/worktrees` (known), and the
  suites it did not reach are the ones listed above. `pnpm validate` and
  `pnpm format:check` pass run separately.
- `pnpm build` passes. The client bundle carries none of `PasswordException`, `SAXParser`, `MAX_BUFFER_LENGTH`,
  `createInflateRaw`, `documents_text` or `FD_DOCUMENTS_OCR_URL`; pdf.js is a
  lazy server chunk (`dist/server/assets/pdfjs-*.js`) that read a PDF's text
  when imported by Node on its own.

## Open points

- Headers, footers, footnotes, comments, speaker notes and spreadsheet number
  formats are not read.
- A long sheet is paged at 10000 characters, but a sheet past 2 MiB of text is
  cut.
- The Text tab was checked by typecheck and the presentation tests, not in a
  running browser: that needs a signed-in account in a local app, which this
  stream did not create.
- The row action column grew from 220px to 300px for the third action
  (Details); the tables redesign that follows may replace it.
- No rate limit on Retry beyond the runner doing one extraction at a time.
- research reads a PDF through a fake `documents.text.v1` in its tests; the
  real capability is proven in documents.core's own suites.
