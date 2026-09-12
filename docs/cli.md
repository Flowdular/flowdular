# CLI

`flowdular` is the primary CLI name; `fd` is the short alias and resolves to the
same command. From the repository both run through pnpm:

```bash
pnpm flowdular <group> <action> [target] [options]
pnpm fd <group> <action> [target] [options]
```

## Conventions

- **Dry run by default.** Every write command prints its plan and changes
  nothing until `--apply`. Destructive capabilities additionally require
  `--confirm <phrase>`.
- **`--json`** prints the machine-readable envelope. Use it from scripts and
  agents; a failed command exits non-zero with a stable error code.
- **`--root <dir>`** runs against another workspace. Without it the CLI walks up
  from the current directory to the nearest `flowdular.json`.
- **Capabilities are the policy.** `capability list` and `capability describe
<id>` show what a command may do, its risk, and the confirmation it demands.

## Core commands

```bash
flowdular doctor                                   # workspace health checks
flowdular capability list|describe <id>|run <id>   # capability catalog
flowdular spec validate [--all]                    # module specs, --all adds specs/
flowdular blueprint list|validate --all            # blueprint manifests and guardrail files
flowdular module list|validate                     # manifests, composition entries, translations
flowdular module sync [--apply]                    # regenerate the composition
flowdular module version <id>                      # version, platformApi range, dependents
flowdular module version bump <id> <level> [--apply] # patch|minor|major across module.json, package.json, specVersion and dependent ranges
flowdular module new <id> --spec <path> [--apply]  # scaffold from an approved spec
flowdular module enable|disable <id> [--apply]     # composition and scope grants
flowdular migration status [--module <id>]         # migration ledger
flowdular migration apply --module <id> [--apply]
flowdular migration verify                         # checksum drift, row security, file and constant parity
flowdular migration new <name> --module <id> [--apply]  # scaffold the up and down pair
flowdular database reset                           # plan a destructive reset of the configured database
flowdular database reset --apply --confirm reset-database
flowdular database backup --output <dir> [--apply]  # dump plus a key fingerprint manifest
flowdular database restore --input <dir> --apply --confirm restore-database
flowdular setup check                              # alias of doctor
flowdular setup quick [--apply --confirm reset-local-auth]
flowdular setup migrate-state [--apply --confirm migrate-legacy-state]
```

### Authoring a migration

`migration new` writes exactly two files,
`migrations/<NNNN>_<stem>_<name>.up.sql` and `.down.sql`, in PostgreSQL, with
the tenant table, its index, forced row-level security and a tenant policy
already filled in. Replace the placeholder columns with the real schema.

`migration verify` then checks that every applied ledger checksum still matches,
that every tenant table a migration leaves behind has `ENABLE ROW LEVEL
SECURITY`, `FORCE ROW LEVEL SECURITY` and a tenant policy declared after the
last statement that puts the table in place, that a `coreloom_background` policy
grants no more than `FOR SELECT`, and that every `migrations/*.up.sql` file has
a matching id in `databaseMigrations` and the other way round.

### Resetting a database

`database reset` works through the configured provider, so the same command
resets a local embedded database and a PostgreSQL deployment. Without `--apply`
it prints the tables it would drop and changes nothing.

Every table goes, including the migration ledger, so the next start migrates
from zero. The command takes a `migration` lease, which is the only lease that
may run a reset. Every module shares one database, so `--module` is refused
rather than silently dropping other modules' tables.

Like every destructive capability it runs only when `FD_ENV` or `NODE_ENV` is
`development` or `test`.

### Backing a database up and restoring it

`database backup` writes the configured database into a directory together with
a `backup.json` manifest: timestamp, adapter, platform version, enabled modules
and a SHA-256 fingerprint of each of the six encryption keys, never the key
material. PostgreSQL is dumped with `pg_dump --format=custom` through the
migrator connection, with the credentials passed as `PG*` variables instead of
arguments; the embedded adapter is copied file by file and wants the application
stopped. A missing client tool fails with `BACKUP_TOOL_MISSING`.

`database restore` reads such a directory, refuses a backup from another
adapter, and warns with `BACKUP_KEY_MISMATCH` when the running environment holds
different keys, because the rows would come back unreadable. It runs
`pg_restore --clean --if-exists`, or replaces the embedded data directory only
once the restored copy is staged. Being destructive, it needs
`--apply --confirm restore-database` and, like `database reset`, runs only when
`FD_ENV` or `NODE_ENV` is `development` or `test`.

