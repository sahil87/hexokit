# Intake: perf-idle-cpu reports the xterm renderer and runs headed

**Change**: 260917-lhr5-perf-idle-cpu-renderer-headed
**Created**: 2026-09-17

## Origin

> Idle CPU follow-ups — Change 5 (perf-idle-cpu-renderer-headed): the instrument reports which xterm renderer the page used and gains --headed. Read fab/plans/sahil/26-09-17-idle-cpu-followups.md in full (Standing context, Decisions of record, R5 pre-intake research, and § Change 5's five numbered tasks) before writing the intake. Lane: light.

One-shot `/fab-new` from the plan `fab/plans/sahil/26-09-17-idle-cpu-followups.md` § Change 5 (the first of three follow-up changes; change 6 `flair-composited-with-terminal` is sequenced after this one because its acceptance gate needs `--headed` and the renderer field). The worktree branch `perf-idle-cpu-renderer-headed` was pre-created for this change. **Lane: light** (`/fab-ff --light` / `/fab-fff --light`).

Decisions of record carried from the plan:

- **Errata on the first plan** (`26-09-16-idle-cpu.md`): headless Playwright Chromium on the dev box has **no WebGL at all** (chromium-1208 and -1217, every SwiftShader flag tried), so every terminal-route row in the first plan's table was an xterm **DOM-renderer** row. The "one run in nine fell back to the DOM renderer, doubling cost" story was wrong — that run simply had a fuller screen (15k nodes). WebGL exists on this box only **headed** under `xvfb-run` (Xvfb is installed at `/usr/bin/xvfb-run`).
- **The instrument must say which xterm renderer it measured.** A tty-route number without the renderer kind is not comparable to anything; this change is a prerequisite for change 6, not a nicety.
- **Live-daemon etiquette** (from 07pj): the user's `:3000` daemon and tmux servers are read-only for measurement. This change modifies only the instrument, so measuring against the live daemon is fine.
- **Selection method unchanged**: measured A/B delta against the ≈3-point noise floor.

Pre-intake research already done (R5, in the plan) and what this session added:

- R5 reproduced the `xterm=0` inventory: three back-to-back headless runs on `/runKit/@99`, `/runKit/@4`, `/runKit/@79` printed `xterm=0 iframes=0 ws[/ws/terminals]=0` with recalcs ≈ 300 and renderer ≈ 6 %, while 11 plain Playwright loads of the same routes mounted `.xterm` within 1.7 s and kept it for 36 s. Two later instrument runs on `@4`/`@109` read `xterm=1`. Unexplained as of intake.
- This session found the frontend already keeps a **per-window renderer registry**: `window.__rkRenderer: Record<windowId, "webgl" | "canvas">` in `app/frontend/src/components/terminal-client.tsx` (`setActiveRenderer` at ~:134 writes `"webgl"` after `loadAddon(webgl)` succeeds and `"canvas"` on the construction `catch` or `onContextLoss`; the entry is deleted at cleanup). The change-4 console line `rk: xterm WebGL {unavailable at load | context lost} for {server}/{windowId} — using the DOM renderer (N terminal(s) mounted)` is emitted from `reportWebglFallback` at ~:190 on the same two paths. The registry is therefore the primary renderer signal; the console line corroborates it.
- This session found the summary line already has a `renderer=<n>%` field (the renderer-process CPU sum, documented in `architecture/testing.md` § Performance probes as a fixed-order grep contract). The plan's proposed `renderer=webgl|dom|none` would collide with it, so the new field is named `xterm-renderer=`.

## Why

**The pain point.** `just perf-idle-cpu` (PR #991) is the contract of record for every CPU claim in the repo, but on a terminal route it cannot say what it measured. xterm 6 renders with WebGL when a context is available and silently drops to the DOM renderer otherwise; the two differ by roughly 2× renderer CPU on the same page. On this dev box headless Chromium never gets WebGL, so every tty-route number produced so far is a DOM-renderer number — and nobody could tell that from the output. The first plan drew a wrong conclusion ("one run in nine fell back") from exactly this blind spot.

**A second blind spot.** Three tty-route runs reported `xterm=0` — no terminal on the page — yet printed a plausible-looking summary line with no warning. Anyone pasting those lines into a plan would have compared a sidebar-only page against a terminal page. Until R5 is explained, a tty-route summary line with `xterm=0` must be flagged as not-a-terminal-measurement, mechanically, by the tool.

**No WebGL numbers exist on the dev box.** Change 6 (flairs stay composited with a terminal mounted) must prove its fix for **both** renderers, and the Mac baseline (R0) has real WebGL. Without a headed mode the dev box can only produce half of that table, and the xvfb incantation (`xvfb-run -a -s "-screen 0 1920x1080x24" node …` plus `headless: false`, `--enable-unsafe-swiftshader --ignore-gpu-blocklist`) lives only in a plan file.

**If we don't fix it**: change 6's acceptance gate ("recalcs within 200 of the flairs-paused inject on the same route, both renderers") cannot be evaluated; every future tty-route measurement stays ambiguous; and the `xterm=0` class of bad row keeps entering plan tables undetected.

**Why this approach.** The instrument is the one place every measurement flows through, so the renderer kind belongs on its summary line and in its JSON rather than in a runbook. Reading `window.__rkRenderer` is a direct observation of what xterm did (the frontend writes it at the exact moment the addon loads or fails), while the console line is the same fact one step removed; both are captured so the two can be cross-checked. `--headed` is added to the existing script rather than as a second script because the summary/JSON contract, the settle constants, and the socket counters must be byte-identical between a headless and a headed run for the rows to be comparable. Auto-wrapping in `xvfb-run` when `DISPLAY` is unset keeps the justfile a one-liner (Constitution VIII) and puts the only Xvfb logic in `scripts/perf-idle-cpu.sh`, next to the Playwright prerequisite check it already owns.

## What Changes

### 1. `xterm-renderer=` field: which xterm renderer the page used (`scripts/perf-idle-cpu.mjs`)

**Capture.** After `ctx.newPage()` and before `loadRoute`, attach `page.on("console", …)` and record every console message whose text starts with `rk: xterm WebGL` (both variants: `unavailable at load` and `context lost`). Keep the count and the first line verbatim (the greppable contract in `reportWebglFallback`'s JSDoc). Nothing else on the console is stored.

**Derive** the renderer kind at inventory time (`collectInventory`, currently ~:335), inside the same `page.evaluate`, by reading the registry alongside the existing `.xterm` count:

```js
const registry = window.__rkRenderer ?? {};
const kinds = new Set(Object.values(registry));          // "webgl" | "canvas"
```

Mapping (the `.xterm` count is the mount oracle; the registry is the renderer oracle):

| `.xterm` count | registry values | `xterm-renderer=` |
|---|---|---|
| 0 | (any) | `none` |
| ≥ 1 | all `webgl` | `webgl` |
| ≥ 1 | all `canvas` | `dom` (xterm 6's fallback is the DOM renderer; the registry keeps the legacy `canvas` literal for the echo-latency harness — `ui/terminal.md`) |
| ≥ 1 | both values present | `mixed` (a board or multi-tile page can hold both) |
| ≥ 1 | empty registry | `unknown` (a mounted `.xterm` that never reached the WebGL block — not expected; surfaces a frontend bug rather than hiding it) |

The console-line count is a **cross-check**, not the source: `dom`/`mixed` with zero `rk: xterm WebGL` lines, or `webgl` with ≥ 1 line, is reported as a mismatch in the `## page` section (`webgl warnings  2 (registry says webgl — mismatch)`), never silently reconciled.

**Output.** The summary line gains `xterm-renderer=<kind>` immediately **after** `xterm=<n>` (fixed field order stays grep-able; the existing `renderer=<n>%` CPU field is untouched and keeps its name). The `## page` section gains rows `xterm renderer` and `webgl warnings <count>[ — <first line>]`. The `--json` output gains `inventory.xtermRenderer` (the kind string), `inventory.rendererRegistry` (the raw `{windowId: value}` map), and `webglConsole: { count, first }`. `--help`'s Output paragraph lists the new field.

### 2. Tty-route guard: flag a terminal measurement with no terminal (`scripts/perf-idle-cpu.mjs`)

A route **looks like a tty route** when the path the sample actually ran on (the `--then` target when given, else `<path>`) matches `^/[^/]+/@?\d+/?$` — `/$server/@N` (the window id, the only window identity per `router.tsx`) or the bare-number form the plan names — and is not `/board/…` or `/__controls`. Query strings are stripped before matching.

When the route looks like a tty route **and** `.xterm` count is 0 at sample end, the run prints, to **stderr**, after the report:

```
perf-idle-cpu: warning: no terminal mounted on /runKit/@99 — not a tty measurement (xterm=0; the sidebar/server numbers are still valid)
```

and exits **0** — the run is still a valid measurement of everything else on the page. The summary line already carries `xterm=0 xterm-renderer=none`, so a pasted line is self-flagging without the stderr text. The JSON gains `ttyRoute: true|false` and `warnings: [ "no terminal mounted …" ]` so a scripted consumer can filter rows without parsing stderr. No new exit code: the exit-code contract (`0 sampled · 1 load failure · 2 usage`) is unchanged.

### 3. `--headed`: a headed run, auto-wrapped in Xvfb when there is no display

**`scripts/perf-idle-cpu.mjs`** gains `--headed` (boolean, default false). `launchChromium` becomes:

```js
chromium.launch(
  opts.headed
    ? { headless: false, channel: "chromium", args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }
    : { headless: true, channel: "chromium" },   // byte-identical to today's headless launch
);
```

The headless launch is deliberately **unchanged** (no new flags) so every earlier headless row remains comparable. `--headed` is recorded in the result (`headed: true`), appended to the summary line as a trailing `headed` token (same position class as the existing trailing `reduced-motion` token), and shown in `## page` (`headed  true`). `--help` gains the flag with the one-line caveat: *headless Chromium has no WebGL on Linux — this is the only way to get an xterm WebGL row on the dev box; GPU % under Xvfb is SwiftShader and not a number.*

**`scripts/perf-idle-cpu.sh`** scans `"$@"` for `--headed` (the same loop shape as the existing `--url` scan). When present:

- `DISPLAY` set (this box exports `:60`, the Xvnc rig) → run `node` directly on that display; no wrapping.
- `DISPLAY` unset and `xvfb-run` on PATH → `exec xvfb-run -a -s "-screen 0 1920x1080x24" node "$SCRIPT_DIR/perf-idle-cpu.mjs" "$@"`.
- `DISPLAY` unset and no `xvfb-run` → `perf-idle-cpu: --headed needs a display — set DISPLAY or install xvfb (apt install xvfb) for xvfb-run` on stderr, exit 1 (the wrapper's existing prerequisite exit code).

To force the Xvfb path on a box that exports `DISPLAY`, run `env -u DISPLAY just perf-idle-cpu … --headed`. The justfile recipe stays `scripts/perf-idle-cpu.sh {{args}}` (Constitution VIII — no change).

### 4. R5: explain (or fix) the `xterm=0` inventory

The change **must** close R5 one of two ways, recorded in `plan.md` and in the memory section below:

- **Instrument fault** → fix it in this change. Candidates to test first, cheapest first: (a) the inventory runs on the main frame via `page.evaluate` and `.xterm` lives in the main frame, so a wrong-frame read is unlikely — confirm by also recording `document.visibilityState`, `location.href` (already captured — a redirect to `/$server` when the window is gone would show as an href mismatch against the requested path) and the tty-tile container's presence at sample end; (b) the 1 ms `Profiler.setSamplingInterval` starving the page — compare `.xterm` presence with the profiler off; (c) the swallowed 15 s `networkidle` wait plus the 6 s settle racing the state socket's window list — poll `.xterm` for up to N s after load on a tty route and record the mount time in the JSON (`xtermMountedAfterMs`), rather than sampling a page that has not finished mounting.
- **Genuinely never mounted** (the window did not exist on the daemon at that moment, or the layout hid the tty tile) → document the cause and the guard from § 2 is the permanent answer.

Either way the diagnostic fields added while investigating (`visibilityState`, requested-vs-landed href, `xtermMountedAfterMs`) stay in the JSON only if they earned their keep; they do not join the summary line.

### 5. Documentation (`docs/memory/run-kit/architecture/testing.md` § Performance probes)

- **Output** paragraph: new summary field order — `… xterm=<n> xterm-renderer=<kind> iframes=<n> ws[…] … [reduced-motion] [headed]`; the `## page` rows; the JSON fields.
- **Flags** paragraph: `--headed` with the xvfb-run auto-wrap rule and the `env -u DISPLAY` override.
- **Caveats** (1) is corrected: headless Linux Chromium has **no WebGL** (not "no GPU / software GPU"): every headless tty row is `xterm-renderer=dom`; a WebGL row needs `--headed`; GPU % under Xvfb is SwiftShader and is not a number — read renderer and recalcs only. The "~700 recalcs on a tty route" reading note is re-stated per renderer once the verification runs give the numbers.
- New paragraph: the tty-route guard and what `xterm=0` on a tty route means (R5's answer).
- `ui/terminal.md` § Design Decisions → "WebGL fallback is announced, not fixed": the *Why* cites the 2026-09-16 "one tty run in nine landed on the DOM renderer at 39 % vs 21 % with WebGL" — corrected to the errata (every headless run on the dev box is a DOM-renderer run; the 39 % run had a fuller screen). The decision itself is unchanged.

### Verification (recorded in `plan.md`)

1. `just perf-idle-cpu --help` lists `--headed` and the `xterm-renderer=` field; `--headed` with `DISPLAY` unset and no `xvfb-run` on PATH errors with the install hint (simulate with a PATH that lacks it).
2. One **headless** and one **headed** run on the same tty route against the live daemon (`--url http://127.0.0.1:3000`, read-only), both summary lines pasted into `plan.md`: headless shows `xterm=1 xterm-renderer=dom` with ≥ 1 webgl warning; headed shows `xterm=1 xterm-renderer=webgl` with 0 warnings and the trailing `headed` token. Run the headed one both ways: on `DISPLAY=:60` and under `env -u DISPLAY` (exercises the xvfb-run wrap).
3. A server route (`/runKit`) still prints `xterm=0 xterm-renderer=none` with **no** tty warning; a tty route with the terminal absent (or `--inject` removing `.xterm`) prints the warning and exits 0.
4. `--json` output carries the new fields; the existing fields are unchanged.
5. `npx tsc --noEmit` is not applicable (plain `.mjs`); `node --check scripts/perf-idle-cpu.mjs` and `bash -n scripts/perf-idle-cpu.sh` as syntax gates. No e2e spec covers the instrument; none is added (it is excluded from `just test` and CI by design).

## Affected Memory

- `run-kit/architecture/testing`: (modify) § Performance probes — `xterm-renderer=` field and its mapping table, the tty-route guard, `--headed` + the xvfb-run auto-wrap rule, the corrected WebGL caveat (headless has no WebGL; GPU % under Xvfb is not a number), the R5 finding, new JSON fields.
- `run-kit/ui/terminal`: (modify) § Design Decisions → "WebGL fallback is announced, not fixed" — the *Why* paragraph's "one run in nine" measurement story replaced by the errata; add a one-line pointer that `window.__rkRenderer` is read by the perf instrument (a second consumer beside the echo-latency harness, so the `"webgl" | "canvas"` literals are now a cross-file contract).

## Impact

- **Code**: `scripts/perf-idle-cpu.mjs` (CLI parse, `launchChromium`, console capture, `collectInventory`, `summaryLine`, `report`, JSON writer, `USAGE`), `scripts/perf-idle-cpu.sh` (the `--headed` scan and xvfb-run wrap). No frontend, backend, or justfile changes. No tests exist for the instrument today and none are added; the gates are the syntax checks and the recorded live runs.
- **Contracts**: the summary line gains one field after `xterm=` and one optional trailing token; existing fields keep name, order, and meaning. JSON gains fields, removes none. Exit codes unchanged.
- **Frontend contract consumed**: `window.__rkRenderer` (`terminal-client.tsx`) and the `rk: xterm WebGL` console prefix become read-side contracts of the instrument; a rename in the frontend must update the script (memory records this).
- **Dependencies**: `xvfb-run` (present at `/usr/bin/xvfb-run`; optional — only for `--headed` without a `DISPLAY`). No new npm packages.
- **Downstream**: change 6 (`flair-composited-with-terminal`) consumes `--headed` and `xterm-renderer=` in its acceptance gate; R0 (Mac baseline) will run the same script headed with real WebGL.
- **Constitution**: IV untouched (no route, no settings surface); VIII kept (justfile unchanged, logic in `scripts/`); Toolkit Standards do not govern repo-local `scripts/` help text (they bind the `rk` binary's CLI surface); Test Intent Comments not triggered (no e2e touched).

## Open Questions

- None blocking. R5's root cause is investigative work inside the change (§ What Changes 4), not an intake decision.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The renderer kind is read from `window.__rkRenderer` (primary) with the `rk: xterm WebGL` console lines as a cross-check, rather than from console lines alone as the plan's task 1 words it | The registry is written at the exact WebGL load/fail moment by the same code that emits the console line; reading it is a direct observation and answers R5's "confirm the console line is reliable" by construction. Plan wording is a means, not the decision | S:70 R:90 A:90 D:75 |
| 2 | Certain | The new summary field is `xterm-renderer=` with one of webgl / dom / none / mixed / unknown, placed right after `xterm=<n>`; the plan's `renderer=` name is not used | The summary line already has `renderer=<n>%` (renderer-process CPU) as a documented fixed-order grep field; reusing the key would break every existing grep. Placement beside `xterm=` keeps the terminal facts adjacent | S:65 R:95 A:90 D:65 |
| 3 | Certain | `dom` is the reported kind for the registry's `"canvas"` literal | `ui/terminal.md` records that `"canvas"` is a legacy literal kept for the echo-latency harness while the human-facing text says DOM renderer, which is what xterm 6 falls back to; the plan's own vocabulary is webgl / dom | S:80 R:95 A:95 D:85 |
| 4 | Certain | The headless launch (`{ headless: true, channel: "chromium" }`) stays byte-identical; the SwiftShader/GPU-blocklist flags are added only on `--headed` | The errata records that every SwiftShader flag was tried headless and none produced WebGL; changing the headless launch would only break comparability with every earlier row | S:85 R:90 A:95 D:90 |
| 5 | Certain | Tty-route detection is `^/[^/]+/@?\d+/?$` on the sampled route (the `--then` target when present), excluding `/board/…` and `/__controls`; query strings stripped | `router.tsx` says `@N` is the only window identity; the plan explicitly also names the bare `/$server/N` form; `--then` is the route actually on screen at sample end | S:75 R:90 A:85 D:70 |
| 6 | Certain | The no-terminal warning goes to stderr after the report, exit stays 0, and the JSON gains `ttyRoute` + `warnings[]` | Plan task 2 says print a warning and exit 0; stdout line 1 is a grep contract so the warning must not displace it; `xterm=0 xterm-renderer=none` makes a pasted line self-flagging | S:80 R:90 A:85 D:75 |
| 7 | Certain | Wrapper rule: `DISPLAY` set → run on it, no wrap; unset + `xvfb-run` → wrap with `-a -s "-screen 0 1920x1080x24"`; unset + no `xvfb-run` → stderr hint, exit 1. `env -u DISPLAY` forces the wrap | Plan task 3 specifies exactly this; exit 1 matches the wrapper's existing prerequisite failure; the desktop e2e lane (`test-desktop-e2e.sh`) uses the same `DISPLAY`-unset + xvfb-run-present rule, so the repo already has this pattern | S:85 R:90 A:90 D:85 |
| 8 | Certain | `headed` appears as a trailing summary token (like `reduced-motion`) and as a `## page` row + JSON `headed: true`, not as a value inside another field | Mirrors the existing `reduced-motion` convention; a headed row must be distinguishable when pasted next to a headless one | S:70 R:95 A:85 D:80 |
| 9 | Confident | `mixed` and `unknown` are reported as distinct kinds instead of collapsing to `dom` | A board/multi-tile page can hold both renderers; an `.xterm` with no registry entry is a frontend anomaly the instrument should surface, not mask. Both are cheap and reversible | S:55 R:95 A:85 D:70 |
| 10 | Confident | R5 is closed inside this change, whichever way it falls: an instrument fault is fixed here (with `xtermMountedAfterMs` / visibility / landed-href diagnostics kept only if useful); a genuine non-mount is documented and § 2's guard is the answer | Plan task 4 says "R5's answer goes into the same doc section (or fixes the inventory if it was the instrument's fault)"; the cause is unknown at intake, so the scope of the fix is unknown — bounded by the three cheapest candidates listed | S:60 R:70 A:55 D:45 |
| 11 | Confident | `ui/terminal.md`'s WebGL-fallback *Why* paragraph is corrected to the errata in this change's hydrate | The plan's Decisions of record list the errata and this change is the one that establishes the renderer fact mechanically; leaving a memory file asserting the wrong story next to the corrected testing doc would be a contradiction hydrate is meant to prevent | S:65 R:95 A:80 D:70 |
| 12 | Certain | No new tests, no e2e, no justfile change; gates are `node --check`, `bash -n`, `--help` smoke, and the recorded headless/headed live runs | The instrument is excluded from `just test`/CI by design (testing.md § Performance probes); the justfile recipe already passes `{{args}}` through (Constitution VIII); the plan's task 5 names exactly these verifications | S:85 R:90 A:95 D:90 |
| 13 | Certain | Light lane | User-specified in the invocation; the plan's lane hint for change 5 is light | S:100 R:95 A:100 D:100 |

13 assumptions (10 certain, 3 confident, 0 tentative, 0 unresolved).
