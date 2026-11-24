# Plan: Desktop-shell titlebar host strip — colour squares, host nameplate, and a lit band

**Change**: 261124-gwem-shell-strip-host-squares
**Intake**: `intake.md`

## Requirements

### Strip: Layout & Squares

#### R1: Left-aligned strip row replaces the centred host label
In the desktop shell (`isShell()`), `ShellTitlebarStrip` SHALL render a left-aligned row `[inset][key-hint pill][squares…][+][nameplate][inset]` instead of the centred `<host> ▾` trigger. Height stays 28px (`SHELL_STRIP_HEIGHT_PX` ↔ `STRIP_HEIGHT_PX`). `stripInsets()` returns an 80px left inset on darwin (a small gutter on the right) and the existing `env(titlebar-area-*)` expressions elsewhere. Popout windows (`title` prop) keep the static centred title with no squares/pill/nameplate. Below the switch gate (`stripSwitcherEnabled` false) there are no squares/pill and the nameplate shows the static name (`activeShellHostName ?? location.hostname`); the band still renders and drags.

- **GIVEN** the shell reports a non-empty host list **WHEN** the strip mounts **THEN** squares render left-aligned after the pill, followed by `+` and the nameplate
- **GIVEN** a popout window **WHEN** the strip mounts **THEN** only the centred static title renders
- **GIVEN** an older shell with no `servers` group **WHEN** the strip mounts **THEN** the nameplate shows the static host name and no squares/pill render

