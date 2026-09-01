---
name: translations-i18n
description: What translations are today (declared, validated for locale shape, never loaded), how to keep the files consistent, and what a real runtime would have to touch.
roles:
  - business-manager
  - frontend-engineer
  - ux-designer
  - module-executor
when: A module declares locales, a translation file changes, or someone asks to localize UI copy.
---

# Translations

## 1. Reality

- Every module ships `translations/en.json` and one file per declared locale. Today each holds one key, `module.name` (`modules/catalog/translations/en.json`, `pl.json`).
- No code loads them. `grep -rn translations packages/client/src platform/src modules/*/src` finds no reader; `ModuleClientContext` is `{ csrfToken, scopes }` with no locale; `platform/index.html` is `lang="en"`; there is no locale switch in the shell.
- The scaffold (`packages/cli/src/module-templates.ts`, `translation`) writes `en.json` plus every spec locale; `pl.json` gets the placeholder `Moduł <name>` so an untranslated bundle is visible at a glance. Files the business manager already wrote survive the scaffold.
- Schema constraints: `module.json` `locales[]` match `^[a-z]{2}(-[A-Z]{2})?$` (`packages/contracts/schemas/module.schema.json`); the spec `locales` are free strings but keep them identical to the manifest. `pnpm oerp module validate` (`packages/cli/src/module-validate.ts`) reports `TRANSLATION_FILE_MISSING` for a declared locale without a file, `TRANSLATION_KEYS_MISMATCH` when key sets differ from `en.json`, and warns `LOCALE_NOT_IN_PROJECT` when a module locale is not in `coreloom.json` `locales`.
- UI copy lives as English literals in `.tsrx` files. This is the accepted state, not a shortcut to fix module by module.

## 2. What to do in a module

- Declare the same locales in `spec/module.yaml` and `module.json`; `en` is always present.
- Keep the key set identical across locale files. When you add a key to `en.json`, add it to every other file, translated, in the same change; `module validate` fails on `TRANSLATION_KEYS_MISMATCH` otherwise.
- Translate `module.name` in `pl.json` when the module declares `pl` (`Katalog produktów i usług` in `modules/catalog`).
- Do not put screen copy into `translations/*.json`. Until a loader exists it would be dead data and the screen would still show the literal.
- Keys, when more arrive, use the module prefix: `catalog.items.list.title`.

## 3. What a real runtime would touch (core change, see `core-extend`)

1. `packages/client/src/contributions.ts`: add `locale` to `ModuleClientContext` and a `t(key, params?)` helper or a per-module bundle in the contribution.
2. `packages/cli/src/module-sync.ts`: collect each module's `translations/<locale>.json` into the generated client composition (or add a `./translations` package export and import it).
3. `platform/src/App.tsrx`: pass the principal's locale (a new `auth.core` account field or tenant setting) into `createModuleClientContributions`; set `<html lang>` accordingly.
4. `packages/client/src/shell/UserMenu.tsrx`: a locale switch.
5. Modules: replace literals with `t('catalog.items.list.title')`, one module at a time, keeping `en.json` as the contract locale.

Until that lands, a brief that asks for Polish screens gets `HANDOFF: none - translations need the core runtime described in reference/skills/translations-i18n/SKILL.md` in the sandbox, or a `core-extend` task at the repository root.

## 4. Worked example

`modules/inventory/module.json` and `spec/module.yaml` both declare:

```yaml
locales:
  - en
  - pl
```

`translations/en.json`:

```json
{
	"module.name": "Inventory Core"
}
```

`translations/pl.json`:

```json
{
	"module.name": "Magazyn"
}
```

Key parity is checked by `pnpm oerp module validate --json` (`TRANSLATION_KEYS_MISMATCH`); run it after every translation edit.

## 5. Answering a localisation request

A brief that asks for a Polish screen, a locale switch, or per-tenant language gets this answer, in the sandbox or at the repository root:

1. Translate `module.name` in every locale file (done in the module).
2. State that screen copy stays English until the client runtime exists, and name the core change (section 3) with its files.
3. In the sandbox: `HANDOFF: none - translations need the core runtime described in reference/skills/translations-i18n/SKILL.md`. At the root: open a `core-extend` task with the six steps above as its consumer list.

Do not add a module-local `t()` helper or a JSON import of the translation file into a `.tsrx`; a third half-implementation is harder to remove than none.

## Pitfalls

- Renaming a module changes `name` in the spec; update `module.name` in every locale file.
- `pl.json` written by the scaffold contains the placeholder `Moduł <name>`; replace it before landing.
- JSON files are formatted by Prettier with tabs; run `pnpm format` after editing.
