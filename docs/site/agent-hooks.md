# Agent hook integrations

HexoKit learns what an agent pane is doing from **harness hooks**: small entries `rk agent setup` writes into each agent CLI's native config, which fire `rk agent hook` on lifecycle events. The hook writes two tmux pane options — `@rk_pane_agent_state` (`active|waiting|idle` with a timestamp) and `@rk_pane_agent_session` (the `provider:session-id` identity) — and the dashboard derives everything else from there.

Every installed hook is a thin `/bin/sh -c` wrapper delegating to the `rk agent hook` binary, so hook *logic* fixes ship with `rk update` — no re-setup, no session restarts. Installs are idempotent, preserve your existing configuration, show a diff before writing, and `--uninstall` removes exactly the HexoKit-owned artifacts. Only harnesses whose binary is on `PATH` are wired.

## Capability matrix

Verified 2026-09-09 against the vendors' current documentation and the locally installed versions linked per row.

| Harness | Verified | Mechanism | Install target | Identity | Lifecycle events | Transcript | Activation |
|---------|----------|-----------|----------------|----------|------------------|------------|------------|
| **Claude Code** | 2.1.263 | settings.json hooks | `~/.claude/settings.json` | `session_id` | prompt/tool → active · Notification → waiting/idle · Stop → idle · SessionStart → stamp | `projects/*/<id>.jsonl` glob | new sessions |
| **Codex** | 0.153.4 ([hooks](https://developers.openai.com/codex/hooks)) | hooks (stable, on by default) | `$CODEX_HOME/hooks.json` | `session_id` | UserPromptSubmit/PreToolUse → active · PermissionRequest → waiting · Stop/SessionEnd → idle · SessionStart → stamp | `sessions/*/*/*/rollout-*-<id>.jsonl` glob | **`/hooks` trust review required** — non-managed hooks are skipped until trusted |
| **Gemini CLI** | 0.54.4 ([hooks](https://geminicli.com/docs/hooks/)) | settings.json hooks | `~/.gemini/settings.json` | `session_id` | BeforeAgent/BeforeTool → active · Notification(`ToolPermission`) → waiting · AfterAgent/SessionEnd → idle · SessionStart → stamp | `tmp/*/chats/session-*-<id8>.jsonl` glob + full-id verification | new sessions |
| **GitHub Copilot CLI** | 1.0.78 ([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)) | hook files | `$COPILOT_HOME/hooks/run-kit.json` | `sessionId` (camelCase events) | userPromptSubmitted/preToolUse → active · permissionRequest/notification → waiting · notification(`agent_idle`)/agentStop → idle · sessionStart → stamp | **not available** (see gaps) | CLI restart |
| **Kimi Code** | 0.41.0 ([hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks.md)) | `[[hooks]]` in config.toml | `$KIMI_CODE_HOME/config.toml` | `session_id` | TurnStarted/PreToolUse → active · PermissionRequest → waiting · Stop → idle · SessionStart → stamp | `session_index.jsonl` → `agents/main/wire.jsonl` | new sessions |
| **OpenCode** | 1.18.25 ([plugins](https://opencode.ai/docs/plugins/)) | JS plugin event stream | `~/.config/opencode/plugins/run-kit.js` | event `sessionID` (root sessions only) | session.status busy → active · permission.updated → waiting · session.idle → idle · session.created → stamp | `opencode export <id> --sanitize`, materialized per request (see gaps) | process restart |
| **Antigravity CLI** | agy 1.1.11 ([hooks](https://antigravity.google/docs/hooks)) | named hooks in hooks.json | `~/.gemini/config/hooks.json` | `conversationId` | PreInvocation → active · Stop(fullyIdle) → idle · **no waiting signal** (see gaps) | `brain/<id>/.system_generated/logs/transcript.jsonl` (deterministic) | new sessions |

## Honest gaps

- **Copilot CLI — no transcript-backed actions.** On the verified 1.0.78 install, a session's identity does not determine a conversation file: `transcriptPath` rides only the agentStop/preCompact/subagent payloads (none of which HexoKit hooks), and `~/.copilot/session-state/<id>/` holds workspace metadata (workspace.yaml, checkpoints, files, research) with no observed per-session transcript file. Identity and lifecycle work; Fix tab name and other transcript-backed operator actions stay unadvertised for Copilot panes.
- **OpenCode — transcript via export, not a file path.** Sessions have no on-disk transcript file; the adapter runs the native `opencode export --sanitize -- <sessionID>` and materializes the JSON **at request time only** — never on the dashboard's derive tick (the sidebar advertises the capability from a cheap ref+binary probe, and the POST/queue-drain paths revalidate for real). Artifacts land in the user-private `$XDG_STATE_HOME/hexokit/opencode-export/` (0700, symlink-refusing atomic replace, 32 MiB output cap, 15s timeout). Retention is consumer-aware: every returned path stays valid for a one-hour grace window (past-grace artifacts are pruned; when 16 in-grace artifacts are reached a new export is refused instead of evicting a path already handed out) — disposable request-derived data, never authoritative state. An export adds one bounded subprocess to a user-initiated action; that is the price of the path-based transcript contract here.
- **Antigravity CLI — no waiting signal, no startup event.** HexoKit deliberately does not hook agy's PreToolUse/PostToolUse: their contract answers permission decisions, and telemetry must never emit allow/deny. Permission prompts therefore never flip an agy pane to `waiting`. There is also no SessionStart event; identity lands on the first model invocation (PreInvocation), and Stop only writes `idle` when the payload reports `fullyIdle` (background tasks may still be running otherwise). Hook config reload timing is not documented; assume a new session is required.
- **Gemini CLI** reports as comm `node` (it is a bundled node script): process validation matches the ancestor node process, and its `Notification` hook is observability-only — it cannot answer permission prompts, only signal them.
- **Codex** requires its native trust review: after `rk agent setup` writes `hooks.json`, open `codex`, run `/hooks`, and trust the HexoKit entries. Until then they are installed but inactive — by Codex's design, not a HexoKit limitation.

## The shared contract

All providers write the same two pane options, so every dashboard feature — the sidebar status dot, the waiting-duration badge, boot-readiness, Fix tab name — works identically per harness:

```text
@rk_pane_agent_session = <provider>:<session-ref>
@rk_pane_agent_state   = <active|waiting|idle>:<epoch>[:<agent-pid>]
```

State on a pane whose agent process died is reconciled away at read time (PID liveness for pid-carrying values; a plain-shell pane never reports an agent), so a crashed or killed agent never leaves a live-looking row. Child/subagent sessions can never replace the pane's root identity or falsely complete its turn: harnesses with distinct subagent events are simply not hooked there, and OpenCode's plugin (whose event stream mixes child sessions into ordinary session events) resolves every event's session through the SDK and ignores any with a `parentID`. A mid-turn compaction never reads as idle.

Hooks fire for sessions launched by hand in any shell — the integration does not depend on HexoKit owning the launch (`rk riff`-spawned agents are simply the common case).
