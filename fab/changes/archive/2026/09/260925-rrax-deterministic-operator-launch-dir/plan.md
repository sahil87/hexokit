# Plan: Deterministic Operator Launch Directory

**Change**: 260925-rrax-deterministic-operator-launch-dir
**Intake**: `intake.md`

## Requirements

### CLI: Operator Launch Directory Selection (`app/backend/cmd/rk/operator.go`)

#### R1: Ranking removal
operator.go MUST NOT retain the live-session ranking: `operatorLaunchRoot`, `hasOperatorSkill`, `operatorSkillPaths`, the `operatorSessionFactsFn`/`operatorMainRootFn` seams, and the `dirRungSole`/`dirRungMostAttached`/`dirRungMostWindows`/`dirRungFirst` constants are deleted. `tmux.ListSessionFacts` and `gitinfo.MainWorktreeRoot` themselves stay (rk tab new uses them).

- **GIVEN** the pre-change operator.go with the ranking ladder
- **WHEN** the change is applied
- **THEN** none of the named symbols or tokens exist anywhere in cmd/rk
- **AND** `rk tab new`'s `session_rung` ladder is untouched

#### R2: Server-mode directory rule (explicit → stored → home)
`rk operator -L <server>` without `--dir` MUST read the server-scoped option `@rk_srv_operator_root`; when it is set and passes `validateOperatorDir` (absolute, exists, is a directory) the window opens there (`dir_rung` = `stored`, agent-resolution root = `config.FindGitRoot(stored)` falling back to the stored dir). When it is unset, unreadable, or fails validation, the window MUST open in `$HOME` (`dir_rung` = `home`, agent-resolution root left empty). A read failure of the stored option (server unreachable, option unset) is never an error — it degrades to `home`.

- **GIVEN** a server whose `@rk_srv_operator_root` names an existing directory
- **WHEN** `rk operator -L <server> --json` runs with no `--dir` and no operator window present
- **THEN** the new window's `-c` is the stored directory and the receipt carries `dir`/`dir_rung: stored`
- **AND** with the option unset or pointing at a deleted directory, the `-c` is `$HOME` and the receipt carries `dir_rung: home`

#### R3: `--dir` verbatim semantics unchanged
`--dir <path>` MUST keep today's behavior: validated (absolute/existing/directory, explicit empty rejected via `cmd.Flags().Changed("dir")`) as a usage error (exit 2) before any subprocess; used verbatim as the window directory (`dir_rung` = `explicit`); its git root (falling back to the path itself) drives agent resolution.

- **GIVEN** any invocation with `--dir /abs/existing/dir`
- **WHEN** the command runs
- **THEN** no stored-option read occurs, the window opens at the given path verbatim, and the receipt reports `dir_rung: explicit`

#### R4: Interactive path unchanged
The interactive in-tmux path (no `-L`) MUST keep the git-root-of-cwd directory choice, and its `--json` created receipt MUST keep omitting `dir`/`dir_rung`.

- **GIVEN** `rk operator` inside tmux with no flags
- **WHEN** no operator window exists
- **THEN** the window opens at `config.FindGitRoot(cwd)` (or cwd) and the receipt carries no `dir`/`dir_rung`

### CLI: Launch Directory Persistence (`@rk_srv_operator_root`)

#### R5: internal/tmux helpers
`app/backend/internal/tmux` MUST gain `OperatorRootOption = "@rk_srv_operator_root"` plus `SetOperatorRoot(ctx, server, dir)` / `GetOperatorRoot(ctx, server) (string, error)` beside `SetServerRank`/`GetServerRank`. `GetOperatorRoot` MUST follow the `GetServerOrigin` posture: an unset option ("invalid/unknown option") or a gone server (`IsServerGone`) reads as `("", nil)`, never an error.

- **GIVEN** a fresh tmux server
- **WHEN** `GetOperatorRoot` runs before any set
- **THEN** it returns `("", nil)`
- **AND** after `SetOperatorRoot(ctx, server, "/x")`, `GetOperatorRoot` returns `("/x", nil)`; on a dead server it returns `("", nil)`

#### R6: Stamp on create
Every successful operator-window create MUST stamp `@rk_srv_operator_root` (`set-option -s`) with the created window's directory (`windowDir`, the `-c` argument) on the same server the window was created on — `--dir`, `stored`, `home`, and interactive launches alike. A singleton hit (`created:false`) MUST NOT stamp. A stamp failure MUST be best-effort: a stderr note, never a changed exit code or `--json` receipt.

