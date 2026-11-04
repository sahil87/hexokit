# Intake: Updatecheck HexoKit Self-Row Match

**Change**: 260928-xq5k-updatecheck-hexokit-self-row
**Created**: 2026-09-29

## Origin

One-shot request from the user (surfaced during the HexoKit rebrand's R2(c) work, plan doc `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`):

> The bug: app/backend/internal/updatecheck/updatecheck.go hardcodes `runKitTool = "run-kit"` (used at lines ~368 and ~547 to find run-kit's own row when comparing against shll's `check-updates --json` roster output). As of shll v0.1.34+ (shipped in this rebrand, R1(c)/R2(b)), shll's roster now names that row `hexokit` (with `run-kit`/`rk` as recognized legacy/alias names in shll's own lookup, but the row's primary `Name`/`Tool` field in its JSON output is `hexokit`). Because run-kit's own code still looks for a row named exactly `run-kit`, it no longer finds its own row against shll >= v0.1.34, silently losing the version comparison against the currently-running binary and the brew-install gate check. [...] the match should accept `hexokit` (the new primary name) as well as `run-kit`/`rk` (legacy names, for anyone still on shll < v0.1.34). Follow whatever pattern shll itself used for its LegacyNames handling [...] or use the simplest correct fix for this specific comparison if a full legacy-list isn't warranted. Add a test that would have caught this regression (feed a `check-updates --json`-shaped fixture with `Tool: "hexokit"` through the comparison and assert it's recognized as run-kit's own row). Full pipeline: /fab-new then /fab-fff. Report back the PR URL. Do not merge it yourself.

The plan doc does not need its own row: the R1 row already carries a "Follow-up (run-kit, not yet filed)" note describing exactly this bug, and it should be marked done there (with the PR link).

Pre-intake investigation (this session):
- shll precedent (`/home/sahil/code/sahil87/shll/src/cmd/shll/tools.go:230`): roster entry `{Name: "hexokit", ..., LegacyNames: []string{"rk", "run-kit"}}`, plus `legacyAliases = map[string]string{"rk": "hexokit", "run-kit": "hexokit"}` (line 179) so `shll update run-kit` / `shll update rk` resolve to `hexokit` with a `note: run-kit is now hexokit` stderr line. shll's `check_updates.go:313` looks the manifest row up by `hexokit` then each legacy name.
- The frontend mirrors the backend constant: `app/frontend/src/contexts/session-context.tsx:1359` `const RUN_KIT_TOOL = "run-kit";` ("Mirrors the backend's `runKitTool` constant"), used at line 1505 `const singleRunKit = tools.length === 1 && tools[0].tool === RUN_KIT_TOOL;` to pick the single-version chip/palette wording (`⬆ v{latest}` / `run-kit: Update to v{latest}`).
- `app/backend/api/update.go:196-206` builds the scoped `shll update --yes <matched…>` argv from `Snapshot().Matched[].Tool` (validated by `validate.ValidateToolName`).

## Why

**The problem.** `internal/updatecheck` delegates the update check to `shll check-updates --json` but re-compares exactly one row locally: run-kit's own. That row is special because shll can only see the brew-visible installed version, while the daemon's restart-relevant truth is the RUNNING ldflags version; and it is gated on `c.selfBrew` because a go-install/dev rk cannot self-update through the brew-based remediation. The row is found by `tool.Name == runKitTool` where `runKitTool = "run-kit"`. shll ≥ v0.1.34 names that row `hexokit`, so the match never fires and the row falls through to the sibling branch, where shll's pre-evaluated `update_available`/`notable` are trusted verbatim.

**Consequences if unfixed** (a real functional regression, not cosmetic):
1. **No local version comparison.** Between `brew upgrade` and a daemon restart, brew's on-disk version is ahead of the running binary; shll reports `update_available: false` for the row and the daemon hides a pending restart-worthy update (and the inverse skews are possible too).
2. **No brew-install gate.** A go-install/dev-built rk (non-brew) whose brew-visible sibling install lags would list its own row and advertise an update the brew-based remediation cannot actually apply to the running binary.
3. **Legacy compat fields blank.** `runKitFields` (`m.Tool == runKitTool`) never finds the row, so `Result.Current`/`Result.Latest` stay empty even when the self row is notable — a not-yet-reloaded frontend keyed off a non-empty `Latest` never lights.
4. **Frontend wording.** `singleRunKit` never matches a `hexokit` row, so a single self-update shows the generic count form instead of `⬆ v{latest}`.
5. Downstream: hexokit-site keeps its `versions.json` `run-kit` key (R1(d) note) until run-kit accepts `hexokit` — this fix unblocks flipping that key.

**Why this approach.** This is one hardcoded name compared in a few places, not a general roster, so a full roster/LegacyNames struct is not warranted. The simplest correct form that mirrors shll's precedent is a small ordered name list (primary first, then legacy — the same `hexokit`, `rk`, `run-kit` set shll carries) plus one predicate used at every comparison site. Rejected: bumping the constant to `"hexokit"` alone (breaks every user still on shll < v0.1.34, whose roster still says `run-kit`); normalizing the reported name back to `"run-kit"` (would make the dismissal key and chip label disagree with what shll reports and put a legacy alias into the `shll update` argv).

## What Changes

### Backend: `app/backend/internal/updatecheck/updatecheck.go`

Replace the single constant with a primary name + legacy names and one predicate. Suggested shape (mirrors shll's `Name` + `LegacyNames`):

```go
const (
	// selfToolName is the roster name shll (>= v0.1.34) reports for this
	// binary's own row — the one row compared against the RUNNING ldflags
	// version (not the brew-visible version shll reports) and gated on this
	// binary being a brew install.
	selfToolName = "hexokit"
	...
)

// selfToolLegacyNames are the roster names older shll releases (< v0.1.34)
// report for the same row; they mirror shll's own LegacyNames for the tool.
var selfToolLegacyNames = []string{"rk", "run-kit"}

// isSelfTool reports whether a roster name is this binary's own row.
func isSelfTool(name string) bool {
	if name == selfToolName {
		return true
	}
	return slices.Contains(selfToolLegacyNames, name)
}
```

(Exact identifiers are the apply agent's choice; keep it this small.)

Call sites:
- `computeVerdicts` (~line 368): `if tool.Name == runKitTool {` → `if isSelfTool(tool.Name) {`. The self-row verdict's `Tool` field (currently `Tool: runKitTool`, ~line 377) becomes `Tool: tool.Name` — the name shll actually reported — so the scoped `shll update` argv (built from `Matched[].Tool` in `api/update.go`) and the dismissal key use the roster name the installed shll knows (`hexokit` on ≥ v0.1.34, `run-kit` on older shll, both natively valid for that shll).
- `runKitFields` (~line 547): `if m.Tool == runKitTool {` → `if isSelfTool(m.Tool) {`.
- Update the doc comments that name the row as `"run-kit"` where they describe the self-row match (e.g. the `CheckTool.Name` / `ToolVerdict.Tool` / `ToolUpdate.Tool` examples, the `Result.Current`/`Latest` comment, `computeVerdicts`/`runKitFields` comments) so they say the self row is matched by `hexokit` or a legacy name. Do not rewrite unrelated package prose.

Behavior is otherwise unchanged: local `anyIncrease(c.current, latest)` + `crossesThreshold(c.current, latest, tool.Notify)`, the `selfBrew` gate, sibling rows trusted verbatim, sorted-name iteration.

### Frontend: `app/frontend/src/contexts/session-context.tsx`

`RUN_KIT_TOOL` mirrors the backend constant and must accept the same names, otherwise the single-self-row chip form (`⬆ v{latest}`) silently degrades for `hexokit` rows. Replace with a name set and a predicate:

```ts
/** The roster names of this app's own row — `hexokit` (shll >= v0.1.34) plus the
 *  legacy `rk`/`run-kit` older shll reports. Mirrors the backend's self-tool
 *  names. The single tool that keeps the `⬆ v{latest}` chip form. */
const SELF_TOOL_NAMES: ReadonlySet<string> = new Set(["hexokit", "rk", "run-kit"]);
...
const singleRunKit = tools.length === 1 && SELF_TOOL_NAMES.has(tools[0].tool);
```

Keep the exported `singleRunKit` field name (consumers depend on it); renaming it is out of scope. Check other frontend consumers of the self-tool name (e.g. `lib/palette/update.ts`, `hooks/use-update-check.ts`, top-bar chip) for literal `"run-kit"` comparisons against a tool name and route them through the same set if any exist (pre-intake grep found only `session-context.tsx:1359`/`1505`; the other hits are comments/labels).

### Tests

Backend (`app/backend/internal/updatecheck/updatecheck_test.go`) — regression tests that would have caught the bug:
1. A `check-updates --json`-shaped report (inline `CheckReport` or a new testdata fixture shaped like `testdata/check-updates.json`) whose self row is `{Name: "hexokit", Formula: "sahil87/tap/hexokit", Installed: <brew-visible>, Latest: "3.9.0", Notify: "minor", UpdateAvailable: <deliberately wrong vs running>, Notable: <deliberately wrong>}`, run through `computeVerdicts`/`CheckOnceForTest` with a checker built for running version `3.8.1` and `selfBrew=true`: assert the verdict for `hexokit` uses `Installed == "3.8.1"` (the RUNNING version, not shll's) with `UpdateAvailable && Notable` computed locally, and `Snapshot().Current/Latest == ("3.8.1","3.9.0")` (runKitFields populated), and `Key` contains `hexokit@3.9.0`.
2. Same fixture with `selfBrew=false`: the `hexokit` row is omitted from `Tools` and `Matched` (gate honored), even though shll's row says `update_available: true`.
3. Legacy names keep working: a `run-kit`-named row (existing tests already cover this — keep them) and an `rk`-named row are both recognized as the self row. A table-driven `isSelfTool` test covering `hexokit`, `run-kit`, `rk` → true and `fab-kit`, `shll`, `""`, `hexokit-x` → false is sufficient for `rk`.
4. Optionally update `testdata/check-updates.json` (the vendored contract) so its self row reflects the current shll output (`hexokit`), keeping at least one test on the legacy `run-kit` name. If existing tests use `findVerdict(snap.Tools, "run-kit")` against that fixture, update them consistently.

Frontend (`app/frontend/src/contexts/session-context.test.tsx` or wherever `singleRunKit` is tested): add a case that a single `hexokit` tool row yields `singleRunKit === true` with `latest`/`current` populated; keep the existing `run-kit` case.

### Plan doc: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`

In the R1 row, the note "Follow-up (run-kit, not yet filed): `app/backend/internal/updatecheck/updatecheck.go` matches its own row by `runKitTool = "run-kit"`; shll ≥ v0.1.34 names that row `hexokit`, so until run-kit accepts `hexokit` the daemon treats its own row as a sibling (brew-visible version, no selfBrew gate)" → mark DONE with the PR link (PR URL is known only at ship; add it at ship or leave a `run-kit#TBD` placeholder the ship step fills). Also the (d) note's "flip the key only after run-kit accepts `hexokit` (the follow-up above)" can note the follow-up is done (the key flip itself is hexokit-site work, still pending until a run-kit release carries this fix). No new plan row.

## Affected Memory

- `run-kit/architecture/backend-packages`: (modify) `internal/updatecheck` row + its Design Decision — the run-kit row is matched by `hexokit` (primary) or the legacy `rk`/`run-kit` names; the self verdict carries the name shll reported; example key `fab-kit@2.17.0,run-kit@3.9.0` may become `hexokit@…`
- `run-kit/ui/updates-and-notifications`: (modify) `singleRunKit` is computed against the self-tool name set (`hexokit`/`rk`/`run-kit`), not the single `"run-kit"` literal

## Impact

- `app/backend/internal/updatecheck/updatecheck.go` (+ `updatecheck_test.go`, possibly `testdata/check-updates.json`)
- `app/frontend/src/contexts/session-context.tsx` (+ its test)
- `api/update.go` needs no code change — it consumes `Matched[].Tool` verbatim; its tests use the checker via stubs and may reference `"run-kit"` rows, which keep working.
- User-visible side effect: once a user's shll is ≥ v0.1.34 the dismissal key's self pair becomes `hexokit@X` instead of `run-kit@X`, so a previously dismissed notice for the same version may reappear once. Accepted — it only happens across the shll upgrade boundary.
- Downstream unblock: hexokit-site can flip its `versions.json` `run-kit` key to `hexokit` once a run-kit release carries this fix (not done here).

## Open Questions

- None blocking. The self-verdict `Tool` naming (pass-through of the reported name) is decided below.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Recognize the self row by `hexokit` plus legacy `rk`/`run-kit` | User-specified; mirrors shll's `Name: "hexokit"` + `LegacyNames: {rk, run-kit}` | S:95 R:90 A:95 D:95 |
| 2 | Certain | Small primary-name + legacy-name list + one predicate, not a roster struct | User allowed the simplest correct form; one name compared at 2 backend sites + 1 frontend site | S:80 R:90 A:85 D:80 |
| 3 | Confident | Self verdict's `Tool` = the name shll reported (`tool.Name`), not a normalized constant | Scoped `shll update` argv and dismissal key must use a name the installed shll natively knows; `hexokit` is invalid on shll < v0.1.34 and `run-kit` is a deprecated alias on ≥ v0.1.34 | S:65 R:85 A:75 D:60 |
| 4 | Certain | Update the frontend `RUN_KIT_TOOL` mirror to the same name set; keep the `singleRunKit` field name | Constant is documented as mirroring the backend; without it the single-self chip wording degrades for `hexokit` rows; renaming the exported field is scope creep | S:70 R:90 A:85 D:75 |
| 5 | Certain | Regression tests: hexokit-named fixture row → local comparison, selfBrew gate, runKitFields populated; legacy names still match | User-specified test; code-quality.md requires tests for bug fixes | S:95 R:95 A:95 D:90 |
| 6 | Certain | Mark the existing R1 follow-up note done in the plan doc, no new row | User: "note it in the plan doc's existing R1/R2 notes if there's a natural place" — the R1 row has exactly this follow-up note | S:85 R:95 A:90 D:85 |
| 7 | Confident | Accept a one-time dismissal-key change (`run-kit@X` → `hexokit@X`) across the shll upgrade | Unavoidable with pass-through naming; only re-shows a notice once; no persistent state migration warranted | S:60 R:90 A:80 D:70 |

7 assumptions (5 certain, 2 confident, 0 tentative, 0 unresolved).
