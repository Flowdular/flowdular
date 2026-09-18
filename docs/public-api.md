# The API of a deployment

Every module endpoint is reachable from outside the dashboard with an API
token. Nothing has to be exposed per module: an endpoint is part of the API
because it composed, so a module a sandbox session wrote is callable and
described as soon as it is enabled.

## Issue a token

Open Administration, API tokens, and create one. A token belongs to the
workspace it was issued in and carries at most the permissions of the account
that issued it; the two are intersected again at every request, so revoking a
scope or disabling the membership narrows the token immediately.

Five decisions are made when it is issued:

| Field               | What it does                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Scopes              | The permissions the token may use. Pick the smallest set that works.                                                    |
| Expiration          | Optional, at most one year.                                                                                             |
| Allow writes        | Off by default. Without it the token can only read.                                                                     |
| Browser origins     | Empty for a server-side caller. Naming origins is what lets a browser use the token, and refuses it from anywhere else. |
| Requests per minute | 0 takes the deployment default. The token is answered 429 once it spends its minute.                                    |

The secret is shown once. Store it in a secret manager, never in source code.

## Call it

```bash
curl 'https://erp.example.com/api/catalog/items' \
  -H 'authorization: Bearer clat_…'
```

A mutation needs a token issued with writes allowed:

```bash
curl -X POST 'https://erp.example.com/api/catalog/items' \
  -H 'authorization: Bearer clat_…' \
  -H 'content-type: application/json' \
  -d '{"sku":"A-1","name":"Widget","kind":"product","unit":"pc","basePriceMinor":1900,"currency":"EUR"}'
```

A token that may not write is answered 403 `TOKEN_MUTATION_DENIED`. Whatever a
token was issued with, it can never pass an auth.core mutation: credentials,
sessions, memberships, roles and identity providers stay behind a browser
session, so a token can never mint another or widen its own access.

## Read the API description

```bash
curl 'https://erp.example.com/api/openapi.json' \
  -H 'authorization: Bearer clat_…'
```

The answer is OpenAPI 3.1, built for the credential that asked: an operation
whose permission the caller does not hold, and an operation of a module
inactive in its workspace, is left out. Each operation carries the module that
owns it, the permission it needs, and whether a token has to be write-enabled.
The same description is on screen in Administration, API.

Point any OpenAPI tool at that address with the token as a bearer credential.

## Calling from a browser

A page on another origin can call the API only with a token that names its
origin. Preflight requests carry no credential, so the deployment answers them
from the origins its live tokens declare; issuing or revoking a token changes
that within half a minute, with no restart and no environment variable.

A cross-origin response never carries `access-control-allow-credentials`, so a
page on another origin cannot read the API with a visitor's dashboard session
cookie. It has to present a token of its own.

Weigh that before shipping a token to a browser: whatever the page holds, its
visitors hold. For a public website, the safer shape is a server-side fetch
with a read-only token that names no origin, and your own cache in front.

## Watching what a token spends

Every answer to a token that has a ceiling carries its budget:

```text
x-ratelimit-limit: 600
x-ratelimit-remaining: 597
x-ratelimit-reset: 43
```

`x-ratelimit-reset` is the whole seconds left in the current minute. The
request that goes over is answered 429 `TOKEN_RATE_LIMITED` with `retry-after`
set to the same number, so a client backs off without guessing.

The ceiling comes from the token, or from the deployment default in
Administration, Settings (`auth.core.apiTokenRateLimit`, 600 by default, 0
removes it). Changing it is live; no restart.

The window is a fixed minute per token inside each process, capped at 4096
tracked credentials. Behind several processes each admits up to the ceiling,
so treat it as a guard against a runaway integration, not as an accounting
record. What a token actually asks for, refused requests included, is on
`/api/metrics` when the deployment exposes them: `flowdular_module_auth_core_api_token_requests_total` and
`flowdular_module_auth_core_api_token_rate_limited_total`.

## What is not covered

- No versioned address space: an operation lives at the path its module gives
  it, and a module changes that path with its own version.
- No durable per-token usage history; the counters above are what a deployment
  keeps.
