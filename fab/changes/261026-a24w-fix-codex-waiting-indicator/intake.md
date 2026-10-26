# Intake: Fix Codex waiting indicator

**Change**: 261026-a24w-fix-codex-waiting-indicator
**Created**: 2026-10-26

## Origin

Conversational bug report followed by an explicit `/fab-proceed` request. The user's screenshot showed `codex-main` working while its yellow status dot pulsed. The user requested the same meaningful distinction already working for Claude: working means a solid dot, finished means a hollow circle, and a pulsing attention ring means a human question or approval actually needs a response.

The conversation's task synthesis is:

> Fix false pulsating waiting for Codex. Working, including automatic approval review, must not pulse. Finished must be hollow without pulsing. A genuine human question or approval must pulse until resolved. Preserve Claude's correct behavior.

Before proceeding, the user explicitly requested resetting this worktree to latest `origin/main` to pick up the updated constitution. Creation begins from clean commit `ef50f162`, branch `agile-basin`, with no active change. Constitution v2.2.0 now requires Playwright workflow verification, comparable before/after recordings for temporal behavior, desktop and mobile web evidence, and actual external integration coverage. This intake is the create-only prefix; activation, branch creation, implementation, review, hydration, and shipping belong to the calling pipeline.

## Why

The attention animation promises that the user must intervene. A pulse during autonomous work wastes attention, obscures genuine requests, and makes the dashboard unreliable as an orchestration surface. A stale waiting value after completion also misrepresents an idle pane, and affects the existing waiting rollups beyond the dot itself.

The present visual contract is already suitable. `app/frontend/src/components/status-dot.tsx` adds `rk-waiting-halo` only from `state.waiting`; `pr-status-model.ts` sets that flag only when `win.agentState === "waiting"`. `docs/specs/agent-state.md` explicitly defines waiting as blocked on a human. Correcting the source of that state is preferable to masking its pulse in one component, which would leave other attention consumers wrong.

The Codex registry currently equates `PermissionRequest` with human waiting. The prior discussion found that the installed Codex uses `approvals_reviewer = "auto_review"`; a raw permission request can therefore occur while a reviewer subagent works autonomously. A post-tool reset alone would shorten a false pulse but would not prevent it during the automatic review. Session ownership also needs verification before claiming that this mapping explains every observed symptom.

## What Changes

### Preserve the human-attention contract

For the pane's owning Codex conversation, the required states and visible outcomes are:

| Situation | Lifecycle state | Dot and attention behavior |
|---|---|---|
| A turn is reasoning, executing tools, or undergoing automatic approval review | `active` | Solid dot; no waiting attention halo |
| The turn has finished and no human request is pending | `idle` | Hollow circle; no waiting attention halo |
| An actual human question, elicitation, or permission approval is pending | `waiting` | Hollow base with the existing pulsing yellow attention ring until resolved |
| The human answers or approves and the turn resumes | `active` | Pulse clears promptly and the dot becomes solid |
| The request is resolved by completion or cancellation | Accurate resulting lifecycle state | No stale waiting halo |

The established phase hues, shape vocabulary, additive failed/watched overlays, and reduced-motion treatment remain appropriate. Do not simply disable Codex waiting or suppress its halo unconditionally. Preserve genuine question detection and the complete resume/completion lifecycle. Keep Claude's existing working/idle/permission/question behavior correct.

### Verify Codex runtime signals before choosing the fix

Inspect the installed Codex's actual hook payloads and available runtime surfaces in an isolated rig, and choose the smallest reliable mechanism that distinguishes a real human block from automated approval evaluation. The observed installed version was `0.164.0`, while the existing installer comment cites `0.153.4`; reverify the version exercised and report that version in evidence. Do not assume the older mapping proves current behavior.

Current code relevant to that investigation:

- `app/backend/cmd/rk/agent_setup.go`: Codex maps `UserPromptSubmit` and `PreToolUse` to `active`, `PermissionRequest` to `waiting`, `Stop` and `SessionEnd` to `idle`, and `SessionStart` to `stamp`; there is no `PostToolUse` reset. Claude maps `Notification` matching `permission_prompt|elicitation_dialog|agent_needs_input` to `waiting`.
- `app/backend/cmd/rk/agent_hook.go`: `runAgentHook` takes a state token, parses bounded stdin JSON once, writes the state with a validated ancestor PID, and stamps session identity on every valid session-bearing event. Existing payload fields include `session_id`, `source`, and provider-specific identity/idle fields; unknown fields are ignored.
- `app/backend/cmd/rk/agent_registry.go`: provider runtime descriptors select identity fields and provider gates independently of installation shape.
- The existing state wire format is `<state>:<epoch_seconds>[:<pid>]`, with `active|waiting|idle`. The session option is `@rk_pane_agent_session = <provider>:<session-ref>`. Keep the established schema and reader contracts unless runtime evidence demonstrates a necessary change.

