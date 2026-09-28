# Plan: Consolidate R2 evidence into the HexoKit rebrand Phase 3 plan doc

**Change**: 260928-jor0-hexokit-r2-plan-doc-consolidate
**Intake**: `intake.md`

## Requirements

### Plan Doc: R2 Row Consolidation

#### R1: R2 row marks all four sub-steps done, matching the R1 row's convention
The R2 table row in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL
have its Scope cell rewritten to mark sub-steps (a)-(d) done inline, each as a
`**(x) DONE — ...:**` fragment folded into the flowing cell — mirroring the R1
row's exact established convention — with PR links collected in the PR column
and the Status column reduced to a one-line "done" summary.

- **GIVEN** the R2 row currently reads "not started" with an empty PR column
- **WHEN** the row is rewritten
- **THEN** the Scope cell contains four `(a)`/`(b)`/`(c)`/`(d)` DONE fragments carrying the evidence below, the PR column lists every PR link for (b)/(c)/(d), and the Status column reads a "done" summary
- **AND** the sub-step evidence exactly reflects: (a) GitHub repo rename `sahil87/run-kit`→`sahil87/hexokit`, 2026-09-28, via `gh auth switch --user sahil87`, switched back after, redirects verified (web/clone/API), no PR (account-level action); (b) shll roster `Repo`→`hexokit`, [shll#104](https://github.com/sahil87/shll/pull/104) merged, released shll v0.1.35; (c) hexokit-site slug-table + both refresh crons, [hexokit-site#12](https://github.com/sahil87/hexokit-site/pull/12) merged + follow-up [hexokit-site#13](https://github.com/sahil87/hexokit-site/pull/13) merged (carried forward 2 commits dropped by a merge race), both crons ran successfully, `versions.json`'s `run-kit` key deliberately left as-is; (d) run-kit badges/homepage/formula-template URLs, [hexokit#1060](https://github.com/sahil87/hexokit/pull/1060) merged, plus the sahil87 profile duplicate-PR note and the six-companion-repo check (fab-kit, wt, idea, tu, hop) with no live-URL changes needed

#### R2: The doc's own convention (not a new one) governs the exact prose
The rewrite SHALL reuse the R1 row's phrasing patterns (e.g. "**(a) DONE —
...:**", "merged", em-dash separated clauses) rather than introducing a new
visual convention for R2.

- **GIVEN** the R1 row already establishes this doc's DONE-sub-step convention
- **WHEN** R2's row is rewritten
- **THEN** a reader comparing R1 and R2 rows sees the same structural pattern (inline lettered DONE fragments, PR column, one-line Status)

### Plan Doc: Traceability and Follow-ups

#### R3: The updatecheck.go bugfix is cross-referenced, not re-documented as a new row
A short note SHALL appear near/after the R2 row (fitting the doc's existing
convention of folding a caused-by-this-work bugfix into nearby prose, as the
R1 row already does for its own follow-up) recording that R2(c) surfaced the
`updatecheck.go` hardcoded-`run-kit` self-recognition bug, fixed and merged as
[hexokit#1061](https://github.com/sahil87/hexokit/pull/1061), shipped in
release v3.20.23. It is explicitly NOT a new table row.

- **GIVEN** the R1 row's own "Follow-up (run-kit) DONE" text already narrates this same PR/fix without stating the release version
- **WHEN** the R2-side note is added
- **THEN** it is prose (not a table row), links hexokit#1061, states release v3.20.23, and reads as a pointer/cross-reference rather than a duplicate full narration

#### R4: Two open follow-ups are recorded, not filed
The doc SHALL record, near the R2 row, that (i) hexokit-site's `versions.json`
`run-kit` key can now be flipped to `hexokit` (unblocked by the updatecheck.go
fix) and (ii) the broader out-of-scope `sahil87/run-kit` URL sweep from R2(d)
(README raw image URLs, `DefaultRepo` in `internal/desktop/desktop.go`,
`vapidSubscriber` in `internal/push/send.go`, frontend doc-link constants in
`global-chrome.tsx`/`row-flyout-card.tsx`, docs/site back-links) are open,
not-yet-filed follow-ups — matching the doc's existing "Follow-up (shll, not
yet filed): ..." convention. Neither follow-up SHALL be filed (no Linear
issue, no new plan row) as part of this change.

