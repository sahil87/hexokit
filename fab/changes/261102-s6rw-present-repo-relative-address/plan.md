# Plan: Present Repo-Relative Address

**Change**: 261102-s6rw-present-repo-relative-address
**Intake**: `intake.md`

## Requirements

### Backend: Web roots in the live window path

#### R1: ListWindows reads the per-slot web roots
`tmux.ListWindows` / `parseWindows` SHALL read the `@rk_win_web_<n>_root` family (n = 1..`MaxWebTabs`) by mirroring the `layout.go` format: the `MaxWebTabs` URL slots are followed by `MaxWebTabs` parallel root slots, with every positional index constant derived from `MaxWebTabs`. `parseWindows` SHALL fill an internal `WebRoots []string` on `WindowInfo`, one trimmed entry per dense `WebTabs` entry (`""` when the slot has no root), tagged `json:"-"` so absolute roots are never serialized. Slot 1 SHALL fall back to the retired `@rk_win_present_root` when `web_1_root` is empty, the same rule the `/present/` route applies. A pre-16-slot (shorter than `listWindowsFullFields`) line SHALL keep parsing at the 8-slot-era offsets and carries no roots.

- **GIVEN** a full-format line with `web_1 = /present/s/h/x.html` and `web_1_root = /home/u/loom3/docs`
- **WHEN** `parseWindows` runs
- **THEN** `WebTabs[0]` is the URL and `WebRoots[0]` is `/home/u/loom3/docs`; every trailing field still lands in its own member
- **GIVEN** a legacy short line
- **WHEN** parsed
- **THEN** it parses at the 8-slot offsets with `WebRoots` entries all `""`

#### R2: `WebTabRootOption` doc is accurate
The `WebTabRootOption` doc comment SHALL no longer claim the root is never enumerated into ListWindows.

- **GIVEN** the code after the change
- **WHEN** reading `WebTabRootOption`
- **THEN** the comment states ListWindows reads it for the display prefix

### Backend: Derive the repo-relative display prefix

#### R3: `webPaths` is derived server-side per window
`FetchSessions` SHALL derive, beside `GitRoot`, a `WebPaths []string` (`json:"webPaths,omitempty"`) on `tmux.WindowInfo`, index-aligned with `WebTabs`, via a pure `deriveWebPath(root, windowGitRoot string) string` using `config.FindGitRoot` (stat-walk, no subprocess): `""` for empty root, root outside any repo, or root == repo toplevel in the same repo; the forward-slash relative path from the toplevel for a same-repo root; `<base(repoTop)>:<rel>` when the repo toplevel differs from the window's `GitRoot` (`<base>:` at that repo's toplevel). Nothing is stored at `rk present` time. `WebPaths` is omitted entirely when no slot yields a non-empty prefix.

- **GIVEN** root `/home/u/loom3/docs/wiki`, window gitRoot `/home/u/loom3`
- **WHEN** `deriveWebPath` runs
- **THEN** it returns `docs/wiki`
- **GIVEN** root `/home/u/loom/docs/wiki`, window gitRoot `/home/u/hexokit`
- **THEN** it returns `loom:docs/wiki`; root `/home/u/loom` returns `loom:`
- **GIVEN** a git worktree (`.git` as a file) or a root outside any repo
- **THEN** the worktree resolves like a repo; outside-repo returns `""`

### Frontend: Carry `webPaths`

#### R4: `webPaths` flows through types, client, and optimistic store mutations
The window type (`types.ts`) and the API client window shape SHALL carry optional `webPaths?: string[]` (parallel to `webTabs`). `window-store.ts` optimistic close and move SHALL apply the same filter/splice to `webPaths` when present. Consumers SHALL treat a length mismatch between `webPaths` and `webTabs` as "no prefix".

- **GIVEN** a window with 3 tabs and aligned `webPaths`
- **WHEN** tab 2 is optimistically closed or moved
- **THEN** `webPaths` is filtered/spliced identically and stays aligned

### Frontend: Display composition

#### R5: `presentDisplayBase` returns the whole tail
For the content-keyed form `/present/{server}/{hash}/…`, `presentDisplayBase` SHALL return all segments after server+hash joined by `/`; a directory present (server+hash only) still returns `index.html`; the legacy `/present/@<windowId>/[slot/]…` form keeps returning the last segment.

