# Intake: Fix Shared Agent Paste Submission

**Change**: 261026-ejam-fix-shared-agent-paste-submission
**Created**: 2026-10-26

## Origin

Conversational investigation followed by the user's explicit request to use the normal Fab pipeline:

> continue the previous work - of fixing the shared injecting engine - using a normal fab pipeline

The original report was that HexoKit cron pastes prompt text into an ordinary Codex tab but never submits it, while the user's Claude-based operator receives and submits cron prompts. The supplied screenshot, `.uploads/261026072543-image.png`, shows fourteen accumulated `[Pasted Content 1433 chars]` chips, with `#2` through `#14` suffixes, in the Codex composer.

The user specifically requested Playwright verification across every supported agent and before/after recordings attached directly to the PR body for review. A separate constitution-only amendment, PR #1088, was merged first. This change starts from `origin/main` at `ef50f162895d1a480024f43b237f54b04a711afa`, which includes Constitution 2.2.0 and its stronger PR Evidence requirements. The worktree was fast-forwarded to that base without a hard reset. This intake is created by `/fab-proceed` in `promptless-defer` mode; the parent orchestrator owns activation, branching, and the remaining pipeline.

## Why

The defect prevents scheduled prompts from becoming agent turns and causes later firings to accumulate more copies in the same composer. Read-only investigation found the matching entry in `/home/sahil/.local/state/hexokit/cron/loom.yaml`: id `gg6z`, name `lib-stamps migration check`, target pane `%45`, schedule `every: 30m0s`, delivery policy `when-idle`, and a 1,433-character single-line payload. The corresponding `loom.log` repeatedly records:

```text
failed: agent input not ready — message pasted but not echoed; Enter withheld.
The text remains in the agent's input — check the terminal view before retrying,
as a resend would duplicate it.
```

The production cron deliverer already calls the shared engine with `submit=true` (`app/backend/internal/cron/deliver.go`). The failure occurs earlier in `app/backend/internal/inject/inject.go`: `Send` pastes through a named tmux buffer, then `probeEcho` requires the count of recognizable echo signals to increase over a pre-paste capture before `SendEnter` runs. Long or multiline pastes may appear as collapsed chips instead of raw text. `pasteCollapseRe` currently recognizes only Claude's forms:

```text
[Pasted text #1 +12 lines]
[Pasted text #7]
```

It does not recognize the Codex form seen in the screenshot:

```text
[Pasted Content 1433 chars]
[Pasted Content 1433 chars] #2
```

The raw text is hidden by the chip, so neither echo arm succeeds and Enter is correctly withheld under an incomplete compatibility predicate. A local check against the current regex counted one Claude marker and zero Codex markers, including repeated Codex chips. The role difference is incidental: ordinary-tab and operator delivery share the injection mechanism.

The fix belongs in that shared mechanism so cron, direct sends, operator sends, and other consumers receive consistent behavior. Bypassing the echo check or unconditionally sending an extra Enter would weaken the existing guard against submitting into the wrong UI state and would not address the actual recognition gap.

## What Changes

### 1. Recognize supported agents' actual paste echoes

Update the shared engine's collapsed-paste recognition to accept the observed Codex marker, including the first paste and numbered repeats, while preserving Claude's existing multiline and suffix-less forms. Inspect the seven agents in `app/backend/cmd/rk/agent_registry.go`: Claude Code (`claude`), Codex (`codex`), Gemini CLI (`gemini`), Copilot CLI (`copilot`), Kimi (`kimi`), OpenCode (`opencode`), and Antigravity (`agy`). Add recognition for any additional collapsed forms demonstrated by real testing; agents that echo raw text should continue to use the existing raw-needle path. Do not invent renderer formats or thresholds from agent names.

Retain the pre-paste baseline and strict increase requirement so a stale chip or previously visible text does not authorize Enter. Keep normalization of ANSI, whitespace, wrapped text, and frame glyphs; keep the shape gates for collapsible text and image-only paths. Observe collapse thresholds during verification and adjust the compatibility logic only as supported by evidence. An unrecognized echo must still fail closed.

