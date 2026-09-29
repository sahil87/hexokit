# Intake: Deterministic Operator Launch Directory

**Change**: 260925-rrax-deterministic-operator-launch-dir
**Created**: 2026-09-25

## Origin

Conversational — synthesized from a user discussion and dispatched promptless (`{questioning-mode} = promptless-defer`): no questions were asked; every would-be question is recorded as a deferred row in `## Assumptions`.

> **Title**: Deterministic operator launch directory
>
> **Problem**: `rk operator -L <server>` — the daemon path used by the dashboard's Start Operator / Cmd+J (`POST /api/operator/start` in `app/backend/api/operator_start.go`, which execs `rk operator -L <server> --json` with no `--dir`) and by the operator-tick cron respawn — picks the operator window's working directory via `operatorLaunchRoot` (`app/backend/cmd/rk/operator.go`): among user-role sessions' main-worktree roots carrying the fab-operator skill, sole → most-attached → most-windows → first-in-enumeration. The inputs (attach counts, window counts, enumeration order) change constantly, so from the user's view the operator lands in a different folder each time. User's principle: **deterministic behavior, even if sometimes not correct, beats a non-deterministic heuristic.** The operator's cwd matters: when the user says "start a session / start a tab", the operator uses its cwd as the default project, so `$HOME`-always is not acceptable.

Seven decisions were agreed with the user in the discussion (reproduced in § What Changes and graded in § Assumptions). Rejected in the discussion: always-`$HOME`, a `settings` registry key (`operator.dir`), and keeping any ranking over live session facts.

This change **supersedes** two recorded Design Decisions in `docs/memory/run-kit/rk-riff.md` (introduced by `260913-t7vy-operator-daemon-launch-root-kickoff`): "Derive the operator's server-mode launch root from live sessions, not a setting" and "Skill presence is the launch-root qualification test". Hydrate reverses them with this change's rationale.

## Why

1. **The pain**: every Start Operator / Cmd+J / cron respawn re-ranks the server's live sessions (attach counts, window counts, enumeration order). Those facts move constantly — attaching a second browser, opening a window, or reordering sessions flips the winner — so the operator lands in a different folder from one launch to the next, with no way for the user to predict or steer it.
2. **The consequence**: the operator's cwd is its default project. "Start a session / start a tab" requests resolve against it, so a surprise cwd sends new work to the wrong repo. A launch into a linked worktree is worse: `wt delete` removes it after its PR merges, stranding the operator in a deleted directory.
3. **Why this approach**: the user's principle is determinism over cleverness. The new rule is fully predictable from the user's own action — the operator starts where the user is (the viewed window, collapsed to its main checkout); a respawn reuses the directory the operator was last started in (stored on the tmux server); and only when neither exists does it fall back to `$HOME`. The skill-presence qualification is unnecessary because `fab sync` already writes a user-level pointer skill at `~/.claude/skills/fab-operator/SKILL.md` (and `~/.agents/skills/…`), so `/fab-operator` resolves from any directory, including `$HOME`.
4. **Alternatives rejected** (from the discussion):
   - **Always `$HOME`** — deterministic but loses the operator's default-project context for "start a tab/session".
   - **A `settings` registry key (`operator.dir`)** — proposed earlier, superseded by the explicit-from-the-viewed-window rule plus the per-server option (it would also be a global value for a per-server fact).
   - **Keeping any ranking over live session facts** — the volatility IS the bug.

## What Changes

### 1. `rk operator` directory selection (`app/backend/cmd/rk/operator.go`)

**Remove the ranking entirely**:

