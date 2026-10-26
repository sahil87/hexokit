# Plan: Fix Shared Agent Paste Submission

**Change**: 261026-ejam-fix-shared-agent-paste-submission
**Intake**: `intake.md`

## Requirements

### Injection: Recognize Fresh Paste Evidence

#### R1: Supported collapsed paste representations

The shared `internal/inject` engine MUST recognize Codex's observed `[Pasted Content 1433 chars]` representation, including successive occurrences whose displayed suffix is `#2`, `#3`, and so on. It MUST preserve Claude's `[Pasted text #N +M lines]` and `[Pasted text #N]` forms and raw-text echoes. Additional agent-specific collapsed forms SHALL be supported when actual installed-agent observations establish their syntax. Recognition MUST remain centralized in the shared engine, without a cron-specific submit workaround or guessed renderer formats.

- **GIVEN** a collapsible payload and a capture containing no new raw-text echo
- **WHEN** Codex renders a new collapsed paste marker after that payload is pasted
- **THEN** the novelty probe recognizes the added marker and `submit=true` proceeds to Enter.
- **AND** two occurrences are counted independently even when their character counts are identical.

#### R2: Existing safety and insertion contracts

The engine MUST retain strict growth against the pre-paste baseline, the collapsible/image shape gates, ANSI/whitespace/frame normalization, control-byte sanitization, pane-mode guard, per-pane serialization, named-buffer locking, popup handling, context deadlines, and bounded evidence-gated recovery. Stale markers alone MUST NOT authorize Enter. `submit=false` MUST leave the verified paste staged without Enter. `ProbeFailure`, `StagedSendFailure`, and `SubmitUnverified` MUST retain their existing meanings. This change MUST NOT introduce unconditional Enter, speculative composer clearing, or changes to live user panes.

- **GIVEN** a Codex or Claude marker already in the baseline
- **WHEN** the post-paste captures contain no additional echo evidence
- **THEN** the engine returns a probe failure and sends no Enter.
- **GIVEN** a fresh recognized marker with `submit=false`
- **WHEN** the probe succeeds
- **THEN** no submit or popup-consuming Enter is sent.

### Delivery: Common Engine and Repeatability

#### R3: Cron and ordinary-tab submission

Cron MUST continue to request `submit=true` through the same engine used by direct and operator delivery. The regression verification MUST exercise the real cron delivery path against an ordinary Codex tab and repeated successful firings. Each firing MUST produce one intended agent turn, with no newly accumulated unsubmitted paste. No change to schedule evaluation, persistence, targeting, or retry policy is required by this compatibility fix. Any additional necessary behavioral change MUST be recorded in this plan before implementation.

- **GIVEN** an idle ordinary Codex test tab and a cron prompt with a 1,433-character single line
- **WHEN** the isolated scheduler delivers the prompt, and later delivers another prompt after completion
- **THEN** the agent receives and responds to both prompts separately, without accumulating unsent chips.
- **AND** a role-only comparison for Claude and Codex demonstrates equivalent submission in an operator-marked test tab, without launching an autonomous operator workflow.

### Verification: Real Agents and Reviewable Evidence

#### R4: Seven-agent verification matrix

Playwright verification MUST inventory Claude Code, Codex, Gemini CLI, Copilot CLI, Kimi, OpenCode, and Antigravity from the runtime registry. For each runnable agent it MUST exercise short single-line, 1,433-character single-line, multiline, and successive-delivery cases in ordinary tabs, using harmless unique acknowledgement prompts. Actual responses/turns and the composer state MUST establish submission; HTTP success, a `delivered` log, or any changed frame alone is insufficient. Agent versions, observed marker formats, scenario outcomes, and unavailable/blocked cases MUST be recorded accurately. Unverified integrations MUST NOT be claimed as passing, and mocks MUST NOT substitute for real-agent compatibility evidence.

- **GIVEN** a runnable authenticated supported CLI in a dedicated test tab
- **WHEN** the browser observes the real delivery scenarios
- **THEN** the matrix records the observed response, submission result, and applicable renderer representation.
- **GIVEN** an agent is absent or cannot pass authentication/startup prerequisites
- **WHEN** verification reaches that agent
- **THEN** its matrix row records the concrete limitation as unverified and does not falsely satisfy a compatibility claim.

#### R5: Isolation and before/after recordings

