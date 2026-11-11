# S1 findings — headless run in a tmux window

> Throwaway spike for step **S1** of `26-11-10-operator-to-hexokit.md`. Run 2026-11-11 on
> dev-ws-sahil-01 (tmux 3.8, rk v3.22.9, fab-kit 2.28.11, claude / codex 0.167.1 / kimi 2.5.3).
> No production code; scripts lived in a scratchpad and are not committed.

## Verdict

**Mostly answered; claude is still missing.** codex and kimi were logged in for a second pass and
measured for real (3 runs each, ~$0.01 total). **claude is still "Not logged in" on this host**
(`claude auth status`: `loggedIn: false`, no `~/.claude/.credentials.json`), so the one provider
whose cache buckets the plan cares about (`ephemeral_5m` vs `_1h`) is unmeasured. Window mechanics
and daemon-restart survival are good for all.

| Question | Answer |
|---|---|
| Launch headless in an ephemeral window | Works for codex and kimi end to end (`rc=0`, answer `S1 OK 2`); claude blocked by auth |
| Start-up | Window → wrapper **0.2 s**; wrapper → first model output **codex ≈ 4.1 s, kimi ≈ 4.3–6.0 s** (includes reading the brief and one model call); total run **codex ≈ 5 s, kimi ≈ 6–8 s** |
| Total tokens (≈ 40 KB synthetic brief) | codex: **21 320 input**, 9–30 output; kimi: **≈ 19.6K** context tokens (its only counter, `wire.jsonl` `token_counting.*`). The brief is ≈ 20K tokens, about **2× my 10K estimate**: 40 KB of word-salad tokenizes at ~2 B/token |
| Which prompt cache | **codex: `cached_input_tokens` = 10 240 on all three runs (t₀, t₀+1 min, t₀+6 min), `cache_write_input_tokens` = 0** — a fixed ~10K prefix (instructions/tools) is cached, the brief itself never was, and the 6-min gap changed nothing. **kimi: no cache accounting exposed.** **claude: not measured** |
| Window survives rk daemon restart | **Yes** — SIGTERM and SIGKILL of the daemon, fresh daemon rediscovered the window, run finished `rc=0` |

### Measured runs (codex / kimi, resolved command + output-format flag for timing)

Launched via `rk tab new -L s1spike --session '=spike' --no-shell-fallback --json -- run.sh <tag> <cmd>`
at t₀, t₀+1 min, t₀+6 min. codex used `codex exec --json …` (JSONL events give first-output time and
usage); kimi used `kimi --output-format stream-json -p "$(cat)"`. Both differ from the resolved
`command` only by the output-format flag.

| Run | launch→start | start→first answer | total | tokens |
|---|---|---|---|---|
| codex t₀ | 0.24 s | 4.13 s | 5.08 s | in 21 320 (10 240 cached) / out 9 |
| codex t₀+1 m | 0.20 s | 4.12 s | 4.97 s | same |
| codex t₀+6 m | 0.23 s | 4.40 s | 5.24 s | same (out 30, 19 reasoning) |
| kimi t₀ | 0.25 s | 5.95 s | 7.75 s | ≈ 19 594 ctx |
| kimi t₀+1 m | 0.19 s | 4.31 s | 6.20 s | ≈ 19 594 ctx |
| kimi t₀+6 m | 0.24 s | 5.51 s | 7.95 s | ≈ 19 596 ctx |

Cost implication for M1/R5: the cache evidence so far is **no brief caching at all on codex**, so a
cold run pays the full brief every time — shrink the brief rather than count on a cache.

## Auth state (first pass, before the second login)

| Provider | Resolved headless command (`fab agent operator --headless -o yaml`) | Result here |
|---|---|---|
| claude | `claude -p --permission-mode bypassPermissions --model claude-sonnet-5-5 --effort medium` | `Not logged in · Please run /login` (`claude auth status`: `loggedIn: false`; no credentials file; the interactive agent's auth is in-process and not inherited by children) |
| codex | `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna -c model_reasoning_effort=medium` | `ERROR: unexpected status 401 Unauthorized`, after ~15 s of retries |
| kimi | `sh -c 'kimi -p "$(cat)"'` (model/effort empty) | `No model configured. Run kimi and use /login…` (~1.3 s) |

After the user's second login pass: **codex ✓, kimi ✓, claude still ✗** (the login did not persist to
this host's `~/.claude`).

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
  `Reading prompt from stdin…`). The 40 KB (~9–10K token) synthetic brief reached a stub reader
  intact (`wc -c` → 40513). The kimi form passes the brief as **one argv word**
  (`-p "$(cat)"`): `execve` rejects a single argument over 128 KiB (`MAX_ARG_STRLEN`) — tested:
  100 000 B ok, 140 000 B → `Argument list too long`. A 10–15K-token brief is ≈ 45–80 KB, so R5 is
  safe today; cap the brief below ~120 KB or give kimi a file/stdin path.