- **GIVEN** a successful create in either mode
- **WHEN** the window exists
- **THEN** `@rk_srv_operator_root` on that server equals the window's `-c` directory
- **AND** when the stamp subprocess fails, the command still exits 0 with an unchanged receipt and a stderr note

### Daemon: Viewed-Window Derivation (`app/backend/api/operator_start.go`)

#### R7: Request body contract
`POST /api/operator/start` MUST accept an optional JSON body `{"window": "@N"}`; `{}` or an empty body means "no viewed window" (today's behavior). Malformed JSON MUST yield `400`; a present `window` failing `validate.ValidateWindowID` MUST yield `400`. The handler MUST NOT accept a client-supplied filesystem path — only the window identity.

- **GIVEN** the endpoint with no operator present
- **WHEN** the body is `{` (malformed) or `{"window":"7"}` (malformed id)
- **THEN** the response is `400` and no exec runs
- **AND** an empty or `{}` body behaves exactly as pre-change

#### R8: Server-side derivation and argv
After the unchanged `FetchSessions` pre-check / `409 operator_exists` short-circuit, a valid `window` MUST be looked up in the already-fetched sessions slice (no second fetch); its active-pane cwd (`WindowInfo.WorktreePath`) MUST be collapsed to the main checkout via `gitinfo.MainWorktreeRoot` (`""` → the cwd verbatim), and the exec argv MUST become `[selfPath, "operator", "-L", server, "--dir", <derived>, "--json"]`. A well-formed `window` absent from the server, an empty `WorktreePath`, or a derived directory failing an absolute/exists/is-dir pre-check MUST degrade to the no-window argv (never a failed start). Everything else (detached 90s context, 30s receipt bound, 202/409/502/504/500 mapping, SSE wake, kickoff-note handling) is unchanged.

- **GIVEN** a Terminal-route Start with body `{"window":"@7"}` where @7's pane cwd is inside a linked worktree of repo R
- **WHEN** the handler runs
- **THEN** the exec argv carries `--dir <R's main checkout>`
- **AND** with `{"window":"@99"}` (not on the server) the argv is the unchanged no-window form

### Frontend: Send the Viewed Window (`app/frontend/src/`)

#### R9: `startOperator` signature
`startOperator(server: string, windowId?: string)` in `app/frontend/src/api/client.ts` MUST send body `{"window": windowId}` when `windowId` is given, else `{}`. The call stays POST (Constitution IX).

- **GIVEN** `startOperator("default", "@7")`
- **WHEN** the fetch fires
- **THEN** the body is `{"window":"@7"}`; `startOperator("default")` sends `{}`

#### R10: Callers pass the viewed window
The quake terminal's Start operator button (`components/quake-terminal.tsx`) and the `Operator: Start operator` palette entry (`lib/palette/quake-terminal.ts` + `hooks/use-global-palette-actions.ts`) MUST pass the Terminal route's (`/$server/$window`) window, and only when the route's server equals the server the operator is being started on (the quake terminal's picker/pinned server can differ). Views with no single window (Host `/`, tmux Server `/ $server`, Board `/board/$name`) MUST send no window.

- **GIVEN** the user on `/default/@1` with no operator on `default`
- **WHEN** they click Start operator (or pick the palette entry)
- **THEN** the POST body is `{"window":"@1"}`
- **AND** on `/`, `/default`, or `/board/x` the body is `{}`, including when the quake server was pinned/picked away from the route's server

### Receipt Vocabulary and Docs

#### R11: `dir_rung` closed token set
The `--json` created receipt's `dir_rung` vocabulary MUST become exactly `explicit | stored | home`; `dir`/`dir_rung` still appear only when a directory decision was made in server mode or via `--dir`.

- **GIVEN** any created receipt
- **WHEN** it carries `dir_rung`
- **THEN** the value is one of `explicit`, `stored`, `home`

#### R12: Help text
`rk operator`'s Long help and the `-L/--server` flag help MUST describe the new rule (stored `@rk_srv_operator_root`, else `$HOME`; `--dir` pins; every created operator records its directory), and `rk help-dump` MUST stay conformant to the shll help-dump standard (exit 0, one JSON envelope on stdout, empty stderr).

