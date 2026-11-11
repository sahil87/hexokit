# Plan: Headless Run in a tmux Window — Spike (S1)

**Change**: 261111-psze-headless-run-tmux-spike
**Intake**: `intake.md`

## Requirements

### Spike: Headless launch measurements

#### R1: Per-provider headless run in an ephemeral tmux window
The spike SHALL launch the headless command resolved by `fab agent operator --headless -o yaml --provider <p>` for each of claude, codex and kimi inside a new ephemeral tmux window, feeding a synthetic ≈ 10K-token brief the way each launcher expects (stdin, argv or file). A provider that cannot be exercised (unauthenticated, no usable headless mode) MUST be recorded as a finding with the reason.

- **GIVEN** the three provider binaries are on PATH and the resolver prints a `command`/`template`
- **WHEN** the spike launches each in a window created via `rk tab new … -- sh -c "…"` (or tmux `new-window`)
- **THEN** each run either completes with captured output and exit status, or is documented as not exercisable

#### R2: Measurements
For each exercised provider the findings SHALL report start-up time, first-token time, total tokens (input/output/cache read/cache creation), and which prompt cache the run used (claude: `usage.cache_creation.ephemeral_5m_input_tokens` vs `ephemeral_1h_input_tokens`; others: whatever is observable, else "not observable"). At least two runs per provider SHOULD be taken more than 5 minutes apart so cache behaviour is observed.

- **GIVEN** a completed run with a transcript or JSON output
- **WHEN** the transcript is parsed
- **THEN** the findings table contains the four numbers per run and states the source of each

#### R3: Daemon-restart survival
The spike SHALL confirm whether a run window and its process survive an rk daemon kill/restart mid-run, using a throwaway isolated daemon (own tmux socket, own port outside the live port, own `XDG_STATE_HOME`). The live rk daemon, installed binaries and live operator state MUST NOT be touched or restarted.

- **GIVEN** a long-ish run in a window on the isolated socket and an isolated `rk serve` running
- **WHEN** the isolated daemon is killed (SIGTERM and SIGKILL trials) and a fresh one started
- **THEN** the run window/process continues and completes, and the findings record the result

### Deliverable

#### R4: Findings file, no production code
The only committed output SHALL be `fab/plans/sahil/26-11-11-headless-run-spike.md`: measurements, exact commands, surprises, cost incurred, and a recommendation for R5 (including any R5 brief assumption the data contradicts). No edits under `app/`, `scripts/`, `docs/memory/`, `docs/specs/`. Throwaway scripts stay in the scratchpad. The file MUST NOT contain credentials or full transcripts.

- **GIVEN** the spike is done
- **WHEN** `git diff --stat main` is inspected
- **THEN** only the findings file and `fab/changes/261111-psze-headless-run-tmux-spike/` differ

### Non-Goals

- R5's cron/check/loop wiring, the real run brief (R4), UI, and changes to `fab agent` / `rk tab` — gaps found are listed as follow-ups in the findings.

## Tasks

### Phase 1: Setup

- [x] T001 Resolve the headless launcher for claude/codex/kimi (`fab agent operator --headless -o yaml --provider <p>`), generate the ≈ 40KB synthetic brief and a wrapper script (timestamps, tee, exit status) in the scratchpad; check provider auth with a tiny prompt <!-- R1 -->

### Phase 2: Experiments

- [x] T002 Run each provider in an ephemeral window on an isolated tmux socket, capture start-up/first-token times and transcripts; repeat > 5 min apart <!-- R1, R2 -->
- [x] T003 Parse transcripts for tokens and cache TTL fields (5m vs 1h) per run <!-- R2 --> <!-- blocked: no provider authenticated; documented as finding + recipe -->
- [x] T004 Start an isolated rk daemon (own socket/port/XDG_STATE_HOME), launch a long-ish run, kill the daemon (SIGTERM, then SIGKILL), restart, and record window/process survival <!-- R3 -->

### Phase 3: Write-up

- [x] T005 Write `fab/plans/sahil/26-11-11-headless-run-spike.md` with the tables, commands, cost, and R5 recommendation <!-- R4 -->

## Execution Order

- T001 → T002 → T003; T004 can run while waiting out the > 5 min gap in T002; T005 last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: Each of claude, codex, kimi is either run in an ephemeral window or documented as not exercisable with a reason
- [x] A-002 R2: Findings give start-up, first-token, total tokens and cache-TTL evidence per exercised provider, with sources — **N/A**: no provider was authenticated, so none was exercised end-to-end; start-up (window→wrapper→provider error) is reported, and first-token/tokens/cache are explicitly marked "Not measured (no auth)" with a recipe to finish
- [x] A-003 R3: Findings state whether the window survived SIGTERM and SIGKILL of an isolated daemon, and that a fresh daemon rediscovered it
- [x] A-004 R4: Findings file exists at `fab/plans/sahil/26-11-11-headless-run-spike.md` with an R5 recommendation

### Behavioral Correctness

- [x] A-005 R3: The live rk daemon, installed binaries and live operator state were not touched (no restart, no install, no writes to live state)

### Scenario Coverage

- [x] A-006 R2: Cache finding is observed from ≥ 2 runs per provider spaced > 5 min apart, or the gap is stated <!-- gap stated: Verdict + "Which prompt cache: Not measured (no auth)" -->

### Edge Cases & Error Handling

- [x] A-007 R1: Unauthenticated/unsupported providers are reported as findings, not hidden

### Code Quality

- [x] A-008 Pattern consistency: Findings file follows the `fab/plans/sahil/` doc convention
- [x] A-009 No unnecessary duplication: No production code or scripts committed

### Security

- [x] A-010 R4: No credentials or full transcripts in the findings file; spike processes ran via argv/`sh -c` wrappers with no secrets in commands

## Notes

- Check items as you review: `- [x]`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Spike windows live on an isolated tmux socket (`-L s1spike`), not the live socket | Resolves the intake open question toward no dashboard pollution and no live-state contact | S:75 R:90 A:80 D:70 |
| 2 | Confident | If a provider is unauthenticated it is recorded as "not exercised" rather than blocking | Intake open question; brief's goal is answers, not forced success | S:70 R:90 A:80 D:75 |

2 assumptions (0 certain, 2 confident, 0 tentative).
