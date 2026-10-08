# Intake: `easter_eggs` setting — a registry switch to turn the screen-break Easter eggs off

**Change**: 260916-hn6s-easter-eggs-setting
**Created**: 2026-09-16

## Origin

Promptless dispatch from a `/fab-discuss` session on 2026-09-16, after phase 1 (kp2l, PR #985) and phase 2 (23xd, PR #992) of the screen-break Easter eggs merged. The user's raw ask:

> add a setting to turn 'off' easter eggs. In case someone finds it distracting. (On by default)

and, when the palette question came up:

> The pal[ette] entry should remain even when the setting is off.

Design points agreed in that discussion (carried here verbatim as decisions, not re-opened):

- **One settings-registry key, per-instance** — stored in `~/.config/run-kit/config.yaml` behind the `internal/settings` registry, NOT a per-viewer localStorage preference. "Someone finds it distracting" is about the box, and only registry keys get a row in the single settings surface (Constitution IV — no second settings surface).
- **The palette entries keep working when the setting is off.** `Easter egg: Smash` / `Easter egg: Peek` are explicit intent; they already fire with `force: true`, which bypasses the once-per-identity gate — they bypass this gate too. Only the AUTOMATIC triggers (the fist on the viewed window's PR flipping to merged; the eye on the update chip lighting) are switched off.
- **Default ON.**

Interaction mode: conversational discussion, then a one-shot intake dispatch with `promptless-defer` questioning (no questions asked; would-be questions land as Unresolved rows).

## Why

**Problem.** The screen-break Easter eggs are a 12 s, full-viewport, motion-heavy event that fires on its own — a merged PR on the viewed tab, or the update chip lighting. Phase 1/2 deliberately gave it no off switch beyond the OS-level `prefers-reduced-motion`, which is a blunt instrument: a user who likes motion elsewhere but finds the eggs distracting at work (a demo, a shared screen, a focused session) has no way to keep the dashboard calm without disabling motion system-wide.

**Consequence of not fixing.** The only escape is reduced-motion or a code change. Once-per-identity keeps the eggs from repeating, but every new merge and every new release still fires them on every host. For a tool aimed at daily driving, a joke you cannot turn off stops being a joke.

**Why this shape.**

- *Registry key over localStorage:* the complaint is per-box ("this instance is used at work"), and Constitution IV fixes exactly one settings surface — the registry-driven dialog. A localStorage flag would either be invisible (no row) or need a second per-viewer control, which the constitution forbids. The registry already has the `bool` template (`auto_name`, `cron_ticker`, `gui.enabled`), the All-settings table renders any `ui: true` key generically, and the General tab already hosts one curated `bool` row (`Auto-name tabs`) to model on.
- *Palette bypasses the gate:* the palette entries are the user reaching for the egg on purpose. The eggs' own design decision "force writes nothing and bypasses identity" already treats `force` as "explicit intent, skip the automatic-occasion bookkeeping"; the enabled gate is one more piece of that bookkeeping. Keeping the entries also keeps Constitution V intact — the palette stays the complete action registry, and nothing is hidden behind a setting.
- *Frontend-read `live: true` key, no SSE, no polling:* the value is consumed only by the browser's trigger hook. The theme keys already set the posture — one GET on mount, apply live in the browser that flipped it, other browsers pick it up on reload. A dedicated SSE event or a poll would be surface for a setting that changes a few times a year.
- *Not writing identity while disabled:* the triggers only fire on OBSERVED transitions (the first observation of a merged window never fires; the peek chip fires on `showChip` going true or a key change). So a merge that happened while eggs were off is not replayed later: re-enabling cannot resurrect an old occasion, and nothing needs to be consumed to prevent it. The gate can therefore be a pure early return.

## What Changes

### 1. Backend — registry entry `easter_eggs`

`app/backend/internal/settings/settings.go`:

- `Settings` gains a field, documented like its siblings:

  ```go
  // EasterEggs shows the screen-break Easter eggs' AUTOMATIC occasions (the
  // fist when the viewed tab's PR merges, the eye when an update chip lights).
  // On by default. Read by the frontend on page load and applied live in the
  // browser that flips it; the palette's explicit Easter egg entries ignore it.
  EasterEggs bool
  ```

- `Default()` sets `EasterEggs: true` (alongside `CronTicker: true`).
- A registry entry modelled exactly on `cron_ticker`, inserted **right after `cron_ticker` and before `gui.enabled`** so the behavior toggles sit together in registry order:

  ```go
  {
      key: "easter_eggs", kind: "bool", def: "true",
      desc:     "Shows the screen-break Easter eggs: the fist when the viewed tab's PR merges, the eye when an update is available. Off hides the automatic ones; the palette's Easter egg entries still work.",
      category: "behavior", ui: true, live: true,
      // Tolerant read: any strconv.ParseBool value; anything else keeps the
      // default (on) — the safe direction for a cosmetic default-on feature.
      parse: func(s *Settings, value string) {
          if b, err := strconv.ParseBool(strings.Trim(value, "\"")); err == nil {
              s.EasterEggs = b
          }
      },
      serialize: func(s *Settings) string {
          if !s.EasterEggs {
              return "easter_eggs: false\n"
          }
          return ""
      },
      read:  func(s *Settings) any { return s.EasterEggs },
      apply: boolValue(func(s *Settings) *bool { return &s.EasterEggs }, true),
  },
  ```

  Serialize is omit-when-default: `easter_eggs: false\n` appears in `config.yaml` only when off, so existing files stay byte-identical. `apply` via `boolValue(..., true)`: JSON `true`/`false` sets, `null` resets to on. Update the `boolValue` doc comment's example list if it enumerates keys (`(auto_name, cron_ticker)`).

- **No side effect in `POST /api/settings`** (`app/backend/api/settings.go`): no hub call, no daemon call, no SSE event. It is a `live: true` key read by the frontend, like `theme`. The handler's `hasAutoName` / `hasGUIEnabled` branches are untouched.

**Go tests:**

- `app/backend/internal/settings/registry_test.go`: `TestRegistry_orderAndMetadata`'s `wantKeys` gains `"easter_eggs"` after `"cron_ticker"`; the metadata `checks` table gains `{"easter_eggs", "bool", "true", "behavior", true, true, nil}`; the default-value cases gain `{"easter_eggs", true}` (the registry becomes 18 keys).
- `app/backend/internal/settings/settings_test.go`: the round-trip `fixtures` map gains `"easter_eggs": registryValueFixture(`false`, false, `true`, true, true)`; a `TestEasterEggs` mirroring `TestCronTicker` — `Default().EasterEggs` is true; a file without the key parses to true; each `strconv.ParseBool` spelling (`true`/`false`/`yes`… whatever `TestCronTicker` iterates) round-trips; garbage (`easter_eggs: yes-please`) keeps true; `EasterEggs=false` survives `parse(serialize(s))`; `EasterEggs=true` emits no `easter_eggs` line. Existing `Settings{…, CronTicker: true}` literals in serialize-byte-identity tests need `EasterEggs: true` added wherever the test asserts an exact serialized output (otherwise the new `false` default in a bare struct literal would emit `easter_eggs: false`) — read each and fix the fixture, not the serializer.
- `app/backend/api/settings_test.go`: `wantKeys` gains `"easter_eggs"` after `"cron_ticker"` (GET returns 18 entries); a shape assertion on the entry: `Kind == "bool"`, `Default == "true"`, `Value == true`, `Options` empty/nil.

### 2. Frontend store gate — `screen-break-store.ts`

`app/frontend/src/lib/screen-break-store.ts` gains module state and two exports:

```ts
let enabled = true;

/** Flip the automatic occasions. Palette (`force`) fires ignore this. */
export function setEasterEggsEnabled(v: boolean): void { enabled = v; }
export function easterEggsEnabled(): boolean { return enabled; }
```

`fire()` gains one gate, placed **after** the reduced-motion, viewport, and in-flight checks and **before** the identity block:

```ts
export function fire(egg: ScreenBreakEgg, opts?: { force?: boolean; identity?: string }): boolean {
  if (prefersReducedMotion()) return false;
  if (typeof window === "undefined" || window.innerWidth < MIN_VIEWPORT_WIDTH) return false;
  if (state.flight) return false;
  if (!enabled && !opts?.force) return false;   // no identity write — nothing is consumed
  const identity = opts?.identity;
  if (!opts?.force && identity) { … unchanged … }
  …
}
```

`_resetForTests()` also resets `enabled = true`. The module doc comment and the `fire` JSDoc list the new gate among the "returns false with no side effects" cases and state the constraint: a disabled non-force fire writes no identity, because the triggers fire only on observed transitions so nothing needs consuming; re-enabling later cannot replay an old occasion.

A flight already in progress when the setting flips off is **not** cancelled — it finishes its 12 s timeline. The gate governs starting, not running.

### 3. Frontend value feed — two paths, no polling, no SSE change

**Initial value — `ScreenBreakController`** (`app/frontend/src/components/screen-break.tsx`). The controller currently mounts the triggers hook and renders the layer. It gains a mount effect:

```tsx
export function ScreenBreakController() {
  useEffect(() => {
    let cancelled = false;
    getSettingsEntries()
      .then((entries) => {
        if (cancelled) return;
        const entry = entries.find((e) => e.key === "easter_eggs");
        setEasterEggsEnabled(entry === undefined || entry.value !== false);
      })
      .catch(() => { /* fetch failure keeps the store enabled (default on) */ });
    return () => { cancelled = true; };
  }, []);
  useScreenBreakTriggers();
  return <ScreenBreak />;
}
```

Exactly one GET per page load — the same posture as the theme context's mount fetch (`getSettingsEntries` rides `deduplicatedFetch`, so a concurrent settings-dialog fetch shares the request). A missing key or a rejected fetch leaves the store enabled. The `entry.value !== false` narrowing is a type guard, not an `as` cast. Other browsers observe a flip on their next reload — accepted and documented (matches `theme`).

**Live flip in the same browser — `settings-registry-seam.ts`.** `commitSetting` gets a key-specific case next to `gui.enabled`:

```ts
case "easter_eggs": {
  await postSettings({ easter_eggs: value });
  updateEntryValue("easter_eggs", value);
  // The trigger hook reads the store, not the fetched list — mirror the
  // committed value so the next automatic occasion respects the toggle
  // without a reload. null (unset) restores the registry default: on.
  setEasterEggsEnabled(value !== false);
  return;
}
```

This is a write-side hook like `gui.enabled`, not a read-side mirror: the read path stays the fetched list (`entriesWithMirrors` is not touched). Import `setEasterEggsEnabled` from `@/lib/screen-break-store`. A rejected POST throws out of the `await` before the store setter runs, so a failed commit changes nothing client-side (matching the `ssh_host` case); the General-tab `BoolToggle` surfaces the error the way it does for `auto_name`.

### 4. Settings dialog — General → This host row

`app/frontend/src/components/settings-dialog.tsx`, `GeneralPanel`, inside the `This host` section's `divide-y` list, **directly after the `Auto-name tabs` row**:

```tsx
const easterEggsEntry = registry.entries.find((e) => e.key === "easter_eggs");
…
<PreferenceRow
  label="Easter eggs"
  sublabel={easterEggsEntry?.description}
  htmlFor="settings-easter-eggs"
>
  <BoolToggle
    id="settings-easter-eggs"
    label="Easter eggs"
    on={registry.settingValue("easter_eggs") !== false}
    commit={(on) => registry.commitSetting("easter_eggs", on)}
  />
</PreferenceRow>
```

`!== false` (not `=== true`) so the toggle reads ON before the fetch resolves and when the key is absent — the default-on posture. The sublabel is the registry description verbatim (single source of the wording).

**All-settings tab** (`settings-all-panel.tsx`): nothing to add. The table renders every `ui: true` entry generically — `data-testid="setting-row-easter_eggs"`, a `BoolToggle` with `id="setting-easter_eggs"` and switch name `easter_eggs`, grouped under the title-cased `Behavior` header with `auto_name`/`cron_ticker`/`gui.*`. Verify by reading, not by editing.

### 5. Tests

**Vitest (colocated):**

- `app/frontend/src/lib/screen-break-store.test.ts`: (a) `setEasterEggsEnabled(false)` → `fire("smash", { identity: "1" })` returns `false` and `localStorage[SMASH_KEY]` stays unset; (b) disabled + `fire("smash", { force: true })` returns `true` and writes nothing; (c) `setEasterEggsEnabled(true)` after (a) → the same identity fire returns `true` and writes the identity (nothing was consumed); (d) `_resetForTests()` restores `easterEggsEnabled() === true`.
- `app/frontend/src/components/screen-break.test.tsx`: a `ScreenBreakController` block with `vi.mock("@/api/client")` — `getSettingsEntries` resolving `[{ key: "easter_eggs", value: false, … }]` flips `easterEggsEnabled()` to false after mount; resolving `[]` leaves it true; rejecting leaves it true. The trigger hook's contexts (`useMatches`, `SessionContext`, `useUpdateNotification`) need the same mocks `use-screen-break-triggers.test.tsx` uses — reuse its pattern.
- `app/frontend/src/components/settings-dialog.test.tsx`: with `getSettingsEntries` resolving the `easter_eggs` entry (value `true`), General renders a switch labelled `Easter eggs` with the registry description as sublabel, checked; clicking it calls `postSettings({ easter_eggs: false })`. With the entry absent, the switch renders checked (default-on).
- `app/frontend/src/components/settings-registry-seam.test.tsx`: `vi.mock("@/lib/screen-break-store")` — `commitSetting("easter_eggs", false)` posts `{ easter_eggs: false }`, updates `settingValue("easter_eggs")` to `false`, and calls `setEasterEggsEnabled(false)`; `commitSetting("easter_eggs", null)` calls `setEasterEggsEnabled(true)`.

**Go:** as in § 1.

**e2e (`app/frontend/tests/e2e/`):**

- `settings-dialog.spec.ts` — read the All-settings Behavior-category test (`the All-settings tab toggles auto_name through the live API…`). It searches `log`, asserts `setting-row-auto_name` is gone and the `Behavior` header is emptied. The new key's name, description, and category contain no `log` substring, so that assertion keeps holding; no companion expectation is required there. **Add one test** mirroring that one for the General tab: open Settings, click the `Easter eggs` switch (`#settings-easter-eggs`), `expect.poll` GET `/api/settings` until `easter_eggs` reads `false`, click again, poll back to `true` — restored in a `finally` so the per-run temp config root is left as found. Carries the constitution's Proves/Steps JSDoc.
- `screen-break.spec.ts` — unchanged; the palette path must still mount the layer (it is `force`).

**Gates (all through `just`):** `just test-backend`, `just test-frontend` (full Vitest — not a scoped file run), `just test-e2e settings-dialog.spec`, `just test-e2e screen-break.spec`. On this machine every shell runs inside tmux while CI has no `$TMUX`, so the backend gate MUST be run with the tmux variables unset — `env -u TMUX -u TMUX_PANE just test-backend` — so that precondition-guarded tests behave as they will on CI; a test that passes only with `$TMUX` set is a defect, not a flake.

### 6. Docs (hydrate's job — apply touches no `docs/memory/` file)

- `docs/memory/run-kit/configuration.md`: the inventory table gains the `easter_eggs` row (bool, `true`, behavior, ui yes, live yes, "read by the frontend on page load; the palette's Easter egg entries ignore it"); "17-key inventory" in the frontmatter description and § Settings Registry becomes 18; § Settings HTTP API's `auto_name` as-a-bool example may name the new bool too; "No other key has a side effect" stays true.
- `docs/memory/run-kit/ui/screen-break-eggs.md`: § The store lists the enabled gate (position, no identity write, `setEasterEggsEnabled`/`easterEggsEnabled`, `_resetForTests` reset); § Triggers notes the controller's mount fetch; § Palette entries states the `force` bypass of this gate; § Tests names the new cases; a Design Decisions entry "Disabled fires write no identity" with the observed-transition rationale.
- `docs/memory/run-kit/ui/dialogs-and-state.md`: the General → This host row list gains `Easter eggs`; the seam paragraph's write-routing sentence gains the `easter_eggs` store-mirror case beside `gui.enabled`.
- No spec change (`docs/specs/`), no wiki page.

### 7. Click-to-dismiss (added in flight, after review, at the user's request)

User: "Do you think one should be able to dismiss the easter egg by clicking on it twice (once might be a mistake)" → agreed design: a **single click on the creature** (fist or eye) dismisses; the layer itself stays pointer-transparent; no double click (a zoom gesture on touch, and it doubles the intercepted input), no Escape (keys belong to the tmux pane). Implementation: `dismiss()` in the store stamps `dismissedAt`; the layer's frame loop compresses the remaining timeline at 3× from the retreat curve at the sprite's current emerge amount (~1.4 s heal, never a cut); `.rk-sb-sprite svg *` gets `pointer-events: visiblePainted; cursor: pointer`; the inactive creature slot is `visibility: hidden` per frame so only the visible creature is hit-testable. User: "Instead of another change - just add as another commit to the current PR you are working on."

### Out of scope

Any change to the eggs' geometry, timeline, trigger transition logic, or sprites; an env form for the key (preference keys have none — Constitution IV); an SSE broadcast for the key; a per-viewer localStorage override; cancelling an in-flight flight on flip.

### Constraints

Constitution II (state derived from `config.yaml` at request time — the registry IS that path), IV (one registry-driven settings surface; no env form), V (the palette remains the chord and keeps both entries). Code-quality: no client polling (one mount GET, never `setInterval`); type narrowing over `as`; comments state constraints only — no PR numbers or change IDs; tests through `just` recipes only; new behavior carries tests.

## Affected Memory

- `run-kit/configuration`: (modify) inventory table gains `easter_eggs`; 17 → 18 keys in the frontmatter description and § Settings Registry
- `run-kit/ui/screen-break-eggs`: (modify) § The store — the enabled gate and its no-identity-write rule; § Triggers — the controller mount fetch; § Palette entries — `force` bypasses the gate; § Tests; a Design Decisions entry
- `run-kit/ui/dialogs-and-state`: (modify) General → This host gains the `Easter eggs` row; the seam's write-routing gains the `easter_eggs` store-mirror case

## Impact

- **Backend:** `app/backend/internal/settings/settings.go` (struct field, `Default()`, one registry entry); tests in `internal/settings/registry_test.go`, `internal/settings/settings_test.go`, `api/settings_test.go`. No handler change. `GET /api/settings` grows by one entry; the frontend's `SettingsEntry[]` consumers are list-driven and unaffected.
- **Frontend:** `src/lib/screen-break-store.ts` (gate + two exports), `src/components/screen-break.tsx` (mount fetch), `src/components/settings-registry-seam.ts` (commit case), `src/components/settings-dialog.tsx` (General row); tests in the four colocated test files plus one e2e test in `tests/e2e/settings-dialog.spec.ts`.
- **Behavior:** default-on, so an unchanged `config.yaml` behaves exactly as today. Off: automatic smash/peek never start and consume no identity; palette entries unchanged; other browsers see the flip on reload.
- **Dependencies/systems:** none new. No SSE, no tmux, no daemon involvement.

## Open Questions

- None blocking. The e2e addition (§ 5) is a judgment call recorded in Assumptions, not a question.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | One per-instance registry key `easter_eggs` in `internal/settings`, not a localStorage preference | Discussed — user chose the box-level switch; Constitution IV allows only the registry-driven surface | S:95 R:70 A:95 D:95 |
| 2 | Certain | Palette `Easter egg: Smash`/`Peek` keep working when off; only automatic triggers are gated (`force` bypasses) | Discussed — user: "The palette entry should remain even when the setting is off"; matches the existing force-bypass design | S:95 R:90 A:95 D:95 |
| 3 | Certain | Default ON (`def: "true"`, `Default().EasterEggs = true`, omit-when-default serialize) | Discussed — user: "(On by default)"; `cron_ticker` is the exact template | S:95 R:90 A:95 D:95 |
| 4 | Certain | Registry slice position right after `cron_ticker`, before `gui.enabled` | Keeps behavior bools adjacent in GET order and the All-settings Behavior group; only ordering tests move | S:70 R:95 A:85 D:75 |
| 5 | Certain | No `POST /api/settings` side effect (no hub/daemon/SSE) — a `live: true` key read by the frontend | Only consumer is the browser trigger hook; `theme` sets the same posture; an SSE event would be surface for a rarely-flipped cosmetic key | S:80 R:85 A:85 D:80 |
| 6 | Certain | Store gate returns `false` with no identity write when disabled and not forced, placed after the in-flight check and before the identity block | Triggers fire only on observed transitions, so nothing needs consuming and re-enabling cannot replay; placement keeps all "no side effect" returns together | S:80 R:90 A:85 D:80 |
| 7 | Confident | Initial value via one `getSettingsEntries()` GET in `ScreenBreakController`'s mount effect; failure or missing key keeps enabled | Mirrors the theme context's mount fetch; `deduplicatedFetch` shares a concurrent dialog fetch; no polling per code-quality | S:80 R:85 A:80 D:70 |
| 8 | Confident | Same-browser live flip via a key-specific `easter_eggs` case in `commitSetting` calling `setEasterEggsEnabled(value !== false)` after the POST; cross-browser flips apply on reload | The `gui.enabled` case is the precedent for a write-side hook; the read path stays the fetched list; reload-only propagation matches `theme` and is documented | S:80 R:85 A:80 D:70 |
| 9 | Certain | General → This host row `Easter eggs` (`settings-easter-eggs`) directly after `Auto-name tabs`, sublabel = registry description, `on = value !== false` | `auto_name` is the one curated bool row to model on; `!== false` gives the default-on read before the fetch resolves | S:75 R:95 A:85 D:75 |
| 10 | Confident | A flight already running when the setting flips off finishes its 12 s timeline; the gate governs starting only | Description silent; cancelling mid-flight needs teardown plumbing for a case that lasts 12 s once, and the layer's cleanup contract is built around natural completion | S:40 R:90 A:80 D:70 |
| 11 | Confident | Add one e2e test in `settings-dialog.spec.ts` (General toggle → GET persistence → restore) beyond running the two existing specs | Code-quality: UI changes SHOULD include Playwright coverage where possible; the `auto_name` All-settings test is a ready pattern; existing Behavior-header assertion needs no companion because the key/description contain no `log` substring | S:45 R:90 A:70 D:60 |
| 12 | Certain | Tests run only through `just` recipes (`just test-backend`, `just test-frontend`, `just test-e2e <spec>`); full Vitest as the unit gate | Project context mandates `just`; a scoped Vitest run has missed cross-file assertions before | S:85 R:95 A:100 D:100 |
| 13 | Certain | Apply touches no `docs/memory/` file; hydrate owns the three memory edits in § 6 | Pipeline convention — memory is a post-implementation artifact maintained by hydrate | S:80 R:95 A:90 D:90 |

13 assumptions (9 certain, 4 confident, 0 tentative, 0 unresolved).