- Delete `operatorLaunchRoot` and its rungs (sole / most-attached / most-windows / first).
- Delete `hasOperatorSkill` and `operatorSkillPaths` (the skill-presence qualification test).
- Delete the now-unused seams `operatorSessionFactsFn` and `operatorMainRootFn` from operator.go (the collapse to the main checkout moves to the daemon handler — § 3). `tmux.ListSessionFacts` / `gitinfo.MainWorktreeRoot` themselves stay: `rk tab new` (`tab_new.go`) still uses them for its own, unrelated `session_rung` ladder, which this change does NOT touch.
- Delete the `dirRungSole`, `dirRungMostAttached`, `dirRungMostWindows`, `dirRungFirst` constants.

**New directory-selection switch** (replaces the switch at ~:373–415):

```
case operatorDirFlag != "":          // explicit --dir (CLI or daemon-derived)
    windowDir = operatorDirFlag       // verbatim — no collapse here
    rung      = "explicit"
    root      = config.FindGitRoot(dir) || dir      // unchanged agent-resolution root
case serverMode:                      // -L without --dir (cron respawn argv, Host-page Start)
    stored := read @rk_srv_operator_root on the target server
    if stored passes validateOperatorDir (absolute, exists, is a directory):
        windowDir = stored
        rung      = "stored"
        root      = config.FindGitRoot(stored) || stored
    else:                             // unset, unreadable, or no-longer-existing directory
        windowDir = $HOME (os.UserHomeDir)
        rung      = "home"
        root      = ""                // unchanged: $HOME leaves the agent root empty
default:                              // interactive in-tmux, no -L — UNCHANGED
    root = config.FindGitRoot(cwd); windowDir = root || cwd
```

- `--dir` keeps today's verbatim semantics and validation (`validateOperatorDir`, usage error exit 2 before any subprocess, explicit empty value rejected via `cmd.Flags().Changed("dir")`).
- The interactive (in-tmux, no `-L`) path's git-root-of-cwd rule is already deterministic — its directory choice is left unchanged, and its receipt keeps omitting `dir`/`dir_rung` (omitempty, as today).
- A read failure of the stored option (server unreachable, option unset) is not an error — it degrades to `home` exactly as an unset option does.

### 2. Persist the launch directory: `@rk_srv_operator_root`

When the operator window is **created** (not on a singleton hit — no launch happened), `rk operator` records the created window's directory (`windowDir`, the `-c` argument) on the tmux server as the server-scoped user option **`@rk_srv_operator_root`** (`set-option -s`), following the `@rk_<scope>_<name>` convention in `fab/project/context.md` § Conventions.

