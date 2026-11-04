---
type: memory
description: "The shared DataTable component over @tanstack/react-table — column contract, sortable aria-sort headers with the Control toggle vocabulary, fine-pointer column resizing over --rk-col-<id> CSS vars, the per-viewer hexokit-table-<id> view-state store (clamped reads, pub/sub + storage event), the mounted-table registry, the Table: Reset columns palette action, and the four table ids (watched, watched-dense, cron-list, cron-log)."
---
# run-kit UI — Data Table

**Domain**: run-kit/ui

## Overview

`components/data-table.tsx` is the ONE data table — a headless TanStack Table model (`@tanstack/react-table`) rendered in the project's own Tailwind/Control vocabulary, mounted by `watched-table.tsx` (Operator Tasks / the Server page WATCHED zone), `cron-list.tsx`, and `cron-log.tsx`. The component owns the table *chrome* — the header row with `aria-sort` sort buttons, the fine-pointer-only resize handles, the `<colgroup>` widths, the per-viewer `hexokit-table-<id>` view-state store, and the mounted-table registry behind the palette's `Table: Reset columns`; consumers own their *cells* via per-column `cell(row)` renderers and per-row `rowProps(row)`. The frontend's third TanStack dependency (the router family) — the shadcn/Radix data-table path is rejected (§ Design Decisions).

## Requirements

### Requirement: The column contract
Each column (`DataTableColumn<Row>`) SHALL declare `id` (stable — the sort/width persistence key), `header` (the visible lowercase label), `sortValue(row): string | number | undefined` (the sort accessor — a cell with no natural scalar returns the row's display label), optional `sortingFn(a, b)` (a comparator overriding the default scalar compare — the Cron List's `next` column uses `compareCronEntries`), optional `sortUndefined` (default `"last"` in both directions; set `false` when a `sortingFn` handles undefined itself — TanStack skips the custom sort fn for both-undefined pairs otherwise), `cell(row): ReactNode` (the consumer's renderer — `StatusDot`, chips, `Tip`-wrapped truncation), `size` (default px width), optional `minSize` (default `DATA_TABLE_MIN_COL_PX = 48`) and `maxSize` (default `DATA_TABLE_MAX_COL_PX = 960`), and optional `className` (extra classes on that column's `<td>`s — a string, or a per-row callback for row-conditional cell treatments such as the stale-note dim and the waiting amber). `DataTable<Row>`'s props: `tableId`, `label` (the palette display name), `columns`, `rows`, `rowKey`, `initialSort` (`DataTableSort = { id, desc } | null` — the at-rest order; `null` = input order), `dense` (the quake drawer variant: `pr-2 py-0.5` cells / `pr-2 pb-1` headers vs `pr-3 py-1` / `pr-3 pb-1`, the last column dropping the right padding), `rowProps(row)` (`className` / `onClick` / `onKeyDown` / `role` / `tabIndex` / `aria-disabled` / `data-testid` / `data-done`), `className` (extra classes on the `<table>`), and `data-testid` (forwarded to the `<table>`).

#### Scenario: Undefined sorts last
- **GIVEN** a column whose `sortValue` returns `undefined` for some rows
- **WHEN** the column is sorted in either direction
- **THEN** those rows sort last (`sortUndefined: "last"`)

### Requirement: Sortable headers with `aria-sort`
Every `<th scope="col">` SHALL carry `aria-sort="ascending" | "descending" | "none"` and contain a `<Control variant="toggle" ringed base={DATA_TABLE_HEADER_BASE + padding} pressed={sorted}>` button — `DATA_TABLE_HEADER_BASE` reproduces the header typography (`text-left text-[10px] uppercase tracking-wide text-text-secondary font-normal w-full`), so a header is visually unchanged at rest and the green latched arm marks the sorted column. The button SHALL carry `aria-label="Sort by {header}"` and, after the label, an `aria-hidden` glyph span — `▴` ascending, `▾` descending, nothing at rest. Click / Enter / Space SHALL cycle `none → ascending → descending → none` (single-column: `enableMultiSort: false`, `enableSortingRemoval: true`). The effective sorting fed to the table SHALL be `persistedSort ?? initialSort` — a cleared sort returns to `initialSort`, never to raw input order for a table that has one; when `initialSort` is `null` a cleared sort is input order.

