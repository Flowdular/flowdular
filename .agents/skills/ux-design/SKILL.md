---
name: ux-design
description: >-
  Design a module screen on the shared design system, with the record-screen
  recipe, the five states, the component and class inventory, and the icon keys.
---
# Design a screen

`docs/design-system.md` (in a session: `reference/design-system.md`) is the only source of visual decisions. Primitives live in `packages/ui` (`reference/packages/ui/components/*.tsrx` and `components.css`). The reference screen is `.ai/references/catalog/src/client/CatalogView.tsrx` with `CatalogItemForm.tsrx`.

## 1. Rules (design-system.md, section Rules)

1. Primitives first: a `ui-*` class or an exported component before any new visual code.
2. Colors, fonts, sizes, radii and shadows only from tokens (`var(--...)`); no hex in module CSS.
3. Never restyle or override a `ui-*` class outside `packages/ui`.
4. A missing primitive becomes a module-local component on tokens, flagged as a promotion candidate for `packages/ui`.
5. Blue is action and selection; green, amber and red are state; copper is the brand only.
6. Minimum text size 12 px; labels `--text-xs` uppercase; numbers tabular (`.num`, `ui-kpi__value`).
7. Containment is owned by the primitives: children of `ui-view`, `ui-two-col`, `ui-grid-2`, `ui-kpi-grid` shrink, long words wrap, wide content scrolls inside `ui-table-wrap`.
8. `Kpi` is a stat tile: the value is a number or a short state word; identifiers, addresses and paths go into `note` or a `ui-mono` line.
9. Records own the page; creating and editing happens in a `Drawer`. Never split the width between a table and a form.

## 2. Record screen recipe

```text
div.ui-view
  PageHeader eyebrow title description      actions: Button sm [Icon refresh 14] Refresh, Button sm primary [Icon plus 14] New ...
  Alert                                     only when error && !formOpen
  TableCard title count                     head is one line: title with its count left, SearchField and Filters right
    search  SearchField                     value placeholder label onInput
    filters Filters                         open onToggle activeCount; the controls live inside the dropdown
    columns rows rowKey                     columns is a module-level readonly TableColumn<Row>[] outside the component
    status  'loading' | 'idle'              'loading' only while status === 'loading' && rows.length === 0
    empty emptyFiltered filtered            filtered picks which of the two the table renders
    actions actionsLabel                    visible compact buttons; undefined when the scope is missing
    note                                    one constraint worth stating
  Drawer open title subtitle onClose        form keyed by 'form-' + formSession
```

`TableCard` is the record card and `Table` is the only table in the product: never hand-roll `table.ui-table` again, and never rebuild the head, the loading row or the empty state that these already own. `actions(row)` returns `TableAction[]`; the component renders up to two as compact buttons and folds more than two, or two in a narrow card, into its own More menu. Do not build a dropdown or module-owned action markup. Fixed column widths apply through loading, empty and populated states. A cell returns a typed cell and never raw text: `CellText` (`strong` for the name, `mono` for a code, `wrap` for prose), `CellStack` for a name over its id, `CellTime` for a timestamp, `CellCode` for an identifier, `CellTag` for state, `CellNumber` with `numeric: true` on the column, `CellMuted` for a missing value.

The shared `Table` is backed by the official `@octanejs/tanstack-table` adapter. A module never imports TanStack directly. It supplies the Flowdular columns, rows and actions above, while `@flowdular/ui` owns the features, row model, header model and cell rendering.

Every column declares `width`: px for a bounded column (a time 170, a status or tag 120 to 140, a number 100 to 140, an id 120 to 200) and `auto` for the one column that takes the rest. Every column also gets a `priority` for the reader: 1 (default) for the identity, the state and the main value, 2 for secondary ids, counts and timestamps, 3 for details and descriptions. A narrow card hides 3, then 2, and each row expands to list what is hidden; the first column is always 1. Rules and numbers: `docs/design-system.md`, section Tables.