#### R2: Host squares
One square per shell host in shell list order, fixed 18×18px, plain fill in the host colour (hex-validated `accentColor`; this view's own host uses live `stripeHex`; neutral fallback when absent), NO monogram letters. The active square is marked by a ring (`box-shadow`), never by size; no hover scale. A background host with `waiting > 0` shows an amber 7×7 corner dot. Squares and the `+` square are `.rk-shell-no-drag` islands; the rest of the band (nameplate, pill gutter) stays `.rk-shell-drag`. A digit 1–9 renders inside a square only while hints show or while dragging; squares past the ninth never show a digit. The squares container is `role="toolbar"` `aria-label="Hosts"`; each square a `<button>` with `aria-label` (name, plus `, N waiting`) and `aria-current` on the active one.

- **GIVEN** three hosts, the second active **WHEN** rendered **THEN** three 18px squares in list order, the second carries the ring, no letters inside
- **GIVEN** a background host with waiting 2 **WHEN** rendered **THEN** its square carries the amber dot; the active host's never does

#### R3: Click switches; hover previews
Clicking a square SHALL call `switchShellServer(id)` (false → `"Host switch failed"` error toast); clicking the active square is a no-op. Hovering a square SHALL preview that host in the nameplate (dimmed `opacity .62`, name prefixed `→ `) without switching; leaving restores the active nameplate.

- **GIVEN** squares **WHEN** a non-active square is clicked **THEN** `switchShellServer` is called once with its id
- **WHEN** a square is hovered **THEN** the nameplate shows `→ <name>` dimmed; **WHEN** the pointer leaves **THEN** the active host's nameplate returns

#### R4: Drag & keyboard reorder
Gated on `canReorderShellHosts()`. Pointer-events drag with pointer capture, 4px threshold (below = click, above = drag and the trailing click is suppressed). While dragging every square shows its digit and digits renumber live; the dragged square follows the pointer clamped to the row; siblings shift by one slot (25px). Drop commits EXACTLY ONE `reorderShellHosts(id, toIndex)` when `toIndex !== fromIndex`, with optimistic local order; `false` → `"Shell host reorder failed"` toast + refetch. With a square focused, `⌥←`/`⌥→` moves it one slot per keypress (single commit each), focus follows, no wrap.

- **GIVEN** reorder capability **WHEN** a square is dragged past two slots and dropped **THEN** one `reorderShellHosts(id, 2)` call
- **WHEN** the pointer moves <4px **THEN** the gesture is a click (switches)
- **GIVEN** a focused square **WHEN** Alt+ArrowRight is pressed **THEN** one reorder commit with `index+1`; at the last slot nothing is committed

### Strip: Key hints

#### R5: Key-hint pill with reserved space and zero layout shift
A pill left of the squares reads `⌥⌘` (darwin) / `Alt` (else), `height:18px; padding:0 6px; border-radius:9px; font-size:10.5px`. Its space is ALWAYS reserved (`visibility:hidden` at rest; visible while the band is hovered, the chord is held, or dragging) — never `display:none`/conditional render. Holding the chord (`altKey && metaKey` on darwin, `altKey` elsewhere) or hovering the pill shows digits 1–9 in the squares; hold state clears on keyup and window blur. Square and nameplate bounding boxes MUST be identical at rest, on band hover, with the chord held, and with the pill hovered. The pill is a no-drag island with a `Tip` naming the switch chord and the focus chord.

- **GIVEN** the strip at rest **WHEN** the chord is held **THEN** digits appear in squares 1–9 and no square/nameplate box changes
- **WHEN** keyup or window blur fires **THEN** the digits hide

### Strip: Menu, focus chord, palette

#### R6: Host menu re-anchored; ⇧⌘H focuses the squares
The existing dropdown (rows, edit/remove/reorder cluster, `+ Add Host…`, remove confirm, `HostFormDialog`, digits/Delete/F2/⌥↑↓) SHALL be kept and re-anchored: it opens from the `+` square (add footer focused when an add path exists, else the active row) or right-click on a square (that row focused, anchored under the square). A new registry action `host-strip-focus` ("Focus host squares", default ⇧⌘H / ⇧Ctrl+H) moves focus to the active square (roving: ←/→, Home/End, Enter/Space switch, digits 1–9 switch, ⌥←/⌥→ reorder, Shift+F10/ContextMenu opens the menu at the square, Escape or a second chord returns focus). `host-menu-open` keeps its `Host: Switcher` palette entry and `HOST_MENU_OPEN_EVENT` seam with no default chord. The focus action is palette-registered (gated on a non-empty `useShellServers()`); the Shortcuts panel/overlay rows update.

- **GIVEN** the strip is mounted **WHEN** ⇧⌘H is pressed **THEN** the active square receives focus; **WHEN** pressed again **THEN** focus is released
- **WHEN** `+` is clicked **THEN** the menu opens with `+ Add Host…` focused; **WHEN** a square is right-clicked **THEN** it opens with that host's row focused

### Strip: Nameplate

#### R7: Nameplate fields, derivation, folding
Right of the squares: name (bold) · user@machine · OS+kind glyph · link · agents, separated by `·`. Kind derives from origin (loopback + port 3100–3199 → `tunnel`; other loopback → `local`; else `net`); link: `tunnel` → `ssh tunnel :<port>`, `local` → `local`, `net` → `tailscale` for `*.ts.net` else `lan`. `user@machine` = `${sshUser}@${health.hostname}` (prefix omitted without `sshUser`). Fields fold right-to-left (agents, link, OS+kind, user@machine); the name never folds (truncates). Folding is measurement-driven (ResizeObserver) and MUST NOT move the squares. Background hosts' preview data (`machine`, `os`, `agents`) comes from the additive `nameplate:set` report joined into `servers:list`; absent → name only.

- **GIVEN** `http://127.0.0.1:3142` **THEN** kind is tunnel, link `ssh tunnel :3142`; `http://127.0.0.1:3000` → local; `https://box.tail1234.ts.net` → tailscale; `http://10.0.0.5:3000` → lan
- **GIVEN** a narrow band **THEN** agents fold first, then link, OS+kind, user@machine; the name remains

#### R8: Server-side OS and agent count
`GET /api/health` SHALL gain an additive `os` field (`runtime.GOOS`) and `HealthResponse.os?` the client type; display maps `darwin`→`macOS`. The agent count is the number of tabs/windows with an agent (any rolled-up `agentState`: busy, waiting or idle) across attached workspaces, derived from existing SSE session data in `lib/waiting.ts`.

- **GIVEN** the health endpoint **THEN** the JSON includes `"os"` equal to `runtime.GOOS`
- **GIVEN** sessions with 2 agent windows and 1 plain window **THEN** the count is 2

### Strip: Lit band

#### R9: Band light effect
The band background SHALL be neutral chrome (`bgChrome`) with a treatment layer lit from the active square, keyed on `@property`-registered `--ax`/`--dx`/`--acc` (`--acc` = this host's `stripeHex`; `--ax` = active square centre x; `--dx` = last visible nameplate field right + 22px or `--ax + 40`). Treatments `glow` (default), `livery`, `halftone`, `hex`, `scan`, `edge`, `flat` are `rk-strip-fx-*` CSS in `globals.css`; textured treatments halo the nameplate text. Motion: `slide` (default, `@property` transition), `sweep` (slide + one-shot sweep highlight), `cut` (no transition); `prefers-reduced-motion: reduce` forces `cut`. No accent → no light. Cross-view slide: the shell tells the newly attached view the previous host id (additive attach event); absent signal → cut.

- **GIVEN** effect `glow` and an accent **THEN** the strip layer has class `rk-strip-fx-glow` and `--ax`/`--acc` are set
- **GIVEN** no accent **THEN** no treatment class is applied
- **GIVEN** reduced motion **THEN** motion resolves to `cut`

#### R10: Wash/stripe removed in the shell only; overlay colour
In `AppLayout` the 6.5% top-bar wash and 2px stripe render only when `!isShell()`; the browser is unchanged. In-shell the single theme-color writer emits neutral `bgChrome` when the strip effect is not `flat` (Windows/Linux overlay matches the neutral band end), and `titlebarHex` under `flat`.

- **GIVEN** the shell **THEN** no wash background/stripe renders on the top-bar wrapper; **GIVEN** a browser **THEN** both render

### Shell: prefs & live updates

#### R11: Strip prefs in the shell's own store
The shell SHALL persist `strip.effect` (`glow|livery|halftone|hex|scan|edge|flat`, default `glow`) and `strip.motion` (`slide|sweep|cut`, default `slide`) in `<userData>/prefs.json` via an electron-free `app/desktop/src/prefs.ts` (atomic tmp+rename write; corrupt/unknown → defaults). An optional `prefs` bridge group (`get`, `set(key,value)`, `onChange(handler)` → unsubscribe) follows the optional-invoker pattern: `false`/`null` on absence or rejection and NEVER throws. `prefs:set` is `isHostsSender`-gated and closed-set validated; main broadcasts a change event to every host view in every window.

- **GIVEN** no prefs file **THEN** defaults are glow + slide; **GIVEN** corrupt JSON **THEN** defaults
- **WHEN** `prefs.set("strip.effect","hex")` **THEN** it persists and every host view receives the change event

#### R12: Live projection updates
Main SHALL broadcast an additive `servers:changed` event to every host view whenever the store (add/remove/rename/reorder/set-url/accent) or a view-registry join input (`badge:set` count, `nameplate:set`) changes; the strip refetches `servers:list` on it (monotonic `listSeqRef` guard). Older shells: refetch on mount, window focus, and after own mutations. The `servers:list` projection gains additive optional `machine`, `os`, `agents`, and `current` (this view's host) fields, strict-when-present in `isShellServer`.

- **GIVEN** a `servers:changed` event **THEN** the strip refetches once
- **GIVEN** a projection with a wrong-typed `machine` **THEN** `isShellServer` rejects it

### Settings: This app & Host colour

#### R13: Settings → Appearance "This app" group
`AppearancePanel` SHALL gain a THIS APP scope group between This host and This device, rendered only in the shell and only when the prefs invokers exist: **Host strip effect** (single-select preview cards drawn with the real effect, keyboard reachable, `aria-pressed`) and **On switch** (three Control toggle chips). Reachable via the existing `Settings: Appearance` palette entry.

- **GIVEN** a shell with prefs **THEN** the group shows 7 effect cards and 3 motion chips; **GIVEN** a browser or older shell **THEN** the group is absent

#### R14: Host colour (host-owned) with a 9-hue set
The Appearance accent row SHALL be presented as **Host color** over a 9-hue inline swatch set written via `familyToLegacy`: purple `1+4`, violet `4+5`, blue `4`, red `1`, green `2`, teal `6`, magenta `5`, slate `3+4`, amber `3`, plus Clear. `HUE_FAMILIES` gains `{ name: "violet", hue: 270, legacy: "4+5" }` (11 families). Out-of-set stored values snap to the nearest set hue for display without rewriting. The HOST-panel picker narrows to the same set. In the shell only, a swatch whose hue another host already uses is labelled with that host's monogram, with an advisory (never blocking) "Same color as …" warning; "used by" classifies other hosts' projected `accentColor` hex by nearest OKLCH hue (low chroma → slate).

- **GIVEN** stored `1+3` **THEN** display snaps to the nearest of the 9 and storage is untouched
- **GIVEN** another host uses blue and the user picks blue **THEN** the swatch is labelled with that host's monogram and the advisory shows, and the pick still applies

### Tests & Evidence

#### R15: Tests and PR evidence
Pure helpers have vitest coverage; the strip component has vitest coverage per R1–R6; `prefs.ts` has node:test coverage; the no-shift requirement is covered by a shell e2e spec measuring bounding boxes; a `just demo` shell spec exists under `app/desktop/tests/demo/`. Every Playwright `test()` carries the Proves/Steps JSDoc block and each spec file a setup header. All bridge invokers follow the optional-invoker pattern and never throw.

- **GIVEN** the e2e spec **THEN** square and nameplate boxes are equal at rest, hover, chord-held and pill-hover

### Non-Goals
- Browser placement of squares; crumb dedupe / Refresh to overflow; per-device/per-app host colours; overflowing squares into `+` past a count.

### Design Decisions

#### Fixed-size squares with ring, reserved pill space
**Decision**: 18px fixed squares, active = ring, pill space always reserved via `visibility`.
**Why**: Guarantees zero layout shift on hover/chord.
**Rejected**: Growing squares on hover (layout shift); conditionally rendered pill.
*Introduced by*: 261124-gwem-shell-strip-host-squares

#### Strip prefs in the shell store
**Decision**: `strip.effect`/`strip.motion` live in `<userData>/prefs.json`, broadcast to every host view.
**Why**: Each host is a separate origin in the shell, so localStorage would not follow host switches; the effect belongs to the app, not a host's config.yaml.
**Rejected**: localStorage; host `config.yaml`.
*Introduced by*: 261124-gwem-shell-strip-host-squares

## Tasks

### Phase 1: Foundations (shared data & pure helpers)

- [x] T001 [P] Add `os` (`runtime.GOOS`) to the `/api/health` response in `app/backend/api/` (+ Go test) and `os?: string` to `HealthResponse` in `app/frontend/src/api/client.ts` <!-- R8 -->
- [x] T002 [P] Add violet `{ name: "violet", hue: 270, legacy: "4+5" }` to `HUE_FAMILIES` in `app/frontend/src/themes.ts` and fix count-sensitive tests/layouts <!-- R14 -->
- [x] T003 [P] Create `app/desktop/src/prefs.ts` (+ `prefs.test.ts`): defaults, closed-set validation, atomic load/save of `<userData>/prefs.json` <!-- R11 -->
- [x] T004 Extend `app/frontend/src/lib/shell-strip.ts` (+ `shell-strip.test.ts`): new `stripInsets`, kind/link derivation, monogram, pill label/tip, nameplate field model + fold order, reorder index math, light-geometry helpers, prefs value parsing, effect/motion constants <!-- R1 R5 R7 R9 --> <!-- rework: delete zero-call-site TEXTURED_STRIP_EFFECTS (shell-strip.ts:430); drop the double-counted NAMEPLATE_SEPARATOR_PX in visibleFieldCount (the ::before separator is already inside each field width) + update shell-strip.test.ts expectations -->
- [x] T005 [P] Create `app/frontend/src/lib/host-colors.ts` (+ test): 9-hue Host color set, snap-to-nearest, used-hue classification by OKLCH hue <!-- R14 -->
- [x] T006 [P] Add agent-count derivation to `app/frontend/src/lib/waiting.ts` (+ test) <!-- R8 -->

### Phase 2: Desktop shell (main process)

- [x] T007 Extend `app/desktop/src/views.ts` (+ tests) with in-memory nameplate fields on `ViewEntry` and `setViewNameplate`; extend `app/desktop/src/hosts.ts` `HostInfo` with optional `machine`/`os`/`agents`/`current` <!-- R7 R12 -->
- [x] T008 Wire `app/desktop/src/main.ts`: `prefs:get`/`prefs:set` + broadcast, `nameplate:set`, `servers:list` join, `servers:changed` broadcast on store/registry changes, attach event carrying the previous host id <!-- R11 R12 R9 -->
- [x] T009 Expose `prefs`, `nameplate`, `onChanged`/`onAttach` subscriptions in `app/desktop/src/preload.ts` <!-- R11 R12 R7 R9 -->

### Phase 3: Frontend bridge

- [x] T010 Extend `app/frontend/src/lib/shell.ts` (+ tests): `ShellServer` optional fields strict-when-present, prefs invokers + subscription, nameplate report, `servers:changed` and attach-event subscriptions — all optional-invoker, never throw <!-- R11 R12 R7 R9 -->
- [x] T011 Add a prefs context/hook (`app/frontend/src/hooks/use-strip-prefs.ts`) exposing effect, motion (reduced-motion → cut), defaults when the bridge is absent <!-- R9 R11 -->

### Phase 4: Strip UI

- [x] T012 Add `@property` registrations, `rk-strip-fx-*` treatments, halo, sweep keyframes, square/pill utility classes to `app/frontend/src/globals.css` <!-- R9 R2 R5 --> <!-- rework: uncoloured square uses the intake-specified neutral color-mix(text-secondary 35%) fill so it is distinct from the + square -->
- [x] T013 Create `components/desktop-shell/host-menu.tsx` (extract the dropdown from `titlebar-strip.tsx`, keep behavior, anchor-prop driven) <!-- R6 -->
- [x] T014 Create `components/desktop-shell/host-squares.tsx` (squares, `+`, waiting dot, drag/keyboard reorder, roving focus) <!-- R2 R3 R4 R6 -->
- [x] T015 Create `components/desktop-shell/nameplate.tsx` and `key-hint-pill.tsx` (fields, fold, preview, pill + Tip, chord hold) <!-- R5 R7 --> <!-- rework: nameplate fold measure — clone must include the peek "→ " prefix; align with the de-duplicated separator width -->
- [x] T016 Rewrite `components/desktop-shell/titlebar-strip.tsx` composing the above; light-geometry measurement; no-shift layout; popout/older-shell branches <!-- R1 R9 --> <!-- rework: attach handler restores --rk-acc to this host stripeHex after seating the previous host, so the cross-view slide does not depend on the servers:changed re-render timing -->
- [x] T017 Create `components/desktop-shell/nameplate-reporter.tsx` (health + agent count → `nameplate:set`) and mount it in `app.tsx`; gate wash/stripe on `!isShell()` <!-- R7 R10 --> <!-- rework: use-host-nameplate omits machine when hostname is empty (an empty machine makes views.ts drop the whole report) -->
- [x] T018 Add `host-strip-focus` to `lib/keybindings.ts`, retarget ⇧⌘H, make `host-menu-open` palette-only, register palette entry in `use-global-palette-actions.ts`, update `settings-shortcuts-panel.tsx` rows <!-- R6 -->
- [x] T019 In-shell theme-color neutral under non-flat effect (`instance-accent.ts` / its context consumer) <!-- R10 -->

### Phase 5: Settings

- [x] T020 Add "This app" group (effect cards, motion chips) and Host color row/swatch set to `settings-dialog.tsx`; narrow the HOST-panel picker to the 9-hue set <!-- R13 R14 -->

### Phase 6: Tests & evidence

- [x] T021 Component tests: update `titlebar-strip.test.tsx` and add squares/nameplate/pill/menu tests; settings-dialog tests for This app + Host color <!-- R1 R2 R3 R4 R5 R6 R13 R14 --> <!-- rework: fix stale titlebar-strip.test.tsx:118 helper doc; cover the acc restore and fold-width fixes -->
- [x] T022 Shell e2e `app/desktop/tests/e2e/strip-no-shift.spec.ts` (bounding-box equality at rest/hover/chord/pill hover) with intent comments <!-- R5 R15 -->
- [x] T023 Shell demo spec `app/desktop/tests/demo/shell-strip-host-squares.demo.ts` <!-- R15 -->
- [x] T024 Run `just test-backend`, `just test-frontend`, desktop node tests, and typecheck; fix failures <!-- R15 --> <!-- rework: re-run gates after the fixes -->

## Execution Order

- T004 blocks T014, T015, T016
- T010 blocks T011, T014–T017, T020
- T012 blocks T016
- T013 and T014 and T015 block T016

## Acceptance

### Functional Completeness

- [x] A-001 R1: Shell strip renders the left-aligned row; popout and older-shell branches behave as specified
- [x] A-002 R2: Squares render per spec (18px, ring, dot, no letters, islands, ARIA)
- [x] A-003 R3: Click switches and hover previews without switching
- [x] A-004 R4: Drag commits exactly one reorder; ⌥←/⌥→ reorders; failure toasts + refetches
- [x] A-005 R5: Pill space is reserved and the chord/pill-hover reveals digits
- [x] A-006 R6: `+`/right-click open the menu; ⇧⌘H focuses squares with the roving keys; palette + shortcuts updated
- [x] A-007 R7: Nameplate fields, kind/link derivation and right-to-left folding work; background preview fields join via `nameplate:set`
- [x] A-008 R8: `/api/health` carries `os`; agent count derived from SSE data
- [x] A-009 R9: Seven treatments, three motions, reduced-motion cut, cross-view slide signal
- [x] A-010 R10: Wash/stripe gated to non-shell; theme-color neutral under non-flat in the shell
- [x] A-011 R11: Prefs store + bridge group + broadcast
- [x] A-012 R12: `servers:changed` drives refetch; additive projection fields validated
- [x] A-013 R13: This app group present only in the shell with invokers
- [x] A-014 R14: 9-hue Host color set, violet family, snap-to-nearest, used-hue labels + advisory

### Behavioral Correctness

- [x] A-015 R5: Square and nameplate boxes are identical at rest, band hover, chord held, pill hover
- [x] A-016 R10: Browser behaviour unchanged (wash/stripe/PWA tint)

### Removal Verification

- [x] A-017 R1: The centred `<host> ▾` trigger and "single no-drag island" claims are gone from code and comments

### Scenario Coverage

- [x] A-018 R15: Vitest, node:test, e2e and demo specs exist and cover the scenarios above

### Edge Cases & Error Handling

- [x] A-019 R11: Every new bridge invoker returns false/null on absence, rejection or malformed payloads and never throws
- [x] A-020 R4: Without the reorder invoker squares do not drag and click still switches

### Code Quality

- [x] A-021 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [x] A-022 No unnecessary duplication: Existing utilities reused where applicable
- [x] A-023 No god functions: the strip is split into focused components (no >50-line functions without reason)
- [x] A-024 No magic numbers/strings: named constants for geometry, MIME-less channel names, closed sets
- [x] A-025 No polling: live updates ride events/SSE, not intervals
- [x] A-026 Comment hygiene: comments state constraints, never narrate history or cite change IDs
- [x] A-027 Type narrowing over assertions in new frontend code

## Notes

- Check items as you review: `- [x]`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Prefs/nameplate/attach/changed IPC channels are `prefs:get`/`prefs:set`/`prefs:changed`, `nameplate:set`, `servers:changed`, `strip:attached` | Matches existing `group:verb` channel naming | S:60 R:80 A:75 D:60 |
| 2 | Confident | `current?: boolean` projection field marks the sender view's host; strip uses it before `active` | Intake assumption #18 proposal; falls back on older shells | S:55 R:75 A:70 D:60 |
| 3 | Tentative | Whether bare-Alt reveals the native menu bar on Win/Linux is not handled specially: reveal is keydown-while-held and clears on keyup/blur | Intake Open Question; no platform to verify here | S:35 R:70 A:45 D:40 |
| 4 | Tentative | Band-hover reveal is driven by a hover sensor on the non-drag strip wrapper area plus the islands' own pointer events | Intake Open Question on drag-region hover delivery | S:35 R:70 A:45 D:40 |
| 5 | Confident | Many hosts: squares never shrink and never overflow; the row clips at the nameplate | Intake Open Question; simplest consistent behaviour | S:50 R:80 A:65 D:55 |

| 6 | Confident | The popout and older-shell (no switcher) bands keep today's flat accent tint (`titlebarHex`) rather than the neutral band + light | Neither has an active square to light from; the tint keeps the identity cue they have today | S:55 R:80 A:70 D:60 |
| 7 | Confident | The `+` / right-click openers refetch `servers:list` on every menu open, in addition to the push/focus refresh | Preserves the existing open-time refetch contract (native Remove mutates the list without a push on older shells) | S:60 R:85 A:75 D:65 |
| 8 | Confident | Violet needs backend support: `violet` joins the closed colour-name set in `internal/validate` and `internal/icontint` (hexes frozen from the default-dark palette) | The shared picker writes `violet-light`/`violet-dark`, and the backend validates every stored colour | S:65 R:75 A:80 D:70 |
| 9 | Confident | The HOST-panel picker narrows through a `hostColorSet` prop on `SwatchPopover` (one row of the nine hues, normal shade), while Settings gets a dedicated inline `HostColorControl` | Keeps the popover's preview/clear/keyboard model while giving Settings the inline swatch row the intake specifies | S:60 R:80 A:75 D:65 |
| 10 | Confident | In the shell, a stored colour outside the Host color set is snapped in `InstanceAccentProvider` (strip square, light, reported edge colour, HOST-panel tint); the stored value and the localStorage echo are untouched | One display seam keeps every shell surface consistent without rewriting config | S:60 R:80 A:70 D:60 |
| 11 | Confident | Prefers-reduced-motion needs no CSS media query for the strip: the strip resolves `cut` in JS (`effectiveMotion`), so no transition class or sweep ever applies | The flair compositing lint pins the first reduced-motion block to flair rules; JS resolution is the single source | S:55 R:85 A:75 D:65 |

11 assumptions (0 certain, 8 confident, 3 tentative).

## Deletion Candidates

- `app/frontend/src/globals.css:420` `var(--rk-sq, …)` — `--rk-sq` is never set (squares colour via inline `backgroundColor`), so the custom-property indirection is dead and `.rk-strip-sq-uncolored`'s `background` (globals.css:435) repeats the same fallback value
