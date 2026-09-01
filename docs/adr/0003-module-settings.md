# ADR 0003: Namespaced module settings

- Status: accepted, runtime implemented 2026-09-01
- Date: 2026-08-31

## Decision

Every setting is declared and owned by one module. Its stable key is the module identifier plus a module-local key, such as `auth.core.allowSignUp`. A declaration fixes the value type, default value, visibility, client exposure, and secret status.

A module may read another module's setting only when its manifest declares a direct dependency on the owner and the setting is explicitly marked shared. Private or secret settings never cross that boundary. Secret settings cannot be included in a client snapshot.

The first setting is `auth.core.allowSignUp`. The server is authoritative and rejects sign-up when it is disabled. The client configuration endpoint exposes only the client-safe boolean so the public authentication screen can hide the sign-up action. The environment variable `OERP_AUTH_ALLOW_SIGN_UP` supplies the initial deployment value.

## Runtime (amendment, 2026-09-01)

- `@coreloom/kernel` exports `ModuleSettingsRuntime` (`declare`, `get`, `list`, `set`, `onChange`) and `createModuleSettingsRuntime(store)`. Values live in `module_settings` in auth.db (`tenant_id`, `module_id`, `key`, `value_json`, `updated_at`, `updated_by`); `auth.core` provides the store and exposes the runtime as `authRuntime.moduleSettings`.
- A setting is tenant-scoped by default. `scope: 'platform'` stores one value for the whole deployment (tenant id `''`); auth uses it for knobs that apply before a tenant is known (sign-up, session policy, password length, sign-in providers).
- Environment variables only supply the declared default. A stored value wins at read time; reads are live, never snapshotted at boot.
- A module declares settings by returning `settings` from `createServerComposition`; the platform registers every declaration after composing, then calls each composition's `start()`.
- Administration: `GET /api/settings` (`system.settings.read`) lists every declaration with its current tenant value and metadata; `POST /api/settings/update` (`system.settings.manage`, session only) validates against the declaration, stores or clears the value, and appends `settings.updated` to the auth audit trail. Secrets are write-only: the API returns whether a value is set, never the value. Administration > Settings renders one card per declaring module from that metadata.
- `emailConfirmation` cannot be enabled while no mail transport is composed; the API refuses with `MAIL_TRANSPORT_REQUIRED` and the screen shows the setting as locked.
- The cross-module read rule (declared dependency, shared, non-secret) is not enforced by `get`; it is a review rule until a requester-aware read exists.
