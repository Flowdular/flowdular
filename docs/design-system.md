# Coreloom design system

Identity 1.0 (2026-08-31). The implementation reference for humans and agents:
shared primitives, tokens, and the rules for using them.

## Where things live

- `packages/ui` (`@coreloom/ui`): the only source of visual primitives.
  Design tokens (`src/styles/tokens.css`), base styles, `ui-*` component
  classes, TSRX components, icons, and the brand mark. Fonts (IBM Plex Sans
  Variable, IBM Plex Mono) are self-hosted through `@fontsource` packages.
- `packages/client`: the application shell (sidebar, topbar, command palette,
  dashboard, contribution outlets). Shell-only layout lives in
  `src/shell/shell.css`.
- Modules: compose screens from `@coreloom/ui`. Module CSS may only add
  module-specific composites built on the tokens (example:
  `modules/agents/src/client/agents.css`).
- `platform/public`: `favicon.svg`, `og.png` (1200x630 Open Graph image).
- Brand mark geometry is generated: `node packages/ui/scripts/gen-mark.mjs`
  rewrites `packages/ui/src/brand/mark.ts` from the weave parameters.

## Rules

1. Primitives first. Use a `ui-*` class or an exported component before
   writing any new visual code.
2. Colors, fonts, sizes, radii, and shadows come only from tokens
   (`var(--...)`). No hex values in shell or module CSS.
3. Never restyle or override a `ui-*` class outside `packages/ui`.
4. A missing primitive is added per use case as a module-local component built
   on the tokens, and flagged as a promotion candidate for `packages/ui`.
5. Blue means action and selection. Green, amber, and red mean state. Copper
   is reserved for the brand (mark, splash, sign-in) and is never a button or
   a state color.
6. Minimum text size is 12 px (`--text-sm`); labels use `--text-xs` uppercase.
   Numbers in tables and KPIs are tabular (`.num`, `ui-kpi__value`).
7. Layout containment is owned by the primitives, not by the screen. Children
   of `ui-view`, `ui-two-col`, `ui-grid-2`, and `ui-kpi-grid` are shrinkable
   tracks, long words wrap, and the workspace never scrolls horizontally. Wide
   content scrolls inside its own container (`ui-table-wrap`), so one long
   value can never push the page sideways.
8. `Kpi` is a stat tile. Its value is a number or a short state word; addresses,
   identifiers, and paths belong in `note` or a `ui-mono` line.
9. A screen never splits its width between records and a form. Records own the
   page; creating and editing happens in a `Drawer`.
10. `Tag` carries state or a value with meaning (a status, a count, a scope).
    Never decoration: no "Secure", "Master data", or "Suggested setup" badges.
    A card head is a title, a one-line description in its `small`, and at most
    one right-aligned cluster (`ui-card__actions`: a count, a state, buttons).
11. A row is title and description on the left and its controls on one line on
    the right, vertically centered (`SettingRow`). The row title is the label;
    the control inside carries `aria-label`, never a second visible label.
12. Large sets are summarized where they are read (`ScopeSummary`, grouped by
    module) and edited in full only inside the drawer (`CheckGrid`).
13. Destructive actions close a drawer in their own `ui-form__section--danger`:
    one title, one line of consequence, one `Button variant="danger"`. They are
    never mixed into a status row.
14. Menus (workspace switcher, account menu, session actions) are `ui-menu`
    with `ui-menu__item` rows: 40 px, 10 px inset, the same hover and selected
    background, a 32 px avatar, two lines of text, and the trailing check
    pushed to the right edge.

## Screen pattern

Every record screen is built the same way, so a user who learns one learns all
of them:

```text
PageHeader        eyebrow, title, description, [Refresh] [+ New ...]
Alert             only when the last action failed
TableCard
  ui-card__head   title, count, SearchField and Filters on one line
  Table           the records, full width
  ui-note         the constraint worth stating (permissions, boundaries)
Drawer            the create or edit form, opened from the header or a row
```

