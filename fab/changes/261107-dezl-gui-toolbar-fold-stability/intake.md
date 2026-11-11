# Intake: Deterministic gui header-fold e2e suite

**Change**: 261107-dezl-gui-toolbar-fold-stability
**Created**: 2026-11-07

## Origin

> "CI checks fail" → diagnosis showed the sole red check on PR #1105 (Operator launcher, since merged) was E2E shard 1 failing in `gui-toolbar-fold.spec.ts`; the failed-jobs rerun passed. User: "Yes, create a PR to remove the flakiness."

Conversational (this session). The diagnosis conversation established, with local evidence:

- `just test-e2e gui-toolbar-fold --repeat-each 3 --retries 0` fails **3 of 12 runs on `origin/main`'s frontend** (A/B in the same worktree, source swapped via `git checkout origin/main -- app/frontend/src`) and 4 of 12 on the ogop branch — the flake pre-exists this branch.
- The ogop change is **not the cause**: the one file it shares with the gui toolbar (`lib/top-bar-overflow.ts`) is add-only — `computeVisibleCount`, which `lib/gui-toolbar-fold.ts` reuses, is byte-identical; the new `computeFit` is top-bar-only.
- The backlog's known flaky item ([8wf7], max-update-depth console error) is a different failure; nothing else covers this suite's flakiness.

## Why

The "gui header fold — real widths" suite (`app/frontend/tests/e2e/gui-toolbar-fold.spec.ts`) is the only e2e proof of the gui tile header's measured fold ladder (tail-first fold, label degradation before any fold, `⚙` two-pass reserve, `rk-gui-toolbar` persistence, fullscreen targeting). It fails intermittently on `main` and in CI:

- It was the **sole cause of PR #1105's red CI** (all other 8 checks passed; the failed-jobs rerun passed) — a false red that costs a rerun and erodes trust in every PR's e2e output.
- Local repro (retries off): ~25–33% failure rate on both `main` and the ogop branch.

Observed failure modes (from CI shard-1 logs and local `--repeat-each 3` runs):

1. `Error: spring did not converge to 300` — `resizeToSpring`'s loop (15 iterations, 2px tolerance) fails to land the header spring on its target.
2. `expect(...getByRole('button', { name: 'Toggle stats' })).toBeVisible()` fails at a spring targeted `full + cap + 40` — something folded when everything was expected inline.
3. `expect(...gui-toolbar-resolution).toHaveText("1920 ▾")` fails at a mid-band target — the size label did not degrade when expected.

Structural fragility the spec itself documents: jsdom has no layout, so the suite drives the fold at real viewport widths; the toolbar's `ResizeObserver` re-fit is **not atomic with the resize** (the same caveat `top-bar-overflow.spec.ts` / `crumb-collapse.spec.ts` document), and the header's **shrinkable meta chip** makes the viewport↔spring overhead non-constant. On top of that, `resizeToSpring` iterates to a **2px tolerance** and tests then assert at targets sitting **10–40px from fold boundaries** — a few px of drift (font metrics, scrollbar, meta-chip state, timing of the re-fit) flips the expected fold state.

If unfixed: every PR's e2e shards can false-fail on this suite, and each pipeline run must re-prove innocence against it.

## What Changes

### 1. Diagnose the actual mechanism per failure mode (before fixing)

Instrument/repro locally to name the root cause for each observed mode — e.g. log `measureFold`'s viewport/spring/widths across the `resizeToSpring` loop; capture the fold state (`gui-toolbar-fold` result, rendered `⚙`/degraded labels) at each assertion; check whether the meta chip oscillates, whether the loop converges to a *different* spring than asserted (target computed from stale widths), and whether the post-resize assertion reads the pre-refit DOM. The fix must address the named mechanism, not add blanket retries/timeouts.

### 2. Make the suite's sizing deterministic (expected primary fix, test-side)

Rework how the spec lands on and asserts fold boundaries, candidates (pick by what diagnosis proves, not all at once):

