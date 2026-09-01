---
name: ux-design
description: Design a module screen on the shared design system, with the record-screen recipe, the five states, the component and class inventory, and the icon keys.
roles:
  - ux-designer
  - frontend-engineer
when: A screen, drawer form, dashboard widget, or copy is being designed or reviewed.
---

# Design a screen

`docs/design-system.md` (in a session: `reference/design-system.md`) is the only source of visual decisions. Primitives live in `packages/ui` (`reference/packages/ui/components/*.tsrx` and `components.css`). The reference screen is `modules/catalog/src/client/CatalogView.tsrx` with `CatalogItemForm.tsrx`.

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
  section.ui-card
    div.ui-card__head
      span.ui-card__title  Title <small>{n + ' items'}</small>
      SearchField value placeholder label onInput
    p.ui-table__empty                       loading: 'Loading ...…'
    EmptyState icon title                   empty: verb for the first action; filtered: 'No matching ...'
    div.ui-table-wrap > table.ui-table      populated: th.num for numbers, span.ui-cell (<b>name</b> <small class="ui-mono">id</small>), Tag for state
    p.ui-note                               one constraint worth stating
  Drawer open title subtitle onClose        form keyed by 'form-' + formSession
```

Drawer form: `form.ui-drawer__form > div.ui-drawer__body > div.ui-form > div.ui-form__row > FormField label required help` wrapping a native `input.ui-input`, `select.ui-select` or `textarea.ui-textarea`; `Alert` inside the body for the submit error; `div.ui-drawer__foot` with `<small>` for the constraint and `div.ui-form__actions` (Cancel, primary submit with `disabled={busy}` and a progressive label `Creating…`). `Drawer width="lg"` when rows have two columns or an editor.

Read-only master-detail (runs, playground) keeps `ui-two-col` (+ `--wide-aside`). Admin overviews use `ui-kpi-grid` with several `Kpi`; a module dashboard widget is one `Kpi` with `href` and `linkLabel`, rendered by the shell in `dashboard.metrics`.

## 3. Five states

- Loading: `p.ui-table__empty` while `status === 'loading' && items.length === 0`.
- Empty: `EmptyState` with an icon and a sentence that names the first action; a filtered empty says no match.
- Error: `Alert` (tone `danger` default) under the header, or inside the drawer while the form is open.
- Populated: table or list.
- Denied: the shell already hides navigation and widgets whose `scope` the principal lacks. Inside a view, pass booleans derived from `ModuleClientContext.scopes` (`canManage={options.scopes.includes(X_PERMISSIONS.manage)}` in `contribution.tsrx`, as `modules/agents` does) and do not render the action. A 403 from the server still becomes an `Alert`; it is never a crash.

## 4. Component and prop inventory (`packages/ui/src/components`)

- `Button`: `variant` primary, secondary (default), ghost, danger; `size` sm, md, lg; `type` button, submit; `block`; `disabled`; `onClick`.
- `FormField`: `label`, `required`, `help`, `error`; one control child with `ui-input`, `ui-select` or `ui-textarea`.
- `SearchField`: `value`, `placeholder`, `label` (accessible name), `onInput(value)`.
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

Icon keys (`ICON_PATHS`, `packages/ui/src/icons/Icon.tsrx`): `dashboard`, `parties`, `catalog`, `user`, `users`, `shield`, `code`, `modules`, `file-text`, `play`, `bot`, `flask`, `activity`, `plug`, `search`, `chevron-down`, `chevrons-up-down`, `plus`, `panel-left`, `check`, `filter`, `download`, `more`, `external`, `alert`, `x`, `sign-out`, `refresh`, `help`, `key`. An unknown name renders `modules` silently, so check the list.

## 5. Classes a module writes by hand (`packages/ui/src/styles/components.css`)

Layout `ui-view`, `ui-two-col` (+`--wide-aside`), `ui-grid-2`, `ui-kpi-grid`, `ui-tag-cloud`, `ui-section-head` (h2 plus actions inside a view), `ui-toolbar` (+`__spacer`). Surfaces `ui-card` (+`__head`, `__title`, `__body`). Data `ui-table` (+`ui-table-wrap`, `ui-table__empty`, `ui-table__actions` for the trailing action column, `ui-table__state` for a dot plus label, `.num`), `ui-cell` (+`ui-cell__muted`), `ui-mono`, `ui-code`, `ui-dot` (+`--muted`). Forms `ui-form` (+`__row`, `__row--4`, `__foot`, `__actions`), `ui-input` (+`--error`), `ui-select`, `ui-textarea` (+`--error`), `ui-checkbox`, `ui-label`, `ui-help` (+`--error`). Drawer `ui-drawer__form`, `ui-drawer__body`, `ui-drawer__foot`. Bits `ui-kbd`, `ui-note`, `ui-menu` (+`__label`, `__item`, `__item--active`, `__item--danger`, `__sep`), `ui-btn ui-btn--icon` for an icon-only button. Classes rendered by components (`ui-drawer__panel`, `ui-search`, `ui-page-head*`, `ui-field`, `ui-empty*`, `ui-alert*`, `ui-tag*`, `ui-kpi__*`, `ui-checks*`, `ui-avatar*`) are not written by hand.

## 6. Copy

English literals in `.tsrx`; translations are inert. Eyebrow names the domain (`Master data`, `Commercial master data`), title names the records, description is one sentence. Table headers say what the value is. Buttons start with a verb. Loading text ends with `…`. Drawer footer states the constraint the user cannot see (`The SKU is tenant-scoped and cannot change later.`). No exclamation marks, no jargon from the database.

## Pitfalls

- `Kpi value={items.length}` does not typecheck; use `String(items.length)`.
- A `Tag` for a lifecycle state uses `success` for active and `neutral` for archived, with `dot`.
- An `Icon` inside `Button size="sm"` is 14, not 18.
- A new component file per screen, form, table, or stateful region; a page composes them.