The prior discussion inspected [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks), which describes `PermissionRequest` as occurring before an approval decision, including decisions another hook can allow without a displayed prompt. It also inspected the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), which documents the reviewer subagent selected by `approvals_reviewer = "auto_review"`. Treat these as investigation leads and validate the runtime behavior used by the fix; the final design must not infer a human block solely from raw `PermissionRequest`.

### Check pane and conversation ownership

The earlier read-only diagnostics observed pane `%45` reporting waiting while a visible root response appeared finished. However, the stamped session identity belonged to the diagnostic conversation in the HexoKit `agile-basin` worktree (`source`/originator observations included `vscode` and `codex-tui`), which shared a runtime process with the original visible Loom `codex-main` pane. This is a qualified observation, not proof that the displayed original conversation was awaiting the user.

Investigate whether reviewer, child, or separate conversations can write root-pane state or replace its identity through ordinary mapped events. Excluding only `SubagentStart` and `SubagentStop` is not evidence that every ordinary hook belongs to the visible root. If the issue is confirmed, enforce ownership using observed authoritative payload/runtime information, while preserving legitimate startup, resume, clear, compact, and session-identity rotation behavior. Do not adopt a blanket rule that locks out valid resumed roots. If investigation rules this out, record the evidence and keep the fix limited to the confirmed cause.

### Preserve hook and compatibility guarantees

The change remains telemetry: hook processing must never approve or deny a tool, block the harness, emit accidental decision output, or change the user's approval policy. Preserve the silent always-exit-zero hook contract, bounded input and subprocess handling, correct tmux socket/pane targeting, validated identities, PID-liveness reconciliation, durable source of truth, and existing compatibility aliases/dual writes where applicable.

Prefer the existing hook/runtime boundaries and existing state propagation. No shared agent-delivery redesign is required by this task. Do not mutate the user's live `~/.codex/config.toml`, trusted hooks, live tmux options, or running daemon to test or deploy the change. Exercise temporary config and hook installations only in the throwaway test rig. Any needed installer mapping change must preserve unrelated hooks and idempotent installation, with deployment/trust prerequisites documented honestly.

### Verification and PR evidence

Create deterministic regressions for the actual chosen mechanism, plus an actual Codex integration exercise. At minimum cover autonomous work, automatic approval review without human intervention, a real human approval or elicitation/question, resumption, completion, and any session-ownership edge confirmed during investigation. Add Claude regression coverage for its existing active/waiting/idle lifecycle. Distinguish fixtures from real harness executions in the results; mocked-only browser coverage does not establish external compatibility.

Run tests through repository `just` recipes in their isolated socket/config/state rig. Use `just setup` as needed. Exercise the affected user workflow with Playwright and record temporal outcomes with `just demo`: a demo under `app/frontend/tests/demo/` should produce comparable **Before** and **After** short recordings for desktop and mobile, ideally with `--before ef50f162`. Show the base bug reproduction and corrected behavior, including real human waiting remaining visible and clearing after resolution. If an external case or a required recording cannot be completed, explain exactly what was attempted and what remains unverified; never mark missing coverage as passing or stage a synthetic event as if Codex emitted it.

The before/after views must identify scenario, agent/version, and viewport. New or changed Playwright e2e tests require the constitution's file setup comment and immediate `Proves`/numbered `Steps` JSDoc. Upload recordings as GitHub attachments with `gh pr create --attach` or `gh pr edit --attach`; do not commit video assets. The final PR body must include the evidence directly, each video on its own paragraph, and summarize scenarios, agents, results, and limitations. No shell recording is expected from a hook-only change; if implementation touches desktop-shell or engine-specific paths, follow the constitution's additional shell evidence requirements.

## Affected Memory

