# Intake: Consolidate R2 evidence into the HexoKit rebrand Phase 3 plan doc

**Change**: 260928-jor0-hexokit-r2-plan-doc-consolidate
**Created**: 2026-09-29

## Origin

> Dispatched by the team lead in this session: "Repo/worktree already created for
> a docs-only bookkeeping change. Run the full fab pipeline (`/fab-new` then
> `/fab-fff`). File: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`. R2
> (the GitHub repo rename bundle) just finished; consolidate its evidence into
> the plan doc the same way R1 was already consolidated (row shows
> "(a)+(b)+(c)+(d) merged")."
>
> One-shot dispatch with full evidence supplied inline by the team lead (PR
> links, dates, verification notes) — no conversational back-and-forth needed;
> this intake is a direct transcription/formatting task against known facts,
> not an open design question.

## Why

R2 — the GitHub repo rename (`sahil87/run-kit` → `sahil87/hexokit`) plus the
three downstream surfaces that key off the repo name (shll roster, hexokit-site
slug table, run-kit's own badges/homepage/formula-template URLs) — has now
fully merged, but the plan doc's R2 row still reads "not started". Left
un-updated, the doc misrepresents current state: a future reader (or agent)
consulting it to decide "is anything blocking X3" would not know R2 is done,
and the updatecheck.go bugfix discovered mid-flight (a real, merged, released
fix) would have no pointer from the plan that caused its discovery. The plan
doc is the single source of truth `/fab-status`-adjacent readers use for this
rebrand; the master plan's Pickup Protocol (item 4) explicitly requires
updating rows "when you start or finish" — this change is that required
bookkeeping step, done now that R2 has finished. The alternative — leaving it
stale until X3 also finishes and back-filling both at once — risks losing the
per-PR verification detail (redirect checks, the merge-race follow-up, the
stale-shll guard interaction) that's fresh right now and would be tedious to
reconstruct later.

## What Changes

Single file: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`. Docs-only,
no code, no memory/spec impact.

### 1. R2 row (Phase 3 table, currently `| R2 | ... | not started |`)

Rewrite the Scope cell to mark all four sub-steps done inline, matching the R1
row's established convention (`**(x) DONE — ...:** ...` per sub-step, folded
into one flowing cell; the PR column collects the links; the Status cell
becomes a one-line summary):

- **(a)** GitHub repo rename `sahil87/run-kit` → `sahil87/hexokit`, executed
  2026-09-28 via `gh auth switch --user sahil87` (Sahil's explicit
  pre-approval), switched back to `sahil-noon` afterward; redirects verified
  for web, clone, and API. No PR — account-level action.