`TableCard` is the default for a record screen. It owns the card, the one-line
head (title, `count`, and the `search` and `filters` slots inside
`ui-card__filters`), the `Table`, and the optional `ui-note` footer, so every
screen shows the same head, loading row, empty state, and filtered-empty
message. A screen passes data and slots, never table markup. Row actions are
compact, visible buttons in a narrow trailing column with an accessible but
visually empty header. The column is part of the same `colgroup` in loading,
empty and populated states, so widths do not drift. `Table` on its own covers
what needs a bare table, such as the list side of a master-detail screen.

`Table` is backed by the official `@octanejs/tanstack-table` adapter. Modules
still use the smaller Coreloom `Table` and `TableCard` contract from
`@coreloom/ui`; they never import TanStack directly. The shared primitive owns
the TanStack features, row model, header model and cell rendering so every
screen keeps the same states, widths and actions.

Every column declares a semantic CSS `width`. Give the primary record and its
description the largest share, medium shares to dates and identifiers, and the
smallest share to counts and lifecycle state. In a table with row actions, data
columns normally add up to about 90 percent; the shared 160 px action column
uses the rest. In a read-only table, data columns add up to 100 percent. The
table keeps these widths in loading, empty and populated states and scrolls
horizontally below its minimum readable width.

The drawer holds one `ui-drawer__form`: fields scroll inside
`ui-drawer__body`, and the primary action stays pinned in `ui-drawer__foot`.
Escape and the scrim close it. Master-detail screens that only read (agent runs,
the playground) keep `ui-two-col`; the list side is a `ui-table` whose open
record carries `is-selected`.

A drawer that edits several independent things (a member, a module) stacks
`ui-form__section` blocks inside its `ui-form`: an uppercase title and one-line
description in `ui-form__section-head`, then the fields and a right-aligned
`ui-form__actions` row with one primary per section. An input paired with one
action (a temporary password and its Reset) sits in a `ui-control-row`. The
danger section comes last, and the foot then keeps only Close.

Administration > Settings holds only workspace settings: full-width cards
(Workspace, Preferences), each `SettingRow` one setting. A module's declared
settings are edited in its Drawer under Administration > Modules, as
`SettingRow`s inside the drawer's Settings `ui-form__section`; a module
without settings shows a one-line empty state there.

## Components