- **Every successful create stamps it** — `--dir` launches (including daemon-derived ones), `stored` and `home` launches, and the interactive in-tmux path (stated default, see Assumptions #9).
- **Readers**: `rk operator -L <server>` without `--dir` — the cron respawn's argv and a Start from a view with no window — reads it back (§ 1).
- **Lifetime**: the tmux server's — the same lifetime as the operator window itself, so the two stay consistent. No migration row: this is a new key, so `tmux.MigrateLegacyOptions`'s table is unaffected. Not added to snapshot capture (snapshots capture `@rk_srv_rank` / `@rk_srv_session_order`; the operator root is server-lifetime state, like `@rk_srv_origin`'s exclusion).
- **Helpers**: add `tmux.SetOperatorRoot(ctx, server, dir)` / `tmux.GetOperatorRoot(ctx, server)` beside `SetServerRank`/`GetServerRank` in `internal/tmux` (all tmux interaction goes through `internal/tmux` — code-quality anti-pattern), with a named const `tmux.OperatorRootOption = "@rk_srv_operator_root"`. The Get helper follows `GetServerRank`'s posture: an unset option ("invalid/unknown option") or a gone server (`tmux.IsServerGone`) reads as "unset", not an error. The interactive path addresses the caller's server by socket (`tmuxSocketArgs(originalTMUX)`), the server path by `-L` (`operatorServerPrefix`) — the stamp must address the same server the window was created on in both modes (the helpers' exact server-addressing shape is a plan-time detail).
- **Stamp failure is best-effort**: the window and agent already exist, so a failed stamp writes a stderr note and never changes the exit code or the `--json` receipt (the kickoff-delivery degrade precedent).
- **Registry**: add the `@rk_srv_operator_root` row to `docs/memory/run-kit/tmux-sessions.md` § Server-Scoped User Options (Scope: server `-s`; Set via: `rk operator` create path; Read via: `rk operator -L` without `--dir`; Owner: operator launch directory; Dies with the server; Legacy names: —).

### 3. Cmd+J starts from where the user is (`app/backend/api/operator_start.go`)

`POST /api/operator/start` gains an optional request body field identifying the window the user is viewing:

```json
{ "window": "@7" }
```

`{}` (or an empty body) keeps meaning "no viewed window". Handler flow (after the existing `FetchSessions` pre-check / `409 operator_exists` short-circuit, which is unchanged — rule 5):

1. Parse the body; malformed JSON → `400`. A present `window` is validated with `validate.ValidateWindowID` → `400` on a malformed id.
2. Look the window up in the **already-fetched** sessions slice (no second fetch — the `findOperatorSubject` pattern in `api/operator.go`) and take its active-pane cwd (`WindowInfo.WorktreePath`, which `list-windows` fills from `#{pane_current_path}` — the active pane's cwd).
3. **Collapse to the main checkout**: `gitinfo.MainWorktreeRoot(ctx, cwd)` — a linked worktree under `<repo>.worktrees/<name>` maps to `<repo>`. When it returns `""` (not inside a git repo), use the cwd **verbatim** (deterministic — it is where the user is).
4. Append `--dir <derived>` to the argv: `[selfPath, "operator", "-L", server, "--dir", <derived>, "--json"]`. The CLI's `validateOperatorDir` gate still applies to `--dir`.
5. No `window` in the body → argv unchanged (`[selfPath, "operator", "-L", server, "--json"]`) → the CLI's `stored` → `home` rule (§ 1).

The daemon derives the path from tmux; it never accepts a client-supplied path (Constitution II — state derived from tmux; and it avoids trusting a filesystem path from the client) (stated default, Assumptions #7).

Edge handling (Confident — Assumptions #12): a well-formed `window` that is not on the server (closed between the click and the request), or whose derived directory fails a pre-exec absolute/exists/is-dir check, degrades to the no-window argv (stored → home) rather than failing the start; the handler's `validateOperatorDir`-equivalent pre-check prevents a doomed exec from surfacing a `502` usage error.

Everything else in the handler is unchanged: detached 90 s process context, 30 s receipt bound, receipt parse (`parseOperatorStartEnvelope`), `202` / `409` / `502` / `504` / `500` mapping, SSE wake, and the post-exit `kickoff: undelivered … dir=<quoted>` note → `slog.Warn` + tagged `notify` toast (the toast reads the note's `dir`, not `dir_rung`, so its text needs no change).

### 4. Frontend: send the viewed window (`app/frontend/src/api/client.ts` + callers)

- `startOperator(server: string, windowId?: string)` — body `{"window": windowId}` when given, else `{}` (today's shape). Stays POST (Constitution IX).
- Callers that must pass the viewed window:
  - The quake terminal's **Start operator** button (`components/quake-terminal.tsx`, the operator-less body, `data-testid="quake-terminal-start-operator"`).
  - The **`Operator: Start operator`** palette entry (`buildOperatorStartAction` in `lib/palette/quake-terminal.ts`, registered in `hooks/use-global-palette-actions.ts`) — the only Start path on mobile.
- **Which window counts as "viewed"**: the Terminal route's (`/$server/$window`) window, and only when the route's server equals the server the operator is being started on. The quake terminal's server can differ from the route's (picker / pinned server — `resolveQuakeServer`); in that case the viewed window lives on another server and no window is sent (Assumptions #8).
- Views with no single window — Host (`/`), tmux Server (`/$server`), Board (`/board/$name`) — send no window → no `--dir` → `stored` → `home` (Assumptions #11 for Board).

### 5. Existing operator → just open it (rule 5, unchanged behavior)

Cmd+J / Start when an operator window already exists only focuses/opens it — today's `409 operator_exists` pre-check and the CLI's `created:false` singleton hit. It never re-roots the operator and never re-stamps `@rk_srv_operator_root`. To move the operator, the user kills it and starts it again from the desired window.

### 6. Receipt `dir_rung` vocabulary

The `--json` created receipt's closed token set becomes **`explicit | stored | home`** (was `sole | most-attached | most-windows | first | home | explicit`). `dir`/`dir_rung` still appear only when a directory decision was made in server mode or via `--dir`; singleton hits and the interactive default omit both.

**Consumer inventory** (grepped `dir_rung|DirRung|dirRung|most-attached|operatorLaunchRoot|hasOperatorSkill`):

| Consumer | What reads the rung | Change |
|----------|--------------------|--------|
| `app/backend/cmd/rk/operator.go` | constants, receipt, help text | rewrite per § 1/§ 6 |
| `app/backend/cmd/rk/operator_test.go` | ~14 references (ranking-ladder tests, receipt assertions) | replace ladder tests with explicit/stored/home + stamp tests |
| `app/backend/api/operator_start.go` | `operatorStartReceipt.DirRung` struct field only (tolerant parse); the toast uses the kickoff note's `dir` | no logic change; comment update if it names the old tokens |
| `app/backend/api/operator_start_test.go` | ~6 references (fixture receipts) | update fixtures to the new tokens; add body/argv tests |
| Frontend | none — `OperatorStartResult` is `{windowId, server}`; the rung never reaches the client | none for the rung |
| MCP (`internal/mcp/policy.go` `operator` tool; `docs/specs/mcp.md` § receipts) | none — the tool exposes `-L`/`--workers` only; the documented receipt is `{window, server, created}`; `operatorDescription` does not mention the directory | none (verify at apply) |
| `app/backend/cmd/rk/tab_new.go` / `tab_new_test.go` | its OWN `sessionRungMostAttached` (`session_rung`) — a different ladder | **out of scope — do not touch** |
| Memory: `rk-riff.md`, `architecture/cli.md`, `api-and-sockets.md` | prose describing the ladder and token set | hydrate rewrites |

### 7. Help text and docs

- `rk operator` Long help and the `-L/--server` flag help: replace the "derived from the server's own sessions … sole … most attached … most windows … earliest session" paragraph with the new rule — `-L` without `--dir` opens in the directory recorded by the server's last operator launch (`@rk_srv_operator_root`), else your home directory; `--dir` pins it outright; every created operator records its directory for later respawns. (Toolkit standards: help-dump surface — check against `shll standards`.)
- `docs/specs/api.md` § `POST /api/operator/start`: the body is no longer ignored — document `{"window"?: "@N"}`, the server-side derivation (active-pane cwd → main-worktree collapse → `--dir`), the `400` responses, and the no-window fall-through. POST-only (Constitution IX).

## Affected Memory

- `run-kit/rk-riff`: (modify) reverse the Design Decisions "Derive the operator's server-mode launch root from live sessions, not a setting" and "Skill presence is the launch-root qualification test" with this change's rationale (determinism over heuristics; the user-level pointer skill makes skill-presence moot); rewrite the `operator.go` file-map entry (no `operatorLaunchRoot`/`hasOperatorSkill`, the explicit → stored → home rule, the new token set, the `@rk_srv_operator_root` stamp)
- `run-kit/tmux-sessions`: (modify) add the `@rk_srv_operator_root` row to § Server-Scoped User Options and list it in the section's server-scoped option inventory sentence
- `run-kit/architecture/cli`: (modify) the `operator` row — server-mode directory selection, receipt `dir_rung` token set, the stamp on create
- `run-kit/api-and-sockets`: (modify) the `/api/operator/start` row — the optional `{"window"}` body, the server-side cwd derivation + main-worktree collapse, the `--dir` argv, the `400`s, the no-window fall-through
- `run-kit/ui/quake-terminal`: (modify) the Start operator button and the `Operator: Start operator` palette entry send the viewed window (same-server Terminal route only)

`run-kit/agent-send` mentions `260913-t7vy` only for the `WaitThroughWalls` server-mode delivery decision, which this change does not touch — no update expected.

## Impact

- **Backend CLI**: `app/backend/cmd/rk/operator.go` (directory switch, deletions, stamp, help text), `app/backend/cmd/rk/operator_test.go`.
- **Backend tmux**: `app/backend/internal/tmux` — new `OperatorRootOption` const + Set/Get helpers (+ tests).
- **Backend API**: `app/backend/api/operator_start.go` (body parse, window lookup, `gitinfo.MainWorktreeRoot` collapse, argv), `app/backend/api/operator_start_test.go`. `internal/gitinfo` is reused, not changed.
- **Frontend**: `app/frontend/src/api/client.ts` (`startOperator` signature/body), `components/quake-terminal.tsx`, `lib/palette/quake-terminal.ts`, `hooks/use-global-palette-actions.ts` (+ their Vitest files). E2E: `app/frontend/tests/e2e/operator-page.spec.ts` stubs `POST /api/operator/start` via `page.route("**/api/operator/start*", …)` and asserts the call — extend to assert the `window` body where the spec covers a Terminal route (intent comments per Constitution Test Intent Comments).
- **Specs/docs**: `docs/specs/api.md` § `POST /api/operator/start`; memory per § Affected Memory.
- **Out of scope**: `rk tab new`'s `session_rung` ladder; the MCP `operator` tool surface; the cron respawn argv itself (fab-kit owns the operator-tick entry — its argv `rk operator -L <server>` needs no change, it just gains the stored-root read); the kickoff delivery path.
- **Security**: the path passed as `--dir` is derived server-side from tmux, never taken from the client; `exec.CommandContext` argv slice unchanged (Constitution I).
- **Behavior change on upgrade**: servers running before this change have no `@rk_srv_operator_root`, so their first no-window launch / cron respawn after upgrade lands in `$HOME` (see Assumptions #13).

## Open Questions


## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Remove `operatorLaunchRoot`, its rungs (sole/most-attached/most-windows/first), `hasOperatorSkill`, `operatorSkillPaths`, and the now-unused `operatorSessionFactsFn`/`operatorMainRootFn` seams from operator.go | Discussed — user agreed; the ranking's volatility is the bug; `fab sync`'s user-level pointer skill makes skill presence moot | S:95 R:80 A:90 D:95 |
| 2 | Certain | Cmd+J/Start sends the viewed window; the daemon derives its active-pane cwd and passes it to `rk operator` as `--dir`; no window → no `--dir` | Discussed — user agreed ("starts from where the user is") | S:95 R:75 A:85 D:90 |
| 3 | Certain | The daemon-derived cwd is collapsed to its main-worktree root via `gitinfo.MainWorktreeRoot`; a non-repo folder is used verbatim; an explicit CLI `--dir` stays verbatim | Discussed — user agreed; main checkout is the right project and a linked worktree is deleted by `wt delete` after merge | S:95 R:75 A:90 D:90 |
| 4 | Certain | Persist the launch directory as server-scoped `@rk_srv_operator_root`; `rk operator -L` without `--dir` reads it; unset or missing directory → `$HOME`; registry row in tmux-sessions.md | Discussed — user agreed; naming per the `@rk_<scope>_<name>` convention in context.md; server lifetime matches the operator window's | S:95 R:75 A:90 D:90 |
| 5 | Certain | An existing operator is only focused/opened — never re-rooted, never re-stamped (today's 409 `operator_exists` / `created:false`) | Discussed — user agreed (rule 5) | S:95 R:85 A:95 D:95 |
| 6 | Certain | The interactive in-tmux (no `-L`) path's directory choice stays git-root-of-cwd, unchanged | Discussed — user agreed it is already deterministic | S:95 R:90 A:95 D:95 |
| 7 | Confident | The request carries the window identity (`{"window":"@N"}`) and the daemon derives the path from tmux; no client-supplied path is accepted; `validateOperatorDir` still gates `--dir` | Stated default in the discussion — Constitution II and not trusting a client path | S:85 R:70 A:85 D:80 |
| 8 | Confident | "Viewed window" = the Terminal route's window, sent only when the route's server equals the server the operator is being started on (the quake terminal's picker/pinned server can differ) | Follows from "starts from where the user is": a window on another server is not where the operator will run; quake-terminal.tsx already distinguishes `routeServer` from the resolved `server` | S:60 R:80 A:70 D:65 |
| 9 | Confident | Every successful create stamps `@rk_srv_operator_root` with `windowDir` — `--dir`, `stored`, `home`, and the interactive path; a singleton hit does not stamp | Stated default in the discussion ("every successful launch stamps it, including `--dir` launches and the interactive in-tmux path") | S:85 R:75 A:80 D:80 |
| 10 | Confident | `dir_rung` token set becomes `explicit` / `stored` / `home`; dir/dir_rung still omitted on singleton hits and the interactive default; consumers are cmd/rk + api tests only (frontend/MCP never read the rung) | Discussed ("e.g. explicit / stored / home"); inventory grep confirms the rung reaches no client or MCP consumer | S:75 R:80 A:80 D:75 |
| 11 | Confident | Board (`/board/$name`) — like Host and Server pages — sends no window, even if a tile is focused | A board aggregates panes from many windows, so there is no single "viewed window"; the discussion named only Host/Server pages. Using a focused board tile is a later additive change | S:40 R:85 A:50 D:45 |
| 12 | Confident | A well-formed `window` absent from the server, or whose derived directory fails an absolute/exists/is-dir pre-check, degrades to the no-window argv (stored → home) instead of failing the start; malformed JSON or a malformed window id → `400` | The deterministic fall-through keeps a raced close from breaking Start; a `400` for malformed input matches the API's validation posture | S:35 R:80 A:60 D:45 |
| 13 | Certain | Upgrade backfill: none — `@rk_srv_operator_root` is never seeded from an already-running operator window (no singleton-hit write, no daemon sweep); the first post-upgrade cron respawn on a server without the option lands in `$HOME` once, and every later launch follows the stored rule | Clarified — user confirmed: no backfill (least code; a one-time `$HOME` landing is still deterministic) | S:95 R:70 A:90 D:95 |
| 14 | Confident | Stored-root read failure (option unset, server unreachable) degrades to `home`, never an error; a failed stamp is a stderr note, never an exit-code or receipt change | Follows the `GetServerRank` unset/`IsServerGone` posture and the kickoff-delivery best-effort precedent in operator.go | S:65 R:85 A:80 D:75 |
| 15 | Confident | Agent resolution root: `stored` behaves like `explicit` (`config.FindGitRoot(dir)` falling back to the dir); `home` keeps the empty root | Mirrors the existing `--dir` branch; no discussion signal against it | S:55 R:85 A:80 D:75 |
| 16 | Confident | `@rk_srv_operator_root` is not added to layout-snapshot capture, and needs no `MigrateLegacyOptions` row | New key (no legacy name); its stated lifetime is the tmux server's, like `@rk_srv_origin`'s snapshot exclusion | S:60 R:85 A:80 D:80 |
| 17 | Certain | `rk tab new`'s `session_rung` ladder (and its use of `ListSessionFacts`/`MainWorktreeRoot`) is out of scope | Different verb, different ladder; the discussion scoped the change to the operator launch directory | S:85 R:90 A:95 D:90 |

17 assumptions (8 certain, 9 confident, 0 tentative, 0 unresolved).
