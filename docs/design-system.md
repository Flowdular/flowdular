# Flowdular design system

Identity 1.0 (2026-08-31). The implementation reference for humans and agents:
shared primitives, tokens, and the rules for using them.

## Where things live

- `packages/ui` (`@flowdular/ui`): the only source of visual primitives.
  Design tokens (`src/styles/tokens.css`), base styles, `ui-*` component
  classes, TSRX components, icons, and the brand mark. Fonts (IBM Plex Sans
  Variable, IBM Plex Mono) are self-hosted through `@fontsource` packages.
- `packages/client`: the application shell (sidebar, topbar, command palette,
  dashboard, contribution outlets). Shell-only layout lives in
  `src/shell/shell.css`.
- Modules: compose screens from `@flowdular/ui`. Module CSS may only add
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
14. A screen never writes a bare `select.ui-select`, a bare date input, a bare
    file input, or its own label for any of them: it uses `Select`,
    `DateField`, `DateRangeField`, `DatePicker`, or `FileUpload`, which own the
    label association, the invalid state, and the help or error line. The only
    bare `ui-select` left is the one a primitive renders inside itself (the
    `Pagination` page size), where the row is the label and the control carries
    `aria-label`.
15. Menus (workspace switcher, account menu, session actions) are `ui-menu`
    with `ui-menu__item` rows: 40 px, 10 px inset, the same hover and selected
    background, a 32 px avatar, two lines of text, and the trailing check
    pushed to the right edge.
16. A surface that opens over the workspace holds the keyboard. `Drawer` and
    `ConfirmDialog` trap Tab inside the open panel, close on Escape, and return
    focus to the control that opened them; the screen only names the first
    field with `autoFocus`, and the panel takes focus when it names none.
17. A refusal is stated where the reader meets it, never folded into a label.
    A disabled `TableAction` carries `reason`, and a refused file carries the
    `FileUpload` refusal line; an action label stays the name of the action.

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
still use the smaller Flowdular `Table` and `TableCard` contract from
`@flowdular/ui`; they never import TanStack directly. The shared primitive owns
the TanStack features, row model, header model and cell rendering so every
screen keeps the same states, widths and actions.

Sorting, narrowing and paging are opt-in on the same `Table`. A column that
declares `value` (the comparable, searchable value behind the rendered cell) is
sortable once the table carries `sorting`, and is scanned by `globalFilter`; a
column without it stays presentation only. Sorting is uncontrolled by default
and reported through `onSortingChange`; pass `sortingState` as well to keep it
in the screen's own state. `pagination` takes `pageIndex`, `pageSize` and
`onPageChange` and slices `rows` client-side; add `totalRows` when `rows`
already holds one page because the module paginated in SQL. The page window is
taken over the rows that survive `globalFilter`, so a narrowed set can never
page into emptiness. The table never moves the page on its own: it clamps the
index when the row set shrinks under it and reports that through `onPageChange`
after the render commits, so the reader keeps their place when they sort or
filter. A screen that wants the first page after a sort or a new search term
resets the index itself.

A list the module already sorted, narrowed and cut in SQL passes `mode="server"`
instead. The table then renders `rows` exactly as they arrive and narrows
nothing: the headers still toggle and report through `onSortingChange`, the page
still reports through `onPageChange`, and the screen turns both into its next
request. `pagination.totalRows` stays optional there. With a total the table
clamps the page index the same way it does client-side; without one the page is
a keyset page nobody counted, and `pagination.hasMore` says whether another
follows, so an empty page with nothing behind it walks the reader back one page
rather than leaving them on a page that does not exist.

A row action that is refused carries `reason` beside `disabled`. The label stays
the name of the action and the reason becomes the button's accessible
description, so a reader who cannot see the greyed button still hears why.

