# Agent hook integrations

HexoKit learns what an agent pane is doing from **harness hooks**: small entries `rk agent setup` writes into each agent CLI's native config, which fire `rk agent hook` on lifecycle events. The hook writes two tmux pane options — `@rk_pane_agent_state` (`active|waiting|idle` with a timestamp) and `@rk_pane_agent_session` (the `provider:session-id` identity). Codex also uses bounded, read-only transcript and runtime observations to distinguish human attention from autonomous work.

Every installed hook is a thin `/bin/sh -c` wrapper delegating to the `rk agent hook` binary, so hook *logic* fixes ship with `rk update`. Changes to the registered events require `rk agent setup` and the harness's activation steps. Installs are idempotent, preserve your existing configuration, show a diff before writing, and `--uninstall` removes exactly the HexoKit-owned artifacts. Only harnesses whose binary is on `PATH` are wired.

## Capability matrix

Codex 0.164.0 is verified with isolated runtime exercises on 2026-10-26. The other rows retain their 2026-09-09 documentation and local-version verification.

| Harness | Verified | Mechanism | Install target | Identity | Lifecycle events | Transcript | Activation |
|---------|----------|-----------|----------------|----------|------------------|------------|------------|
| **Claude Code** | 2.1.263 | settings.json hooks | `~/.claude/settings.json` | `session_id` | prompt/tool → active · Notification → waiting/idle · Stop → idle · SessionStart → stamp | `projects/*/<id>.jsonl` glob | new sessions |
| **Codex** | 0.164.0 ([hooks](https://developers.openai.com/codex/hooks)) | hooks + bounded transcript/runtime reads | `$CODEX_HOME/hooks.json` | `session_id` with confirmed-child guard | prompt/tool → active · human-review permission or pending question → waiting · Interrupt/SessionEnd → idle · Stop → idle unless async questions remain · SessionStart → stamp (details below) | `sessions/*/*/*/rollout-*-<id>.jsonl` glob; hook/runtime paths for lifecycle projection | **`/hooks` trust review required**, including PostToolUse/Interrupt entries |
| **Gemini CLI** | 0.54.4 ([hooks](https://geminicli.com/docs/hooks/)) | settings.json hooks | `~/.gemini/settings.json` | `session_id` | BeforeAgent/BeforeTool → active · Notification(`ToolPermission`) → waiting · AfterAgent/SessionEnd → idle · SessionStart → stamp | `tmp/*/chats/session-*-<id8>.jsonl` glob + full-id verification | new sessions |
| **GitHub Copilot CLI** | 1.0.78 ([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)) | hook files | `$COPILOT_HOME/hooks/run-kit.json` | `sessionId` (camelCase events) | userPromptSubmitted/preToolUse → active · permissionRequest/notification → waiting · notification(`agent_idle`)/agentStop → idle · sessionStart → stamp | **not available** (see gaps) | CLI restart |
| **Kimi Code** | 0.41.0 ([hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks.md)) | `[[hooks]]` in config.toml | `$KIMI_CODE_HOME/config.toml` | `session_id` | TurnStarted/PreToolUse → active · PermissionRequest → waiting · Stop → idle · SessionStart → stamp | `session_index.jsonl` → `agents/main/wire.jsonl` | new sessions |
| **OpenCode** | 1.18.25 ([plugins](https://opencode.ai/docs/plugins/)) | JS plugin event stream | `~/.config/opencode/plugins/run-kit.js` | event `sessionID` (root sessions only) | session.status busy → active · permission.updated → waiting · session.idle → idle · session.created → stamp | `opencode export <id> --sanitize`, materialized per request (see gaps) | process restart |
| **Antigravity CLI** | agy 1.1.11 ([hooks](https://antigravity.google/docs/hooks)) | named hooks in hooks.json | `~/.gemini/config/hooks.json` | `conversationId` | PreInvocation → active · Stop(fullyIdle) → idle · **no waiting signal** (see gaps) | `brain/<id>/.system_generated/logs/transcript.jsonl` (deterministic) | new sessions |

## Codex human attention

Automatic approval review stays **active**, with a solid dot and no attention
halo. `PermissionRequest` becomes **waiting** only when the matching transcript's
effective `approvals_reviewer` is `user`; `auto_review` or unknown reviewer
context does not establish a human wait. A known pending question also requires
waiting. Hooks are telemetry: they never approve or deny a command or change
your approval policy.

Questions have their own completion boundaries:

- An accepted `request_user_input_async` with questions stays waiting across
  unrelated tools, ordinary user messages, and turn completion. Canonical replies
  clear only their matching question IDs; unanswered sibling questions remain.
- A nonempty `request_user_input` in Plan mode stays waiting while its tool call
  is unresolved, including across unrelated tools. Its matching result, turn
  completion, or explicit cancellation clears that blocking request.
- Interrupt/session-end hooks clear attention; transcript turn-abort records
  cancel pending questions. Root startup/resume/clear stamps idle, while
  compaction preserves the in-flight state.

For a waiting Codex pane, existing dashboard and mux reads can detect manual
approval resolution **before the resumed command finishes**. They read
`thread/read` from the managed daemon's local Unix control socket and accept
`active` with an explicit empty flag list, or `idle` with no flags, only when a
matching root transcript proves no question is pending. Pending questions retain
attention even if the runtime reports active or idle. This read does not start
a daemon, resume or subscribe to a thread, or write tmux options. It uses the
existing state update path, with no background watcher or client polling.

The runtime summary has no transition timestamp. A state changed by that read
therefore carries epoch `0` (unknown), so elapsed displays and idle scheduling
cannot reuse the permission-wait age. A later native hook supplies its timestamp.

Compatibility limits for the verified 0.164.0 integration:

- Transcript reads use a 64 KiB metadata head and an 8 MiB tail. Only a complete,
  valid root transcript can prove that no question remains. These fields are
  version-sensitive.
- Runtime lookup uses the **rk process's** `CODEX_HOME` (default `~/.codex`),
  not per-pane overrides. One connection shares a 300 ms batch budget, at most
  32 distinct session IDs, a 2 MiB message limit, and a 64-message response-loop
  cap for intervening notifications.
- Standalone `--no-daemon`, a missing/unresponsive/incompatible socket, unknown
  status/flags, absent or mismatched transcript paths, uncertain/incomplete
  context, files over the projection window, or a session outside the bounded
  batch preserve hook state. Approval can remain waiting until a later hook,
  such as `PostToolUse`, in these cases.
- Confirmed `session_meta.source.subagent` sources and mismatched session IDs
  suppress both lifecycle and identity writes. Independent non-subagent roots
  sharing a pane/process are not disambiguated.
- PostToolUse and Interrupt handling require the corresponding entries from
  `rk agent setup` and Codex's `/hooks` trust review. A binary update alone does
  not add those registrations.

Verification includes real isolated Codex automatic-review and manual-approval
exercises. The manual exercise replays the initial hook from the real approval
request; the answer, execution, and runtime reads are real. Async questions and
child ownership use observed payloads and deterministic regressions, without
a fresh live async-dialog or child-overwrite claim. Browser recordings are
labeled **Codex 0.164.0 event replay**. Full results and limitations are in the
[verification record](https://github.com/sahil87/hexokit/pull/1089).

## Honest gaps

- **Copilot CLI — no transcript-backed actions.** On the verified 1.0.78 install, a session's identity does not determine a conversation file: `transcriptPath` rides only the agentStop/preCompact/subagent payloads (none of which HexoKit hooks), and `~/.copilot/session-state/<id>/` holds workspace metadata (workspace.yaml, checkpoints, files, research) with no observed per-session transcript file. Identity and lifecycle work; Fix tab name and other transcript-backed operator actions stay unadvertised for Copilot panes.
- **OpenCode — transcript via export, not a file path.** Sessions have no on-disk transcript file; the adapter runs the native `opencode export --sanitize -- <sessionID>` and materializes the JSON **at request time only** — never on the dashboard's derive tick (the sidebar advertises the capability from a cheap ref+binary probe, and the POST/queue-drain paths revalidate for real). Artifacts land in the user-private `$XDG_STATE_HOME/hexokit/opencode-export/` (0700, symlink-refusing atomic replace, 32 MiB output cap, 15s timeout). Retention is consumer-aware: every returned path stays valid for a one-hour grace window (past-grace artifacts are pruned; when 16 in-grace artifacts are reached a new export is refused instead of evicting a path already handed out) — disposable request-derived data, never authoritative state. An export adds one bounded subprocess to a user-initiated action; that is the price of the path-based transcript contract here.
- **Antigravity CLI — no waiting signal, no startup event.** HexoKit deliberately does not hook agy's PreToolUse/PostToolUse: their contract answers permission decisions, and telemetry must never emit allow/deny. Permission prompts therefore never flip an agy pane to `waiting`. There is also no SessionStart event; identity lands on the first model invocation (PreInvocation), and Stop only writes `idle` when the payload reports `fullyIdle` (background tasks may still be running otherwise). Hook config reload timing is not documented; assume a new session is required.
- **Gemini CLI** reports as comm `node` (it is a bundled node script): process validation matches the ancestor node process, and its `Notification` hook is observability-only — it cannot answer permission prompts, only signal them.
- **Codex** requires its native trust review: after `rk agent setup` writes `hooks.json`, open `codex`, run `/hooks`, and trust the HexoKit entries. Until then they are installed but inactive — by Codex's design, not a HexoKit limitation.

## The shared contract

All providers write the same two pane options. Shared dashboard consumers use
that contract; available lifecycle signals and transcript-backed actions depend
on the capabilities and gaps above:

```text
@rk_pane_agent_session = <provider>:<session-ref>
@rk_pane_agent_state   = <active|waiting|idle>:<epoch>[:<agent-pid>]
```

State on a pane whose agent process died is reconciled away at read time (PID liveness for pid-carrying values; a plain-shell pane never reports an agent), so a crashed or killed agent never leaves a live-looking row. Distinct subagent events are not hooked. Codex also filters ordinary events with a confirmed subagent transcript source, and OpenCode's plugin resolves every event's session through the SDK and ignores any with a `parentID`. The Codex independent-root limitation is described above. A mid-turn compaction does not stamp idle.

Hooks fire for sessions launched by hand in any shell — the integration does not depend on HexoKit owning the launch (`rk riff`-spawned agents are simply the common case).