- zsh footgun when scripting: an unquoted `=spike` is expanded by zsh as a command lookup
  (`spike not found`). Quote `'=S'`.

## Daemon-restart survival (R5 acceptance)

Setup (this table is the **valid redo inside the user namespace**, not the first leaky run): isolated daemon (`RK_PORT=21150`, own `XDG_STATE_HOME`/`XDG_DATA_HOME`/`RK_CONFIG_DIR`,
`RK_SERVER_ALLOWLIST=s1spike`) against a tmux server `s1spike`; run = a stub launcher
(`wc -c; sleep 75; echo SURVIVED`) fed the 40 KB brief on stdin via the wrapper.

| Step | Observation |
|---|---|
| `SIGTERM` to daemon 1 (graceful shutdown) | Daemon exited; window `s1-stub` and its `sleep` kept running |
| Start daemon 2 | `/api/servers` showed `windowCount: 2` — window rediscovered from tmux alone |
| `SIGKILL` daemon 2 | Process gone; `sleep` still running |
| Start daemon 3, wait | Stub printed `SURVIVED` at +75 s, wrapper wrote `t_exit rc=0`; output file complete |

Exact commands (all prefixed with `unshare -Ur`, so tmux and rk resolve `/tmp/tmux-0/`, which holds
only the spike server; the process tree above was observed in this namespace):

```sh
unshare -Ur tmux -L s1spike new-session -d -s spike -c "$WORK"
RK_PORT=21150 RK_HOST=127.0.0.1 RK_SERVER_ALLOWLIST=s1spike XDG_STATE_HOME=$S/state \
  XDG_DATA_HOME=$S/data RK_CONFIG_DIR=$S/config unshare -Ur rk serve   # via setsid nohup
unshare -Ur rk tab new -L s1spike --session '=spike' --cwd "$WORK" --json -- \
  "$S/run.sh" stub1 sh -c 'wc -c; sleep 75; echo SURVIVED'
kill -TERM|-KILL <pid of the listener on 127.0.0.1:21150>   # never pgrep -x rk
```

Limits of the test: a stub, not a real provider (a real provider holds a network connection to the
API, which is independent of the daemon, so no difference is expected); the note-write at the end
of a run was not exercised (R5 work).

## Surprises

1. **`RK_SERVER_ALLOWLIST` does not scope control-mode attach.** The first isolated daemon opened
   `tmuxctl` sockets on **all six live tmux servers** (`code`, `fab_kit`, `hexokit`, `hexokit2`,
   `loom`, `rk-daemon`) for ~13 s before being SIGTERMed — only its read path (`/api/servers`) was
   filtered. No live session was touched (all six servers' session counts were unchanged afterwards;
   the live daemon was never signalled or restarted), but this is a gap in the e2e rig's isolation
   claim and a real bug (`RK_SERVER_ALLOWLIST` should also scope tmuxctl attach) to file as a follow-up (an allowlist-aware tmuxctl open). The test was redone inside
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
- **Do not freeze the cold-cache / $30 assumption on this spike.** codex shows no brief caching;
  claude's 5m-vs-1h behaviour is still unmeasured — run the recipe below for claude (one provider
  left) or let M1 confirm.

## Recipe to finish the measurements (claude only; needs a working `claude auth login`)

1. Log in: `claude auth login` (confirm `claude auth status` says `loggedIn: true` in the shell that will run it).
2. Generate a ≈ 40 KB brief (any filler rules text ending with "Reply `S1 OK` and exit; use no tools").
3. For each provider, in a new window (`rk tab new --session '=S' --cwd <tmpdir> --no-shell-fallback -- sh -c '<resolved command> < brief.md'`),
   run at t₀, t₀ + 1 min (inside the 5-min TTL) and t₀ + 6 min (beyond it), keeping the timestamp wrapper
   (`run.sh`: `date +%s.%N` at start, per output line, and at exit).
4. claude: sum `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`,
   `cache_creation_input_tokens` and read `usage.cache_creation.ephemeral_5m_input_tokens` vs
   `ephemeral_1h_input_tokens` from `~/.claude/projects/<cwd-slug>/*.jsonl`. The t₀+1 run should show a large `cache_read`; the t₀+6 run shows whether the 5m or 1h bucket was re-created.
5. codex/kimi: use `--json`/session logs for token counts; record "not observable" where absent.
   First-token = first transcript entry timestamp minus `t_start`.
