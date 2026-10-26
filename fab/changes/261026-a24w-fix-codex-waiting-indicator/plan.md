# Plan: Fix Codex waiting indicator

**Change**: 261026-a24w-fix-codex-waiting-indicator
**Intake**: `intake.md`

## Requirements

### Agent lifecycle

#### R1: Automatic review is active
Codex permission telemetry MUST distinguish automatic approval evaluation from a human reviewer using effective conversation context. An unverified permission event SHALL NOT manufacture human waiting.

- **GIVEN** a Codex turn using `approvals_reviewer=auto_review`
- **WHEN** `PermissionRequest` fires
- **THEN** the pane remains active without the attention pulse.
- **GIVEN** a verified human reviewer
- **WHEN** approval is requested and subsequently answered
- **THEN** waiting is shown until tool execution resumes, followed by active and eventual idle.

#### R2: Genuine questions retain attention
Accepted asynchronous Codex questions MUST remain waiting across unrelated tool execution and turn completion until answered or cancelled. Blocking questions MUST wait while their tool is pending and clear after resolution.

- **GIVEN** a displayed unanswered question
- **WHEN** another tool executes or the agent finishes its response
- **THEN** attention remains visible.
- **GIVEN** a question reply, interrupt, or session termination
- **WHEN** its lifecycle hook fires
- **THEN** the resulting state has no stale question attention.

#### R3: Conversation ownership
Confirmed child/reviewer conversations MUST NOT overwrite the pane's root lifecycle or identity. Legitimate root startup, resume, clear, and compaction SHALL continue to work.

- **GIVEN** a transcript whose `session_meta.source` identifies a subagent
- **WHEN** an ordinary lifecycle hook fires with the inherited tmux environment
- **THEN** neither state nor identity changes.

#### R4: Compatibility and bounded telemetry
Hooks MUST remain silent, exit zero, perform bounded reads, emit no permission decisions, retain the three-state wire contract, and preserve Claude behavior. Installer changes MUST preserve unrelated hooks and idempotence.

- **GIVEN** missing, malformed, oversized, or mismatched Codex context
- **WHEN** a hook runs
- **THEN** it degrades without blocking the agent or claiming unverified human attention.
- **GIVEN** Claude working, question, resume, and completion hooks
- **WHEN** they fire
- **THEN** the existing active/waiting/active/idle sequence remains intact.

#### R5: Observable verification
Verification MUST exercise deterministic lifecycle regressions, actual Codex integration, and Playwright on a throwaway rig. Comparable before/after desktop/mobile recordings MUST be produced with `just demo`; unavailable cases MUST be stated explicitly rather than reported passing.

- **GIVEN** automatic review and real human waiting scenarios
- **WHEN** the base and changed binaries drive the dashboard
- **THEN** recordings show false attention removed and genuine attention retained and cleared.

### Design Decisions

#### Use effective transcript context
**Decision**: Read Codex's own session metadata and current turn context from the hook-supplied transcript, validating session identity and bounding filesystem work.
**Why**: Codex 0.164.0 includes the effective reviewer in `turn_context`, while the recorded `PermissionRequest` payload does not. Global configuration cannot describe per-session overrides.
**Rejected**: Global configuration guesses, timeouts, and hiding the frontend pulse; each can misclassify a real request or leave other waiting consumers incorrect.
*Introduced by*: 261026-a24w-fix-codex-waiting-indicator

#### Bound the transcript projection
**Decision**: Read at most 64 KiB for session metadata and the last 8 MiB for current turn and question facts; unknown reviewer context does not produce permission attention.
**Why**: Hook execution must stay bounded even for very long conversations, and a raw permission check does not prove a human prompt. The native source remains authoritative without introducing another persisted state representation.
**Rejected**: Unbounded transcript scans, global configuration fallback, and a second pending-question state schema.
*Introduced by*: 261026-a24w-fix-codex-waiting-indicator

## Tasks

### Phase 1: Runtime contract

- [x] T001 Record verified Codex event shapes and choose bounded context projection in `app/backend/cmd/rk/agent_hook_codex.go`. <!-- R1 -->
- [x] T002 Implement Codex reviewer and root-session filtering in `app/backend/cmd/rk/agent_hook.go` and `agent_hook_codex.go`. <!-- R1 R3 -->

### Phase 2: Lifecycle and regressions

- [x] T003 Implement question/resume/cancel handling and installer mappings in `app/backend/cmd/rk/agent_hook_codex.go` and `agent_setup.go`. <!-- R2 -->
- [x] T004 Add deterministic regressions and installer coverage in `app/backend/cmd/rk/agent_hook_codex_test.go` and `agent_setup_markers_test.go`; run through `just test-backend`. <!-- R1 R2 R3 R4 -->

### Phase 3: Workflow verification

- [x] T005 Add browser lifecycle checks and before/after desktop/mobile demo under `app/frontend/tests/e2e/` and `app/frontend/tests/demo/`. <!-- R5 -->
- [x] T006 Exercise isolated actual Codex integration and record verification results/limitations in `fab/changes/261026-a24w-fix-codex-waiting-indicator/verification.md`; run repository quality gates. <!-- R5 -->

