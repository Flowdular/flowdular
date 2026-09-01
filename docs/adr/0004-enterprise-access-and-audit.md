# ADR 0004: Enterprise access and audit boundaries

- Status: proposed; first increment landed in auth.core on 2026-09-01
- Date: 2026-08-31

## Context

The current authentication core provides tenant membership roles and explicit scopes. Module endpoints deny missing scopes, Development is owner-only, and agent runs snapshot the initiating subject and authorization evidence. This is a secure first phase, but it is not the complete enterprise RBAC and audit model.

## Proposed direction

`access.core` should own custom roles, permission grants, user and group assignments, resource constraints, temporary grants, segregation-of-duties policies, and an authorization decision API. Business modules should depend on this API instead of interpreting role names.

`audit.core` should own a central append-only event contract, tenant and actor indexing, integrity verification, retention policy, redaction, export, and external sink delivery. Module-local audit writers should publish into that contract. Sensitive values, credentials, raw session tokens, and unrestricted request bodies must never enter audit metadata.

Background agents should receive a bounded execution grant at enqueue time. Every API or CLI tool invocation must still pass through the target capability's server-side authorization and audit boundary. Revocation policy for queued work, approval workflows, privileged access, and emergency access require explicit acceptance scenarios before implementation.

Until those modules are approved and implemented, the platform must describe its current model as scope-based authorization with module-local audit evidence, not full enterprise RBAC or centralized compliance audit.

## First increment in auth.core (amendment, 2026-09-01)

Custom roles and the auth audit trail now live in `auth.core`, sized to what a workspace administrator needs today and shaped so `access.core` and `audit.core` can take them over without a data migration of meaning:

- `auth_roles` holds one row per tenant role. The built-in `owner` and `member` rows are seeded per tenant from the static scope lists and are read-only; custom roles carry a subset of the scopes the workspace can grant (`AuthService.listGrantableScopes`). `auth_memberships.role_id` points at the row and the legacy `role` string stays in sync. Assigning a role replaces the membership scopes with the role's scopes; changing a role's scopes updates every holder; a role in use cannot be deleted. Endpoints: `/api/auth/roles` (`auth.roles.read`, `auth.roles.manage`).
- Member administration goes through the auth administration port with the acting principal: only an owner may create, promote, or change an owner; a non-owner may only hand out scopes it holds; a tenant always keeps one active owner; nobody edits their own membership from the directory.
- `auth_audit` is an append-only, tenant-indexed table (`tenant_id, actor, action, subject_type, subject_id, metadata_json, occurred_at`) written for sign-in success, failure, and lockout, sign-out, session revocation, password change and reset, token issue and revoke, member create, update, status, scopes, role, and removal, role create, update, and delete, workspace rename, and settings updates. It is readable per tenant through `GET /api/auth/audit` (`auth.audit.read`) with a cursor on `(occurred_at, id)`. Metadata never carries credentials, raw tokens, or request bodies. Unauthenticated failures for unknown addresses are not attributed to any tenant. Hash chaining, retention, export, and sinks remain with `audit.core`.