| Component          | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`           | Actions: `variant` primary, secondary (default), ghost, danger; `size` sm, md, lg; `block`                                                                                                                                                                                                                                                                                                                                                                                |
| `FormField`        | Label + control + help or error. Put `ui-input`, `ui-select`, or `ui-textarea` inside                                                                                                                                                                                                                                                                                                                                                                                     |
| `VariableTextarea` | Multiline template field: `value`, `onInput`, `variables` (scope-filtered `VariableDefinition[]`), `sampleValues`, `label`, `name`; a `braces` menu inserts `{{ key }}` and tokens highlight as pills (error pill when unknown). Presentational, never fetches                                                                                                                                                                                                            |
| `VariableInput`    | Single-line variant of `VariableTextarea` with the same props                                                                                                                                                                                                                                                                                                                                                                                                             |
| `VariableSelect`   | Native select that stores either a literal option value or one allowed `{{ key }}` token. Takes scope-filtered `variables`, `sampleValues`, literal `options`, `value`, `onInput`, `name`, `label`, and native required/disabled state. It preserves keyboard, validation, accessibility, and `FormData` semantics and never fetches or resolves data                                                                                                                     |
| `Tag`              | Status and metadata: `tone` neutral, success, warning, danger, info, ink; `dot` adds a state dot; `mono`                                                                                                                                                                                                                                                                                                                                                                  |
| `Kpi`              | Stat tile: `label`, `value`, `unit`, `badge`, `note`, `href`, `linkLabel`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Chart`            | Token-driven Chart.js wrapper on a client-only canvas: `type` area, bar, line; `data`, `series` (`key`, `label`, `token`), `xKey`, `height`, `title`, `xTickFormatter`; series colors come from `--chart-1..5`; shows an EmptyState for empty or all-zero data                                                                                                                                                                                                            |
| `Table`            | The one data table, backed by `@octanejs/tanstack-table`: `columns` (`key`, `header`, required `width`, `numeric`, `cell`), `rows`, `rowKey`, `status` idle/loading, `loadingLabel`, `empty` and `emptyFiltered` picked by `filtered`, `actions(row): TableAction[]`, `actionsLabel`, optional stable `actionsWidth` (160 px by default, 280 px for two actions), `onSelect` with `selectedKey`, `caption`; fixed layout and `colgroup` keep columns stable across states |
| `TableCard`        | The record card around `Table`: `title`, `count`, the `head`, `search`, and `filters` head slots, `before` and `after` around the table, `note` with `noteIcon` as the footer                                                                                                                                                                                                                                                                                             |
| `PageHeader`       | Every view starts with it: `eyebrow`, `title`, `description`; children render as right-side actions                                                                                                                                                                                                                                                                                                                                                                       |
| `EmptyState`       | `icon`, `title`, children, optional `code`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Alert`            | Inline message: `tone` danger (default), warning, info                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Drawer`           | Editor panel over the records: `open`, `title`, `subtitle`, `width` md/lg, `onClose`                                                                                                                                                                                                                                                                                                                                                                                      |
| `SearchField`      | Filter control for a panel head: `value`, `placeholder`, `label`, `onInput`                                                                                                                                                                                                                                                                                                                                                                                               |
| `CheckGrid`        | Grouped multi-select for scopes, tools, and long option sets: `groups` (`label`, `options` of `value`, `label`, `hint`), `value`, `mono`, `disabled`, `onChange`                                                                                                                                                                                                                                                                                                          |
| `ScopeSummary`     | Read-only summary of `module.entity.action` scopes: one row per module, one chip per entity with its actions: `scopes`, `labels` (module id to display name)                                                                                                                                                                                                                                                                                                              |
| `SettingRow`       | One setting: `label`, `description` (node, one line), `scopeLabel` (small neutral tag), `status` (`ok`, `message` of the last save), children as the control cluster                                                                                                                                                                                                                                                                                                      |
| `Avatar`           | Initials from `name`: `square` for organizations, round for people; `large` in profile and account headers                                                                                                                                                                                                                                                                                                                                                                |
| `Switch`           | Boolean setting that applies on its own (no form submit): `checked`, `label` as the accessible name, `disabled`, `onChange`                                                                                                                                                                                                                                                                                                                                               |
| `ConfirmDialog`    | One question before an irreversible action: `open`, `title`, children, `confirmLabel`, `tone` danger (default) or primary, `busy`, `onConfirm`, `onCancel`                                                                                                                                                                                                                                                                                                                |
| `Icon`             | Stroke icon by `name` from `ICON_PATHS`; `size` 18 default, 16 in controls, 14 in `Button size="sm"`; `strokeWidth` 1.75 default                                                                                                                                                                                                                                                                                                                                          |
| `BrandMark`        | The weave: `size`, `signature` (copper weft, large brand moments only), `tone` brand, current, inverse                                                                                                                                                                                                                                                                                                                                                                    |

`Drawer` takes one child, a `ui-drawer__form` (fields in `ui-drawer__body`, actions in `ui-drawer__foot`) or a plain `ui-drawer__body`; it closes on Escape and on the scrim. `SearchField` carries no visible label, so pass `label` as its accessible name. `FormField` renders `error` in place of `help` and marks it `role="alert"`. `SettingRow` is presentation only: the caller owns the draft value, the save call, and passes the result back as `status`. `ScopeSummary` is the read side of `CheckGrid`; both keep the first-seen module order, and `summarizeScopes` is exported for callers that need the grouping without the markup.

Icon names (`packages/ui/src/icons/Icon.tsrx`): `dashboard`, `parties`, `catalog`,
`user`, `users`, `shield`, `code`, `modules`, `file-text`, `play`, `bot`,
`flask`, `activity`, `plug`, `search`, `chevron-down`, `chevrons-up-down`,
`plus`, `panel-left`, `check`, `filter`, `download`, `more`, `external`,
`alert`, `x`, `sign-out`, `refresh`, `help`, `key`, `settings`, `braces`. An unknown name renders
`modules` without a warning; a new icon is one 24x24 stroke path added there.

## Classes

- Layout: `ui-view`, `ui-two-col` (+`--wide-aside`), `ui-grid-2`,
  `ui-kpi-grid`, `ui-tag-cloud`, `ui-section-head` (an `h2` with actions
  inside a view)