#### Scenario: The three-click cycle
- **GIVEN** a table with `initialSort: { id: "next", desc: false }`
- **WHEN** the user clicks the `next` header three times
- **THEN** `aria-sort` reads `ascending` (explicit), then `descending`, then the sort clears and the rows return to the `initialSort` order

### Requirement: Column resizing on fine pointers
Every header except the last SHALL carry an `aria-hidden` resize handle (`data-testid="data-table-resize-handle"`): a 6px-wide (`DATA_TABLE_HANDLE_PX`) absolutely positioned element on the header's right edge, full header height, `cursor-col-resize touch-none`, bound to TanStack's `header.getResizeHandler()` on `onMouseDown` / `onTouchStart`, with `columnResizeMode: "onChange"` and `columnResizeDirection: "ltr"`. Column widths SHALL ride CSS custom properties `--rk-col-<id>` set on the `<table>` and read by each `<col style="width: var(--rk-col-<id>)">` (a drag restyles the table rather than re-keying cells), and the `<table>` SHALL carry `minWidth` equal to the summed column widths so `table-fixed` never redistributes. During a drag the handle wears `bg-accent-green`; on hover `bg-accent-green/60`. Widths clamp to `[minSize, maxSize]`; the view-state store is written ONCE on drag end (pointer-up / touch-end via a document-level listener armed on handle press — during the drag the live sizes sit in a local overlay), never per move. Double-click on a handle resets that column to its `size`. When `useCoarsePointer()` is true, `enableColumnResizing` SHALL be `false` and no handles render — header-tap sorting stays.

#### Scenario: Drag writes once
- **GIVEN** a fine-pointer viewport and a two-column table
- **WHEN** the user drags the first column's handle 40px right and releases
- **THEN** `--rk-col-<first>` grows by 40px (within clamps) and `localStorage["hexokit-table-<id>"]` gains `widths: { "<first>": <px> }` exactly once

### Requirement: Per-viewer view state in localStorage
One JSON key per `tableId`: `DATA_TABLE_STORAGE_PREFIX = "hexokit-table-"` + `tableId` (e.g. `hexokit-table-cron-list`), holding `DataTableViewState = { sort: { id, desc } | null; widths: Record<string, number> }` — `sort: null` means "use the table's `initialSort`", and `widths` holds only user-resized columns. The store (`readDataTableViewState` / `writeDataTableViewState` / `resetDataTableViewState` / the `useDataTableViewState` hook) SHALL follow `hooks/use-local-storage-enum.ts`'s in-module pub/sub (same-tab subscribers keyed on the storage key — the drawer's table and the Server page's table may co-mount) plus the native `storage` event cross-tab, and `lib/quake-terminal.ts`'s value discipline: `JSON.parse` in try/catch; a `sort.id` naming a column not in `columns` degrades to `null`; each width must be a finite number clamped into its column's `[minSize, maxSize]`; unknown column ids drop; anything unusable resolves per field to the defaults (`{ sort: null, widths: {} }`) with no error; a throwing localStorage (privacy mode) reads as empty and ignores writes. `resetDataTableViewState` removes the key and notifies subscribers. A legacy value under the `runkit-table-<id>` name reaches a fresh browser through the one-shot, marker-guarded (`hexokit-storage-migrated`) copy in `lib/legacy-storage-migration.ts` (run from `main.tsx` before mount, copying each legacy value only onto an absent `hexokit-` key); the legacy keys remain in place for one release.

#### Scenario: Corrupt value degrades per field
- **GIVEN** `localStorage["hexokit-table-t"] = '{"sort":{"id":"nope","desc":true},"widths":{"a":"wide","b":10,"zzz":200}}'` and columns `a`/`b` (both `minSize` 48)
- **WHEN** `readDataTableViewState("t", columns)` runs
- **THEN** it returns `{ sort: null, widths: { b: 48 } }`

### Requirement: The mounted-table registry and the palette reset
`data-table.tsx` SHALL keep a module-level registry of mounted tables (`tableId → label`, registered on mount, unregistered on unmount) and export `useMountedDataTables(): { id, label }[]` (a `useSyncExternalStore`-backed subscription). `lib/palette/data-table.ts` SHALL export the pure builder `buildDataTableActions(mounted, reset?)`: zero mounted → `[]` (omit-not-disable); one → a direct `Table: Reset columns` action resetting that table; two or more → one `Table: Reset columns…` action with an `optionPicker` over the mounted tables (`Pick a table to reset — Space toggle · Enter apply`) whose apply resets each picked table (the `lib/palette/cron.ts` picker idiom). Reset clears the table's `hexokit-table-<id>` key — sort back to `initialSort`, widths back to `size` — the Constitution V keyboard path for the mouse-only resize. `app.tsx` calls `useMountedDataTables()` in AppShell and spreads `buildDataTableActions(mounted)` into the `paletteActions` memo beside the cron group.