### Phase 4: Review rework

- [x] T007 Track unresolved synchronous Plan-mode questions across unrelated tool events and resolution. <!-- R2 -->
- [x] T008 Reconcile manual approval resolution from an authoritative live runtime signal before tool completion; extend integration verification. <!-- R1 R5 -->

### Phase 5: Timestamp review rework

- [x] T009 Clear unknown transition epochs when runtime reconciliation changes state, propagate the state/epoch pair through both readers, and verify idle backoff does not inherit permission-wait age. <!-- R4 -->

### Phase 6: Question cancellation review rework

- [x] T010 Preserve asynchronous questions across ordinary user messages; clear only matching replies or verified lifecycle cancellation, with partial-answer and steering regressions. <!-- R2 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: Automatic review never generates waiting; verified human approval does and clears on resume. **Review:** effective-reviewer regressions and the isolated runtime approval exercise establish active before tool completion, subject to the documented runtime availability limits.
- [x] A-002 R2: Accepted async questions retain attention across ordinary tool churn and Stop; answer/cancel clears it. **Review:** matching-reply, partial-sibling, ordinary-steering, mixed-content, and explicit-cancellation regressions pass. The shared projection preserves pending async questions through hook writes and runtime reconciliation; blocking questions retain their separate call-ID completion boundary.
- [x] A-003 R3: Subagent events cannot change root identity/state; root session rotation and compact remain valid.
- [x] A-004 R4: Silent bounded hooks and installation compatibility remain intact, with Claude lifecycle regression coverage.
- [x] A-005 R5: Actual integration and Playwright results are documented accurately; before/after desktop and mobile recordings are ready to attach.

### Code Quality

- [x] A-006: Implementation follows neighboring naming, error-handling, and module patterns without unnecessary duplication. **Review:** runtime reconciliation clears the unavailable transition epoch to zero, both readers propagate the state/epoch pair, and real tmux plus cron regressions verify that permission-wait age cannot become an idle backoff anchor.
- [x] A-007: Functions remain focused and constants name resource bounds; no shell construction or new client polling is introduced.
- [x] A-008: Durable state remains authoritative and new behavior has meaningful automated regression coverage. **Review:** fresh affected checks passed through `just test-backend` with `-count=1`, including the private runtime protocol, real tmux reader agreement, hook/installer behavior, and cron epoch regressions (`/tmp/a24w-independent-review-tests.log`). Runtime reconciliation performs no tmux writes.

### Security

- [x] A-009 R4: Transcript reads cannot block on special files and do not consume unbounded input; hook output contains no approval decisions.

## Notes

The root orchestrator owns PR evidence attachments. Focused backend checks, nine desktop/mobile browser cases, and actual Codex automatic-review and manual-approval integration passed. `verification.md` records broader-suite results and compatibility limits. Acceptance checkboxes belong to the independent reviewer.

Manual approval resume is reconciled on existing dashboard and mux reads. `internal/codexstatus` reads `thread/read` summaries through the local managed-daemon Unix WebSocket; it never resumes, subscribes to, or mutates a conversation. A batch shares a 300 ms deadline, one connection, at most 32 distinct validated session IDs, a 2 MiB message limit, and at most 64 intervening notifications per response. Only Codex panes already marked waiting are candidates. Runtime `active` with an explicit empty flag list, or `idle`, clears attention only when the returned transcript path validates the same root session and the shared `internal/codexstate` projection proves no pending question. All attention consumers retain the existing three-state vocabulary and hook options; no extra marker, cache, polling loop, or tmux write is introduced.

Fallback limits: the socket uses the rk process's `CODEX_HOME`, or `~/.codex`; a different per-pane home is not discovered. Standalone `--no-daemon`, a missing/unresponsive/incompatible socket, absent runtime transcript path, unknown status/flags, or a thread outside the bounded batch leaves hook state unchanged. Missing/malformed metadata, incomplete/concurrently appended transcripts, and files exceeding the 8 MiB projection window cannot prove absence of questions, so they also retain hook state. In these fallback cases a manual approval can still remain waiting until `PostToolUse` or another lifecycle hook; immediate clearing is not claimed. Known pending async and blocking questions always retain attention regardless of an active runtime status. Confirmed subagent sources are suppressed, but separate non-subagent root conversations sharing one process/pane remain outside the verified ownership result.

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. Hook writes and both runtime read paths share the bounded transcript projection; the existing state/session compatibility reads and lifecycle fallbacks remain in use.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Codex 0.164.0 transcript metadata is the effective reviewer and child-ownership source. | Verified temporary-rig transcripts include reviewer overrides and guardian source, unlike hook payloads. | S:85 R:80 A:65 D:75 |
| 2 | Certain | Keep UI rendering and the existing three-state wire format. | The frontend correctly pulses only for waiting; the defect is upstream classification. | S:100 R:95 A:95 D:100 |
| 3 | Certain | Use isolated fixtures and sandboxed workers; leave user-global hooks alone. | Explicit user instruction and recovery scope. | S:100 R:100 A:100 D:100 |

3 assumptions (2 certain, 1 confident, 0 tentative).
