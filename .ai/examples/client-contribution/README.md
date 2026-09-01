# Client contribution example

Mirror of `modules/catalog/src/client/{contribution.tsrx,index.ts}`, flattened into one directory. In a module the files live at `src/client/contribution.tsrx`, `src/client/index.ts`, `src/client/CustomerListView.tsrx`, and the permissions at `src/acl/permissions.ts`.

What it shows:

- `createClientContribution(context: ModuleClientContext)` in `index.ts` is the entry the generated composition imports (`packages/cli/src/module-sync.ts`); it threads `context.csrfToken` into the factory, which passes it to every view that mutates.
- `glyph: 'parties'` is a key of `ICON_PATHS` (`packages/ui/src/icons/Icon.tsrx`); an unknown key renders the `modules` icon silently.
- Ids: `customers.navigation`, view `customers` (the URL slug), widget `customers.dashboard.summary`; `slot` is one of `WORKSPACE_SLOTS`; `scope` is the module's read permission.

These files are not part of any `tsconfig.json` and are not compiled; `modules/catalog` is the compiled reference.