Drawer form: `form.ui-drawer__form > div.ui-drawer__body > div.ui-form > div.ui-form__row > FormField label required help` wrapping a native `input.ui-input`, `select.ui-select` or `textarea.ui-textarea`; `Alert` inside the body for the submit error; `div.ui-drawer__foot` with `<small>` for the constraint and `div.ui-form__actions` (Cancel, primary submit with `disabled={busy}` and a progressive label `Creating…`). `Drawer width="lg"` when rows have two columns or an editor.

Read-only master-detail (runs, playground) keeps `ui-two-col` (+ `--wide-aside`). Admin overviews use `ui-kpi-grid` with several `Kpi`; a module dashboard widget is one `Kpi` with `href` and `linkLabel`, rendered by the shell in `dashboard.metrics`.

## 3. Five states

- Loading: `Table status="loading"` while `status === 'loading' && rows.length === 0`, so a refresh never blanks rows the user is reading.
- Empty: `empty` with an icon and a sentence that names the first action; `emptyFiltered` says no match and is chosen by `filtered`.
- Error: `Alert` (tone `danger` default) under the header, or inside the drawer while the form is open.
- Populated: the `Table` rows, or a list where records are not tabular.
- Denied: the shell already hides navigation and widgets whose `scope` the principal lacks. Inside a view, pass booleans derived from `ModuleClientContext.scopes` (`canManage={options.scopes.includes(X_PERMISSIONS.manage)}` in `contribution.tsrx`, as `modules/agents` does) and do not render the action. A 403 from the server still becomes an `Alert`; it is never a crash.

## 4. Component and prop inventory (`packages/ui/src/components`)