The pager is a separate `Pagination` in the `TableCard` `after` slot, so the
screen holds one page index and size that both the table and the pager read.
It takes the row total the screen already knows (after its own filtering) and
a `summary(range)` the screen translates; `pageRange` is exported for a screen
that needs the same arithmetic elsewhere. Default page size is 25. A keyset
page passes `hasMore` in place of `totalRows`: Previous behaves the same, Next
stays open exactly while another page follows, and `summary(page)` reads a
`keysetPage` with the page index, size and first row but no page count, because
nobody counted the set.

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

| Component          | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`           | Actions: `variant` primary, secondary (default), ghost, danger; `size` sm, md, lg; `block`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `FormField`        | Label + control + help or error. Put `ui-input`, `ui-select`, or `ui-textarea` inside                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `VariableTextarea` | Multiline template field: `value`, `onInput`, `variables` (scope-filtered `VariableDefinition[]`), `sampleValues`, `label`, `name`; a `braces` menu inserts `{{ key }}` and tokens highlight as pills (error pill when unknown). Presentational, never fetches                                                                                                                                                                                                                                                                                                                                                                                                 |
| `VariableInput`    | Single-line variant of `VariableTextarea` with the same props                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `VariableSelect`   | Native select that stores either a literal option value or one allowed `{{ key }}` token. Takes scope-filtered `variables`, `sampleValues`, literal `options`, `value`, `onInput`, `name`, `label`, and native required/disabled state. It preserves keyboard, validation, accessibility, and `FormData` semantics and never fetches or resolves data                                                                                                                                                                                                                                                                                                          |
| `Tag`              | Status and metadata: `tone` neutral, success, warning, danger, info, ink; `dot` adds a state dot; `mono`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Kpi`              | Stat tile: `label`, `value`, `unit`, `badge`, `note`, `href`, `linkLabel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Chart`            | Token-driven Chart.js wrapper on a client-only canvas: `type` area, bar, line; `data`, `series` (`key`, `label`, `token`), `xKey`, `height`, `title`, `xTickFormatter`; series colors come from `--chart-1..5`; shows an EmptyState for empty or all-zero data                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Table`            | The one data table, backed by `@octanejs/tanstack-table`: `columns` (`key`, `header`, required `width`, `numeric`, `value`, `cell`), `rows`, `rowKey`, `status` idle/loading, `loadingLabel`, `empty` and `emptyFiltered` picked by `filtered`, `sorting` with `sortingState` and `onSortingChange`, `globalFilter`, `pagination`, `mode` client (default) or server, `actions(row): TableAction[]` (`id`, `label`, `icon`, `tone`, `disabled`, `reason`), `actionsLabel`, optional stable `actionsWidth` (160 px by default, 280 px for two actions), `onSelect` with `selectedKey`, `caption`; fixed layout and `colgroup` keep columns stable across states |
| `TableCard`        | The record card around `Table`: `title`, `count`, the `head`, `search`, and `filters` head slots, `before` and `after` around the table, `note` with `noteIcon` as the footer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Pagination`       | The pager for the `TableCard` `after` slot: `pageIndex`, `pageSize`, `totalRows` or `hasMore` for a keyset page nobody counted, `onPageChange`, `pageSizes` with `onPageSizeChange` (the type couples the pair, so one cannot arrive without the other), `label`, `previousLabel`, `nextLabel`, `pageSizeLabel`, and `summary(range)` that the screen translates                                                                                                                                                                                                                                                                                               |
| `Select`           | The labelled native select: required `id`, `label`, `options` (`value`, `label`, `disabled`), `value`, `onChange`, `placeholder`, `name` (defaults to `id`), `required`, `disabled`, `autoFocus`, `invalid`, `help`, `error`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DateField`        | Native date or datetime control: required `id`, `label`, ISO `value`, `onChange`, `kind` date (default) or datetime, `locale`, `min`, `max`, `name`, `required`, `disabled`, `invalid`, `help`, `error`, `describedBy` for a message a group around the field owns; the reading beside the input repeats the value in the reader's locale                                                                                                                                                                                                                                                                                                                      |
| `DateRangeField`   | Two `DateField`s with one answer: required `id`, `legend`, `fromLabel`, `toLabel`, `value` (`from`, `to`), `onChange`, `kind`, `locale`, `min`, `max`, `required`, `disabled`, `reversedMessage`, `help`, `error`; each side bounds the other and a reversed range reports instead of swapping                                                                                                                                                                                                                                                                                                                                                                 |
| `DatePicker`       | The calendar picker: required `id`, `label`, `openLabel`, `previousMonthLabel`, `nextMonthLabel`, `value` (`from`, `to`), `onChange`, `mode` single (default) or range, `kind`, `locale`, `min`, `max`, `presets` with `presetsLabel`, `fromLabel` and `toLabel` for a range, `name`, `required`, `disabled`, `autoFocus`, `invalid`, `help`, `error`; one popover holds the presets and the month grid                                                                                                                                                                                                                                                        |
| `FileUpload`       | The file control: required `id`, `label`, `value`, `onChange`, `refusal(reason, file)`, `chosen(file)`, `clearLabel`, plus `accept`, `maxBytes`, `hint`, `busy` with `busyLabel`, `error`, `name`, `required`, `disabled`, `autoFocus`; it refuses an unaccepted type and a file over `maxBytes` and hands the screen back `null`                                                                                                                                                                                                                                                                                                                              |
| `Tabs`             | Accessible tablist: required `id`, `items` (`id`, `label`, `disabled`), `active`, `onChange`, `label`; arrows, Home and End move roving focus, an `active` that names no enabled tab selects the first enabled one, and the caller renders the panel                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ToastHost`        | Renders the toast queue: `label`, `closeLabel`, optional `store`. Raise toasts with `toasts.success/error/info(message)`; `createToastStore` makes a scoped queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PageHeader`       | Every view starts with it: `eyebrow`, `title`, `description`; children render as right-side actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EmptyState`       | `icon`, `title`, children, optional `code`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Alert`            | Inline message: `tone` danger (default), warning, info                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Drawer`           | Editor panel over the records: `open`, `title`, `subtitle`, `width` md/lg, `onClose`; traps Tab and restores focus to the opener                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SearchField`      | Filter control for a panel head: `value`, `placeholder`, `label`, `onInput`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CheckGrid`        | Grouped multi-select for scopes, tools, and long option sets: `groups` (`label`, `options` of `value`, `label`, `hint`), `value`, `mono`, `disabled`, `onChange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ScopeSummary`     | Read-only summary of `module.entity.action` scopes: one row per module, one chip per entity with its actions: `scopes`, `labels` (module id to display name)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SettingRow`       | One setting: `label`, `description` (node, one line), `scopeLabel` (small neutral tag), `status` (`ok`, `message` of the last save), children as the control cluster                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Avatar`           | Initials from `name`: `square` for organizations, round for people; `large` in profile and account headers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Switch`           | Boolean setting that applies on its own (no form submit): `checked`, `label` as the accessible name, `disabled`, `onChange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ConfirmDialog`    | One question before an irreversible action: `open`, `title`, children, `confirmLabel`, `tone` danger (default) or primary, `busy`, `onConfirm`, `onCancel`; traps Tab and restores focus to the opener                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Icon`             | Stroke icon by `name` from `ICON_PATHS`; `size` 18 default, 16 in controls, 14 in `Button size="sm"`; `strokeWidth` 1.75 default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BrandMark`        | The weave: `size`, `signature` (copper weft, large brand moments only), `tone` brand, current, inverse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`Drawer` takes one child, a `ui-drawer__form` (fields in `ui-drawer__body`, actions in `ui-drawer__foot`) or a plain `ui-drawer__body`; it closes on Escape and on the scrim. `SearchField` carries no visible label, so pass `label` as its accessible name. `FormField` renders `error` in place of `help` and marks it `role="alert"`. `SettingRow` is presentation only: the caller owns the draft value, the save call, and passes the result back as `status`. `ScopeSummary` is the read side of `CheckGrid`; both keep the first-seen module order, and `summarizeScopes` is exported for callers that need the grouping without the markup.

`Select`, `DateField` and `DateRangeField` own their own label, so they go
straight into a form row and not inside a `FormField`. Each requires an `id`:
it binds the label to the control and keeps the browser's association stable
across renders, and `name` defaults to it for `FormData`. `invalid` marks the
control without occupying the message line; `error` does both and replaces
`help`.

A `DateField` holds the ISO value the platform stores and the form submits
(`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` for `kind="datetime"`), because a native
date input picks its own display format and no page can change it. The reading
beside the input repeats that value in the reader's locale: pass `locale` from
`activeLocale()`, and use the exported `formatDateValue` for the same reading
in a table cell. `DateRangeField` bounds each side by the other, so the picker
cannot produce a reversed range, and shows `reversedMessage` when one arrives
from the screen's own state; `dateRangeReversed` is exported for the same check
before a submit. Its one help or error line describes both inputs through
`describedBy`, because a fieldset's own `aria-describedby` never reaches the
controls inside it.

`DatePicker` is the calendar over those same native inputs: the trigger opens
one popover holding the presets and the month grid, and a range is picked in
that one calendar, first end then second, ordered on the way out so the picker
can never make a reversed range. `mode="single"` reads and writes `value.from`
and mirrors it into `to`, because a single day is a range whose ends match and
one shape keeps one keyboard model. Arrows move by day and week, PageUp and
PageDown by month, Home and End to the ends of the week, Enter or Space selects,
and Escape closes the calendar and stops there, so a picker inside a `Drawer`
never dismisses the drawer with the same keystroke. The four standard windows
come from `datePresetRange('today' | 'last-7-days' | 'last-30-days' |
'this-month')`, which the screen pairs with its own translated labels;
'this-month' is the month so far. With `kind="datetime"` the calendar answers
about the day only and keeps the time the value already carried, clamping the
result into `min` and `max`. Use `DateField` for a plain date a reader types,
`DateRangeField` for two dates in two labelled fields, and `DatePicker` when the
reader picks from a calendar or takes a window in one click.

`FileUpload` owns the two refusals a browser cannot state: a content type the
`accept` list does not cover, and a file over `maxBytes`. It detects them and
the screen supplies the words through `refusal(reason, file)`, the same way
every other primitive takes its copy. A refused file is never handed on: the
control reports `null`, empties the native list so the same file can be chosen
again, and shows the refusal in place of the reading. It re-reads the file it
holds whenever the limits change, so a ceiling that arrives after the drawer
opened still refuses what it must, and the screen keeps one `File | null` and no
check of its own. The native input stays the focus stop, so the picker opens
from the keyboard.

`Drawer` and `ConfirmDialog` hold the keyboard while they are open. Tab wraps at
both ends of the panel, Escape closes, and closing returns focus to the control
that opened the panel. Focus moves in on open: to the control the screen marked
`autoFocus` if there is one, otherwise to the first focusable control in the
panel, otherwise to the panel itself. A drawer whose first field is a `Select`
marks it `autoFocus`; the screen never moves focus by hand.

`Tabs` renders only the tablist. The caller renders the panel and wires it to
the tab: the tabs are `<id>-tab-<item.id>` and point at `<id>-panel-<item.id>`,
so a panel is `<div id={id + '-panel-' + active} role="tabpanel"
aria-labelledby={id + '-tab-' + active}>`. Arrow keys move focus and selection
over enabled tabs and wrap, Home and End jump to the ends, and only the active
tab is in the tab order, so Tab leaves the list for the panel.

`Toast` is a transient confirmation of something the reader just did, never a
state a screen must keep showing: a failure that blocks work stays in `Alert`.
A screen that raises toasts renders one `ToastHost`; the region keeps its place
in the DOM while empty, because a live region added with its first message is
not announced. `toasts.success`, `.error` and `.info` raise them from anywhere,
the queue keeps the four newest and dismisses each after five seconds, and
`createToastStore` makes a scoped queue for a surface or a test. The entry
animation follows the global reduced-motion rule in `base.css`.

The five states read the same way on every one of these: `Select`, `DateField`,
`DateRangeField` and `DatePicker` are loading when the screen disables them,
empty with an empty `value` (and a `placeholder` on `Select`), in error through
`error` or `invalid`, populated with a value, and denied by not being rendered
at all. `FileUpload` is loading while `busy`, empty with no `value` and its
`hint` on the line, in error through `error` or a refusal it made itself,
populated with the `chosen` reading beside a remove button, and denied the same
way: the screen does not render it.
`Table` keeps its own loading row, empty state and filtered-empty message, and
`Pagination` reads "1 of 1" over an empty set rather than disappearing.
`ToastHost` has no loading or denied state: it is empty or it carries toasts.

Icon names (`packages/ui/src/icons/Icon.tsrx`): `dashboard`, `parties`, `catalog`,
`user`, `users`, `shield`, `code`, `modules`, `file-text`, `play`, `bot`,
`flask`, `activity`, `plug`, `search`, `chevron-down`, `chevron-left`,
`chevron-right`, `chevrons-up-down`, `sort`, `calendar`,
`plus`, `panel-left`, `check`, `filter`, `download`, `more`, `external`,
`alert`, `x`, `sign-out`, `refresh`, `help`, `info`, `key`, `settings`, `braces`. An unknown name renders
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
  (+`--error`), `ui-select` (+`--error`), `ui-textarea` (+`--error`),
  `ui-checkbox`, `ui-label`, `ui-help` (+`--error`)
- Drawer: `ui-drawer__form` (scrolling body plus pinned footer),
  `ui-drawer__body`, `ui-drawer__foot`
- Settings rows inside a `ui-card` or a drawer `ui-form__section`, rendered
  by `SettingRow`: `ui-setting`
  (+`__text` for title, scope tag, and help, `__control` for the one-line
  control cluster, `__status` (+`--error`) for the inline result)
- Buttons: `ui-btn` with `--primary`, `--secondary`, `--ghost`, `--danger`,
  `--sm`, `--lg`, `--block`, and `--icon` for an icon-only square button
  (the `Button` component renders all but `--icon`)
- Bits: `ui-visually-hidden` (text only a screen reader reads), `ui-kbd`,
  `ui-dot` (+`--muted`), `ui-note`, `ui-menu` (+`__label`,
  `__section` for a static identity or connection block, `__item`,
  `__item--active`, `__item--danger`, `__sep`), `ui-icon`

Rendered by components, not written by hand: `ui-page-head*`, `ui-search`,
`ui-field`, `ui-switch` (+`--on`), `ui-dialog` (+`__panel`, `__title`,
`__body`, `__actions`), `ui-empty` (+`__icon`), `ui-alert` (+`--danger`, `--warning`,
`--info`), `ui-tag` (+tone and `--mono`), `ui-kpi` (+`__label`, `__value`,
`__note`, `__link`), `ui-avatar` (+`--sq`, `--lg`), `ui-checks` (+`__group`,
`__head`, `__count`, `__all`, `__items`, `__option`), `ui-scopes` (+`__row`,
`__chip`), `ui-drawer-slot`, `ui-drawer` (+`__panel`, `__panel--lg`, `__head`,
`__close`), `ui-table__sort` with `ui-table__sort-icon` (+`--on`, `--asc`),
`ui-pagination` (+`__summary`, `__size`, `__pages`), `ui-datefield`
(+`__reading`), `ui-daterange` (+`__row`), `ui-datepicker` (+`__row`,
`__trigger`, `__scrim`, `__popover`, `__presets`, `__preset`, `__calendar`,
`__head`, `__month`, `__step`, `__grid`, `__day` (+`--outside`, `--between`,
`--on`)), `ui-fileupload` (+`__control`, `__input`, `__clear`),
`ui-table-action` (the wrapper carrying a refused action's title),
`ui-tabs` (+`__tab`, `__tab--on`),
`ui-toasts` with `ui-toast` (+`--success`, `--error`, `--info`, `__message`,
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
