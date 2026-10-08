# HexoKit skill

The agent skill bundle for **HexoKit** — the tmux session manager with a web UI that may be hosting the pane you are running in. This is a static usage briefing: when to reach for HexoKit, what it can do, how it composes with the rest of your session, and the traps to avoid. It never changes between invocations; live values (your location, the server URL) you derive directly — see [Where am I](#where-am-i).

## Topics

Depth for a specific job lives in topic pages — pull one at use-time:

- **large change through one operator** (dedicated server, worker worktrees, integration branch, PR and authorized merge) → `rk skill change`
- **panes, iframes & visual display** → `rk skill display`
- **agent-to-agent messaging concepts** (which channel for write/read/wait, spawn-then-deliver past trust walls — the `ready`/`parked` readiness standard) → `rk skill messaging`
- **`rk mux` verb reference** (send/await/capture/kill/process/panes/sessions/inventory flags, gates, report words) → `rk skill mux`; start fleet inspection with `rk mux inventory --json` (MCP: `inventory`), then address panes by returned server + id
- **act inside the `code` lens editor** (run VS Code palette commands in the open code-server window from the shell) → `rk skill code`
- **drive and screenshot the host GUI display** (launch apps with DISPLAY set, take a PNG the human also sees in the GUI tile) → `rk skill gui`
- **schedule a prompt for later or on a cadence** (user says "check on this every 30 min", "nudge me when…", "remind me at 9") → `rk skill cron`
- **guided first-run tour** (when the user asks for a tutorial, tour, or onboarding) → `rk skill tutorial`
- **drive the tab UI** (layouts, web-tab strip, code folder, sidebar signals — `rk tab --help`); works with `rk serve` down

## When to use

You are an agent working inside a tmux pane, and HexoKit may be managing it. Reach for HexoKit to:

- **Notify the human out-of-band** — surface a result or a question to their browser/phone without blocking your loop.
- **Show web content visually** — render generated HTML, a diagram, a report, or a local dev server as a window the user can see, instead of describing it in text.

For own-pane and UI helpers, gate first — HexoKit is optional and may be absent:

```sh
command -v rk >/dev/null 2>&1 && [ -n "$TMUX_PANE" ] || exit 0
```

If either check fails, skip own-pane/UI helpers silently and describe output in text. Live fleet queries (`rk mux inventory` and MCP `inventory`) work outside a tmux pane, with no daemon dependency.

> `rk` is the short alias; `hexokit` is the full binary name. Both work everywhere.

## Capabilities

One line each, keyed to the subcommand or tmux option that does it:

- `rk notify <message> [--title <t>]` — Web Push a message to every subscribed browser/device. Fail-silent by contract (see Output contracts).
- `rk url` — print the HexoKit **server URL** (config-derived: `port:` in config.yaml or the RK_HOST/RK_PORT env, default `http://127.0.0.1:6123`). It is a heuristic, not a liveness probe. Run it at use-time; never hardcode the value.
- `rk present <path|url>` — attach web content beside your own terminal: a file, a directory, a `:port`, a localhost URL, or an external URL. Prints the resolved URL to stdout. Alias of `rk tab web add <target> --show` — it also opens the web tile. Depth: `rk skill display`.
- `rk tab new [--layout L] [--name N] [--json] [--ready] [-- CMD…]` — create a window (born with a layout when given); prints `@N`. A command after `--` is argv, never a shell string — each token reaches the process as one literal word; for in-window shell expansion pass `-- sh -c "…"`. The pane drops into an interactive shell when the command exits (`--no-shell-fallback` lets it die instead). `--json` prints the standard envelope `{"ok":true,"result":{session, window_id, pane_id}}`; `--ready` (requires `--json` + a command) waits for boot readiness and adds the verdict as `"ready"` inside `result` (a `gone` verdict reads `ok:false` with the object still carried in `result`).
- `rk tab layout [@N] [L|--add S|--rm S|--promote S|--cycle]` — read or mutate the tab's surface layout, a split tree (quote it for the shell: `'h(tty,web)'`, …; a legacy `split-h:tty,web` string still parses and rewrites to the tree); unset reads as `tty`.
- `rk tab web add|rm|select|ls` — manage the tab's web-tab strip (add takes a `present` target; rm/select address `@N/web/<n>` or bare `<n>`; `ls [--json]` lists — the JSON rides the envelope as `{"ok":true,"result":{…}}`).
- `rk tab code set [@N] <folder>` — point the tab's code surface at a folder; `rk tab show [@N] [--json]` dumps every `@rk_win_*` option (`--json` wraps the options object: `{"ok":true,"result":{…}}`).
- `rk board show [name] [--json]` · `pin|unpin <name> <@N>` · `reorder <name> <@N> [--before @N] [--after @N]` — pin windows onto the cross-server board dashboards (`--json` rides the envelope); needs `rk serve` up (it rides the daemon, unlike `rk tab`).
- `rk tab color|mark|note|flair [@N] <v> | --off` — set or clear the sidebar signal options below (validated against the same closed sets the dashboard renders).
- **Sidebar signals** — annotate your window's sidebar row so a human scanning many agents sees your state at a glance. Write through the `rk tab` verbs (validated, epoch-stamped for you); `[@N]` omitted writes your own tab, and `--off` clears:
  - `rk tab color <v>` — row color: an ANSI index `0`–`15`, a palette family name, or a blend `a+b`; stored and printed normalized.
  - `rk tab mark <v>` — stage marker: `manual|auto|blocked` × `:1|:2|:3` (bare mode = stage 1); `blocked` is the "I'm stuck" flag.
  - `rk tab note <text>` — a short status line on the row's flyout card (stale-dims after 24h); stamped `"<epoch>:<text>"` for you, e.g. `rk tab note "tests green, drafting PR"`; `-` reads the text from stdin.
  - `rk tab flair <name>` — animated row flair from a closed set (`rain`, `scan`, `matrix`, `nyan`, …); unknown values are rejected.
  - `rk tab owner operator` — operator-facing only (the fab operator's enrollment marker); not an agent signal.
  - rk absent: fall back to raw `tmux set-option -w @rk_win_<name> <value>` (`-u` unsets) — same option names as the verbs.
- `rk mux send <target> [<msg>|-]` — deliver a message into another agent's pane, gated on its `@rk_pane_agent_state`, with a pre-Enter paste probe and post-Enter non-submission detection; a changed pane frame makes no submit claim. Depth: `rk skill mux`.
- `rk mux await <target>` — block until a pane's agent state (or a `--file` signal) fires; prints a one-word report. Depth: `rk skill mux`.
- `rk mux new <name> [--ephemeral]` — create a detached tmux server on socket `<name>`; scratch servers are created with `--ephemeral` and bulk-cleaned with `rk mux reap --ephemeral` (never bare `tmux kill-server`). Depth: `rk skill mux`.
- `rk code exec <command> [json-arg…]` — act inside the `code` lens editor: run a VS Code palette command in an open code-server window, resolving its host via `--host`/`--tab` (the tab's `@rk_win_code_root`)/`--folder`/the cwd's git toplevel. `rk code hosts` lists live hosts; `rk code commands` grep-lists command ids. Depth: `rk skill code`.
- `rk gui exec <cmd…>` / `rk gui shot [--out f.png]` — run a command on the host GUI display (DISPLAY set; `--detach` launches and returns) and screenshot it to a PNG whose path prints to stdout. Gated on the user's `gui.enabled` switch — exit 1 with the hint when off; never run `rk gui on` yourself. Depth: `rk skill gui`.
- `rk skill display` — the visual-display topic page: target forms, attach vs. standalone windows, the proxy, and the canonical Visual Display Recipe, in depth.
- **Proxy** — reach a local service through the HexoKit server:

  ```
  {server_url}/proxy/{port}/...
  ```

  The relative form `/proxy/{port}/...` works from the frontend behind any origin or reverse proxy.
- **Visual Display Recipe** — the canonical flow to show HTML to the user:
  1. **Generate HTML** to a known location (a temp dir or the project tree).
  2. **`rk present ./file.html`** — serves it live and attaches it to your window's web tile; re-run the same command to refresh.
  3. **Optionally `--notify`** — push the user when they may be away.
  4. **Fail silently** — if any prerequisite is unavailable (HexoKit missing, not in tmux), skip the rest without surfacing an error.

## Where am I

This bundle is static, so it can't report your live location — derive it directly:

```sh
echo "$TMUX_PANE"                                # pane ID, e.g. %82 (empty ⇒ not in tmux)
tmux display-message -t "$TMUX_PANE" -p '#S'     # session
tmux display-message -t "$TMUX_PANE" -p '#W'     # window
tmux show-option -w -t "$TMUX_PANE" -qv @rk_win_layout # surface layout (empty ⇒ single terminal)
rk url                                           # server URL (config-derived)
```

## Composition patterns

- **Large changes:** MCP `new_server {name}` creates a durable server; `operator {server, dir}` starts its operator in an absolute repository directory. Creation does not certify boot or kickoff delivery; inspect the operator with `inventory`/`capture` before handoff. Use the returned `window` with `operator_request {server, template:"user-message", window, text}` to hand off scope, target branch and acceptance checks. Tell the operator to read `rk skill change`, create an integration worktree, coordinate worker branches, validate the combined diff and return an integration PR. A request receipt proves submission, not completion; verify artifacts and GitHub. Merge within the user's authorization after required checks pass. Leave panes and worktrees available for review.
- **Discover the server URL at use-time** via `rk url`, never hardcode it — it is config-derived from this environment (see [Where am I](#where-am-i)).
- **`rk skill` is the static briefing; you derive the live details.** Read the bundle to learn *what* HexoKit does; run the [Where am I](#where-am-i) derivations to learn *where* you are, and `rk skill display` for the visual-display recipe in depth.
- **`rk notify` is the default non-blocking escalation channel** for out-of-band messages to the human, gated on `command -v rk`:

  ```sh
  command -v rk >/dev/null 2>&1 && rk notify "build finished" --title "CI"
  ```

## Output & exit-code contracts

- **`--json` on a mutating verb prints exactly one `{"ok":true,"result":…}` document on stdout** (or `{"ok":false,"error":{"code","message"}}` on failure — `code` is `usage` for exit 2, `operational` otherwise) and changes nothing else: exit codes, stderr, and the default human line are byte-identical without the flag. The verbs that carry it: `mux new`, `mux kill`, `cron add`, `cron rm`, `cron mute`, `tab layout`, `tab web add|rm|select|mv`, `tab code set`, `gui exec --detach`, `operator`, `riff`, `notify`. Each receipt names the id it created or changed — `mux new` → `{report, server, ephemeral}`, `mux kill` → `{report, target}`, `cron add` → `{id, name, schedule, target}`, `cron rm` → `{id, removed}`, `cron mute` → `{id, muted, until?}`, `tab layout` → `{window, layout}`, `tab web` → `{window, index, url?, tabs}`, `tab code set` → `{window, code_root}`, `gui exec --detach` → `{pid, display}`, `operator` → `{window, server, created}`, `riff` → `{windows:[{id, name, server, panes, worktree, branch}]}`, `notify` → `{delivered}`.
- **`rk notify` is fail-silent by contract.** Any error — server unreachable, no subscriptions, non-2xx — exits **0** and prints nothing, so it never stalls a calling loop. With `--json` the receipt says it instead: `{"delivered":false}` is not an error. Do not branch on its output.
- **`rk present` prints only the resolved URL to stdout** (data — printed even under `--quiet`); diagnostics go to stderr. Its exit codes follow the convention below; its `--notify` send stays fail-silent like `rk notify`.
- **`rk tab` verbs print one datum to stdout** — `tab new` prints `@N` (`--json` prints `{"ok":true,"result":{session, window_id, pane_id[, ready]}}`), `tab web add` prints `@N/web/<n>` (the URL echoes to stderr), `tab layout` prints the resulting layout value, the signal setters (`tab color|mark|note|flair|owner`) print the stored value (the note's stamped `<epoch>:<text>`, the normalized color), and `tab web ls`/`tab show` print rows (`--json` wraps the object in the same envelope). rm/select and every `--off` print nothing on success. With `--json` (inside the same envelope's `result`), `tab layout` prints `{"window","layout"}` (read and mutate alike), `tab code set` prints `{"window","code_root"}`, and the `tab web` mutations print `{"window","index","url"?,"tabs"}` — `index` is the affected slot (mv: the destination) and `tabs` the post-mutation family; `--show`/`--json` are persistent flags of `tab web` and `--show` on rm/select/mv is a usage error.
- **`rk mux send`/`rk mux await` print exactly one report line to stdout** — `delivered|unverified|staged|sent <pane>` for send (the await report word under `--await`), and the reached state / `file` / `running` / `gone` for await — plus `ready %N (state)` / `ready %N (echo)` / `parked %N` / `narrow %N (WxH)` (all exit 0 — `parked` and `narrow` are classifications, not failures; the wall's screen snippet or the narrow geometry + remedy ride stderr) under `--ready`. A changed post-Enter frame makes no submit claim and reports `delivered`; successful recovery also reports `delivered`. `unverified` means the engine detected non-submission and bounded recovery did not fix it (exit 1); capture the pane before resending, because the message may or may not have landed and a resend may duplicate it. Diagnostics go to stderr; `gone` and gate refusals also exit 1.
- **`rk skill`, `rk url`, and `rk help-dump` print data to stdout** (stdout is data; stderr is diagnostics). `rk skill` emits this bundle byte-identical with empty stderr and exit 0; `rk skill <topic>` (e.g. `display`) prints one topic page under the same contract, and an unknown topic exits non-zero with the valid topics on stderr; `rk url` prints the server URL newline-terminated; `rk help-dump` emits the machine-readable command tree.
- **Exit codes follow the toolkit convention: `0` success, `1` operational failure, `2` usage error** — usage/flag/arg-count/unknown-command errors exit `2`; operational failures (dead server, failed check) exit `1`; `rk riff` subprocess failures exit `3`. The diagnostic is on stderr. (`rk notify` is the exception above — runtime failures exit `0`.)

## Gotchas

- `@rk_win_layout` / `@rk_win_web_<n>` changes are picked up by the server's SSE polling automatically — no refresh, no API call. The retired `@rk_win_lens` / `@rk_win_url` are accepted only via compat for one release.
- Legacy option names (`@rk_type`, `@rk_url`, `@rk_note`) are still read for now.
- Killing a tmux window kills the backing process — no separate cleanup step is needed.
- `set-option -w` targets the **current** window: create the window first, then set options from within it (or pass `-t <window>`).
- The server URL is config-derived from this environment — always get it from `rk url`, never hardcode.
- Gate own-pane/UI helpers and skip those silently when rk or `$TMUX_PANE` is absent. Fleet queries, server creation and explicitly targeted operators work outside tmux; report failures of an explicitly requested workflow.
