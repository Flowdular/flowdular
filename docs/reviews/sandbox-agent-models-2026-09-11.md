# Sandbox agent progress, fresh context and BYOK settings

Scope: `@flowdular/sandbox@0.2.5`, including its bundled coding-agent driver.

## Requirements and evidence

- Claude progress: `packages/coding-agent/src/drivers/claude-code.ts` reads the protocol's `thinking` field and requests partial messages. A content-block start produces one localized activity event; token deltas do not create transcript writes. The stream mapping test failed against the old field mapping and passes with the fix.
- Resume: `drivers.test.ts` starts a real fixture process, cancels it after initialization, resumes using its identifier and then starts fresh with retained user context. All three lifecycle outcomes are asserted. This proves adapter behavior, not the availability or latency of a remote model service.
- Fresh context: the turn endpoint accepts an optional flag, passes a null resume identifier and replays the original brief plus recent messages. Old provider identifiers are removed if a fresh run returns none. The route test checks the driver request, retained brief, transcript and unchanged draft file. No approval hash, specification or checkpoint is reset.
- BYOK: `ModelSettingsModal.tsrx` is reachable through `WorkspaceMenu`; it uses the existing provider catalog and authenticated configuration endpoint. Settings include provider, model, credential, API URL, Azure resource, default selection, credential clearing and removal. The browser regression submits the actual form and checks its request payload.
- Credentials: `byok-settings.ts` bounds fields, checks provider kinds and required fields, rejects remote plaintext HTTP and URLs containing embedded credentials/query/fragment, and seals credentials using the existing encryption store. Empty input retains a key only for the same provider and destination. Unit tests exercise encryption/decryption, clearing, removal, destination changes and invalid inputs. Route tests exercise validation before persistence; safe configuration contains a fingerprint, never the key.

## Contracts, security and lifecycle

Reviewed all changed production files, their callers, test additions, locales, README and package metadata. The new event variant is handled by the sandbox client; fresh-context input and safe configuration additions are optional. The coding-agent package is bundled only into the sandbox, so SDK, CLI and generator artifact integrity remains unchanged. No module schema, public database contract, migration or generated platform composition changed.

Existing configuration and turn mutations retain authentication, tenant/ownership authorization and CSRF/origin checks. The new provider configuration does not widen agent file permissions or grants. Running driver instances retain their starting configuration. No customer API key was used and no paid model request was made during verification.

History reading remains O(transcript size); replay retains the existing 20-message window plus the brief. No additional full transcript scan is introduced. Activity processing is O(stream events), with one persisted activity event per response block, not per token. Provider history is replaced only at the operator's request; complete sandbox history remains on disk. Earlier decisions outside the recent messages must be recorded in the specification or repeated, as documented.

## Verification

- `pnpm --filter @flowdular/coding-agent test`: 45 passed, including cancellation/resume/history replay and stream mapping.
- Final sandbox suite: 257 passed, including BYOK settings, configuration security and fresh-context routing.
- `pnpm build`: passed, including CLI smoke and platform build.
- `pnpm release:pack`: passed; exactly four public artifacts, only sandbox version changed.
- `pnpm release:smoke`: passed; packed sandbox launcher, HTTP state, SSR page and isolated consumer preview compose successfully.
- Browser regression against a separate local sandbox: passed, no page errors. Inspected BYOK drawer with masked key, padding and footer controls, plus desktop/mobile session behavior and Polish/English switching. Fixtures intercept API traffic; no user workspace mutations or model calls occur. Evidence: `/tmp/agent-ui-final.log` and its artifact directory.
- `pnpm verify`: passed on the final implementation (typecheck, tests, validation, rules/reference consistency and formatting). Log: `/tmp/agent-verify-final.log`.

## Limits

Measured session evidence before the change: 41 reads at median 9 ms; 74 tool calls totaling approximately 1.4 seconds; first visible resumed response after 70.7 seconds; native context approximately 117k tokens. These changes improve observability and provide an explicit way to reduce retained provider context. No before/after inference-time claim is made. Optional external PostgreSQL suites retain their existing environment-dependent skips; no new skipped test was introduced. Existing upstream segment-state sourcemap warnings remain visible in test logs.

## Verdict

Pass. No unresolved actionable finding in this change. Live provider latency remains an observation for the next real session, not a release guarantee.