- **GIVEN** `/present/s/h/sub/page.html`
- **WHEN** the display base is computed
- **THEN** it is `sub/page.html`

#### R6: `displayForm(url, prefix?)` composes the repo-relative display
`displayForm` SHALL accept an optional prefix and for a content-keyed present address render `<prefix>/<tail>` (`<prefix><tail>` with no slash when the prefix ends in `:`; just `<tail>` when the prefix is empty/undefined). Plumbing params (`server`, `v`, `raw`) stay hidden; a page's own query and hash still follow. The prefix SHALL be ignored for non-present kinds, the legacy `@windowId` form and degraded shapes. It SHALL never throw.

- **GIVEN** prefix `docs/wiki` and `/present/s/h/verses-3d.html?v=1`
- **WHEN** `displayForm` runs
- **THEN** it returns `docs/wiki/verses-3d.html`; prefix `loom:` returns `loom:verses-3d.html`; dir root returns `docs/wiki/index.html`

#### R7: `webTabTitle` stays the basename
`webTabTitle` SHALL take only the last segment of the joined tail so the tab-strip label is unchanged.

- **GIVEN** `/present/s/h/sub/page.html`
- **WHEN** `webTabTitle` runs
- **THEN** it returns `page.html`

### Frontend: Chrome wiring

#### R8: Address bar, tab tooltip and tile header use the prefix
`IframeWindow` SHALL receive `webPaths` from `SurfaceLayout` and render `displayForm(rawAddress, activePrefix)` at rest, where `activePrefix` is `webPaths[webActive-1]` only when aligned; for a tracked frame location the prefix applies only while it is still a `/present/` address under the same `{server}/{hash}` as the active slot's stored URL. The tab tooltip SHALL use that tab's own prefix; the tab-strip label stays the basename; the tile header meta (`tileMeta`) SHALL use the active slot's prefix. Focused/edit mode SHALL keep showing and submitting the raw `/present/…` URL.

- **GIVEN** a presented file in a seeded repo
- **WHEN** the address bar is at rest
- **THEN** it reads `<repo-relative dir>/<file>`
- **GIVEN** the address input is focused
- **THEN** it shows the raw `/present/…` URL

### Non-Goals

- Making the repo-relative path itself submittable in the address input — out of scope.
- Any `app/desktop/src/` change — the native guest engine shares the SPA chrome.

### Design Decisions

#### Derive the prefix server-side at request time
**Decision**: Read stored absolute roots in `ListWindows` and derive `webPaths` in `FetchSessions`; serialize only the derived relative form.
**Why**: Constitution X ("derivation wins") and II; the URL carries only a sha256 prefix of the root, so the frontend cannot recover it, and absolute host paths stay server-side.
**Rejected**: Storing a display path at `rk present` time (violates X/II); shipping absolute roots to the frontend (needless exposure).
*Introduced by*: 261102-s6rw-present-repo-relative-address

## Tasks

### Phase 1: Backend

- [x] T001 Extend the `ListWindows` format and `parseWindows` in `app/backend/internal/tmux/tmux.go` with the `MaxWebTabs` root slots + legacy present-root field, new index constants, `WebRoots` (`json:"-"`) and `WebPaths` fields on `WindowInfo`, and the `WebTabRootOption` doc fix <!-- R1 --> <!-- R2 -->
- [x] T002 Update the `tmux_test.go` fixtures and add `parseWindows` root-parsing / legacy-detection / legacy present-root tests in `app/backend/internal/tmux/tmux_test.go` <!-- R1 -->
- [x] T003 Add `deriveWebPath` and wire `WebPaths` beside `GitRoot` in `app/backend/internal/sessions/sessions.go` <!-- R3 -->
- [x] T004 Add the `deriveWebPath` table test (in-repo subdir, toplevel, outside repo, worktree, cross-repo, cross-repo toplevel, empty) in `app/backend/internal/sessions/sessions_test.go` <!-- R3 -->

### Phase 2: Frontend core