Tests and recordings MUST use the repository's `just` harness with throwaway tmux sockets, state/config homes, work directories, and ports. They MUST NOT touch the live `loom` server, live cron registry, or existing user agents. `just setup` is complete for this worktree. `just demo` MUST record base `ef50f162895d1a480024f43b237f54b04a711afa` and the fixed tree with comparable scenarios, showing the Codex failure before and actual submission after. Desktop and mobile browser evidence is required; shell recordings become required if shell-only paths are changed. Recordings MUST remain untracked, be labeled by agent/scenario/viewport, and be attached inline in the PR body by the orchestrator. Missing evidence MUST be identified explicitly.

- **GIVEN** the same isolated demo scenario on the base and fixed trees
- **WHEN** a collapsed Codex prompt is delivered
- **THEN** the before recording shows the staged failure and the after recording shows the intended response.
- **AND** available-agent evidence and a result matrix accompany the recordings in the PR.

#### R6: Regression and project checks

Meaningful engine regressions MUST prove send ordering, freshness, normalization, insertion-only behavior, and repeated delivery using the existing fake-tmux seam. All required project checks MUST run through `just` recipes: backend tests, frontend type check, the full test suite, and production build. New Playwright tests MUST carry the repository's intent and setup comments. Unrelated infrastructure failures, if encountered, MUST be diagnosed and reported accurately rather than hidden or fixed by weakening the tests.

- **GIVEN** the fixed implementation and the existing safety suite
- **WHEN** the focused regressions and required project gates run
- **THEN** the new behavior is covered and the prior contracts continue to pass, with exact commands/results retained for review.

### Non-Goals

- Redesigning cron retries, scheduler persistence, or automatic recovery of the user's accumulated prompt copies.
- Changing agent authentication, installing hooks globally, or sending instructions into live user sessions.
- Adding public APIs, configuration knobs, or a parallel injection engine for one provider.

### Design Decisions

#### Extend evidence recognition within the existing engine

**Decision**: Add observed renderer representations to the shared echo predicate while preserving its baseline comparison and submission sequence.

**Why**: Cron already requests submission; its failure is the unrecognized Codex rendering before Enter. Shared recognition benefits all callers and also supplies post-Enter recovery evidence.

**Rejected**: An unconditional extra Enter or cron-only provider branch would bypass or duplicate the existing delivery contract.

*Introduced by*: 261026-ejam-fix-shared-agent-paste-submission

## Tasks

### Phase 1: Reproduction and Fixture

- [x] T001 Add an isolated real-agent Playwright fixture and demo under `app/frontend/tests/demo/_agent-injection.ts` and `app/frontend/tests/demo/agent-injection.demo.ts` (factor only necessary reusable support into existing harness helpers). Inventory all seven agents, capture actual renderer behavior, and record the base Codex failure through the real cron delivery path. Record prerequisites and the exact base in `fab/changes/261026-ejam-fix-shared-agent-paste-submission/verification.md`. <!-- R3 --> <!-- R4 --> <!-- R5 -->

### Phase 2: Shared Engine Fix

- [x] T002 Add failing behavioral regressions in `app/backend/internal/inject/inject_test.go` for fresh and stale Codex chips, numbered repeated occurrences, insert-only sends, normalized/wrapped markers, and successful successive submissions. Retain existing Claude/image/popup/recovery coverage and use `just test-backend` to verify the regression is real before fixing it. <!-- R1 --> <!-- R2 --> <!-- R6 -->
- [x] T003 Update `app/backend/internal/inject/inject.go` to recognize the observed Codex representation and any other empirically demonstrated missing forms, preserving shape gates and safety semantics; update focused comments to describe the resulting contract. Confirm cron still uses the common `submit=true` path in `app/backend/internal/cron/deliver.go`, adding targeted coverage in `deliver_test.go` only if it proves behavior not already covered. <!-- R1 --> <!-- R2 --> <!-- R3 -->

### Phase 3: Real-Agent Verification and Evidence

- [x] T004 Run the real-agent Playwright matrix using the fixture/demo for every supported agent that can run, including short/long/multiline/repeated cases and Claude/Codex role comparisons. Record versions, response evidence, observed marker forms, and exact blocked/unverified cases in `fab/changes/261026-ejam-fix-shared-agent-paste-submission/verification.md`; resolve genuine compatibility defects within R1/R2. <!-- R3 --> <!-- R4 -->
- [x] T005 Produce reviewable before/after recordings with `just demo agent-injection --before ef50f162895d1a480024f43b237f54b04a711afa` (or equivalent agent-specific demo names using the same harness), covering desktop/mobile and real submission outcomes. Inspect the captured evidence and record untracked artifact paths, labels, results, and any missing evidence in `verification.md` for the orchestrator's PR attachment step. <!-- R5 -->

### Phase 4: Validation

