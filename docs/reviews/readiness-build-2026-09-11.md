# Readiness build review, 2026-09-11

## Scope

Closing the readiness report list: spec-driven development (module spec
schema v2, `spec-interview`, questions protocol, capability card), generated
application completeness (specs, infra, metrics, health), auth.core production
paths (SMTP transport, tenant MFA requirement, admin MFA reset, OIDC ID token
verification, password policy, MFA key rotation, retired scopes), key rotation
across agents, automations and workflows with `secrets-rotate` commands, backup
and restore, structured logging, Prometheus metrics, UI primitives (table
sorting, filtering and pagination, Select, DateField, DateRangeField, Tabs,
Toast), sandbox answers form and e2e test, the root-mount Vite fallback fix,
release version alignment (SDK 0.2.4) and the sdk-release workflow on main.

## Review procedure

Implementation ran in phases with disjoint file ownership. Auto-review ran as a
separate read-only phase in two rounds: five area reviews (41 findings, one
blocker), an implementation pass per area with a regression test per finding,
then three re-reviews of the fixes (17 findings, none blocking) and a second
implementation pass. Every finding named a file, an input, the wrong outcome
and the required fix; each fix was proven by a test that failed against the
defect.

Findings that changed behaviour: `requireMfa` is refused with 409
`MFA_KEY_REQUIRED` without `FD_AUTH_MFA_KEY` and the settings row is locked;
the enrolment gate exempts API token principals and covers module web surfaces
through `resolveIdentity`; the settings write passes the gate only for the
reversal of `auth.core.requireMfa`; `smtp:` demands STARTTLS; the password
denylist runs before the length rule and carries entries longer than 12
characters; a reset link survives a policy refusal; migration 0018 retires the
grants of the deleted parties and catalog modules; PostgreSQL reserved words
that snake-case from camelCase ids (including `system_user`) are refused;
enum values are constrained and escaped; `.dockerignore` excludes
`infra/docker/.env`; the generated app serves `/api/metrics`, ships
`FD_TRUST_PROXY=false` and wires it into compose and Kubernetes; backups are
owner-only; the root mount no longer claims `/*unmatched`; the questions block
refuses control characters and only the operator note selects a skill.

## Commands and results

- `pnpm verify` (rules, reference, capability card, typecheck, tests,
  validate, format): see the closing summary in the session; the last run
  before this record passed with 1716 tests and 3 skipped hosted PostgreSQL
  suites.
- `pnpm build`, `pnpm release:pack`, `pnpm release:smoke`: passed, including
  the standalone sandbox consumer step that failed at the start of the day.
- Scoped suites per area passed after every implementation pass (auth 207,
  system 14, users 9, sandbox 343, coding-agent 57, ui 57, cli 160, server 80,
  kernel 71, agents 134, automations 53, workflows 104, create-flowdular 43,
  platform 92, contracts 23).

## Unresolved and remaining risks

- `modules/auth/spec/module.yaml` moved to 0.11.0 with new invariants and
  scenarios while keeping `status: approved`. The owner must approve the exact
  current spec explicitly before delivery treats it as approved.
- No test drives a live model provider; sandbox flows are proven with the fake
  driver and real gates.
- Live hydration under a root web mount was proven at the router level only.
- Shared services (files, notifications, cron, outbound webhooks, search,
  import and export, PDF) and module enable from the admin UI are not built;
  they need RFC 0002 acceptance and approved specs.
- Restore stays `localOnly`; production restore is the documented manual
  `pg_restore` path.
- Version pins are exact, so every core module bump must update dependents,
  the template example pins and the spec ranges together.

## Verdict

Pass for the reviewed scope once the owner records the auth.core 0.11.0
approval; the gates named above are the evidence, not this record.
