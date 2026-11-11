# S1 findings — headless run in a tmux window

> Throwaway spike for step **S1** of `26-11-10-operator-to-hexokit.md`. Run 2026-11-11 on
> dev-ws-sahil-01 (tmux 3.8, rk v3.22.9, fab-kit 2.28.11, claude / codex 0.167.1 / kimi 2.5.3).
> No production code; scripts lived in a scratchpad and are not committed.

## Verdict

**Half answered.** Window mechanics and daemon-restart survival are measured and good. The
**token and cache-TTL numbers could not be measured: none of the three providers is logged in on
this machine**, so no model call succeeded (spend: $0). R5 can be designed on the mechanics below;
the cache question stays open until someone logs in and runs the recipe at the end (~15 min,
< $1).

| Question | Answer |
|---|---|
| Launch claude / codex / kimi headless in an ephemeral window | Mechanics work for all three. Real runs blocked by auth (below) |
| Start-up time | Window → wrapper running **0.18 s**; wrapper → provider error **0.9 s** (claude), **1.3 s** (kimi), **15 s** (codex, retries a 401). Not a model first-token time |
| First-token time, total tokens | **Not measured** (no auth) |
| Which prompt cache | **Not measured** (no auth) |
| Window survives rk daemon restart | **Yes** — SIGTERM and SIGKILL of the daemon, then a fresh daemon; the run finished (`rc=0`, 75 s after launch) and the fresh daemon listed the window |

## Auth state (why the numbers are missing)

