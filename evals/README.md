# Evaluation suite

`pnpm verify` measures the code the platform ships. This suite measures the
skills that write it.

A change to `.ai/skills/module-new/SKILL.md` can degrade every module an agent
produces from then on, and no test in the repository fails. That is the gap this
suite closes: a fixed specification goes in, a module comes out, and the same
deterministic checks score it every time.

## Running it

```bash
pnpm eval                      # the whole suite
pnpm eval --case record-crud   # one case
pnpm eval --json               # the report as JSON
```

A run opens a real sandbox session per case, drives turns with the workspace's
configured driver, then runs the session gates and the checks. It costs model
tokens. It is not wired into CI for that reason; run it when a skill, a role
instruction or a blueprint changes, and record the result.

## Approval

A case scaffolds from its specification, and scaffolding requires an approval.
The approval is yours, never the runner's: each `case.json` carries the hash of
the text its owner approved, and the runner replays that approval only while the
hash still matches the file. A case whose specification was edited afterwards is
refused rather than silently re-approved, exactly as a live session refuses.

Approve a case after reading it:

```bash
pnpm eval:approve record-crud                                  # prints the spec
pnpm eval:approve record-crud --apply --confirm approve-record-crud
```

Editing `spec/module.yaml` invalidates the approval on purpose. If a case needs
to change, that is a new measurement, not a correction to an old one.

## Cases

| Case                  | Module         | Measures                                            |
| --------------------- | -------------- | --------------------------------------------------- |
| `record-crud`         | `eval.catalog` | One tenant table, a list screen, a guarded create   |
| `permission-boundary` | `eval.tickets` | Two permissions that must not collapse into one     |
| `tenant-isolation`    | `eval.ledger`  | Forced row-level security with USING and WITH CHECK |

## Adding a case

1. Create `cases/<id>/spec/module.yaml`. It must satisfy
   `packages/contracts/schemas/module-spec.schema.json`.
2. Create `cases/<id>/case.json` with the module id, directory, blueprint, role,
   brief, turn cap, gates and checks. Leave `approval` null.
3. Approve it with the command above.
4. Run the case once and read the output before trusting the score.

## Checks

Checks are deterministic reads over the produced source, defined in
`packages/sandbox/src/evals/checks.ts`. They are conservative by design: a check
fails on positive evidence of a defect or a definitely absent marker, and
abstains otherwise, because a false failure teaches a reader to ignore the
suite.

| Check                          | Fails when                                                |
| ------------------------------ | --------------------------------------------------------- |
| `module-manifest`              | Nothing was scaffolded, or the id does not match the spec |
| `permissions-declared`         | A specified permission appears nowhere in the module      |
| `endpoints-declare-permission` | An endpoint carries no permission                         |
| `tenant-not-from-request`      | Tenant identity is read from request input                |
| `rls-forced`                   | A migration misses ENABLE, FORCE, USING or WITH CHECK     |
| `migrations-mirrored`          | A `.sql` file is not mirrored in `databaseMigrations`     |
| `locales-complete`             | A declared locale has no bundle, or the keys drifted      |
| `no-sql-interpolation`         | A statement interpolates a value instead of binding it    |

## What is not here yet

An `edit-module` case. Changing an existing module is where the immutable
migration rule and the version bump rules are easiest to break, and the register
in `docs/handbook/security-risk-management.md` scores that as R-15. It needs a
seeded module tree in the fixture rather than a specification alone, which is
the next piece of work on this suite.