- **(b)** shll roster `Repo` field → `hexokit` —
  [shll#104](https://github.com/sahil87/shll/pull/104), merged, released as
  shll v0.1.35.
- **(c)** hexokit-site slug-table source + both refresh crons (README, Help) —
  [hexokit-site#12](https://github.com/sahil87/hexokit-site/pull/12) merged,
  follow-up [hexokit-site#13](https://github.com/sahil87/hexokit-site/pull/13)
  merged (carried forward 2 commits dropped by a merge race). Both crons ran
  successfully. Note: `versions.json`'s `run-kit` key was deliberately left
  as-is at this point (see bugfix note below).
- **(d)** run-kit badges/homepage/formula-template URLs → `sahil87/hexokit` —
  [hexokit#1060](https://github.com/sahil87/hexokit/pull/1060) merged (repo
  already renamed by (a), so this PR's URL uses the new `hexokit` repo name).
  Also: sahil87 profile repo link (a redundant duplicate PR was closed since
  main already had the fix independently); six companion repos (fab-kit, wt,
  idea, tu, hop) checked — none needed a live-URL change (history/fixture/
  local-path mentions only, out of scope).

PR column: link all of (b)/(c)/(d)'s PRs (no PR exists for (a)). Status
column: **done** — all four sub-steps merged.

### 2. Cross-reference note for the updatecheck.go bugfix

Add a short note near/after the R2 row (matching the doc's existing convention
of folding a caused-by-this-work bugfix into prose near where it surfaced,
as R1's row already does for its own follow-up) recording: R2(c) surfaced that
run-kit's `updatecheck.go` hardcoded `runKitTool = "run-kit"`, which broke
self-row recognition against shll ≥v0.1.34's `hexokit`-named roster row
(silently losing the version-check comparison and the brew-install gate).
Fixed and merged as [hexokit#1061](https://github.com/sahil87/hexokit/pull/1061),
shipped in release **v3.20.23**. Not a plan row of its own — a traceability
pointer only.

### 3. Two open follow-ups, recorded but not filed

Note both, clearly marked not-yet-filed (matching the "Follow-up (shll, not
yet filed): ..." convention already used in the R1 row):

- hexokit-site's `versions.json` `run-kit` key can now be flipped to `hexokit`
  in a small follow-up change, now that the updatecheck.go fix (above) makes
  run-kit recognize a `hexokit`-keyed row. Not done in this change.
- The broader out-of-scope `sahil87/run-kit` URL sweep surfaced during R2(d):
  README raw image URLs, `DefaultRepo` in `internal/desktop/desktop.go`,
  `vapidSubscriber` in `internal/push/send.go`, frontend doc-link constants in
  `global-chrome.tsx`/`row-flyout-card.tsx`, and docs/site back-links. Surfaced
  as a candidate follow-up, not filed.

### 4. Order line and top Status summary

- Order line (currently `... ~~R1~~ · R2 (any time after A3) → X3.`): strike
  through R2 (`~~R2~~`) so only X3 remains unstruck.
- Top "Where we are" / "Status (2026-09-28)" prose (lines ~9-36): update the
  "Still on the old name: the GitHub repo `sahil87/run-kit` (R2) is the only
  public rename surface left" framing — R2 is now done, so this no longer
  holds. Update the Status block's "R2 and X3 not started" close to reflect R2
  done, only X3 remaining. Bump the status date if the doc's convention ties
  it to last-updated (check current heading style before deciding whether to
  change the date).

## Affected Memory

None — this change touches only `fab/plans/`, which is fab planning
bookkeeping, not `docs/memory/` or `docs/specs/`. No spec-level behavior
changes.

## Impact

- `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` only.
- No code, no tests, no CI-relevant paths touched (docs-only diff, per
  dispatch instructions CI should treat this as such — any CI failure is
  investigated once as pre-existing/unrelated per session convention before
  being treated as real).

## Open Questions

None — the team lead's dispatch message supplied all facts (PR links, dates,
verification detail, follow-up items) needed to write this row; this is a
formatting/consolidation task against an already-decided set of facts, not an
open design question.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Follow the R1 row's exact inline `(a) DONE — ...` sub-step convention for the R2 row, rather than inventing a new format | Explicit instruction from the dispatch message ("same style the R1 row already uses — read it first") and directly verified by reading the current R1 row in the doc | S:90 R:95 A:95 D:95 |
| 2 | Certain | All R2 evidence (PR links, dates, verification details) comes verbatim from the team lead's dispatch message; no independent verification of the underlying GitHub/shll/hexokit-site state is performed in this change | Dispatch explicitly supplied the evidence as already-verified fact ("merged", "released", specific commit/redirect verification already done); re-verifying live GitHub state is out of scope for a docs bookkeeping change | S:90 R:80 A:85 D:90 |
| 3 | Certain | The updatecheck.go bugfix note is a short cross-reference near the R2 row, not a new plan row, and not a duplicate of the existing similar note already embedded in the R1 row's "Follow-up (run-kit) DONE" text | Explicit instruction: "it's not itself a plan row... should be traceable from here"; R1's existing follow-up note lacks the release version (v3.20.23) and is R1-row-scoped, so an R2-side pointer adds distinct value rather than duplicating | S:85 R:80 A:85 D:85 |
| 4 | Certain | Do not touch X3's row or mark it done | Explicit instruction: "Do NOT touch X3's row or mark it done — that's the next and final step, done separately" | S:95 R:95 A:95 D:95 |
| 5 | Certain | Do not file the two open follow-ups (versions.json key flip, out-of-scope URL sweep) — record only | Explicit instruction: "not yet filed, don't file them, just record them so they aren't lost" | S:95 R:95 A:95 D:95 |
| 6 | Confident | Update the Order line and top Status summary prose (lines ~9-36) to reflect R2 done, leaving only X3 — exact wording left to apply-time judgment rather than a prescribed diff | Instruction says "Update the Order line and top Status summary to reflect R2 fully done, leaving only X3 remaining" without dictating exact phrasing; matching the doc's existing terse, evidence-dense prose style is a reasonable inference | S:65 R:70 A:75 D:70 |

6 assumptions (5 certain, 1 confident, 0 tentative, 0 unresolved).


