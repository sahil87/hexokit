# Intake: Present Repo-Relative Address

**Change**: 261102-s6rw-present-repo-relative-address
**Created**: 2026-11-02

## Origin

> Show the repo-relative path of an `rk present`-ed file in the web tile's address bar instead of the opaque `/present/<server>/<roothash>/<file>?v=<bust>` URL.

Conversational, then dispatched promptless (`/fab-proceed`-style create-new, `{questioning-mode} = promptless-defer`). Trigger: a user screenshot of the desktop shell's web tile showing the `present` kind chip followed by `/present/loom3/98baf10236d1/verses-3d.html?v=1793612360` in the URL field. The user wants the field to read the file's path **relative to the git repo it lives in** — e.g. `docs/wiki/verses-3d.html`.

The approach below was investigated in code and agreed in the preceding conversation (the user said "proceed" on the agent's recommendation, including the cross-repo prefix). Rejected alternatives are recorded under **Why**.

Not the core of the change, and unverified: whether the screenshot showed the field *focused* (focus intentionally swaps in the raw address — `iframe-window.tsx` ~L1387 `onFocus` → `setInputUrl(rawAddress)`) or an older shell build. Either way the at-rest display today is only the basename, which is the gap this change closes.

## Why

1. **Pain point.** A presented file's address carries no human-meaningful location. At rest, `displayForm()` (`app/frontend/src/lib/web-url.ts` ~L209) collapses a present address to its basename via `presentDisplayBase()` (~L116) — `verses-3d.html` — and the raw `/present/<server>/<roothash>/…?v=…` URL shows while focused. Neither tells the user *where* the file is. With several presented files of the same name (`index.html` in multiple folders, worktrees of the same repo), the user cannot tell tabs apart or know what they are looking at.
2. **Consequence of not fixing.** Users must go back to the terminal to recall what they presented; same-named files are indistinguishable; nested navigation inside a presented directory (`/present/s/h/sub/page.html`) shows only `page.html`, losing `sub/` (a latent bug in `presentDisplayBase`, which returns only the LAST segment).
3. **Why this approach.**
   - **Frontend-only is impossible**: the slot URL carries only a sha256 prefix of the absolute serve root (`app/backend/internal/present/present.go` `RootHash` / `PresentURL`); the root itself is not recoverable client-side.
   - **Storing a display path at `rk present` time is rejected**: Constitution Principle X ("derivation wins" — anything derivable from the filesystem/git MUST be derived server-side at request time) and Principle II (disposable daemon; durable sources only). The repo-relative path is fully derivable from the stored absolute root (`@rk_win_web_<n>_root`) plus a filesystem walk.
   - **Shipping absolute roots to the frontend and computing there is rejected**: unnecessary exposure of absolute host paths and the backend already owns filesystem knowledge (`config.FindGitRoot`); `internal/sessions` already derives `GitRoot` per window the same way.
   - Accepted tradeoff: the window payload grows by one parallel string array.

## What Changes

### 1. Backend — read web roots in the live window path (`app/backend/internal/tmux/tmux.go`)

Today the LIVE window payload (`tmux.ListWindows` → `parseWindows` → `WindowInfo` → `internal/sessions` → SSE → frontend) carries `webTabs`, `webActive`, `codeRoot`, `gitRoot`, but **not** the per-slot web roots. Only the layout-snapshot path reads them (`app/backend/internal/tmux/layout.go` ~L48–52 `WebTabs`/`WebRoots`, format built ~L103–107, parsed ~L314–318 where `WebRoots` is filled parallel to the dense `WebTabs`).

Change: `ListWindows` reads the `@rk_win_web_<n>_root` family (`tmux.WebTabRootOption(n)`, n = 1..`MaxWebTabs` = 16) by **mirroring the `layout.go` pattern** — the MaxWebTabs URL slots are followed by MaxWebTabs parallel root slots in the format string, with positional index constants derived from `MaxWebTabs` (the `listWindows*Field` const block ~L1633–1646 shifts accordingly). `parseWindows` fills an internal parallel slice (e.g. `WebRoots []string`, one entry per dense `WebTabs` entry, trimmed, `""` when the slot has no root — port/URL targets clear the root).

- The raw absolute roots are NOT serialized to the client: tag the internal field `json:"-"` (or keep it unexported from the JSON shape) — only the derived relative form is emitted (§ 2).
- The legacy `@rk_win_url` / `@rk_win_present_root` dual-read fallbacks: when `web_1` comes from the retired `@rk_win_url` and `web_1_root` is empty, the slot-1 root falls back to `tmux.LegacyWinPresentRootOption` the same way the `/present/` route does today (mirror whatever `ReadWebTabFamily`/the route does — do not invent a new rule).
- **Constraint (legacy line detection)**: `parseWindows` and `layout.go` both detect a "pre-16-slot capture" by a line being shorter than the current full field count (`listWindowsFullFields`, `legacyWebTabSlots = 8`). Adding 16 root fields changes the full count; the detection must remain coherent — a current-format line is always produced by our own format string, but any existing fixture/capture path that relies on the shorter-line rule must keep parsing correctly. Update `tmux_test.go` fixtures that build full-format lines.
- Update the `WebTabRootOption` doc comment (~L157–160), which today says the root is "never enumerated into ListWindows".

### 2. Backend — derive the repo-relative display prefix (`app/backend/internal/sessions/sessions.go`)

In `FetchSessions`, beside the existing `sd.windows[j].GitRoot = deriveGitRoot(&sd.windows[j])` (~L853), derive per web slot a display prefix and emit it on the window payload as a new parallel array **`webPaths`** (`WebPaths []string \`json:"webPaths,omitempty"\`` on `tmux.WindowInfo`), index-aligned with `webTabs`.

Derivation per slot root `root` (pure function, e.g. `deriveWebPath(root, windowGitRoot string) string`, colocated test):

| Case | Example root | Result |
|------|--------------|--------|
| No root (port/URL target, or empty) | `""` | `""` |
| Root inside a repo, same repo as the window's `GitRoot` | `/home/u/loom3/docs/wiki` (repo `/home/u/loom3`, window gitRoot `/home/u/loom3`) | `docs/wiki` |
| Root == repo toplevel, same repo | `/home/u/loom3` | `""` |
| Root not inside any git repo | `/tmp` (file `/tmp/report.html`) | `""` (→ today's basename display) |
| Root in a DIFFERENT repo than the window's `GitRoot` | `/home/u/loom/docs/wiki` while window gitRoot is `/home/u/hexokit` | `loom:docs/wiki` |
| Different repo, root == that repo's toplevel | `/home/u/loom` | `loom:` |

- Repo detection: `config.FindGitRoot(root)` (`app/backend/internal/config/gitroot.go`) — a pure stat-walk for `.git` (file OR dir, so git worktrees work; no subprocess, Constitution I needs no timeout). Relative part: `filepath.Rel(repoTop, root)`, normalized to forward slashes, `"."` → `""`.
- Cross-repo label: `filepath.Base(repoTop)` followed by `:`. The cross-repo test compares `repoTop` against the window's derived `GitRoot` (which is "git toplevel when in a repo, else the raw cwd" — so a window whose cwd is outside any repo treats every in-repo root as cross-repo and gets the label).
- Derivation happens server-side at request time (Principle X/II) — nothing is stored at `rk present` time; a moved/deleted file still derives from its stored absolute root.
- Cheap enough for the hot path (≤16 stat-walks per window); MAY memoize per distinct root within one `FetchSessions` pass, but no cross-request cache is required.

### 3. Frontend — carry `webPaths` (`app/frontend/src/types.ts`, `app/frontend/src/api/client.ts`, `app/frontend/src/store/window-store.ts`, `app/frontend/src/lib/window-view.ts`)

- Add `webPaths?: string[]` to the window type in `types.ts` (doc comment: parallel to `webTabs`, the server-derived repo-relative prefix of each slot's serve root; `""` = no prefix; absent on older backends) and wherever the API client mirrors window shape (`client.ts` ~L266).
- **Optimistic mutations must keep the arrays aligned**: `window-store.ts` optimistically closes (~L130, filters index `n-1`) and moves (~L152–167, splice) `webTabs`; apply the same filter/splice to `webPaths` when present. Consumers MUST additionally treat a length mismatch between `webPaths` and `webTabs` as "no prefix" (degrade, never mis-attribute a prefix to the wrong tab).

### 4. Frontend — compose the display (`app/frontend/src/lib/web-url.ts`)

**4a. Fix `presentDisplayBase` to return the whole tail.** For the NEW content-keyed form (`/present/{server}/{hash}/…`) it returns all segments after server+hash joined with `/` (not just the last), so nested navigation inside a presented directory displays `sub/page.html`. Directory present (only server+hash) still returns `DIRECTORY_PRESENT_LABEL` (`index.html`). Legacy `/present/@<windowId>/[slot/]…` form: keep current behavior (last segment). Segments are URL-decoded the way they are today (no change to escaping posture).

**4b. `displayForm(url, prefix?)`** gains an optional repo-relative prefix argument (string). For a `present` address:

```text
prefix ""/undefined           → <tail>                       verses-3d.html          (unchanged behavior)
prefix "docs/wiki"            → docs/wiki/verses-3d.html
prefix "docs/wiki", nested    → docs/wiki/sub/page.html
prefix "docs/wiki", dir root  → docs/wiki/index.html
prefix "loom:docs/wiki"       → loom:docs/wiki/verses-3d.html
prefix "loom:" (repo top)     → loom:verses-3d.html          (no "/" after a trailing ":")
```

Plumbing params (`server`, `v`, `raw` — `PRESENT_PLUMBING_PARAMS`) stay hidden; a page's own query params and hash still follow. The prefix is ignored for non-present kinds and for the legacy `@windowId` form and degraded shapes (which keep falling back to the raw string). Never throws.

**4c. `webTabTitle` stays the basename.** It currently shares `presentDisplayBase`; after 4a it MUST take only the last segment of the tail (tab-strip width — the ladder caps tabs at 200px), so the strip label is unchanged by this change.

### 5. Frontend — wire the prefix into the chrome (`app/frontend/src/components/iframe-window.tsx`, `app/frontend/src/components/surface-layout.tsx`)

- `IframeWindow` receives the window's `webPaths` (prop alongside `tabs: string[]`, ~L67–69) from `SurfaceLayout`.
- **Address bar at rest** (~L1376): `displayForm(rawAddress, activePrefix)` where `activePrefix` is `webPaths[webActive-1]` when aligned. `rawAddress = trackedLocation ?? url` (~L502) — when the tracked frame location is used, apply the prefix only when it is still a `/present/` address under the SAME `{server}/{hash}` as the active slot's stored URL (a frame that navigated elsewhere must not inherit a prefix that no longer describes it).
- **Focused / edit mode unchanged**: the raw `/present/…` URL is what the input shows and submits. Making the repo-relative path itself submittable is OUT of scope.
- **Tab tooltip** (~L1104 `title={displayForm(tabUrl)}`): passes that tab's own prefix → hover shows `docs/wiki/verses-3d.html`.
- **Tab-strip label** (~L1069 `webTabTitle(tabUrl)`): unchanged (basename).
- **Tile header meta** (`surface-layout.tsx` `tileMeta` ~L826–828, `displayForm(webUrl)` for the active web URL): passes the active slot's prefix too, so the header and address bar agree.
- Both engines: the address bar is SPA chrome, so the browser `<iframe>` engine and the desktop shell's native guest engine get the same display with no `app/desktop/src/` change.

### 6. Tests

- **Go** (`internal/sessions` colocated `_test.go`, and `internal/tmux/tmux_test.go`): `deriveWebPath` table — in-repo subdir, root == toplevel, outside any repo, worktree (`.git` as a FILE), cross-repo label, cross-repo at toplevel, empty root; `parseWindows` reads the 16 root slots parallel to dense `webTabs` and the legacy-length detection still holds.
- **Vitest** (`app/frontend/src/lib/web-url.test.ts`): `presentDisplayBase`/`displayForm` — prefix, nested tail, directory present, no prefix, cross-repo label, `loom:` at repo top, plumbing params hidden, legacy `@windowId` form unchanged, `webTabTitle` still basename for a nested tail. `window-store.test.ts`: close/move keep `webPaths` aligned.
- **PR evidence** (Constitution § PR Evidence — UI-visible): Playwright via the `just` rig (`just pw` / `just test-e2e`), Before/After, desktop (1280×800) + mobile (375×812); because the web tile renders on two engines (browser `<iframe>` and desktop native guest), record both the web lane and a shell lane (`just demo` with specs under `app/frontend/tests/demo/` and `app/desktop/tests/demo/`). An e2e spec under `app/frontend/tests/e2e/` (e.g. extending `web-tabs.spec.ts`) asserting the at-rest address reads `<prefix>/<file>` for a file presented from inside a seeded git repo; Playwright `test()`s carry the Constitution's Proves/Steps intent comments.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) Address input display/edit split + Address model: `displayForm(url, prefix?)` repo-relative present display, `presentDisplayBase` full-tail fix, `webTabTitle` stays basename, tab tooltip/tile-header meta use the prefix, `webPaths` alignment rule
- `run-kit/tmux-sessions`: (modify) `@rk_win_web_<n>_root` registry row — `ListWindows` now reads the family (readers column)
- `run-kit/architecture/backend-packages`: (modify) `internal/sessions` derives `webPaths` per window beside `GitRoot` (FindGitRoot stat-walk, cross-repo label rule)
- `run-kit/api-and-sockets`: (modify) window payload gains `webPaths` (parallel to `webTabs`) on the SSE/state stream

## Impact

- **Backend**: `app/backend/internal/tmux/tmux.go` (ListWindows format + `parseWindows` + `WindowInfo` fields + const block + `WebTabRootOption` comment), `app/backend/internal/tmux/tmux_test.go`, `app/backend/internal/sessions/sessions.go` (+ test). Possibly a small shared helper if `layout.go`'s root parse can be reused — follow the existing duplication-avoidance anti-pattern rule.
- **Frontend**: `src/types.ts`, `src/api/client.ts`, `src/store/window-store.ts` (+ test), `src/lib/web-url.ts` (+ test), `src/components/iframe-window.tsx`, `src/components/surface-layout.tsx` (prop plumbing + `tileMeta`).
- **API surface**: additive `webPaths` field on the window JSON; older frontends ignore it, older backends omit it (frontend degrades to basename).
- **Specs (human-curated, not auto-edited)**: `docs/specs/api.md` / `docs/specs/ui-state.md` describe the window payload / web-tab family — flag for the human in the PR if they enumerate window fields.
- **No `app/desktop/src/` change** expected; the native engine shares the SPA chrome. Shell recording is still required since the web tile behaves across both engines.
- **Security**: no new user input reaches a subprocess; absolute roots stay server-side; derivation is a read-only stat-walk.

## Open Questions

- None blocking. Lower-signal defaults (rows 12–14: tile-header meta, where the cross-repo label is computed, non-repo window cwd / worktree label naming) can be revisited via `/fab-clarify`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Derive the repo-relative prefix server-side at request time from `@rk_win_web_<n>_root`; never store it at `rk present` time | Constitution Principle X ("derivation wins") + II; discussed and agreed | S:95 R:80 A:95 D:95 |
| 2 | Certain | Frontend-only fix is impossible — slot URL carries only a sha256 prefix of the root | Verified in `present.go` `RootHash`/`PresentURL`; discussed | S:95 R:90 A:95 D:95 |
| 3 | Confident | `ListWindows` reads the 16 `@rk_win_web_<n>_root` slots by mirroring the `layout.go` format/parse pattern (roots block after URL slots, indices derived from `MaxWebTabs`) | Agreed approach; existing in-repo precedent | S:85 R:70 A:80 D:75 |
| 4 | Confident | Emit a parallel `webPaths []string` (json `webPaths`, omitempty) on the window payload; raw absolute roots are not serialized | Discussed — proposed name parallel to `webTabs`; abs roots rejected as unnecessary | S:85 R:75 A:80 D:80 |
| 5 | Certain | Prefix rule: `rel(FindGitRoot(root), root)`; `""` when root == repo top or root outside any repo (→ today's basename display) | Discussed with explicit examples | S:90 R:80 A:85 D:85 |
| 6 | Confident | Cross-repo (repo top ≠ window `GitRoot`) prefixes the repo folder name: `loom:docs/wiki/x.html`; `loom:` + tail at repo top | Agent recommended, user said "proceed" without objecting | S:70 R:80 A:70 D:65 |
| 7 | Certain | Fix `presentDisplayBase` to join the whole tail after server+hash (nested nav shows `sub/page.html`); directory present still `index.html`; legacy `@windowId` form unchanged | Discussed; latent bug confirmed in code | S:90 R:85 A:85 D:85 |
| 8 | Certain | Tab-strip label `webTabTitle` stays the basename (takes last segment of the joined tail); tab tooltip gets the prefixed form | Discussed — strip width | S:85 R:90 A:85 D:85 |
| 9 | Certain | Focused/edit mode keeps the raw `/present/…` URL (what gets submitted); a submittable repo path is out of scope; `?v=`/`server`/`raw` stay hidden | Explicitly scoped in discussion | S:95 R:90 A:90 D:95 |
| 10 | Confident | `window-store` optimistic close/move apply the same filter/splice to `webPaths`; a `webPaths`/`webTabs` length mismatch degrades to no prefix | Existing optimistic mutations verified in code; alignment is required for correctness | S:60 R:85 A:80 D:75 |
| 11 | Confident | Apply the active prefix to a tracked frame location only when it is still a `/present/` URL under the same `{server}/{hash}` as the slot | `rawAddress = trackedLocation ?? url`; a frame that left the root must not inherit its prefix | S:55 R:85 A:75 D:70 |
| 12 | Confident | Tile header meta (`surface-layout.tsx` `tileMeta`, uses `displayForm`) also shows the prefixed form | Not discussed; consistency with the address bar is the obvious default and trivially reversible | S:35 R:90 A:60 D:55 |
| 13 | Confident | The backend computes the full prefix string including the `repo:` label (frontend just joins; a trailing `:` joins without `/`) | Backend holds both roots; keeps frontend dumb; alternative is a structured `{repo, rel}` entry | S:45 R:70 A:60 D:50 |
| 14 | Confident | Cross-repo comparison uses the window's derived `GitRoot` (raw cwd when not in a repo) and the label is `filepath.Base(repoTop)` (a worktree shows its worktree folder name, e.g. `honest-merlin:`) | Follows existing `deriveGitRoot` semantics; worktree naming is a judgment call | S:40 R:80 A:55 D:45 |
| 15 | Certain | PR evidence: Playwright via `just` rig, Before/After, desktop + mobile, plus a shell recording since the web tile renders on both the iframe and native engines | Constitution § PR Evidence | S:90 R:85 A:95 D:90 |
| 16 | Certain | Tests: Go table tests for derivation (in-repo, toplevel, outside repo, worktree, cross-repo) and Vitest for `displayForm`/`presentDisplayBase`/`webTabTitle` | Discussed verification expectations; code-quality.md requires tests | S:90 R:90 A:90 D:90 |

16 assumptions (8 certain, 8 confident, 0 tentative, 0 unresolved).