### 2. Preserve the engine's submission and recovery contract

Keep `submit=false` as verified insertion without Enter. Preserve control-byte sanitization, explicit pane/server targeting, pane-mode cancellation, per-pane serialization, named-buffer locking, popup handling, deadline bounds, and evidence-gated recovery. Retain the distinction between `ProbeFailure`, `StagedSendFailure`, and `SubmitUnverified`; do not report success just because text was pasted.

Exercise repeated successful deliveries and scheduled firings to establish that prompts submit once each and do not accumulate in the composer. Already-staged user text must not be silently cleared or submitted by this change. The existing live accumulation is diagnostic evidence, not permission to repair the user's live pane. A broad change to cron scheduling, persistence, retries, or target resolution is outside this intake; if verification demonstrates a further defect needed for this outcome, record it explicitly before extending the plan.

### 3. Add focused regression coverage

Extend `app/backend/internal/inject/inject_test.go` with observed paste forms and behavioral assertions: a fresh Codex chip leads to Enter for `submit=true`; a stale chip alone does not; a repeated chip is counted correctly; `submit=false` does not send Enter; short raw text, long single-line text, multiline text, ANSI and narrow wrapping, and existing Claude/image/popup/recovery behavior remain correct. Use the engine's existing fake tmux interface to prove ordering and failure semantics without live services.

Cover the cron path through the shared deliverer where needed, particularly `submit=true` and multiple deliveries. Do not duplicate the engine's renderer logic in cron or introduce tests that only mirror a regex. Existing safety tests remain authoritative for unchanged guarantees.

### 4. Verify real agents with Playwright on an isolated rig

Use `just setup` before tests and the repository's `just`-based test/demo harness. Use dedicated throwaway tmux sockets, state/config homes, working directories, and derived ports. Never test against the user's `loom` server, live cron entries, existing agent sessions, or a live `rk serve` instance.

Run a provider matrix covering all seven registered agents. Intake-time preparation completed `just setup` and installed the repository's Playwright/Chromium prerequisites. Installed versions read during preparation were Claude Code `2.1.310`, Codex `0.164.0`, Copilot `1.0.78`, Kimi `2.3.2`, OpenCode `1.18.25`, and Antigravity `1.4.7`; `gemini` was not on PATH. Authentication and launch readiness remain to be checked during apply. No browser MCP is available in this harness, so use the installed repository Playwright runner. Record the actual versions used and whether each session can run. Missing binaries, credential walls, or other environment constraints are explicit blocked/unverified cases, not passes. Do not change credentials or claim that mocked browser tests establish real-agent compatibility.

For each available agent, exercise an ordinary non-operator tab with:

- A short single-line prompt that echoes directly.
- A 1,433-character single-line prompt reproducing the reported collapse shape.
- A multiline prompt that may collapse independently of total length.
- At least two successive deliveries/firings, with distinguishable replies, proving one turn per delivery and an emptied composer rather than accumulating paste chips.

Use harmless, deterministic prompts that ask the agent to return a unique acknowledgement and do not modify the repository. Verify the requested response/turn from the real agent in the browser and supporting pane/transcript evidence; a successful HTTP response, a cron `delivered` log, a changed terminal frame, or the pasted prompt by itself is insufficient. Cross-check cron logs and pane captures as supporting diagnostics. Include Claude and Codex operator-role comparisons to show that the role does not change the fixed mechanism. Do not launch an autonomous operator workflow merely to assign the role in the test.

### 5. Attach reviewable before/after evidence

Add the required Playwright demo spec(s), normally under `app/frontend/tests/demo/`, and record with `just demo` against the base branch and fixed implementation. Show the real Codex failure before the change and successful submission after it under comparable conditions. Also capture the available-agent verification cases and repeated-delivery behavior. Evidence must show the outcome, not just the input disappearing.

Cover desktop and mobile browser viewports because the terminal workflow is available on both. A shell recording is required only if the implementation touches shell-only paths or behaves differently across engines, per Constitution § PR Evidence. Preserve test intent comments and shared-setup descriptions wherever new e2e tests are introduced.