- **GIVEN** the doc already has a precedent for recording an unfiled follow-up inline (R1 row's shll `install.sh` note)
- **WHEN** the two follow-ups above are added
- **THEN** each is clearly marked as not yet filed and no external tracker entry is created by this change

### Plan Doc: Status Rollup

#### R5: Order line reflects R2 done
The `Order:` line SHALL strike through `R2` (matching the existing `~~R0~~ →
~~C4~~ → ~~C5~~ → ~~R1~~` strikethrough pattern) so only `X3` remains unstruck
as the sole outstanding item.

- **GIVEN** the Order line currently reads `... ~~R1~~ · R2 (any time after A3) → X3.`
- **WHEN** the line is updated
- **THEN** it reads with R2 struck through in the same style as the other completed phases, leaving X3 as the only non-struck remaining step

#### R6: Top-of-doc prose reflects R2 done
The "Where we are" paragraph and the "Status (2026-09-28)" paragraph SHALL be
updated so neither claims R2 is outstanding: the "Still on the old name: the
GitHub repo `sahil87/run-kit` (R2) is the only public rename surface left"
framing SHALL be replaced with language reflecting the completed rename, and
the "R2 and X3 not started" closing SHALL become an R2-done, X3-only framing.
Exact wording is left to the writer's judgment as long as it accurately
reflects state and matches the doc's terse, evidence-dense style — this is a
Confident-graded assumption (see `## Assumptions`).

- **GIVEN** both paragraphs currently describe R2 as not-yet-done
- **WHEN** they are rewritten
- **THEN** neither paragraph contradicts the R2 row's new "done" status, and X3 is named as the sole remaining item

### Non-Goals

- Filing the two open follow-ups (versions.json key flip, out-of-scope URL sweep) as Linear issues or new plan rows — explicitly out of scope (R4)
- Marking X3's row done or altering its content — explicitly out of scope per the dispatch instructions
- Any code, test, or non-plan-doc file change — this is a docs-only bookkeeping change confined to `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`

## Tasks

### Phase 1: Core Implementation

- [x] T001 Rewrite the R2 row's Scope cell in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` (the `| R2 | run-kit → shll → hexokit-site → satellites | ... |` row in the Phase 3 table) to mark (a)-(d) done inline per the R1 row's exact convention, populate the PR column with the (b)/(c)/(d) links, and set Status to a "done" summary <!-- R1 -->
- [x] T002 Add the updatecheck.go bugfix cross-reference note near/after the R2 row, linking hexokit#1061 and release v3.20.23 <!-- R3 -->
- [x] T003 Add the two open-follow-up notes (versions.json key flip; out-of-scope URL sweep) near the R2 row, clearly marked not-yet-filed <!-- R4 -->

### Phase 2: Integration & Rollup

- [x] T004 Update the `Order:` line to strike through R2, leaving X3 unstruck <!-- R5 -->
- [x] T005 Update the "Where we are" paragraph (drop the "R2 is the only public rename surface left" framing) and the "Status (2026-09-28)" paragraph's closing ("R2 and X3 not started") to reflect R2 done, X3 remaining <!-- R6 -->

## Execution Order

- T001-T003 touch the same row/area and are done as one coherent edit pass before T004-T005
- T005 depends on T001 being complete (the rollup prose references R2's new status)

## Acceptance

### Functional Completeness

- [x] A-001 R1: The R2 row's Scope cell contains four `(a)`-`(d)` DONE fragments with the exact evidence specified in R1, and the PR column lists shll#104, hexokit-site#12, hexokit-site#13, and hexokit#1060
- [x] A-002 R2: The R2 row's prose structurally matches the R1 row's DONE-sub-step convention (visually comparable side-by-side)
- [x] A-003 R3: A cross-reference note near the R2 row links hexokit#1061 and states release v3.20.23, and is not formatted as a new table row
- [x] A-004 R4: Both open follow-ups are recorded near the R2 row, each explicitly marked not-yet-filed, and neither was filed as an issue or new row by this change
- [x] A-005 R5: The `Order:` line shows `~~R2~~` (or equivalent strikethrough) with X3 as the only remaining non-struck item
- [x] A-006 R6: Neither the "Where we are" nor the "Status" paragraph states or implies R2 is still outstanding

### Behavioral Correctness

- [x] A-007 R6: The doc's Status/Order sections, read together, are internally consistent (no paragraph contradicts the R2 row's "done" state)

### Scenario Coverage

- [x] A-008 R1: A reader following the doc from top (Status paragraph) to the Phase 3 table to the Order line sees a consistent "R2 done, X3 remaining" narrative at every point

### Edge Cases & Error Handling

- [x] A-009 R4: X3's row is untouched (byte-identical) by this change — confirmed via `git diff` (no `+`/`-` line matches `| X3 |`)

### Code Quality

- [x] A-010 Pattern consistency: New prose follows the doc's existing terse, evidence-dense, link-heavy markdown style (matches surrounding rows/paragraphs)
- [x] A-011 No unnecessary duplication: The updatecheck.go bugfix is referenced, not re-narrated in full (R1's row already carries the full narration; this change adds only the release-version pointer)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Docs-only, `change_type: docs` — per `plan.md` template's review-owned parser contract, the parsimony pass and Deletion Candidates section are silently skipped for `docs` changes

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | R2's Scope-cell rewrite reuses the R1 row's exact `(x) DONE — ...:` sub-step convention | Directly observed in the current doc; explicit dispatch instruction to match it | S:90 R:95 A:95 D:95 |
| 2 | Certain | The updatecheck.go bugfix gets a short cross-reference near R2, not a duplicate full narration or a new row | Explicit dispatch instruction ("not itself a plan row... traceable from here"); R1's row already fully narrates the fix, R2's note adds only the release-version pointer | S:85 R:80 A:85 D:85 |
| 3 | Certain | Neither open follow-up is filed as a Linear issue or new plan row in this change | Explicit dispatch instruction: "not yet filed, don't file them, just record them" | S:95 R:95 A:95 D:95 |
| 4 | Certain | X3's row is not touched | Explicit dispatch instruction: "Do NOT touch X3's row or mark it done" | S:95 R:95 A:95 D:95 |
| 5 | Confident | Exact wording of the top-of-doc "Where we are" / "Status" paragraph rewrites is left to the writer, constrained only by accuracy and style-matching | Instruction specifies the required outcome (reflect R2 done, only X3 remaining) but not exact phrasing | S:65 R:70 A:75 D:70 |
| 6 | Confident | No `## Design Decisions` or `## Deprecated Requirements` subsections are needed — this is additive/status-rollup prose, not an architectural decision or a requirement removal | The change adds evidence and updates status framing; it does not introduce a new design choice or deprecate any prior plan-doc requirement | S:70 R:75 A:80 D:75 |

6 assumptions (4 certain, 2 confident, 0 tentative).