The full procedure, the key trap and the rotation status are in
[operations.md](operations.md).

## Commands provided by modules

Enabled modules add namespaced commands. Discovery reads a declarative JSON
catalog (`src/cli/commands.json`) and never executes module code, so a disabled
module contributes nothing. See [cli-extensions.md](cli-extensions.md) for the
contract.

```bash
flowdular auth scopes                              # scopes granted to new tenant owners
flowdular auth sync-scopes --module <id> [--apply] # re-grant a module's scopes to owners
flowdular auth workspaces [--limit <n>]            # workspaces of this deployment and their owners
flowdular auth workspace-create --name <name> --owner-email <email> --owner-name <name> [--slug <id>] [--password-env <VAR>] [--actor <label>] [--apply]
flowdular auth member-add --workspace <slug|id> --email <email> [--role <key>] [--actor <label>] [--apply]
flowdular auth secrets-rotate [--apply]              # re-seal enrolled TOTP secrets with the current MFA key
flowdular auth greenfield                          # destructive local auth reset (setup quick)

flowdular agents status                            # agents.core runtime status
flowdular agents audit-verify                      # verify the tenant-scoped audit hash chain
flowdular agents secrets-rotate [--apply]          # re-seal stored provider credentials
flowdular automations secrets-rotate [--apply]     # re-seal stored trigger secrets
flowdular workflows secrets-rotate [--apply]       # re-seal stored run payloads
flowdular notifications secrets-rotate [--apply]   # re-seal stored webhook signing secrets

flowdular sandbox access --tenant <tenant>         # grants and eligible members
flowdular sandbox grant --email <email> --tenant <tenant> [--apply]
flowdular sandbox revoke --email <email> --tenant <tenant> [--apply]
flowdular sandbox sessions|session-archive|session-delete --tenant <tenant>
flowdular sandbox audit-verify
```

### Standing up a deployment without public sign-up

A deployment sets `FD_AUTH_ALLOW_SIGN_UP=false`, so the first workspace and its
owner are created from the operator shell instead. The commands run against the
configured deployment database through the platform provider, PostgreSQL server
included, and reset nothing.

```bash
flowdular auth workspace-create --name "Northwind" --owner-email ada@northwind.example --owner-name "Ada Lovelace"
flowdular auth workspace-create --name "Northwind" --owner-email ada@northwind.example --owner-name "Ada Lovelace" --apply
```

Without `--slug` the workspace id is derived from the name. Without `--apply`
the command validates the input, refuses a taken workspace id or a registered
address, and prints the workspace, the owner and the scopes it would grant.

The owner's first credential is a one-time password setup link, printed once
and not recoverable, valid for 24 hours and usable once. Deliver it over a
channel you trust and set `FD_AUTH_PUBLIC_ORIGIN` first so the link points at
the deployment. To choose the password yourself, export it and name the
variable; a password is never accepted as a flag value, because flags land in
shell history and in the host's process list:

```bash
read -rs FD_OWNER_PASSWORD && export FD_OWNER_PASSWORD
flowdular auth workspace-create --name "Northwind" --owner-email ada@northwind.example \
  --owner-name "Ada Lovelace" --password-env FD_OWNER_PASSWORD --apply
```

`auth member-add` onboards colleagues into an existing workspace. An address
that already has an account joins immediately with the role's scopes; an
unknown address receives a single-use invitation link, shown once, that the
person opens to create their own account.

```bash
flowdular auth member-add --workspace northwind --email grace@northwind.example --role member --apply
```

Both commands append an audit row to the workspace trail whose actor is
`cli:<user>`, or `cli:<label>` with `--actor <label>`. `auth workspaces` lists
what exists, with each workspace's owners, so the slug or id for the other
commands is at hand.

## Workspace scripts

```bash
pnpm dev            # platform on http://localhost:4310 (runs module sync first)
pnpm build          # CLI build and smoke, module sync, platform production build
pnpm preview        # serve the production build
pnpm sandbox        # sandbox launcher
pnpm typecheck      # every workspace package
pnpm test           # every workspace package
pnpm validate       # spec, blueprint and module validation
pnpm format:check   # Prettier
pnpm verify         # typecheck + test + validate + format:check
```

`pnpm verify` is the gate CI runs and the gate a pull request is expected to
pass.

## Official module distribution

`module search`, `module info`, `module install`, `module update`, `module recover`, and `module validate --locked` manage reviewed external source. See [the distribution contract](module-distribution.md) for flags, trust, activation and recovery.
