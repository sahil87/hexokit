# Intake: `+ New` Split Button in the Sidebar Head

**Change**: 261030-5am0-sidebar-head-new-split-button
**Created**: 2026-10-30

## Origin

> Go deeper in to option C. Can we get the split button to the left? Near where the hexokit logo is today
> … Ok, nice. Proceed

Conversational (`/fab-discuss` on 2026-10-30). Design study `docs/wiki/create-flow-studies.html` **§5** (Option C deep dive: live placement mock, anatomy, per-route primary, fold ladder, fallbacks, mobile) is the mock for this change, and §6 is the approved recommendation. This is **change 4 of 4**. It depends on `261030-g0gv-ui-rename-workspace-group-tab` (labels) and `261030-6d2o-folder-first-new-sheet` (the `openNewSheet({level, server?, group?})` opener the "…" rows call).

## Why

The mouse paths for creating are hidden: New tab is two levels deep (hover the group → flyout card → `New tab` row), the server-group `+` only shows on hover, and the Workspaces-panel `+` is a 20px glyph. On mac web there's no keyboard path either: ⌘T is browser-reserved and `create-session` is unbound on mac. One persistent, labelled create control fixes discoverability.

**Placement decision (discussed):** the sidebar head, the strip holding the logo and the sidebar toggle, drawn *over* the bar's left end. Its width is `sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX` (`SidebarHead` in `components/top-bar.tsx:325`), so a control there costs **nothing** from the top bar's center or right cluster, and it sits directly above the tree it creates into (the Linear/Slack/Notion compose position). Rejected: the right control cluster (its width ladder is already tight next to the quake launcher and surface toggles) and breadcrumb dropdowns (260813-kvk7 removed the session dropdown on purpose).

## What Changes

### The control: `NewSplitButton` (`components/new-split-button.tsx`)

A two-segment split button reusing `open-button.tsx`'s geometry, flush segment corners and menu shell (the Control primitive's fixed 28px fine / 40px coarse height). Accent-green outline (`border-accent-green text-accent-green bg-accent-green/8`), per the study mock.

**Primary segment: an instant create at the deepest level the route has** (label changes by route):