- **GIVEN** the rebuilt binary
- **WHEN** `rk operator --help` and `rk help-dump` run
- **THEN** the help names the stored/home/explicit rule and the dump validates

#### R13: Spec update
`docs/specs/api.md` § `POST /api/operator/start` MUST document the optional `{"window"?: "@N"}` body, the server-side derivation (active-pane cwd → main-worktree collapse → `--dir`), both `400`s, and the no-window fall-through to the CLI's stored → home rule.

- **GIVEN** the updated spec
- **WHEN** a reader consults the endpoint's section
- **THEN** the body contract, derivation, and fall-through are stated accurately

### Non-Goals

- `rk tab new`'s `session_rung` ladder and its `ListSessionFacts`/`MainWorktreeRoot` use — different verb, different ladder
- The MCP `operator` tool surface (`internal/mcp/policy.go`) — exposes `-L`/`--workers` only; verified unchanged at apply
- The cron respawn argv itself — fab-kit owns the operator-tick entry; its `rk operator -L <server>` argv gains the stored-root read for free
- `docs/memory/` updates (rk-riff DD reversals, the tmux-sessions registry row, architecture/cli, api-and-sockets, ui/quake-terminal) — the hydrate stage owns them (Affected Memory)
- Backfilling `@rk_srv_operator_root` from an already-running operator window — the first post-upgrade no-window launch lands in `$HOME` once, deterministically (intake Assumption #13)
- Board tiles as a "viewed window" source — a board aggregates many windows (intake Assumption #11)

### Design Decisions

#### Determinism over heuristics for the launch directory
**Decision**: the operator's directory is explicit (the viewed window / `--dir`), else the last launch's recorded directory, else `$HOME` — never a ranking over live session facts.
**Why**: attach counts, window counts, and enumeration order move constantly, so a ranked pick lands in a different folder each launch; the operator's cwd is its default project, so a surprise cwd misroutes "start a session/tab" requests, and a worktree landing is deleted by `wt delete` after merge.
**Rejected**: always-`$HOME` (loses default-project context); a `settings` registry key (a global value for a per-server fact, superseded by the viewed-window rule); keeping any ranking (the volatility is the bug).
*Introduced by*: 260925-rrax-deterministic-operator-launch-dir

#### Server-scoped tmux option as the persistence vehicle
**Decision**: the last launch directory lives on the tmux server as `@rk_srv_operator_root`, written by `rk operator`'s create path and read by `-L` launches without `--dir`.
**Why**: its lifetime is exactly the operator window's (the server's), no file/state-store is introduced (Constitution II), and it follows the `@rk_<scope>_<name>` convention with a registry row.
**Rejected**: a config-file setting (wrong scope, and Constitution IV resists new config); deriving from the live operator window at respawn time (the window may be dead — that is the respawn's premise).
*Introduced by*: 260925-rrax-deterministic-operator-launch-dir

#### The daemon derives the path from tmux, never from the client
**Decision**: the request carries only the window identity (`{"window":"@N"}`); the daemon reads the pane cwd from its own sessions fetch and collapses it server-side.
**Why**: Constitution II (state derives from tmux) and not trusting a filesystem path from the client; `validateOperatorDir`'s gate still applies to the derived `--dir`.
**Rejected**: accepting a client-computed `dir` field (spoofable, duplicates server-side knowledge).
*Introduced by*: 260925-rrax-deterministic-operator-launch-dir

### Deprecated Requirements

#### Server-mode launch root ranked over live sessions
**Reason**: the ranking inputs (attach counts, window counts, enumeration order) change constantly — the volatility is the bug being fixed.
**Migration**: replaced by R2 (stored option → `$HOME`) plus the daemon's viewed-window `--dir` derivation (R8).

#### Skill-presence qualification of launch roots
**Reason**: `fab sync` writes a user-level pointer skill (`~/.claude/skills/fab-operator/SKILL.md`, `~/.agents/skills/…`), so `/fab-operator` resolves from any directory, including `$HOME` — the qualification test is moot.
**Migration**: N/A (test deleted with `hasOperatorSkill`/`operatorSkillPaths`).

## Tasks

### Phase 1: Setup

- [x] T001 Add `OperatorRootOption` const + `SetOperatorRoot`/`GetOperatorRoot` beside `SetServerRank`/`GetServerRank` in `app/backend/internal/tmux/tmux.go`, with tests in `app/backend/internal/tmux/tmux_test.go` mirroring `TestServerOrigin` (unset → "", dead server → "", set/overwrite round trip) <!-- R5 -->

### Phase 2: Core Implementation

- [x] T002 Rewrite directory selection in `app/backend/cmd/rk/operator.go`: delete `operatorLaunchRoot`, `hasOperatorSkill`, `operatorSkillPaths`, the `operatorSessionFactsFn`/`operatorMainRootFn` seams, and the four ladder rung constants; replace the switch with explicit (verbatim, unchanged) / server-mode stored→home (new `operatorGetRootFn` seam over `tmux.GetOperatorRoot`, validated via `validateOperatorDir`, `FindGitRoot(stored) || stored` agent root, empty root on home) / interactive (unchanged); drop `dirRungSole`/`dirRungMostAttached`/`dirRungMostWindows`/`dirRungFirst` and add `dirRungStored`; verify `internal/mcp/policy.go` needs no change. Also update the file-header comment and stale prose. <!-- R1 --> <!-- R2 --> <!-- R3 --> <!-- R4 --> <!-- R11 -->
- [x] T003 Stamp `@rk_srv_operator_root` on every successful create in `app/backend/cmd/rk/operator.go` (new `operatorStampRootFn` seam over `tmux.SetOperatorRoot`, keyed by the `-L` server in server mode and by `cliServerLabel(originalTMUX)` interactively; called after `createMarkedOperatorWindow` succeeds; failure → stderr note only, receipt and exit code unchanged; no stamp on singleton hits) <!-- R6 -->
- [x] T004 Replace the ranking tests in `app/backend/cmd/rk/operator_test.go`: delete `TestOperatorLaunchRoot`, `writeOperatorSkillRoot`, the facts/mainRoots stub wiring, and `TestOperatorServerFlagDerivesLaunchRoot`/`TestOperatorServerFlagFactsErrorFallsBackHome`; add stored-rung tests (valid stored → `-c` + receipt `dir_rung: stored` + agent root; stale/unset/read-error → home rung), explicit-override assertion updates, stamp tests (stamped in both modes with the right server, absent on singleton hit, best-effort on failure) <!-- R1 --> <!-- R2 --> <!-- R6 --> <!-- R11 -->
- [x] T005 Implement the viewed-window derivation in `app/backend/api/operator_start.go`: parse the optional `{"window"}` body (400 on malformed JSON / malformed id via `validate.ValidateWindowID`), look the window up in the fetched sessions (`findOperatorSubject`), take `WorktreePath`, collapse via a new `operatorStartMainRootFn` seam over `gitinfo.MainWorktreeRoot` ("" → cwd verbatim), append `--dir <derived>` to the argv; degrade to the no-window argv on unknown window, empty `WorktreePath`, or a failed absolute/exists/is-dir pre-check; update the handler doc comment <!-- R7 --> <!-- R8 -->
- [x] T006 Update `app/backend/api/operator_start_test.go`: body-parsing tests (empty/`{}`, malformed JSON → 400, bad id → 400), argv tests (window hit with collapse, non-repo cwd verbatim, unknown window → unchanged argv, empty WorktreePath → unchanged argv), and fixture `dir_rung` tokens updated to the new vocabulary <!-- R7 --> <!-- R8 --> <!-- R11 -->
- [x] T007 [P] Change `startOperator(server, windowId?)` in `app/frontend/src/api/client.ts` to send `{"window": windowId}` when given (else `{}`) and extend its `client.test.ts` block <!-- R9 -->
- [x] T008 Pass the viewed window from both Start paths: the quake drawer's Start button in `app/frontend/src/components/quake-terminal.tsx` (`routeServer === requested && routeWindow` only) and `buildOperatorStartAction` in `app/frontend/src/lib/palette/quake-terminal.ts` (new optional param) wired in `app/frontend/src/hooks/use-global-palette-actions.ts` from the existing route-param walk (`windowParam`/`serverParam`); update `quake-terminal.test.tsx`, `lib/palette/quake-terminal.test.ts`, and `use-global-palette-actions.test.tsx` <!-- R10 -->

### Phase 3: Integration & Edge Cases

- [x] T009 Extend `app/frontend/tests/e2e/operator-page.spec.ts`: record the Start stub's request body and assert `{"window":"@1"}` on the Terminal-route Start test; add the no-window case (Host-page Start sends `{}`) if the spec covers one — otherwise assert within existing tests only; maintain the JSDoc Proves:/Steps: intent comments and file-header comment <!-- R10 -->

### Phase 4: Polish

- [x] T010 Rewrite the `rk operator` Long help and `-L/--server` flag help in `app/backend/cmd/rk/operator.go` for the explicit/stored/home rule; verify `go run ./cmd/rk help-dump` (or the built binary) exits 0 with a single JSON envelope and empty stderr per `shll standards help-dump` <!-- R12 -->
- [x] T011 Update `docs/specs/api.md` § `POST /api/operator/start` (body contract, derivation, 400s, no-window fall-through, stored→home CLI rule) <!-- R13 -->

## Execution Order

- T001 blocks T003 (the stamp uses the new helpers) and T002's stored-read seam
- T002 → T003 (same file, sequential) → T004 (tests pin both)
- T005 → T006 (handler then its tests)
- T007 → T008 (signature before callers)
- T009–T011 are independent of each other, after their respective implementation tasks

## Acceptance

### Functional Completeness

- [x] A-001 R1: No `operatorLaunchRoot`/`hasOperatorSkill`/`operatorSkillPaths`/`operatorSessionFactsFn`/`operatorMainRootFn` symbol and no `sole`/`most-attached`/`most-windows`/`first` rung token remains in `app/backend/cmd/rk`; `rk tab new`'s `session_rung` ladder is untouched; `go build ./...` passes
- [x] A-002 R2: `rk operator -L <srv>` without `--dir` opens in the stored `@rk_srv_operator_root` when set and valid (receipt `dir_rung: stored`, agent root `FindGitRoot(stored) || stored`); unset, unreadable, or stale → `$HOME` (`dir_rung: home`, empty agent root)
- [x] A-003 R3: `--dir` keeps verbatim semantics — usage error (exit 2) before any subprocess on a bad value (including explicit empty), rung `explicit`, no stored-option read
- [x] A-004 R4: The interactive in-tmux path keeps git-root-of-cwd and its receipt keeps omitting `dir`/`dir_rung`
- [x] A-005 R5: `tmux.OperatorRootOption`/`SetOperatorRoot`/`GetOperatorRoot` exist; Get returns `("", nil)` for an unset option and for a dead server, and round-trips a set value
- [x] A-006 R6: Every create path (explicit/stored/home/interactive) stamps the option on the window's server; singleton hits never stamp; a stamp failure yields a stderr note with exit 0 and an unchanged receipt
- [x] A-007 R7: `POST /api/operator/start` accepts `{"window":"@N"}`; malformed JSON and malformed window ids get `400` with no exec; empty/`{}` body is the pre-change behavior
- [x] A-008 R8: A valid window produces argv `[rk, operator, -L, server, --dir, <active-pane cwd collapsed to the main checkout, verbatim when not a repo>, --json]`; an unknown window, empty `WorktreePath`, or an invalid derived dir degrades to the no-window argv
- [x] A-009 R9: `startOperator` sends `{"window": id}` when given, `{}` otherwise, still POST
- [x] A-010 R10: Both Start paths send the viewed window only on a same-server Terminal route; Host/Server/Board views and cross-server picker/pinned cases send no window
- [x] A-011 R11: The created receipt's `dir_rung` is always one of `explicit`/`stored`/`home`
- [x] A-012 R12: `rk operator --help` and the `-L` flag help state the explicit/stored/home rule; `rk help-dump` exits 0 with one stdout JSON envelope and empty stderr
- [x] A-013 R13: `docs/specs/api.md` § `POST /api/operator/start` documents the body, the server-side derivation, both 400s, and the no-window fall-through

### Behavioral Correctness

- [x] A-014 R2/R6: A cron respawn argv (`rk operator -L <server>`, no `--dir`) reuses the last launch's directory once stamped; a pre-upgrade server (option never set) lands in `$HOME` exactly until the first stamped launch
- [x] A-015 R5: No `MigrateLegacyOptions` row is added and snapshot capture is unchanged (the key is new, server-lifetime)

### Scenario Coverage

- [x] A-016 R2: Go tests cover stored-valid, stored-stale (deleted dir), option-unset, and read-error → home
- [x] A-017 R6: Go tests cover stamp-on-create in both modes with correct server addressing, no stamp on singleton hit, and best-effort stamp failure
- [x] A-018 R7/R8: Handler tests cover `{}`/empty, malformed JSON, malformed id, window hit with worktree collapse, non-repo verbatim cwd, unknown window, and empty `WorktreePath`

### Edge Cases & Error Handling

- [x] A-019 R8: A window closed between the click and the request degrades to stored→home instead of failing the start; only malformed input is a `400`
- [x] A-020 R2: A stored directory deleted since the stamp falls back to `$HOME` (validation at read time), never a failed launch

### Code Quality

- [x] A-021 R8: All new subprocess calls use `exec.CommandContext` argv slices with timeouts, and all tmux interaction goes through `internal/tmux` (Constitution I)
- [x] A-022 Pattern consistency: new code follows the seam/stub style (`operatorRunFn`, `resolveSelfPathFn` precedents) and error-wrapping idiom of surrounding code
- [x] A-023 No unnecessary duplication: reuses `findOperatorSubject`, `validate.ValidateWindowID`, `gitinfo.MainWorktreeRoot`, `config.FindGitRoot`, and the `GetServerOrigin` read posture instead of new variants

### Security

- [x] A-024 R7/R8: No client-supplied filesystem path reaches the exec argv — the body carries only a validated window id, and the `--dir` value is derived server-side from tmux and re-validated before exec

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The planned removals (the `operatorLaunchRoot` ranking ladder, `hasOperatorSkill`/`operatorSkillPaths`, the `operatorSessionFactsFn`/`operatorMainRootFn` seams, and the four ladder rung constants) were deleted in the apply diff itself and are covered by `## Requirements > ### Deprecated Requirements`. The shared helpers the ladder used stay load-bearing: `tmux.ListSessionFacts` still serves `tab_new.go` and `mux_sessions.go`, and `gitinfo.MainWorktreeRoot` still serves `tab_new.go` and now `api/operator_start.go`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The tmux helpers take the server label (`SetOperatorRoot(ctx, server, dir)`); the interactive stamp addresses the caller's server via `cliServerLabel(originalTMUX)` — the documented "socket basename is the -L label" equivalence the kickoff delivery already relies on | The intake leaves the helpers' addressing shape to plan time; label addressing keeps one helper shape beside SetServerRank/GetServerRank and stays seam-stubbable in cmd/rk's tmux-free tests | S:60 R:85 A:75 D:65 |
| 2 | Confident | The API handler gets a package-var seam `operatorStartMainRootFn = gitinfo.MainWorktreeRoot` so handler tests stub the git subprocess (the `resolveSelfPathFn`/`operatorStartRunFn` precedent) | Without a seam, collapse tests would need real git repos on disk; the api package's existing posture is seam-stubbed externals | S:70 R:85 A:80 D:70 |
| 3 | Confident | The stamp runs immediately after `createMarkedOperatorWindow` succeeds, before the receipt print; its failure writes a stderr note and changes nothing else | Intake states best-effort but not ordering; before-receipt keeps the stamp atomic-adjacent to creation while a failure still cannot block the receipt | S:60 R:85 A:80 D:65 |
| 4 | Certain | `docs/specs/api.md` is updated in apply; `docs/memory/` updates (including the `@rk_srv_operator_root` registry row) are deferred to the hydrate stage per the pipeline split | Intake §7 lists the spec in the change scope while § Affected Memory lists the memory files for hydrate | S:90 R:90 A:90 D:85 |
| 5 | Confident | An empty `WorktreePath` on the looked-up window degrades to the no-window argv (same class as an unknown window) | `#{pane_current_path}` is always absolute when present, but an empty value must never become `--dir ""` (the CLI rejects explicit empty as a usage error, which would surface a 502) | S:55 R:85 A:70 D:60 |
| 6 | Confident | The e2e assertion extends the existing Terminal-route Start test in `operator-page.spec.ts` (recording the request body) rather than adding a new spec file | The spec's Start stub already records call URLs; body capture is the minimal extension, and no palette-entry gating changes (operator-compose.spec's entry count is untouched) | S:70 R:80 A:75 D:70 |

6 assumptions (1 certain, 5 confident, 0 tentative).
