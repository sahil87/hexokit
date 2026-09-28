# Plan: HexoKit Memory Hydrate (rebrand row X3)

**Change**: 260928-zuov-hexokit-memory-hydrate
**Intake**: `intake.md`

## Requirements

### Memory: present-truth name facts

#### R1: Stale post-R0/R1/R2 name-fact lines state current naming
Memory lines that assert the product's *current* naming MUST match what shipped: `hexokit` is the long
command name, the Homebrew formula (`sahil87/tap/hexokit`), the shll roster `Name`, and the GitHub repo
(`sahil87/hexokit`); `rk` is the canonical short name, `xk` an alias, `run-kit` a legacy alias (the
formula symlinks all four). The targeted lines are `architecture/overview.md:9`, `architecture/cli.md:9`,
`build-and-release.md:15`, `toolkit-standards.md` (§ Overview self-identification, § version — PASS,
§ install-composition docs.half `run-kit` argument note), and the top-level `docs/memory/index.md`
run-kit row description. `ui/routes-and-shell.md:332` MUST name the wordmark `RunKit` (the string the
code renders), not "Run Kit".

- **GIVEN** an agent reading `architecture/overview.md`
- **WHEN** it looks up the formula/roster/long-command name
- **THEN** it reads `hexokit` (and never "until R1/R2")

#### R2: History, substrate, and code-accurate lines are untouched (D11)
The change MUST NOT edit log files, Design Decisions / change-ID citations, domain folder names or
`# run-kit …` domain headings, generic "the run-kit daemon" prose, substrate identifiers (rule P/D2), or
lines describing the web UI's live `RunKit` strings.

- **GIVEN** the diff of `docs/memory/`
- **WHEN** it is inspected
- **THEN** every hunk touches only an R1 target line

### Wiki/Specs/Context

#### R3: Competitive landscape carries the HexoKit name
`docs/wiki/competitive-landscape.md` SHALL gain one header-blockquote line naming HexoKit as the current
product name (with "run-kit" in the body being the name at time of writing), and its closing
**One-liner** SHALL lead with HexoKit. The body MUST NOT be rewritten.

- **GIVEN** a reader opening the landscape doc
- **WHEN** they read the header
- **THEN** they learn the product is now HexoKit and why the body says run-kit

#### R4: api.md update-check example reports the hexokit self row
`docs/specs/api.md`'s `/api/updates/check` response example SHALL show the self row as `hexokit`
(`tool`, `key`), and the `current`/`latest` bullet SHALL describe them as self-row compat fields
(`hexokit`, or legacy `rk`/`run-kit`).

- **GIVEN** the api.md example **WHEN** compared with `internal/updatecheck` + shll ≥ v0.1.34 **THEN** the self-row name matches

#### R5: context.md key name matches code
`fab/project/context.md` SHALL name the terminal-font localStorage key `hexokit-terminal-font-size`.

- **GIVEN** context.md **WHEN** compared with `chrome-context.tsx:24` **THEN** the key matches

### Plans: closure

#### R6: Remaining-work plan closes Phase 3
`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL mark X3 done (PR column + Status), strike
`X3` on the Order line, state Phase 3 Done in the Status paragraph and "Where we are", keep A3 stated as
open, and list the found follow-ups (web UI `RunKit` strings; npm + code-bridge names; docs/site/install.md
`run-kit` examples; constitution title).

- **GIVEN** the remaining doc **WHEN** read after merge **THEN** no Phase 3 row reads open and A3 reads open

#### R7: Master plan synced but not force-closed
`fab/plans/sahil/26-09-10-hexokit-rebrand.md` SHALL sync its Phase 3 table rows to done with pointers,
add one closing Phase 3 Status line, and MUST NOT claim the plan Done — the Status line SHALL name why
(A3 open; Brand-tier surfaces with no row).

- **GIVEN** the master doc **WHEN** read **THEN** Phase 3 rows read done and the Status states what still blocks Done

### Non-Goals

- Renaming the web UI `RunKit` strings, npm package names, code-bridge metadata, docs/site command examples, or the constitution — code/constitution changes outside X3; recorded as follow-ups
- The R2 out-of-scope `sahil87/run-kit` URL sweep — already a listed follow-up

## Tasks

- [x] T001 Edit memory name-fact lines: `docs/memory/run-kit/architecture/overview.md:9`, `docs/memory/run-kit/architecture/cli.md:9`, `docs/memory/run-kit/build-and-release.md:15`, `docs/memory/run-kit/toolkit-standards.md` (L11, L1298-1303, L1360-1362), `docs/memory/index.md:26`, `docs/memory/run-kit/ui/routes-and-shell.md:332` <!-- R1 -->
- [x] T002 Add the HexoKit header line + One-liner prefix to `docs/wiki/competitive-landscape.md` <!-- R3 -->
- [x] T003 [P] Update `docs/specs/api.md` update-check example + bullet; update `fab/project/context.md` localStorage key <!-- R4 -->
- [x] T004 Close `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` (X3 row, Order, Status, Where we are, follow-ups) <!-- R6 -->
- [x] T005 Sync `fab/plans/sahil/26-09-10-hexokit-rebrand.md` Phase 3 rows + closing Status line (not Done) <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: No memory line outside logs says the formula/roster/long-command name is `run-kit` "until R1/R2"
- [x] A-002 R3: competitive-landscape.md header names HexoKit and the One-liner leads with HexoKit; body unchanged
- [x] A-003 R4: api.md example shows `"tool": "hexokit"` / `"key": "hexokit@3.9.0"` and the bullet names the self row
- [x] A-004 R5: context.md names `hexokit-terminal-font-size`
- [x] A-005 R6: remaining doc — X3 done with PR, Order strikes X3, Phase 3 Done, A3 still open, follow-ups listed
- [x] A-006 R7: master doc — Phase 3 rows done with pointers; Status line says why the plan is not Done

### Behavioral Correctness

- [x] A-007 R2: The memory/specs diff touches only R1/R4 target lines; no log, heading, substrate, or code-accurate `RunKit` line changed

### Code Quality

- [x] A-008 Link integrity: every relative link in edited lines resolves
- [x] A-009 Pattern consistency: edits keep each file's existing prose style and citation convention (change-ID parentheticals)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Tasks carry the intake's exact line targets; no additional sweep beyond them | Intake survey read all 279 candidate lines and classified them | S:90 R:95 A:90 D:85 |
| 2 | Confident | The memory hydrate stage adds no further content — the memory edits ARE the change; hydrate verifies and logs | Docs-only change whose deliverable is memory text | S:70 R:90 A:80 D:70 |

2 assumptions (1 certain, 1 confident, 0 tentative).