- **Convergence**: replace the iterate-to-2px `resizeToSpring` with a deterministic mechanism — e.g. pin the meta chip's width in the test (a CSS override via `page.addStyleTag`) so viewport↔spring overhead becomes constant and one computed resize lands on target; or widen the tolerance and verify the landed spring before asserting.
- **Target margins**: aim assertions at band midpoints with margins scaled to the real inputs (the fold's own 24px expand hysteresis, the reserve width, measured probe widths) instead of fixed `±10`/`+40` offsets from boundaries.
- **Post-resize reads**: keep every post-resize assertion retrying (`expect.poll`/auto-retrying expects) per the existing caveat — or, if diagnosis proves the non-atomic re-fit is itself the flake, see § 3.

### 3. Component-side arm (only if diagnosis proves the non-atomic re-fit is causal)

If the evidence names the `ResizeObserver`-driven measure effect in `components/gui-toolbar.tsx` as the cause (assertions reading a pre-refit DOM that never re-fits, not just a late one), make the re-fit atomic with the resize (e.g. re-measure in the same frame the spring resizes — a `useLayoutEffect`-driven or resize-event-synchronous path). This arm changes component behavior and must not regress the unit suite (`gui-toolbar-fold.test.ts`, `gui-toolbar.test.tsx`) or the fold's documented invariants (cold default, hysteresis, two-pass reserve).

### Constraints (user-set)

- **Do not weaken what the tests prove**: the four proof areas stay covered at real widths — tail-first ladder fold with `⚙` appear/disappear and panel rows, label degradation before any fold, `rk-gui-toolbar` persistence across reload, fullscreen targeting the tile. No deleting assertions in place of stability; no converting the suite to jsdom/unit coverage.
- Acceptance bar: `just test-e2e gui-toolbar-fold --repeat-each 5 --retries 0` passes **20/20** locally, and CI E2E shards pass on the PR.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) the e2e section documents this spec's approach ("the `ResizeObserver` re-fit is not atomic with the resize … every post-resize assertion retries, and fold targets are computed from the probe row's measured widths, never hardcoded") — whichever arm lands, that paragraph must reflect the new determinism mechanism; a component-side arm also touches the § GUI Surface header-fold-cluster paragraph.

## Impact

- **Primary**: `app/frontend/tests/e2e/gui-toolbar-fold.spec.ts` (helpers `measureFold`/`resizeToSpring`/`ladderWidth` + the four tests' targets).
- **Conditional (§ 3 arm only)**: `app/frontend/src/components/gui-toolbar.tsx`, `app/frontend/src/lib/gui-toolbar-fold.ts`.
- **CI reliability**: E2E shard 1 stops false-failing.
- No backend, no API, no user-visible behavior change (test-side arm); the component-side arm is internal measurement timing only.

## Open Questions

- Which layer owns each failure mode — test sizing/convergence (§ 2) or the component's non-atomic re-fit (§ 3)? Resolved empirically by the § 1 diagnosis during apply, not a user decision.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | A separate change branching off merged `main`, not an amendment to the shipped ogop change | Discussed — ogop's PR #1105 is merged; the flake pre-exists on main (3/12 local failures there), so it is new standalone work | S:95 R:90 A:95 D:95 |
| 2 | Certain | The ogop branch is not the cause | A/B evidence: identical failure modes/rate on main; the shared `lib/top-bar-overflow.ts` diff is add-only and `computeVisibleCount` is byte-identical | S:90 R:90 A:85 D:85 |
| 3 | Confident | Diagnose each failure mode to a named mechanism before fixing; the fix lands at the layer the evidence names | User CLAUDE.md: fix root causes, not symptoms; the three failure modes may have different mechanisms | S:80 R:85 A:70 D:60 |
| 4 | Confident | Test-side determinism (§ 2) is the expected fix; the component-side arm (§ 3) runs only if diagnosis proves the non-atomic re-fit causal | Test-side is lower-risk (no behavior change); the documented caveat says assertions already retry, pointing at sizing/convergence as the fragility | S:70 R:75 A:65 D:55 |
| 5 | Certain | Do not weaken what the tests prove — all four proof areas stay covered at real widths | Discussed — user accepted the goal "without weakening what the tests prove"; no assertion deletion, no jsdom conversion | S:90 R:80 A:80 D:75 |
| 6 | Confident | Acceptance: `--repeat-each 5 --retries 0` passes 20/20 locally and CI E2E shards pass on the PR | Discussed — the user approved this bar; it exceeds the observed ~25–33% flake rate with margin | S:85 R:70 A:80 D:70 |

6 assumptions (3 certain, 3 confident, 0 tentative, 0 unresolved).