- `run-kit/agent-state`: (modify) Record the verified Codex human-wait signal, lifecycle reset semantics, any confirmed conversation ownership guard, runtime compatibility, and installer implications. Update the existing Codex mapping rather than appending contradictory behavior.
- `run-kit/ui/status-signals`: (modify) Clarify the Codex lifecycle verification behind the established active/idle/waiting visual contract, if useful; retain the existing provider-neutral dot/attention design and do not invent a new visual language.

The integration capability matrix in `docs/site/agent-hooks.md` is also likely affected by verified event/version changes. Read relevant toolkit standards before changing that site surface. Human-owned design specs already define the desired human-block semantics; reconcile any discovered contradictions explicitly rather than mechanically rewriting them.

## Impact

Primary candidates are `app/backend/cmd/rk/agent_setup.go`, `agent_hook.go`, `agent_registry.go`, their neighboring Go tests, and narrowly relevant existing tmux/session seams if ownership evidence requires them. Frontend verification should use the current `status-dot.tsx`, `pr-status-model.ts`, existing lifecycle/status tests, and an isolated Playwright demo/e2e workflow; production frontend changes are needed only if investigation finds a separate defect.

The corrected lifecycle state naturally reaches the existing SSE consumers, waiting counts, sidebar dots, tiles, and pane status through the existing pipeline. No new endpoint, route, state database, client polling loop, or shared delivery change is presumed. Maintain the current public state vocabulary and Claude compatibility. The scope includes implementation, meaningful tests, memory hydration, required evidence, review, and PR shipping through the caller's full Fab pipeline; it excludes live deployment or user-global hook/config installation.

## Open Questions

There are no unresolved user preference or product-scope decisions. The following are required technical investigation work, not requests for the user to supply an implementation:

- Which actual Codex 0.164.0 signal/payload proves that a human approval or question is displayed and pending, after automatic review is accounted for? What corresponding event or observation reliably clears it on resume, rejection, cancellation, and completion?
- Do ordinary Codex hook events from reviewer/child/other conversations share the visible pane's environment, and what observed root/session identity boundary prevents them from overwriting its lifecycle without breaking resume/clear/compact?
- Can the isolated real Codex rig reproduce both the false pulse and a true human wait, and produce comparable desktop/mobile recordings? Which cases, if any, remain unavailable because of harness capabilities, trust, or credentials?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Working, including automatic approval review, is active/solid without a pulse; finished is idle/hollow without a pulse; actual human waiting pulses until resolved. | Discussed — the user's explicit behavior request agrees with the existing agent-state spec and status-dot design. | S:100 R:95 A:100 D:100 |
| 2 | Certain | Preserve Claude behavior and genuine Codex question/approval detection; never disable all Codex waiting. | Discussed — explicit scope and rejected shortcut; correcting false positives must not hide real requests. | S:100 R:95 A:95 D:100 |
| 3 | Confident | Determine the smallest reliable Codex signal from runtime evidence before choosing a hook or runtime change. | The current raw PermissionRequest mapping is insufficient evidence of a human block; code and prior documentation findings identify the seams, but current payload behavior still needs verification. | S:90 R:75 A:65 D:75 |
| 4 | Confident | Investigate shared-process conversation ownership as a possible contributor without claiming it is proven or precommitting a broad fix. | Discussed — the diagnostic session identity differed from the originally visible conversation; preserve that qualification and validate only the necessary ownership change. | S:90 R:80 A:60 D:75 |
| 5 | Certain | Use isolated repository test/demo rigs and do not change live user config, trusted hooks, pane options, or daemon state. | Discussed scope plus constitution v2.2.0 explicitly requires throwaway verification; the user authorized a code change and full pipeline, not live deployment. | S:100 R:100 A:100 D:100 |
| 6 | Certain | Require actual Codex integration, deterministic regressions, Claude regression coverage, and before/after desktop/mobile recordings with honest limitations. | Constitution v2.2.0 PR Evidence follows observable behavior through backend changes; the requested fix changes a temporal UI signal. | S:100 R:95 A:100 D:100 |
| 7 | Certain | Keep the existing three-state vocabulary, visual model, and hook safety contracts unless verified runtime evidence requires a narrowly documented adjustment. | Existing implementation and memory supply a fitting contract; no delivery, visual redesign, or new API was requested. | S:95 R:90 A:95 D:95 |

7 assumptions (5 certain, 2 confident, 0 tentative, 0 unresolved).