- [x] T005 [P] Add `webPaths?: string[]` to the window type in `app/frontend/src/types.ts` and the client shape in `app/frontend/src/api/client.ts` <!-- R4 -->
- [x] T006 [P] Keep `webPaths` aligned in optimistic close/move in `app/frontend/src/store/window-store.ts`, with tests in `window-store.test.ts` <!-- R4 -->
- [x] T007 Fix `presentDisplayBase`, add `displayForm(url, prefix?)`, keep `webTabTitle` basename in `app/frontend/src/lib/web-url.ts`, with tests in `web-url.test.ts` <!-- R5 --> <!-- R6 --> <!-- R7 -->

### Phase 3: Integration

- [x] T008 Plumb `webPaths` from `SurfaceLayout` into `IframeWindow`, apply the prefix to the address bar (same-root guard for tracked locations), tab tooltip and tile-header meta in `app/frontend/src/components/iframe-window.tsx` and `surface-layout.tsx` <!-- R8 -->
- [x] T009 Extend `app/frontend/tests/e2e/web-tabs.spec.ts` (or a sibling spec) with a seeded-git-repo present test asserting the at-rest address reads `<prefix>/<file>`, with Proves/Steps comments <!-- R8 -->

## Execution Order

- T001 blocks T002, T003; T003 blocks T004
- T005–T007 are independent of the backend; T008 depends on T005 and T007; T009 on T008

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `ListWindows` format carries the root slots and `parseWindows` fills `WebRoots` aligned with `WebTabs`, with the slot-1 legacy present-root fallback
- [ ] A-002 R2: `WebTabRootOption` comment no longer says "never enumerated into ListWindows"
- [ ] A-003 R3: `FetchSessions` emits `webPaths` aligned with `webTabs` via `deriveWebPath`
- [ ] A-004 R4: `webPaths` is typed in `types.ts`/`client.ts` and the optimistic close/move keep it aligned
- [ ] A-005 R5: nested present navigation displays the whole tail
- [ ] A-006 R6: `displayForm` composes prefix + tail including the `loom:` form
- [ ] A-007 R7: `webTabTitle` returns the basename for a nested tail
- [ ] A-008 R8: address bar, tab tooltip and tile header show the prefixed form

### Behavioral Correctness

- [ ] A-009 R8: the focused address input still shows/submits the raw `/present/…` URL
- [ ] A-010 R1: raw absolute roots never appear in the window JSON

### Scenario Coverage

- [ ] A-011 R3: Go tests cover in-repo, toplevel, outside-repo, worktree, cross-repo, cross-repo toplevel and empty root
- [ ] A-012 R6: Vitest covers prefix, nested, directory, no-prefix, cross-repo, `loom:` toplevel, hidden plumbing params and the unchanged legacy form
- [ ] A-013 R8: an e2e spec asserts the at-rest address reads `<prefix>/<file>`

### Edge Cases & Error Handling

- [ ] A-014 R4: a `webPaths`/`webTabs` length mismatch degrades to no prefix
- [ ] A-015 R8: a tracked frame location that left the slot's `{server}/{hash}` does not inherit the prefix
- [ ] A-016 R1: a pre-16-slot capture line still parses at the legacy offsets

### Code Quality

- [ ] A-017 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [ ] A-018 No unnecessary duplication: Existing utilities (`config.FindGitRoot`, `denseWebTabs`, layout.go root pattern) reused where applicable
- [ ] A-019 Magic strings: no unnamed magic numbers/strings for field offsets or the label separator
- [ ] A-020 Comment discipline: comments state constraints only, no change IDs or narration
- [ ] A-021 Tests: new behavior covered by Go and Vitest tests; Playwright test carries Proves/Steps comments

### Security

- [ ] A-022 R1: no new user input reaches a subprocess; derivation is a read-only stat-walk

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The retired `@rk_win_present_root` is read as one extra field before the legacy note (full lines only), mirroring the `/present/` route's slot-1 fallback | Intake mandates mirroring the route rule; one extra fixed field keeps the legacy note LAST | S:70 R:80 A:80 D:70 |
| 2 | Confident | `WebPaths` is omitted (nil) when every slot's prefix is empty, relying on `omitempty` plus an explicit all-empty check | Keeps the payload unchanged for windows with no present tabs | S:65 R:85 A:80 D:75 |
| 3 | Confident | Legacy short ListWindows lines carry no root block and no legacy present-root field; offsets after web_active shift only for full lines | Legacy captures predate roots in ListWindows | S:70 R:80 A:80 D:70 |

3 assumptions (0 certain, 3 confident, 0 tentative).