- [x] T006 Run `just test-backend`, `just check`, `just test`, and `just build` as applicable required gates; inspect the final diff for scope and preserve meaningful regression/test-intent coverage. Record commands, results, and any diagnosed environmental limitations in `verification.md`; do not commit videos or credentials. <!-- R2 --> <!-- R6 -->

## Execution Order

T001 establishes real renderer observations and a reproducible before scenario. T002 proves the original regression, T003 fixes it, and T004/T005 verify and record the fixed behavior. T006 runs final gates after the last implementation change. Reuse already-recorded before runs if the scenario is unchanged. The orchestrator attaches the produced evidence when opening the draft PR, before independent review.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: Fresh Codex collapsed pastes, including numbered repetitions, authorize submission through the shared engine; Claude and raw-text paths remain supported.
- [ ] A-002 R3: An isolated real cron delivery into an ordinary Codex tab produces the expected agent turn and successful subsequent delivery without accumulated unsent chips.
- [ ] A-003 R4: The verification matrix accounts for all seven agents with actual versions and pass/fail/unverified outcomes; runnable agents have short/long/multiline/repeat coverage and Claude/Codex have role comparisons.
- [ ] A-004 R5: Comparable before/after recordings show the Codex bug and corrected outcome on desktop and mobile, are available as inline PR attachments, and missing coverage is explicitly identified.

### Behavioral Correctness

- [ ] A-005 R2: Stale markers alone fail closed; insertion-only sends issue no Enter; existing failure taxonomy, popup handling, and bounded recovery remain intact.
- [ ] A-006 R1: ANSI styling, whitespace wrapping, and repeated identical character-count markers do not defeat or falsely satisfy recognition.
- [ ] A-007 R3: Cron scheduling, target resolution, and persistence remain unchanged unless a necessary extension was documented before implementation.

### Scenario Coverage

- [ ] A-008 R6: Focused regressions demonstrate the original Codex failure and fixed send behavior without replacing real-agent verification with mocks.
- [ ] A-009 R4: Real responses and composer state support submission claims; delivery logs and frame changes are only supporting evidence.
- [ ] A-010 R6: Required `just` checks have recorded outcomes and any environmental failures are diagnosed without weakening correct expectations.

### Security

- [ ] A-011 R2: Sanitization, explicit pane/server arguments, mode guard, locks, and shared deadline remain preserved; no unconditional Enter or speculative clearing is added.
- [ ] A-012 R5: Verification touches only dedicated test resources and commits no videos, secrets, or live agent/cron state.

### Code Quality

- [ ] A-013 Pattern consistency: Changes follow surrounding Go and Playwright naming, error handling, type-narrowing, and module patterns.
- [ ] A-014 No unnecessary duplication: The existing injection engine, fake tmux seam, test rig, and demo fixture are reused; no redundant provider dispatch layer is introduced.
- [ ] A-015 Focused implementation: Functions remain focused, constants name meaningful thresholds, and comments explain constraints rather than narrating code or change history.
- [ ] A-016 Process execution: Go subprocesses use context/timeouts and argv slices; new test helpers bound subprocess execution and target explicit test sockets.
- [ ] A-017 Test coverage: New behavior has meaningful tests, and any added Playwright e2e tests include the required Proves/Steps and shared-setup comments.
- [ ] A-018 Scope: No new production dependencies, client polling, public endpoints, settings surfaces, or unrelated refactors appear.

## Notes

- Apply checks off tasks only; independent review owns Acceptance and Deletion Candidates.
- Apply produces recording files and `verification.md`; the orchestrator owns git/PR writes and attaching the evidence.
- Missing binary/authentication is reported as unverified, never as a successful real-agent run. Existing live prompt accumulation is left untouched.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Keep one common probe predicate and expand only observed marker formats. | The confirmed defect and existing engine architecture determine the minimal production boundary. | S:100 R:95 A:100 D:100 |
| 2 | Certain | Use the existing browser demo lane because no shell-specific behavior changes are planned. | The terminal workflow is visible on desktop and mobile; Constitution requires shell recordings only for shell-specific changes or differing engines. | S:95 R:95 A:95 D:95 |
| 3 | Confident | Treat unavailable providers as explicit verification gaps while continuing available cases. | The user-requested all-agent matrix and Constitution require transparent reporting; missing local prerequisites are not compatibility passes. | S:85 R:90 A:80 D:80 |
| 4 | Certain | Leave live accumulated text and cron policy untouched. | The user authorized a shared engine fix and isolated verification, not intervention in live sessions or a scheduler redesign. | S:95 R:95 A:95 D:95 |

4 assumptions (3 certain, 1 confident, 0 tentative).