#### Scenario: Two tables mounted
- **GIVEN** the quake drawer's Cron List open over the Server page's WATCHED zone
- **WHEN** the palette opens
- **THEN** it lists `Table: Reset columns…` whose picker offers `Cron List` and `Watched`

### Requirement: The four tables and labels
The shipped mounts and their `tableId` / palette `label` pairs: `watched` → `Watched` (the Server page WATCHED zone and the mobile `?tab=tasks` mount, non-dense), `watched-dense` → `Operator Tasks` (the quake drawer), `cron-list` → `Cron List`, `cron-log` → `Cron Log`. At-rest orders: `watched`/`watched-dense` and `cron-log` take `initialSort: null` (the derived / API order); `cron-list` takes `initialSort: { id: "next", desc: false }` over the extracted `compareCronEntries` comparator so its at-rest order IS `sortCronEntries` ([ui/cron-console-tabs](/run-kit/ui/cron-console-tabs.md)).

### Requirement: Test coverage
Unit: `components/data-table.test.tsx` (the sort cycle + `aria-sort`, single-column replacement, undefined-last, cleared-sort → `initialSort`, a resize drag writing `widths` once with the `<col>` var following, the double-click reset, storage round-trip, corrupt JSON / unknown id / non-numeric width fallbacks, a coarse-pointer render with no handles, the mount registry's add/remove), `lib/palette/data-table.test.ts` (the 0 / 1 / 2+ builder shapes and the picker applying resets), and `lib/cron-list-model.test.ts` (`compareCronEntries` equals the `sortCronEntries` order). E2e: `tests/e2e/quake-terminal.spec.ts` (a Cron List header re-sort surviving a reload) and `tests/e2e/server-watched-zone.spec.ts` (the WATCHED table's header row with `aria-sort`), both carrying the **Proves:**/**Steps:** JSDoc.

## Design Decisions

### TanStack Table over shadcn/Radix
**Decision**: `@tanstack/react-table` as the headless table model; every element rendered in the project's own Tailwind/Control vocabulary.
**Why**: Radix has no table primitive; shadcn's data table is TanStack underneath plus a dependency tree (Radix, cva, tailwind-merge, a generated `components/ui/`) the project deliberately does not carry; the router is already TanStack.
**Rejected**: shadcn/ui data table (the dependency tree); a hand-rolled sort/resize (re-implements stable sort, `sortUndefined`, resize deltas the library already gets right); keeping the div-rows with a header span (a fourth bespoke layout, no resize path).
*Introduced by*: 260912-xi3h-data-table-tanstack

### Cleared sort means the table's initial sort
**Decision**: the sorting fed to TanStack is `persistedSort ?? initialSort`; a user un-sorting a column returns to the table's declared at-rest order, never to raw input order when an `initialSort` exists.
**Why**: Cron List's at-rest order is a recorded contract (`sortCronEntries`); "no user sort" must mean that order, not whatever the API returned.
**Rejected**: pre-sorting `rows` before handing them to the table (double sorting, and the header would show no `aria-sort` for the default order).
*Introduced by*: 260912-xi3h-data-table-tanstack

### Resize is mouse-only; reset is the keyboard path
**Decision**: handles render only on fine pointers and are `aria-hidden`; `Table: Reset columns` in the palette restores widths and sort.
**Why**: a touch has no resize gesture and a keyboard width-step chord is scope creep; Constitution V is satisfied by a palette path to undo the mouse-only state.
**Rejected**: keyboard-resizable handles (focusable `<div role="separator">` with arrow keys — more chrome than the tables warrant); no reset at all (a viewer stuck with a bad width).
*Introduced by*: 260912-xi3h-data-table-tanstack

### Two storage keys for the watched table's two densities
**Decision**: `WatchedTable` persists under `watched` (Server page and mobile `?tab=tasks`) and `watched-dense` (the quake drawer).
**Why**: the same six columns at ~420px and at full page width want different widths; one key would fight itself across mounts.
**Rejected**: one shared key (widths tuned in the drawer break the Server page and vice versa).
*Introduced by*: 260912-xi3h-data-table-tanstack