| Provider | Resolved headless command (`fab agent operator --headless -o yaml`) | Result here |
|---|---|---|
| claude | `claude -p --permission-mode bypassPermissions --model claude-sonnet-5-5 --effort medium` | `Not logged in · Please run /login` (`claude auth status`: `loggedIn: false`; no credentials file; the interactive agent's auth is in-process and not inherited by children) |
| codex | `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna -c model_reasoning_effort=medium` | `ERROR: unexpected status 401 Unauthorized`, after ~15 s of retries |
| kimi | `sh -c 'kimi -p "$(cat)"'` (model/effort empty) | `No model configured. Run kimi and use /login…` (~1.3 s) |

R5-relevant, independent of auth: **an unauthenticated provider fails slowly (codex 15 s) or fast
(claude/kimi ~1 s) and exits non-zero** — the run must record the exit status and write an outcome
note even on failure, or the Cron Log row for the fire will be empty.

## Window mechanics

- Launch used: `rk tab new -L <server> --session '=<S>' --name s1-<p> --cwd <dir> --json -- <wrapper> <tag> <launcher…>`.
  Works against a non-default server with an explicit `--session`. Window creation took
  **0.18 s** (call start → wrapper `t_start`).
- **`rk tab new` appends `; exec "${SHELL:-/bin/sh}"`** unless `--no-shell-fallback`. After the
  provider exits the window stays open at a shell prompt (`pane_dead=0`, command `zsh`). R5's
  "close the window when the run exits" therefore needs `--no-shell-fallback` (the window then dies
  with the command) or an explicit kill-window; do not rely on the default.
- The run's process tree is `systemd → tmux server → zsh -c → wrapper → launcher`. The daemon is
  **not** an ancestor; this is what makes survival automatic (Constitution II/VI hold by
  construction).
- **Brief delivery**: all three resolved commands read the brief from **stdin** (codex prints
  `Reading prompt from stdin…`). The 40 KB (~7.5–9K token) synthetic brief reached a stub reader
  intact (`wc -c` → 40513). The kimi form passes the brief as **one argv word**
  (`-p "$(cat)"`): `execve` rejects a single argument over 128 KiB (`MAX_ARG_STRLEN`) — tested:
  100 000 B ok, 140 000 B → `Argument list too long`. A 10–15K-token brief is ≈ 40–60 KB, so R5 is
  safe today; cap the brief below ~120 KB or give kimi a file/stdin path.
- zsh footgun when scripting: an unquoted `=spike` is expanded by zsh as a command lookup
  (`spike not found`). Quote `'=S'`.

## Daemon-restart survival (R5 acceptance)

Setup: isolated daemon (`RK_PORT=21150`, own `XDG_STATE_HOME`/`XDG_DATA_HOME`/`RK_CONFIG_DIR`,
`RK_SERVER_ALLOWLIST=s1spike`) against a tmux server `s1spike`; run = a stub launcher
(`wc -c; sleep 75; echo SURVIVED`) fed the 40 KB brief on stdin via the wrapper.

| Step | Observation |
|---|---|
| `SIGTERM` to daemon 1 (graceful shutdown) | Daemon exited; window `s1-stub` and its `sleep` kept running |
| Start daemon 2 | `/api/servers` showed `windowCount: 2` — window rediscovered from tmux alone |
| `SIGKILL` daemon 2 | Process gone; `sleep` still running |
| Start daemon 3, wait | Stub printed `SURVIVED` at +75 s, wrapper wrote `t_exit rc=0`; output file complete |

Limits of the test: a stub, not a real provider (a real provider holds a network connection to the
API, which is independent of the daemon, so no difference is expected); the note-write at the end
of a run was not exercised (R5 work).

## Surprises

1. **`RK_SERVER_ALLOWLIST` does not scope control-mode attach.** The first isolated daemon opened
   `tmuxctl` sockets on **all six live tmux servers** (`code`, `fab_kit`, `hexokit`, `hexokit2`,
   `loom`, `rk-daemon`) for ~13 s before being SIGTERMed — only its read path (`/api/servers`) was
   filtered. No live session was touched (all six servers' session counts were unchanged afterwards;
   the live daemon was never signalled or restarted), but this is a gap in the e2e rig's isolation
   claim and worth a follow-up (an allowlist-aware tmuxctl open). The test was redone inside
   `unshare -Ur` (uid 0 ⇒ `/tmp/tmux-0`, invisible to the live `/tmp/tmux-<uid>` sockets).
2. `claude --dangerously-skip-permissions` refuses to run as root (the namespace uid), so the
   namespace trick is for daemon tests only, not for real claude runs.
3. `pgrep -x rk` can match the live daemon: any spike/kill script must target the PID of the
   listener on its own port, never a process-name match.

## Recommendations for R5

- Launch through `rk tab new … --no-shell-fallback --json -- <wrapper> <launcher>` and keep the
  returned `window_id`; the wrapper (not the daemon) records start/end time, exit code, and the
  provider's transcript path. Treat "window exists" as the `skipped-busy` signal — it is
  recoverable from tmux after a daemon restart.
- Feed the brief on **stdin** for every provider (what the resolver already implies); keep the brief
  < 120 KB for kimi's argv form.
- Make the wrapper write a Cron Log outcome on non-zero exit (auth failure, 401 retries up to 15 s).
- Fix the isolation gap in Surprise 1 before relying on the e2e rig for run-window tests.
- **Do not freeze the cold-cache / $30 assumption on this spike.** It still rests on the plan's
  earlier evidence; M1 should confirm it, or run the recipe below first.

## Recipe to finish the measurements (needs a human `/login`)

1. Log in: `claude /login`, `codex login`, `kimi` → `/login`.
2. Generate a ≈ 40 KB brief (any filler rules text ending with "Reply `S1 OK` and exit; use no tools").
3. For each provider, in a new window (`rk tab new --session '=S' --cwd <tmpdir> --no-shell-fallback -- sh -c '<resolved command> < brief.md'`),
   run twice at t₀ and t₀ + 6 min (beyond the 5-min TTL) and once at t₀ + 1 min.
4. claude: sum `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`,
   `cache_creation_input_tokens` and read `usage.cache_creation.ephemeral_5m_input_tokens` vs
   `ephemeral_1h_input_tokens` from `~/.claude/projects/<cwd-slug>/*.jsonl`. Run 2 inside the TTL
   should show a large `cache_read`; run 3 shows whether the 5m or 1h bucket was re-created.
5. codex/kimi: use `--json`/session logs for token counts; record "not observable" where absent.
   First-token = first transcript entry timestamp minus `t_start`.