Upload videos as GitHub attachments with `gh pr create/edit --attach`, never commit them. Place each video reference in its own PR-body paragraph so it renders inline. Label **Before** and **After**, agent, scenario, and viewport; include a results matrix with pass/fail/unverified distinctions and concrete reasons for missing evidence. The PR must not claim all-agent verification if any agent remains unverified. The pipeline ends with a reviewable PR, not an automatic merge.

## Affected Memory

- `run-kit/agent-send`: (modify) Document the shared engine's accepted paste evidence, retained freshness gates, and verified compatibility behavior.
- `run-kit/agent-messaging`: (modify) Keep CLI delivery semantics and cross-references aligned with the shared engine's compatibility guarantees.
- `run-kit/cron`: (modify) Record the supported collapsed-paste submission behavior through `EngineDeliverer`, without changing cron scheduling semantics.

## Impact

Primary production scope is `app/backend/internal/inject/inject.go`, with regression tests beside it and targeted integration coverage under `app/backend/internal/cron/` as needed. The engine is also consumed by the HTTP send path, CLI mux sends, operator delivery, and spawn/respawn delivery, so its existing tests and error contracts must remain intact.

Verification scope includes real agent CLIs, Playwright demo/e2e helpers, and possibly a small reusable test helper under `scripts/` if the existing rig cannot otherwise express the scenario. Prefer existing harness primitives; no new production dependency, public endpoint, agent protocol transport, or configuration surface is planned. Memory updates follow implementation and review. The already-merged constitution amendment is the baseline and is not part of this change's diff.

## Open Questions

No unresolved product or scope decisions. Apply must determine which agent versions/authenticated sessions are available and which paste representations they actually render; those are empirical verification work, not grounds to invent compatibility claims. Any unavailable coverage is recorded explicitly in the PR as required above.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix shared injection rather than add a cron-specific Enter workaround. | Discussed and confirmed in source: cron already requests submission, while the shared matcher misses the screenshot's Codex chip. | S:100 R:90 A:100 D:100 |
| 2 | Certain | Keep freshness, fail-closed behavior, popup guards, sanitization, and bounded recovery intact. | Existing engine and agent-messaging spec define these invariants; the user's request is a compatibility fix. | S:95 R:90 A:100 D:100 |
| 3 | Certain | Verify all seven registered agents using real sessions and report blocked cases honestly. | Explicit user request and Constitution 2.2.0 PR Evidence; registry supplies the closed inventory. Missing Gemini/authentication is an execution constraint to report, not a success assumption. | S:100 R:90 A:95 D:100 |
| 4 | Certain | Use short, 1,433-character single-line, multiline, and successive-delivery cases, plus Claude/Codex role comparisons. | The reported payload and prior verification discussion establish these scenarios; they distinguish raw, collapsed, repeated, and role-independent behavior. | S:95 R:95 A:95 D:95 |
| 5 | Certain | Record real before/after runs with Playwright and attach labeled inline videos to the PR body. | Explicit user request, subsequently codified by merged PR #1088; submission is temporal behavior requiring recordings. | S:100 R:95 A:100 D:100 |
| 6 | Certain | Use isolated test rigs and leave live cron/panes untouched. | Constitution, testing context, and the diagnostic-only use of the user's screenshot/logs determine the safety boundary. | S:100 R:95 A:100 D:100 |
| 7 | Confident | Do not redesign cron retry or persistence policy in this compatibility fix. | The requested continuation names the shared injection engine; correcting recognized successful deliveries addresses the observed accumulation. Additional demonstrated defects can be surfaced during apply rather than presumed. | S:80 R:80 A:75 D:75 |
| 8 | Certain | Start from the merged main baseline and ship a separate PR through the normal Fab stages. | Latest user instruction explicitly requests the normal pipeline after the constitution PR merged. | S:100 R:95 A:100 D:100 |

8 assumptions (7 certain, 1 confident, 0 tentative, 0 unresolved).