- Surfaces: `ui-card` (+`__head`, `__title` with a `small` description,
  `__actions` for the right-aligned cluster, `__body`), `ui-toolbar`
  (+`__spacer` to push actions right; a bare `ui-input` or `ui-select` inside
  it takes the button height and an `aria-label`)
- Data: `ui-table` (+`ui-table-wrap`, `ui-table__empty`, `ui-table__actions`
  for the component-owned trailing button column, `ui-table__state` for a dot plus label,
  `ui-table__placeholder` for the loading and empty rows inside the table,
  `.num`, row states `is-clickable` and `is-selected`), `ui-cell`
  (+`ui-cell__muted`), `ui-mono`, `ui-code`
- Forms: `ui-form` (+`__row`, `__row--4`, `__foot`, `__actions`, `__section`
  with `__section-head` (`b` title, `small` description) and
  `__section--danger`), `ui-control-row` (a growing control beside one fixed
  button), `ui-choices` (a short wrapping row of `ui-checkbox`), `ui-input`
  (+`--error`), `ui-select`, `ui-textarea` (+`--error`), `ui-checkbox`,
  `ui-label`, `ui-help` (+`--error`)
- Drawer: `ui-drawer__form` (scrolling body plus pinned footer),
  `ui-drawer__body`, `ui-drawer__foot`
- Settings rows inside a `ui-card` or a drawer `ui-form__section`, rendered
  by `SettingRow`: `ui-setting`
  (+`__text` for title, scope tag, and help, `__control` for the one-line
  control cluster, `__status` (+`--error`) for the inline result)
- Buttons: `ui-btn` with `--primary`, `--secondary`, `--ghost`, `--danger`,
  `--sm`, `--lg`, `--block`, and `--icon` for an icon-only square button
  (the `Button` component renders all but `--icon`)
- Bits: `ui-kbd`, `ui-dot` (+`--muted`), `ui-note`, `ui-menu` (+`__label`,
  `__section` for a static identity or connection block, `__item`,
  `__item--active`, `__item--danger`, `__sep`), `ui-icon`

Rendered by components, not written by hand: `ui-page-head*`, `ui-search`,
`ui-field`, `ui-switch` (+`--on`), `ui-dialog` (+`__panel`, `__title`,
`__body`, `__actions`), `ui-empty` (+`__icon`), `ui-alert` (+`--danger`, `--warning`,
`--info`), `ui-tag` (+tone and `--mono`), `ui-kpi` (+`__label`, `__value`,
`__note`, `__link`), `ui-avatar` (+`--sq`, `--lg`), `ui-checks` (+`__group`,
`__head`, `__count`, `__all`, `__items`, `__option`), `ui-scopes` (+`__row`,
`__chip`), `ui-drawer-slot`, `ui-drawer` (+`__panel`, `__panel--lg`, `__head`,
`__close`), `ui-varfield` (+`__control`, `__highlight`, `__input`, `__pill`
(+`--error`), `__trigger`, `__menu`, `__value`, `__empty`; the overlay layer
that highlights `{{ key }}` tokens, rendered by `VariableTextarea` and
`VariableInput`).

## Token cheat sheet

- Surfaces: `--bg`, `--surface`, `--surface-2`; lines: `--line`, `--line-2`
- Text: `--ink`, `--ink-2` (labels), `--ink-3` (descriptions), `--ink-4`
  (placeholders only, below AA for text)
- Action: `--primary`, `--primary-hover`, `--primary-soft`, `--primary-tint`,
  `--focus`
- State: `--success`, `--warning`, `--danger` with `-bg` and `-line` pairs
- Brand: `--brand`, `--brand-weft` (copper)
- Type: `--font-sans`, `--font-mono`, `--text-xs` 11 to `--text-display` 36
- Dimensions: `--sidebar-w` 260, `--rail-w` 60, `--topbar-h` 52, `--control-h`
  36, `--button-h` 32, `--row-h` 44, radii `--r-sm` 4, `--r` 6, `--r-md` 8,
  `--r-lg` 12

Components reference the semantic layer only, so a dark theme is one token
override block, not a rewrite.