| Route (`TopBar` mode) | Primary label | Primary action | Context |
|---|---|---|---|
| terminal `/$server/$window` | `+ Tab` | exactly the `create-window` action (instant, unnamed, active tab's folder) | current tab |
| server `/$server` | `+ Group` | exactly instant `create-session` (`executeCreateSessionInstant`) | route workspace |
| board `/board/$name` | `+ Tab` | `create-window` in the **focused pane's** workspace › group | `contexts/focused-pane-context.tsx` (already carries server and session) |
| host `/` | `+ Workspace` | opens the New sheet at Workspace level (there is no instant workspace create) | none; plain button, no caret |

Tip on the primary: `New tab (⌘T)` / `New group (⌥⌘T)` / `New workspace` with the effective chord.

This deliberately goes against the "split primary stays a fixed direction" decision in top-bar.md: a fixed `+ Tab` would do nothing on the workspace page, and the noun on the label keeps it honest. Record it as a design decision.

**Caret: a menu grouped by where the result lands.** The section headers name the target. Each row leads with its glyph (the top bar's mirrored-row rule) and shows a trailing keycap when bound. On the terminal route:

```
IN work › hexokit
  ＋ Tab                      ⌘T
  ▱ Tab at folder…
  ✦ Agent tab…
  ◎ Web tab…
  ↺ Reopen closed tab         ⇧⌘T
─────────
IN work
  ▤ Group                     ⌥⌘T
  ▱ Group at folder…
─────────
  ◫ Workspace…
```

Server route: only the `IN <ws>` section plus `Workspace…`. Board route: same as terminal, keyed to the focused pane (header e.g. `IN kit › review`). `Group on new worktree…` from the mock is **omitted** (deferred with change 3's worktree-creation row).

**Every row invokes a palette action by stable id** (Constitution V: no toolbar-only functionality): `create-window`, `create-window-at-folder` (→ sheet, Tab level), the existing spawn-agent action (`+ New Agent` → `SpawnAgentDialog`), the existing `Tab: New Iframe Tab` action, `reopen-window`, `create-session`, `create-session-at-folder` (from change 3, → sheet, Group level), `create-server` (→ sheet, Workspace level). Add any missing palette ids rather than wiring handlers directly.

### Placement and fold ladder

**Desktop, sidebar head shown** (`!isMobile && hasSidebar && sidebarOpen && barKeepsRoom`): the button goes in `SidebarHead` **beside the toggle**, i.e. `[logo][HexoKit] … [+ Tab ▾][≡]`, with `ml-auto` moving from the toggle to the button. Fold rungs, measured (the gui-toolbar measured-fold precedent, `lib/gui-toolbar-fold.ts`):

- **R1**: logo + wordmark + full split (`+ Tab ▾` ≈ 74px). Fits the default 220px sidebar (head 232px; need ≈ 24 + 20 + 8 + 54 + 8 + 74 + 8 + 28 = 224).
- **R2**: wordmark hidden (the logo stays as the `HexoKit home` link and keeps its `aria-label`). Used when the label is longer (`+ Group`) or the sidebar is narrower.
- **R3**: icon-only split `+▾` (≈ 46px). A safety rung; not reached at the 160px minimum sidebar with today's labels.

**Desktop, head not shown** (sidebar closed, or the bar has < `HEAD_MIN_BAR_PX` beside the head): an icon-only `+▾` in the left cluster **immediately after the hamburger** and before the `HistoryNav` arrows: `≡ +▾ ◀ ▶ ⬡HexoKit › work › hexokit`.

**Host page** (no sidebar, no hamburger): `+ Workspace` plain button in the left cluster after the brand crumb.

**Mobile (< sm)**: **not in the top bar** (the 375px budget is fixed forward; top-bar.md design decision). It goes at the right end of the drawer's brand row (`SidebarBrand`, `components/sidebar/`) at the coarse 40px height. The caret menu opens as a bottom sheet (or the existing coarse menu pattern). The rule to teach: *"New" is always at the top-left of the sidebar.*

**Desktop shell**: the head is part of the titlebar drag band. The button must be a `no-drag` island (same as the strip's switcher trigger; top-bar.md "The strip's switcher trigger is the band's only no-drag island" — update that decision).

### Per-group `+` in the sidebar tree (study Option A, reduced)

Each group header row (`session-row.tsx`) gets a `+` icon button (`aria-label="New tab in <group>"`) that is **visible at rest** at ~70% ink on fine pointers (always on coarse), using the shared row-icon geometry. Click → instant `create-window` in that group. This deliberately breaks the "one hover-reveal contract" for this control (creation is primary); record it as a decision.

### New chord: `create-session` on mac

Bind `create-session` to **⌥⌘T** on mac (`macCode: "KeyT"` with an option+cmd tier; follow the keybinding tier machinery in `lib/keybindings.ts`). Win/Linux stays ⇧Ctrl+N. Verify it isn't reserved by Chrome/Safari on mac. Firefox was not verified in the discussion; if Firefox reserves it, mark it "palette only" on that browser like ⌘T. The label becomes `New group`.

### Retired

- The window switcher's `+ New Tab` / `+ New Agent` footer actions (`top-bar.tsx` `BreadcrumbDropdown` `action`/`secondaryAction`, ~line 1686): moved into the split menu.
- The Workspaces panel header `+` (`server-panel.tsx:130`, `aria-label` "New workspace" after change 1): moved into the split menu.
- The server-group header hover `+` in the Groups tree (`sidebar/index.tsx` ~2997): superseded by the split menu's `Group` row. Keep the flyout card's `New group` row.

Palette actions are untouched (only in-bar doors are removed).

### Tests and evidence

- Vitest: primary label/action per mode; menu rows per mode invoke the right palette ids; fold rung selection from measured widths; the head renders the button only when the head shows; the icon-only fallback after the hamburger; mobile brand-row placement; the per-group `+` calls `onCreateWindow(server, group)`.
- e2e: specs that click the window switcher's `+ New Tab` move to the split button. Selection is by new testids (`new-split-primary`, `new-split-caret`, `new-split-menu`). The brand keeps the unique `HexoKit home` label.
- `just demo new-split-button`: web lane (desktop and mobile: head placement, menu, the sidebar-closed fallback, the mobile drawer) **and** the shell lane, because the change touches the titlebar drag band (Constitution § PR Evidence shell rule).

## Affected Memory

- `run-kit/ui/top-bar`: (modify) sidebar head gains the split button + fold ladder; left-cluster fallback; window switcher loses its create footer; design decisions (route-varying primary, no-drag island)
- `run-kit/ui/sidebar`: (modify) per-group `+` at rest; Workspaces panel `+` and server-group `+` removed; mobile brand-row button
- `run-kit/ui/keyboard-and-palette`: (modify) ⌥⌘T `create-session` on mac; any new palette ids
- `run-kit/desktop-shell`: (modify) no-drag island in the head

## Impact

Frontend only: `top-bar.tsx` (`SidebarHead`, left cluster, switcher footer), a new `new-split-button.tsx` + fold module, `sidebar/session-row.tsx`, `sidebar/index.tsx`, `sidebar/server-panel.tsx`, the mobile `SidebarBrand`, `lib/keybindings.ts`, palette wiring in `app.tsx`. The right-cluster overflow machinery is untouched (the head isn't part of the bar's 3-column grid).

## Open Questions

- The study §5.4 variant (the brand wordmark becomes a `work ▾` workspace switcher) is explicitly **not** in scope. It's a separate navigation decision.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The split button lives in the sidebar head (top-left) | The user asked for it there; study §5 approved | S:95 R:75 A:90 D:90 |
| 2 | Confident | Position: beside the toggle (`… [+ Tab ▾][≡]`), not right after the logo | Agent recommended it in the study (Linear/Slack/Notion convention); the user approved without objection | S:60 R:90 A:70 D:60 |
| 3 | Confident | The primary is an instant create whose level/label varies by route | Study §5.2 table; tradeoff recorded | S:75 R:85 A:75 D:70 |
| 4 | Confident | Menu rows invoke palette actions by stable id | Constitution V | S:80 R:85 A:90 D:85 |
| 5 | Confident | Fallbacks: icon-only after the hamburger when the head is hidden; mobile drawer brand row; host-page brand crumb | Study §5.3 table | S:75 R:85 A:75 D:70 |
| 6 | Confident | Per-group `+` visible at rest; the Workspaces-panel `+`, server-group `+` and switcher create footer retired | Study §5.5 / §6 | S:70 R:80 A:70 D:65 |
| 7 | Confident | ⌥⌘T binds `create-session` on mac | Study §6; Firefox unverified, to check in apply | S:65 R:90 A:60 D:70 |
| 8 | Confident | "Group on new worktree…" is omitted (deferred with change 3) | Change 3 defers worktree creation | S:70 R:95 A:80 D:80 |
| 9 | Confident | The workspace-switcher brand variant (§5.4) is out of scope | Study marks it a separate decision | S:80 R:95 A:85 D:85 |

9 assumptions (1 certain, 8 confident, 0 tentative, 0 unresolved).
