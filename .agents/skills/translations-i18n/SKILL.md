---
name: translations-i18n
description: Add or review Coreloom UI translations through the shared client runtime, module bundles, locale-aware formatting, and validation gates.
roles:
  - business-manager
  - frontend-engineer
  - ux-designer
  - module-executor
when: A module adds user-facing copy, a locale changes, a raw translation key appears, or UI must support another language.
---

# Translate Coreloom UI

Coreloom loads translations at runtime. The shell owns locale selection and the fallback chain; each module owns its copy.

## Runtime contract

- `packages/client/src/i18n` registers the shell bundle and every enabled module bundle. Resolution is active locale, then `en`, then the key itself so a missing key stays visible.
- A module contribution imports `translations/en.json` and every declared locale, then returns `translations: { en, pl }` with its `moduleId`.
- Use fully qualified keys with `t()`, for example `t('catalog.items.title')`. In `.tsrx`, import from `@coreloom/client`. In plain `.ts` helpers, import from `@coreloom/client/i18n` so tests do not pull the TSRX shell entry.
- Navigation and account-menu labels use getters. Contributions are created before their bundles are registered, so eager `label: t(...)` can paint a raw key.
- Locale-sensitive dates, numbers and currency use `activeLocale()` with `Intl.DateTimeFormat` or `Intl.NumberFormat`.
- The personal locale selector lives in Profile and applies immediately. The tenant default remains an Administration setting and is the fallback when the browser has no personal choice.

## Module workflow

1. Keep the same locale list in `spec/module.yaml`, `module.json` and `coreloom.json`. Every module ships `en`.
2. Put all user-facing labels, hints, empty states, errors and accessible names in `translations/<locale>.json`. Keep flat, module-local keys such as `items.form.save`; the runtime adds the module namespace.
3. Add the same key to every locale in the same change. Write natural copy in each language.
4. Import the bundles in `src/client/contribution.tsrx` and expose them through `translations`.
5. Replace literals with `t('<module>.<key>')`. Dynamic families such as `t('expenses.status.' + status)` require every possible suffix in every bundle.
6. For a new locale-sensitive helper, add a test that changes the active locale and proves both the text and formatting.

Navigation pattern:

```ts
import { t, type ModuleClientContribution } from '@coreloom/client';
import translationsEn from '../../translations/en.json';
import translationsPl from '../../translations/pl.json';

return {
	moduleId: 'inventory.core',
	translations: { en: translationsEn, pl: translationsPl },
	navigation: [
		{
			get label() {
				return t('inventory.navigation.label');
			},
			get description() {
				return t('inventory.navigation.description');
			},
			// remaining contribution fields
		},
	],
};
```

## Validation

Run:

```bash
pnpm coreloom module validate --module <module-id>
pnpm --filter @coreloom/module-<dir> typecheck
pnpm --filter @coreloom/module-<dir> test
pnpm format:check
```

`module validate` rejects a missing locale file, mismatched locale key sets, and a static `t('module.key')` whose module bundle does not contain the key. A dynamic key cannot be proven statically, so test its complete value set.

When a raw key appears in the UI, check in this order:

1. The key exists in `translations/en.json` and the active locale.
2. The contribution exposes the bundle under the correct `moduleId` namespace.
3. Navigation copy is lazy through getters.
4. The running dev server has rebuilt after the contribution changed.

## Do not

- Add a module-local translation runtime or import JSON directly in each view.
- Leave English fallbacks in client API helpers. Use a translated fallback and preserve server messages when present.
- Translate identifiers, provider names, currency codes, shortcuts or stable error codes.
- Hide a missing key with an empty string.