- `Button`: `variant` primary, secondary (default), ghost, danger; `size` sm, md, lg; `type` button, submit; `block`; `disabled`; `onClick`.
- `FormField`: `label`, `required`, `help`, `error`; one control child with `ui-input`, `ui-select` or `ui-textarea`.
- `SearchField`: `value`, `placeholder`, `label` (accessible name), `onInput(value)`.
- `Table`: `columns: TableColumn<Row>[]` (`key`, `header`, required `width`, `priority`, `cell(row)`, `numeric`, `value(row)` for the comparable and searchable value behind the cell), `rows`, `rowKey(row)`, `status`, `loadingLabel`, `empty`, `emptyFiltered`, `filtered`, `sorting` with `sortingState` and `onSortingChange`, `globalFilter`, `pagination` (`pageIndex`, `pageSize`, `onPageChange`, `totalRows` when the module paged in SQL), `actions(row): TableAction[]`, `actionsLabel`, optional minimum `actionsWidth` (160 px default, 280 px for two actions; the column grows to its widest buttons), `onSelect(row)`, `selectedKey`, `caption`. Only a column with `value` is sortable and searched. Multi-row selection: `selection` (`selectedKeys: ReadonlySet<string>`, `onSelectionChange(keys)`, `label` of the header checkbox, `rowLabel(row)`, optional `selectable(row)` and `clearLabel`) adds a leading checkbox column whose header toggles the rows on screen; `bulkActions: TableBulkAction[]` (`id`, `label`, `icon`, `tone`, `disabled`, `reason`, `onSelect(keys)`) render in the bar above the table while something is selected, and `selectionSummary(count)` translates "N selected". The screen keeps the keys in its own state and resets them on a page, sort or filter change; the header checkbox touches only the rows on screen, while the clear button empties the whole set through `onSelectionChange`.
- `TableCard`: every `Table` prop plus `title`, `count`, `head`, `search`, `filters`, `before`, `after`, `note`, `noteIcon`.
- `Pagination`: the pager for the `TableCard` `after` slot: `pageIndex`, `pageSize`, `totalRows` (after the screen's own filtering), `onPageChange(pageIndex)`, `pageSizes` with `onPageSizeChange(pageSize)` (both or neither), `label`, `previousLabel`, `nextLabel`, `pageSizeLabel`, `summary(range)` that the screen translates. It reads "1 of 1" over an empty set, so it is rendered unconditionally.
- `Select`: the labelled native select: required `id`, `label`, `options` (`value`, `label`, `disabled`), `value`, `onChange(value)`, `placeholder`, `name` (defaults to `id`), `required`, `disabled`, `invalid`, `help`, `error`.
- `DateField`: required `id`, `label`, ISO `value` (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` for `kind="datetime"`), `onChange(value)`, `kind`, `locale` from `activeLocale()`, `min`, `max`, `name`, `required`, `disabled`, `invalid`, `help`, `error`, `describedBy` for a message a group around it owns. The reading beside the input repeats the value in the reader's locale.
- `DateRangeField`: required `id`, `legend`, `fromLabel`, `toLabel`, `value` (`from`, `to`), `onChange(value)`, `kind`, `locale`, `min`, `max`, `required`, `disabled`, `reversedMessage`, `help`, `error`; each side bounds the other and a reversed range is reported, never swapped.
- `Tabs`: required `id`, `items` (`id`, `label`, `disabled`), `active`, `onChange(id)`, `label`; it renders only the tablist, and the caller renders `<id>-panel-<active>` labelled by `<id>-tab-<active>`.
- `ToastHost`: `label`, `closeLabel`, optional `store`. One per screen that raises toasts, rendered even while empty; `toasts.success`, `.error` and `.info` raise them and `createToastStore` makes a scoped queue.

`Select`, `DateField` and `DateRangeField` own their label, so they go straight into a `ui-form__row` and never inside a `FormField`.

- `Filters`: `open`, `onToggle`, `activeCount`, `label`; children are the filter controls, which belong in the dropdown and nowhere else.
- `CheckGrid`: `groups: { label, options: { value, label, hint? }[] }[]`, `value: string[]`, `mono`, `disabled`, `onChange(next)`.
- `Drawer`: `open`, `title`, `subtitle`, `width` md or lg, `onClose`; child is `ui-drawer__form` or `ui-drawer__body`. Escape and the scrim close it.
- `Tag`: `tone` neutral, success, warning, danger, info, ink; `dot`; `mono`.
- `Kpi`: `label`, `value` (string), `unit`, `badge`, `note`, `href`, `linkLabel`.
- `PageHeader`: `eyebrow`, `title`, `description`; children are the right-side actions.
- `EmptyState`: `icon`, `title`, `code`, children as the sentence.
- `Alert`: `tone` danger (default), warning, info.
- `Avatar`: `name`, `square` (organizations), `large`.
- `Icon`: `name`, `size` (18 default, 16 in controls, 14 in `Button size="sm"`), `strokeWidth`.
- `BrandMark`: `size`, `signature`, `tone`; brand moments only.

Icon keys (`ICON_PATHS`, `packages/ui/src/icons/Icon.tsrx`): `dashboard`, `parties`, `catalog`, `user`, `users`, `shield`, `code`, `modules`, `file-text`, `play`, `bot`, `flask`, `activity`, `plug`, `search`, `chevron-down`, `chevron-left`, `chevron-right`, `chevrons-up-down`, `sort`, `calendar`, `plus`, `panel-left`, `check`, `filter`, `download`, `more`, `external`, `alert`, `x`, `sign-out`, `refresh`, `help`, `info`, `key`, `settings`, `braces`, `copy`. An unknown name renders `modules` silently, so check the list.

## 5. Classes a module writes by hand (`packages/ui/src/styles/components.css`)

Layout `ui-view`, `ui-two-col` (+`--wide-aside`), `ui-grid-2`, `ui-kpi-grid`, `ui-tag-cloud`, `ui-section-head` (h2 plus actions inside a view), `ui-toolbar` (+`__spacer`). Surfaces `ui-card` (+`__head`, `__title`, `__body`). Data `ui-table` (+`ui-table-wrap`, `ui-table__empty`, `ui-table__state` for a dot plus label, `.num`), `ui-cell` (+`ui-cell__muted`), `ui-mono`, `ui-code`, `ui-dot` (+`--muted`). Row action classes are component-owned and are never written by a module. Forms `ui-form` (+`__row`, `__row--4`, `__foot`, `__actions`), `ui-input` (+`--error`), `ui-select`, `ui-textarea` (+`--error`), `ui-checkbox`, `ui-label`, `ui-help` (+`--error`). Drawer `ui-drawer__form`, `ui-drawer__body`, `ui-drawer__foot`. Bits `ui-kbd`, `ui-note`, `ui-menu` (+`__label`, `__item`, `__item--active`, `__item--danger`, `__sep`), `ui-btn ui-btn--icon` for an icon-only button. Classes rendered by components (`ui-drawer__panel`, `ui-search`, `ui-page-head*`, `ui-field`, `ui-empty*`, `ui-alert*`, `ui-tag*`, `ui-kpi__*`, `ui-checks*`, `ui-avatar*`, `ui-table__sort`, `ui-pagination` (+`__summary`, `__size`, `__pages`), `ui-datefield` (+`__reading`), `ui-daterange` (+`__row`), `ui-tabs` (+`__tab`), `ui-toasts` with `ui-toast`) are not written by hand.

## 6. Copy

User-facing copy lives in every declared `translations/*.json` bundle and is read with fully qualified `t()` keys. Eyebrow names the domain, title names the records, and description is one sentence. Table headers say what the value is. Buttons start with a verb. Loading text ends with `…`. Drawer footer states the constraint the user cannot see. Write natural copy in each locale, with no exclamation marks or database jargon.

## 7. Inspect the rendered screen

A screen is not finished until it has been looked at. Typecheck and tests say nothing about overflow, alignment, a duplicate label or a column that collapses.

Where to look:

- Repository root: `pnpm dev`, then `http://localhost:4310`. `pnpm flowdular setup quick --apply --confirm reset-local-auth` (stop `pnpm dev` first; local only) seeds two demo tenants and two logins: `admin@example.com` / `Owner!23456789` owns both tenants, `user@example.com` / `Member!2345678` is a reduced-scope member. Navigate to the entry's navigation group and open the view.
- Sandbox: the session preview panel renders the draft module. Use it; a specialist has no shell and no dev server.
- No browser at hand: a headless Chrome screenshot (`--headless --window-size=1440,900 --screenshot=<file>`) captures what a fresh, signed-out session sees, which covers sign-in and public pages only. A protected screen needs a real session, so drive it with whatever browser automation the host offers rather than a bare screenshot flag.

Record one piece of evidence per state before handing off. A state you could not reach is stated as such, not assumed:

| State     | How to reach it                                                       | What to check                                                                         |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Loading   | First paint before the fetch resolves, or a throttled network profile | Column widths match the populated table, the head does not jump, a refresh keeps rows |
| Empty     | A tenant with no records                                              | The icon renders, the sentence names the first action, `emptyFiltered` differs        |
| Error     | Make the request fail (sign out in a second tab, or drop the scope)   | `Alert` under the header, no blank screen, no raw stack or SQL in the message         |
| Populated | Several real records, including the longest realistic value           | No horizontal page scroll, identifiers in `ui-mono`, numbers tabular, actions aligned |
| Denied    | Sign in as `user@example.com`                                         | The manage action is absent, navigation is hidden, a forced request still returns 403 |

Check the drawer form in the same pass: one label per field, fields top-aligned, the footer constraint visible, the submit button disabled while busy.

## Pitfalls

- `Kpi value={items.length}` does not typecheck; use `String(items.length)`.
- A `Tag` for a lifecycle state uses `success` for active and `neutral` for archived, with `dot`.
- An `Icon` inside `Button size="sm"` is 14, not 18.
- A new component file per screen, form, table, or stateful region; a page composes them.
