---
type: memory
description: "run-kit's shll-toolkit-standards conformance posture — constitution binding, HEAD-build audit rule, per-standard PASS (help-dump, skill, principles, update, version, install-composition). Covers P9 `--quiet`/reaper caps, brew-mutation grace, and the help-dump + P9 new-surface check over `rk desktop`/`remote`/`daemon run`/`role`/`code-server`/`present`/`tab`/`agent`/`code`/`tutorial`/`operator` (incl. `operator request`)/`gui`/`mcp`/`board` + the `mux` and `cron` families."
---
# Toolkit Standards Conformance

**Domain**: run-kit

## Overview

HexoKit (`rk`) is one of the HexoKit toolkit CLIs, and its constitution
(§ Toolkit Standards, v1.6.0) binds it to the toolkit's published standards — the
set enumerated at runtime by `shll standards`, each readable with
`shll standards <name>` (PR #379) (260717-zn03-constitution-toolkit-standards).
This file records the **conformance posture**: which standards exist, how run-kit
is measured against each, and where conformance is deferred. It is the
baseline a future re-audit diffs against.

The per-standard conformance report is **not** a committed doc under `docs/`: it
lives in the change folder
(`fab/changes/260717-c424-toolkit-standards-conformance/conformance-report.md`)
and is lifted into the **PR body only** at ship. There is no named consumer for a
parallel in-repo copy, so committing one would only invite drift.
(260717-c424-toolkit-standards-conformance)

## Requirements

### Requirement: Audit against a HEAD build, never the installed brew binary
Conformance MUST be assessed against a build of the repo at HEAD
(`just build` → `bin/rk`, source `app/backend/cmd/rk/`), NOT the installed
Homebrew `rk`. The installed binary lags the tree — at the audit it was
brew `rk` v3.7.2, which rejects `rk skill` (a standard adopted at HEAD by
PR #381) and would false-negative an already-conformant surface. The root
command name is `hexokit`; `rk` is the canonical short name, with `xk` and the
legacy `run-kit` as aliases (all invoke the same binary).
(260717-c424-toolkit-standards-conformance)

#### Scenario: A standard adopted at HEAD but absent from the installed binary
- **GIVEN** the `skill` standard, adopted at HEAD (`rk skill` + `docs/site/skill.md`)
- **WHEN** the audit runs against the stale installed brew `rk` (v3.7.2)
- **THEN** `rk skill` errors (`unknown command "skill"`) and the standard reads as unmet
- **AND** the audit-against-HEAD-build rule prevents that false negative: `bin/rk skill` passes the standard's checklist

### Requirement: Bounded, high-signal output (Principle 9)
run-kit's CLI SHALL conform to toolkit Principle 9 (bounded, high-signal output):
unbounded surfaces carry explicit caps stated in the output, and what survives
`--quiet` is the data and the errors — never progress, decoration, or chatter.
(260717-f8yv-cli-output-volume-controls)

The shipped posture (mechanism lives in
[cli](/run-kit/architecture/cli.md) § CLI Subcommands — the `outputSink`
convention plus the per-command rows):

- **A single persistent `--quiet` bool on `rootCmd`** (`root.go`), so every present
  and future subcommand accepts it uniformly and inherits it with zero registration
  work. It is a deliberate no-op on any command not yet routed through the sink
  (incremental adoption).
- **A shared `outputSink` convention, decided once** (`cmd/rk/output.go`, package
  `main`): **stdout carries data** (machine-consumable results — outcome lines,
  `--json` documents, requested previews/lists — never gated by `--quiet`);
  **stderr carries chatter** (progress/decoration) which `--quiet` routes to
  `io.Discard`. **Errors always survive** (they flow through `RunE` returns and
  ungated stderr writes); exit codes are never affected by `--quiet`; a successful
  run with nothing to report is silent under `--quiet`. Built on
  `cmd.OutOrStdout()`/`cmd.ErrOrStderr()` (never bare `os.Stdout`/`os.Stderr`) so
  gating is unit-testable — the idiom `doctor.go`/`agent_setup.go` already used.
- **Three commands adopt the sink** (the audit-named chatter carriers): `update`
  (`upgrade.go`), `doctor` (`doctor.go`), `agent setup` (`agent_setup.go`).
  `update`'s progress lines route to stderr on non-quiet runs — a consequence of
  "decide the convention once", aligning with Principle 2 (stdout is data).
- **A consent-mode diff-routing nuance in `rk agent setup`**: the consent context
  (a semantic summary on the interactive and `--yes` paths; the full body diff
  under `--dry-run` — see [agent-state](/run-kit/agent-state.md) § the hooks
  merge) routes **per consent mode** via `consent.diffWriter` — on the
  interactive-prompt and `--dry-run` paths it is **data** (never gated: a consent
  prompt without the context it asks about is a dark pattern, and a dry-run's diff
  is the requested output), while on the **`--yes`** path (write already
  authorized) it is **chatter**, so `--yes --quiet` is fully silent on success
  while `--yes` non-quiet still shows the context on stderr. The interactive
  prompt itself and the non-TTY refusal are never gated (the refusal is an error).
- **A brew-stderr-in-error nuance in `update`**: under `--quiet`
  the suppressed brew subprocess stderr is **buffered** (not discarded) and, on a
  non-zero exit, wrapped into the returned error, so a failing `rk update --quiet`
  keeps its diagnostic detail rather than surfacing a bare `exit status 1`.
- **`mux reap` gets a display cap, not a quiet conversion** (`reaper.go`): everything
  the reaper prints is data (a dry-run's candidate list is the requested result; an act
  summary is the record of a destructive mutation), so `--quiet` legitimately
  changes nothing. Instead each rendered list caps at **10 entries per list**
  (mirroring `shll changelog`'s 10-release cap) with a **stated truncation notice**
  (`… and N more; pass --all to list all`) — silent truncation reads as
  completeness — applied to **both** paths (`renderDryRun`'s candidate list;
  `renderReapSummary`'s `killed` and `removed` lists, each capped independently). A
  **`--all`** display-only escape hatch restores the full list. The cap is
  **display-only**: header counts stay exact (computed from the full result),
  `--yes`/`--force` still reap every match regardless of what was listed, and the
  dangerous-prefix guard, `_rk-ctl`/`rk-daemon` unconditional skips, and
  dry-run-by-default behavior are independent of the cap.

#### Scenario: `--quiet` preserves data and errors, drops chatter
- **GIVEN** `run-kit doctor --quiet` with all dependencies present
- **WHEN** the checks pass
- **THEN** stderr is empty (banner / `[ OK ]` rows / success tail dropped) and the exit code is 0
- **AND GIVEN** a failing check, the `[FAIL]` row (carrying the remediation hint) survives on stderr and the exit is non-zero
- **AND GIVEN** `--quiet --json`, stdout carries exactly the JSON report

#### Scenario: Reaper caps a large list and states the cap
- **GIVEN** a dry-run with 4485 candidates
- **WHEN** `renderDryRun` renders under the default cap
- **THEN** at most 10 candidate rows print, the header count is the exact `4485`, and the notice states `… and 4475 more; pass --all to list all`
- **AND GIVEN** `--all`, every candidate row prints with no truncation notice and reap semantics are identical

### Requirement: A new command surface is checked against help-dump and Principle 9
Any change adding or altering the CLI command tree MUST be checked against the
standards governing that surface (constitution § Toolkit Standards) — in
practice the `help-dump` contract and Principle 9's data-vs-chatter split.
(260730-pl4v-rk-desktop-install)

The `rk desktop` group (`install`/`update`/`status` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `desktop` row) is the
first worked example of what conformance costs on a new surface:

- **help-dump: the command tree is platform-stable.** The three children are
  **registered on every platform**; only *running* them is gated (a parent
  `PersistentPreRunE` on the `desktopGOOS` seam var returns `rk desktop is
  macOS-only (the shell is packaged as a macOS .app)`, an operational exit 1).
  Registering conditionally would make the dump's `root` differ by build
  platform, and the dump is a contract surface shll.ai pulls on a schedule —
  it must not depend on where it ran. The dump needs no code change: the cobra
  tree walk picks the subtree up automatically, and every node carries a `Long:`
  block since help-dump publishes `UsageString`.
- **Principle 9: outcome lines are data, narration is chatter.** Every command
  routes through the shared `outputSink` (`newSink(cmd)`): outcome lines
  (already-installed, installed-to, already-up-to-date, updated-to) are `Dataf`
  on stdout and survive `--quiet` — silence there would misreport a no-op as
  success — while resolution/progress narration is `Notef`, with the installer's
  `Progress` writer bound to `sink.chatter` so download and verification
  progress vanishes under `--quiet`. **`rk desktop status` is entirely data**
  (a read-only report is the requested result), so `--quiet` legitimately
  changes nothing — the same posture `rk status` and `mux reap` take, rather than a
  sink conversion.
- **Exit-code convention (P4)** — usage errors 2, operational failures 1:
  flag-parse errors inherit root's `FlagErrorFunc`; the children re-wrap their
  own `Args` validators with `usageArgs` in `desktop.go`'s `init()` because
  root's central wrap loop covers only `rootCmd`'s **direct** children; an
  explicitly-empty `--path ""` is a `usageError` (exit 2) rather than a silent
  fallback to `/Applications`; the platform gate, the not-installed refusal, and
  a quit-timeout abort are operational (1).
- **The `rk skill` bundle and topic pages stay untouched.** The bundle is a
  capability briefing, not a command enumeration — help-dump already covers the
  new tree via the cobra walk, and editing the bundle would trip its
  byte-equality drift guard for no standard-mandated gain.

The `rk remote` group (`add`/`connect`/`list`/`status`/`disconnect`/`remove` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `remote` row, and
[remote-hosts](/run-kit/remote-hosts.md) for the subsystem) is the second surface
measured against the same two checks:

- **help-dump: nothing platform-conditional, nothing hidden.** All six children
  are registered unconditionally on `rootCmd`'s `remoteCmd`, every node carries a
  `Long:` block (help-dump publishes `UsageString`), and the cobra tree walk picks
  the subtree up with no help-dump code change. There is deliberately **no
  `update` verb** — update folds into `connect` — so the dumped tree states the
  surface exactly as designed rather than carrying a seventh node that only
  duplicates a step connect must take anyway.
- **Principle 9: the machine-consumable result is data, the narration is not.**
  Every verb routes through `newSink(cmd)`. `Dataf` on stdout, surviving
  `--quiet`: `add`'s `Name:`/`Target:`/`Local:` lines (the desktop shell parses
  them, so gating them would break a consumer), `connect`'s final origin line
  (the whole point of running it), the `list` tabwriter table and `status`'s
  labeled report (read-only reports are the requested result, the `rk status` /
  `mux reap` posture), and `disconnect`/`remove`'s outcome lines — silence there
  would misreport a mutation. `Notef` on stderr, dropped by `--quiet`: connect's
  progress chain, `add`'s `Already registered.` and `Next: rk remote connect …`
  hints, and the installed/updated notes.
- **Exit-code convention (P4)**: the six children re-wrap their own `Args`
  validators with `usageArgs` in `remote.go`'s `init()` — the same reason as
  `desktop`, root's central wrap loop covers only `rootCmd`'s **direct**
  children — so an arg-count violation is a usage error (exit 2) while an
  unknown remote, an ssh failure, or a squatted port is operational (1).
- **The `rk skill` bundle stays untouched**, for the same reason as `desktop`:
  the bundle is a capability briefing, not a command enumeration, and editing it
  would trip its byte-equality drift guard for no standard-mandated gain.

The `rk daemon run` verb (`--window <name> -- <cmd> [args…]` — see
[daemon-lifecycle](/run-kit/daemon-lifecycle.md) § Daemon Lifecycle, the `rk-jobs`
sibling session) is the third surface measured against the same two checks
(260812-z1ya-update-daemon-tmux-window):

- **help-dump: platform-stable registration.** `daemonRunCmd` is registered
  unconditionally on `daemonCmd` (alongside start/stop/restart/status) and
  carries a `Long:` block, so the cobra tree walk picks it up with no help-dump
  code change and the dumped contract is identical on every platform — nothing
  about the command is build- or host-conditional (the daemon-running gate is an
  operational error at run time, not a registration condition).
- **Principle 9: one bounded line, no narration.** Success prints exactly one
  data line naming the target — `spawned rk-daemon:rk-jobs:<name> (@N)`, or
  `already running: rk-daemon:rk-jobs:<name> (@N)` (exit 0) when a live job
  window exists — and there is no progress chatter to drop under `--quiet`.
  Errors are operational (down daemon names the fix, `rk serve -d`); a missing
  `--window` or a missing `--` command is a usage error.

The `rk role <operator|clear>` verb (`role.go` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `role` row) is the
fourth surface measured against the same two checks
(260813-ifya-operator-role-pinned-row):

- **help-dump: platform-stable registration.** `roleCmd` is registered
  unconditionally on `rootCmd` in `root.go`'s `init()` and carries a `Long:`
  block, so the cobra tree walk picks it up with no help-dump code change and
  the dumped contract is identical on every platform — the `$TMUX_PANE` guard
  is an operational error at run time (a user typed the command outside tmux),
  not a registration condition.
- **Principle 9: the confirmation is data; there is no chatter.** Success
  prints exactly one `Dataf` line on stdout — `@N role=operator` or
  `@N role cleared` — surviving `--quiet` (silence would misreport the
  mutation); there is no progress narration to drop. Errors (unknown action,
  not inside tmux, tmux failure) flow through `RunE` to stderr with a non-zero
  exit.

The `rk code-server` group (`install`/`start`/`restart`/`update` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `code-server` row)
is the fifth surface measured against the same two checks
(260813-oid2-own-code-server-install) (260924-7koz-code-server-restart):

- **help-dump: platform-stable registration.** The parent and all four
  children are registered unconditionally on `rootCmd` (`root.go`'s `init()`)
  and every node carries a `Long:` block, so the cobra tree walk picks the
  subtree up with no help-dump code change and the dumped contract is
  identical on every platform — the `start`/`restart` verbs' daemon-running
  gate and the `update` verb's managed-install gate are operational outcomes
  at run time, not registration conditions. The help-dump goldens cover the
  subtree.
- **Principle 9: outcome lines are data, acquisition narration is chatter.**
  Every verb routes through `newSink(cmd)`, and the `internal/codeserver`
  installer's `Progress` writer is bound to `sink.chatter`, so
  resolve/download/extract progress vanishes under `--quiet` while the outcome
  lines — `install`'s already-current / installed lines, `start`'s
  already-running / externally-managed / started lines, `restart`'s
  `Restarted code-server (rk-code-server session).` / externally-managed /
  install-job-spawned lines, `update`'s
  not-managed skip and `Updated code-server vX -> vY` line — are `Dataf` on
  stdout and survive: silence there would misreport a no-op as success or hide
  a mutation. The respawn additions (260813-2s4u-respawn-aware-code-server-install)
  follow the same split: `install`'s migration-respawn line (`Respawned
  code-server onto the managed v… (was running a non-managed binary).`) and
  both verbs' daemon-down recovery lines are `Dataf` (each reports a mutation
  or explains why one did not happen), the shared `Restarting the code-server
  session on v…` progress and the uncertain-evidence / externally-managed
  notes are `Notef`. No tree change — no new commands or flags, only `Long:`
  prose on `install`/`update` — so the help-dump contract stays shape-stable.
- **Exit-code convention (P4)**: the children re-wrap their own `Args`
  validators with `usageArgs` in `code_server.go`'s `init()` — root's central
  wrap loop covers only `rootCmd`'s **direct** children (the `desktop` /
  `remote` reason) — so an arg-count violation is a usage error (exit 2),
  while a down daemon (`start`/`restart` name `rk serve -d`), a missing binary on
  `start` (names `rk code-server install`), a `restart` whose respawn never
  binds the port (the 15s `codeServerPortUpTimeout` error), and download/verify failures are
  operational (1).
- **The `rk skill` bundle stays untouched**, for the same reason as
  `desktop`/`remote`/`daemon run`/`role`: the bundle is a capability briefing,
  not a command enumeration, and editing it would trip its byte-equality
  drift guard for no standard-mandated gain.

The `rk present` verb (`present.go` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `present` row) is
the sixth surface measured against the same checks
(260813-becu-rk-present-attach-verb):

- **help-dump: platform-stable registration.** `presentCmd` is registered
  unconditionally on `rootCmd` with a `Long:` block, so the cobra tree walk
  picks it up with no help-dump code change; the `$TMUX_PANE` guard is an
  operational exit 1 at run time, not a registration condition.
- **Principle 9: the resolved URL is the only stdout line — data.** stdout
  carries exactly the resolved web-tab slot value (relative for `/present`/
  `/proxy` targets, absolute for external URLs) and prints it even
  under `--quiet` (silence would hide the command's one result); diagnostics
  go to stderr. `--notify`'s send failure is the documented fail-silent
  exception (the `rk notify` contract), not a Principle 9 violation.
- **Exit-code convention (P4)** — 0 success, 1 operational (no `$TMUX_PANE`
  without `--window`, missing file, unreachable port, tmux failure), 2 usage
  (no target, unknown flag).
- **readme-extraction: the README command table carries the `run-kit present`
  row**, keeping the published command documentation closed over the tree.
- **The `skill` standard is load-bearing on this surface** — the canonical
  `docs/site/skill.md` and `docs/site/skill/display.md` (synced to the
  embedded copies by `scripts/sync-skill.sh`) teach `rk present` as the
  primary Visual Display Recipe against the indexed `@rk_win_web_<n>` family
  (the retired names noted as compat-only), as the alias of
  `rk tab web add <target> --show` (the attach also writes the layout and
  selects the tab), with the manual
  `@rk_win_layout`/`@rk_win_web_1` attach path kept as a short appendix for
  older rk versions. Both files stay within the
  ≤150-line budget and under the byte-equality drift guards
  (`TestSkillEmbedMatchesCanonical`, `TestSkillDisplayEmbedMatchesCanonical`),
  so the skill standard keeps passing. No version-skew machinery is needed:
  the bundle ships inside the binary, so an rk that has `present` is the same
  rk whose pages teach it.

The `rk tab` family (`new`/`layout`/`web add|rm|mv|select|ls`/`code set`/`show` —
see [cli](/run-kit/architecture/cli.md) § CLI Subcommands, `tab` row) is
the seventeenth surface measured against the same checks
(260829-c143-rk-tab-cli-present-sugar, 260901-s36e-web-tab-strip-drafts-reorder, 260910-wzve-tab-new-command-json-ready):

- **help-dump: the family tree is platform-stable.** `tabCmd`, its five direct
  members, and the nested `web`/`code` members all register unconditionally on
  `rootCmd` with `Short` + `Long` blocks, so the cobra tree walk picks up the
  whole `tab` subtree with no help-dump code change; `web mv` carries its own
  `Use`/`Short`/`Long` contract, and the parent `tab` summary names move among
  the web verbs. The help-dump test's real-tree walk covers the family
  automatically.
- **Principle 9: one datum per verb on stdout — data.** Every verb routes
  through `newSink(cmd)`: `tab new` prints `@N` bare, or under `--json` the
  `{session, session_rung, window_id, pane_id}` object inside `result` of the
  Principle 2
  `{ok,result|error}` envelope — two-space indented, through the data sink so
  it survives `--quiet` — with the always-present `session_rung` saying why the
  landing session was chosen (a role-aware pick adds one
  `session: <name> (<rung>)` note on stderr — chatter, dropped by `--quiet`,
  never touching the stdout datum), and carrying one extra `ready` key when
  `--ready` gated
  the create (the verdict key rides `result` because the bare datum has no
  room for a second word; a `gone` verdict emits `ok:false` with the object
  still in `result`); `tab web add` prints
  `@N/web/<n>` (the resolved URL echoes to stderr), `tab web mv` prints the
  resulting `@N/web/<m>` address, `tab layout` prints the resulting layout
  value, `tab web ls` prints `index`/`marker`/`url` rows and `tab show` prints
  `key`/`value` rows (both `--json`-able), and `rm`/`select` print nothing on
  success — all `Dataf` on stdout, surviving `--quiet`; diagnostics are
  `Notef`/stderr.
- **Exit-code convention (P4)** — 0 success, 1 operational (family full, index
  out of range, missing dir, not in tmux, a `gone` readiness verdict under
  `tab new --ready` — printed after the JSON — and `nowhere to spawn`: an
  infrastructure-session caller with zero user sessions, raised before any
  window is created), 2 usage (malformed address or
  layout, unknown surface, flag conflicts, arg counts, a `tab new` positional
  without `--`, `--ready` without `--json` or without a command, `--timeout`
  without `--ready`, `--no-shell-fallback` without a command, a negative
  `--timeout`): every nested member
  re-wraps its `Args` validator with `usageArgs` at its own add site (root's
  central wrap loop covers only direct children — the `code.go` idiom), and an
  `-L` naming a foreign server without an explicit `@N` is a usage error.
- **The `skill` standard teaches the family** — the core bundle
  `docs/site/skill.md` carries a "drive the tab UI" capability line —
  `rk tab new [--layout L] [--name N] [--json] [--ready] [-- CMD…]` with the
  argv-after-`--` rule, the `-- sh -c "…"` expansion recipe, the shell-fallback
  / `--no-shell-fallback` note, and the standard `--json` envelope
  (`{"ok":true,"result":{session, window_id, pane_id}}`) — and one
  quickref row per verb group; `docs/site/skill/display.md`'s follow-up-moves
  section teaches `rk tab web ls|select|rm` and `rk tab layout` after the
  `rk present` recipe; `docs/site/skill/code.md` teaches `rk code exec --tab`.
  All three stay within the 150-line budgets and under their byte-equality
  drift guards after `scripts/sync-skill.sh`.

The `rk mux` family (`send`/`await` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `mux` row; full
contract in [agent-messaging](/run-kit/agent-messaging.md)) is the seventh
surface measured against the same checks
(260815-a5vf-rk-send-await-agent-messaging):

- **help-dump: the family tree is platform-stable.** `muxCmd` and both children
  are registered unconditionally with `Long:` blocks, so the cobra tree walk
  picks up the whole `mux` subtree with no help-dump code change; the
  help-dump test asserts the subtree dynamically (exactly `send` + `await`,
  nothing hidden, nothing platform-gated).
- **Principle 9: the report line is the only stdout line — data.** `send`
  prints exactly one of `delivered`/`unverified`/`staged`/`sent %N` (or the
  await report word under `--await`); `delivered` means no non-submission was
  detected and makes no submit-confirmation claim, while `unverified` means the
  engine detected non-submission and bounded recovery did not fix it. `await`
  prints the one-word report (a reached
  `--until` state / `file` / `running` / `gone`). Both route through the shared
  `outputSink`: the report is `Dataf` (survives `--quiet`), the gate's
  unknown-state warning and other diagnostics are chatter on stderr.
  `--notify`'s send failure is the documented fail-silent exception (the
  `rk notify` contract), not a Principle 9 violation. Both verbs also carry an
  opt-in `--json` flag (260911-i2vm-cli-send-await-receipts): bounded by
  construction — exactly one envelope document on stdout with the human report
  line suppressed and exit codes unchanged — so the one-line-report posture
  holds in both modes, and help-dump publishes the flags via `UsageString`
  with no tree change.
- **Exit-code convention (P4)** — 0 success (including `running` on timeout —
  the bound belongs to the observer, never the pane), 1 operational (gate
  refusal, probe failure, submit-unverified outcome, missing target, tmux
  failure, `gone`), 2 usage (bad target form, payload XOR violations,
  `--await --no-enter`, and cobra
  flag-group violations such as `--answer --force` — classified via
  `exit_code.go`'s `flagGroupPrefix`, since cobra's ValidateFlagGroups errors
  bypass root's `FlagErrorFunc`).
- **The `skill` standard covers a `mux` topic page** — `mux` is registered in
  `skillTopics` (canonical `docs/site/skill/mux.md`, synced into the embed copy
  by `scripts/sync-skill.sh`, drift-guarded by
  `TestSkillMuxEmbedMatchesCanonical` like `display`), and the core bundle
  carries the topic-index line plus the two one-line capability rows teaching
  both verbs' report contracts.

The `rk agent` family (`setup`/`hook` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `agent` row; full
contract in [agent-state](/run-kit/agent-state.md)) is the eighth surface
measured against the same checks (260815-r2wp-agent-family):

- **help-dump: the family dumps; the aliases don't.** `agentCmd` and both
  children are registered unconditionally with `Long:` blocks, so the cobra tree
  walk picks up the `agent` subtree with exactly {`setup`, `hook`} and no
  help-dump code change. Both root aliases are `Hidden: true` — hidden nodes are
  dropped from the dump at every level — so neither `agent-setup` nor
  `agent-hook` appears (the visible root count drops by one net: two verbs
  removed, one family added). The help-dump test asserts the subtree and the
  exclusions dynamically, mirroring the mux assertions.
- **Surface help enumerates the supported harnesses.** `rk agent setup`'s
  `Long` help (`agentSetupLong`) names every supported harness and its config
  target, kept honest by `TestAgentSetupLongListsEveryProvider`; `rk agent
  hook`'s `--agent` flag help lists the seven providers. Both enumerations live
  in the `Long:`/flag help the cobra walk already picks up, so the dump's tree
  shape and alias exclusions stand as asserted above. (nnqu)
- **Principle 2/9: the deprecation pointer is chatter; the hook is silent.**
  The `agent-setup` alias's cobra `Deprecated` pointer prints to stderr (a
  diagnostic, not data) and the command still runs with unchanged exit codes;
  the machine-invoked `agent-hook` alias prints nothing ever — the never-fail
  contract outranks any alias warning. `agent setup`'s own output keeps the
  existing sink routing (status lines are chatter, the consent diff routes
  per-mode — see the P9 section above).
- **Exit-code convention (P4)** — usage stays 2 on both forms (`agent setup x`
  and `agent-setup x` both exit 2; the family member wraps its own
  `usageArgs(cobra.NoArgs)` because root's wrap loop covers only direct
  children), and the hook's never-fail carve-out (exit 0 on every malformed
  path) holds on both instances.
- **The `skill` standard is a no-op here** — the topic-page audit found no
  `agent-setup`/`agent-hook` references in `docs/site/skill.md` or
  `docs/site/skill/*.md`; no new `agent` topic page (the family is
  instrumentation plumbing, not an agent-facing capability briefing).

The grown `rk mux` family (`reap`/`snapshot list|show|restore`/`init-conf`,
then `guard`, joining `send`/`await` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `mux` row; full
contract in [agent-messaging](/run-kit/agent-messaging.md)) is the ninth
surface measured against the same checks
(260815-lsgf-mux-consolidation-low-risk); `guard` itself is the tenth surface
below (260815-mi5s-mux-guard-move):

- **help-dump: the grown family dumps; the moved/hidden names don't.**
  `muxCmd` carries exactly {`send`, `await`, `capture`, `kill`, `process`,
  `panes`, `reap`, `snapshot` (with its
  `list`/`show`/`restore` children at depth), `init-conf`, `guard`}, every node
  with a
  `Long:` block, so the cobra tree walk picks up the grown subtree with no
  help-dump code change. The three root aliases (`reaper`, `snapshot`,
  `init-conf`) and `shell-init` are `Hidden: true` — hidden nodes drop from
  the dump at every level — so none of the moved names appears at root and
  the visible root count drops by four. The help-dump test asserts the
  subtree and the exclusions dynamically, mirroring the `agent` assertions.
- **Principle 2/9: the deprecation pointer is chatter; the moved verbs'
  output posture is unchanged.** Each alias's cobra `Deprecated` pointer
  prints to stderr (a diagnostic, not data) and the command still runs with
  identical flags, output, and exit codes — the pointer rides the executed
  command, so `rk snapshot list` warns via the alias children's own
  `Deprecated`. Reap/snapshot output stays all-data (the display caps +
  `--all` unchanged, `--quiet` legitimately a no-op).
- **Exit-code convention (P4)** — usage stays 2 on both the family and alias
  forms, including the new explicit-`-L` rejection on the non-messaging
  members (a usage error naming `--server`); the family members pre-wrap
  their own `Args` validators with `usageArgs` (root's wrap loop covers only
  direct children — the `desktop`/`remote`/`agent` reason), so an arg-count
  violation on `rk mux snapshot show` exits 2, not 1.
- **The `skill` standard is a no-op here** — reap/snapshot/init-conf are
  operator janitor/recovery/scaffold verbs, not agent capabilities
  (advertising the reaper to agents would be an attractive nuisance), so the
  topic pages carry no new content; the audit found no old-form references in
  `docs/site/skill.md` or `docs/site/skill/mux.md`, and the byte-equality
  drift guards stay green.

The guard surface (`rk mux guard`; `tmux-guard`
as a PERMANENT hidden root alias — full contract in
[tmux-guard-shim](/run-kit/tmux-guard-shim.md)) is the tenth surface measured
against the same checks (260815-mi5s-mux-guard-move):

- **help-dump: thirteen members dump; the permanent alias doesn't.** `muxCmd`
  carries exactly thirteen members (the messaging pair, the operator set, `guard`,
  the substrate twins, `panes`, and `adopt` — see the surfaces below), and
  `tmux-guard` joins the excluded-hidden-root-forms assertion list — Hidden
  drops it from the dump like the other aliases. The help-dump test asserts
  both dynamically.
- **Principle 2/9: the permanent alias is byte-silent.** Unlike the
  deprecation aliases, `tmux-guard` carries no cobra `Deprecated` and prints
  nothing ever — installed shims front every PATH-resolved tmux call on the
  machine, so any warning would leak onto stderr machine-wide. A test pins
  `Deprecated == ""` so a future sweep converting it to a warning alias
  fails. The guard's own message prefixes name the canonical command
  (`rk mux guard:`).
- **Exit-code convention (P4)** — unchanged: a guard block exits 1
  (operational), and the pass path is an exec passthrough preserving the real
  tmux's own exit code.
- **The `skill` standard's `mux` topic carries a guard Gotcha bullet** — the `mux` topic
  page teaches that a bare `tmux kill-server` is refused machine-wide by the
  shim and names the `-L` remedy; canonical `docs/site/skill/mux.md` and the
  embedded copy stay byte-identical under
  `TestSkillMuxEmbedMatchesCanonical`.

The substrate twins (`rk mux capture`/`kill`/`process` — the generic
pane-mechanics verbs ported from `fab pane`, agent-state-aware — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `mux` row; full
contract in [agent-messaging](/run-kit/agent-messaging.md)) are the eleventh
surface measured against the same checks (260815-82w7-mux-substrate-twins):

- **help-dump: thirteen members dump.** `muxCmd` carries exactly thirteen members —
  the messaging pair, the three twins, the `panes`/`sessions` enumerations, `adopt`, and the operator set —
  and the
  help-dump test asserts the thirteen-member subtree dynamically, with
  `capture`/`kill`/`process`/`panes`/`adopt` in the captured-children check. Every node is
  registered unconditionally with a `Long:` block, so the dumped contract
  stays platform-stable.
- **Principle 9: report/data on stdout, chatter on stderr.** All three twins
  route through the shared `outputSink`: `capture`'s header block / `--raw`
  content / `--json` wrapper, `kill`'s single `killed %N` line, and
  `process`'s tree (or `--json`) are `Dataf` (data, surviving `--quiet`); the
  kill gates' refusals (agent-state; protected-server — the refusal names the
  server, exit 1, no mutation) and `process`'s agent-state-read warning are
  `Notef` chatter on stderr (260824-xaw2-protected-server-class).
- **Exit-code convention (P4)** — 0 success, 1 operational (missing pane,
  gate refusal, tmux failure), 2 usage (bad target form, `--lines < 1`,
  `--json --raw` together via cobra flag-group validation) — never fab's
  pane-family 2/3 scheme.
- **The `skill` standard's `mux` topic carries three verb sections** — the `mux` topic page
  (canonical `docs/site/skill/mux.md`, embedded copy byte-identical under
  `TestSkillMuxEmbedMatchesCanonical`) teaches the three verbs (targets,
  capture flags/output, kill's two gates — agent-state and protected-server,
  both skipped by `--force` with target existence still validated
  (260824-xaw2-protected-server-class) — process classification, report
  lines, exit codes), and its framing line covers pane inspection/removal alongside
  agent messaging.

The `panes` enumeration (`rk mux panes` — the whole-server substrate-facts
query; full contract in
[agent-messaging](/run-kit/agent-messaging.md)) is the twelfth surface measured
against the same checks (260820-hol4-mux-panes-native-pane-map):

- **help-dump: thirteen members dump.** `muxCmd` carries exactly thirteen members —
  the messaging pair, the three twins, the `panes`/`sessions` enumerations, `adopt`, and the operator set —
  and the
  help-dump test asserts the thirteen-member subtree dynamically, with `panes` in
  the captured-children check. `panes` registers unconditionally with a
  `Long:` block, keeping the dumped contract platform-stable.
- **Principle 9: rows are data, diagnostics are chatter.** The aligned table
  rows and the `--json` array route through the shared `outputSink` as data
  (surviving `--quiet`); an operational failure (no server on the resolved
  socket) carries tmux's diagnostic on stderr.
- **Exit-code convention (P4)** — 0 success including an empty enumeration on
  a live server (`[]` under `--json`; a `tmux.ServerAlive` probe separates
  "alive, nothing to list" from a dead socket), 1 operational (tmux failure),
  2 usage (stray positional argument, flag misuse) — never fab's pane-family
  2/3 scheme.
- **The `skill` standard's `mux` topic carries a `## rk mux panes` section** — the `mux`
  topic page (canonical `docs/site/skill/mux.md`, embedded copy byte-identical
  under `TestSkillMuxEmbedMatchesCanonical`) teaches the enumeration
  (whole-server scope, no target argument, the 13-key `--json` schema with
  null agent fields, exit codes), and the family framing covers
  server-wide enumeration.

The grown `rk mux reap --ephemeral` flag (the reaper's option-match dimension,
unioning live `@rk_ephemeral`-marked servers into the prefix sweep — full
contract in [tmux-sessions](/run-kit/tmux-sessions.md) § `rk mux reap`) is the
thirteenth surface measured against the same checks
(260821-zelc-ephemeral-option-snapshot-reap):

- **help-dump: the flag registers platform-stable and unhidden.** `--ephemeral`
  is a plain `BoolVar` on both `newReapCmd` instances (family member + hidden
  root alias), and the `Long:` block carries the union semantics, the opt-in
  safety framing — naming the option through `tmux.EphemeralOption`
  (`fmt.Sprintf`) so the magic string has one source of truth — and the
  unconditional protected-server skip: live `@rk_protected` servers are skipped
  under the prefix sweep and under `--ephemeral` alike (protected beats
  ephemeral; the dead socket file of a formerly-protected server stays
  removable) (260824-xaw2-protected-server-class). The cobra tree
  walk publishes the flag with no help-dump code change, and the dumped
  contract stays identical on every platform. `Short:` stays the stable
  one-liner; the flag's own help string and `Long:` carry the surface.
- **Principle 9: plan and summary output stay data.** The union dry-run plan
  and the act summary ride the reaper's existing all-data posture; the
  10-entry display caps (`--all` to lift, exact header counts) cover
  option-matched entries with no new code, and `--quiet` remains legitimately
  a no-op.
- **The `skill` standard keeps the reaper out of the agent-facing verb
  teaching** — the reaper stays an operator janitor verb (the
  attractive-nuisance reasoning); the `mux` topic page's Gotchas carries the
  protected-server sentence — `rk mux reap` skips live `@rk_protected` servers
  unconditionally, `rk mux kill` refuses a pane on a protected server absent
  `--force` — with the canonical and embedded copies byte-identical at the
  150-line budget (260824-xaw2-protected-server-class).

The `rk mux new` create verb (operator tier —
full contract in [agent-messaging](/run-kit/agent-messaging.md)) is the
fourteenth surface measured against the same checks
(260821-hbmh-ephemeral-creation-adoption):

- **help-dump: thirteen members dump; `UsageString` published.** `new` is
  registered unconditionally on `muxCmd` with `Short`/`Long`/`Example` in the
  family's style, so the cobra tree walk publishes it as the twelfth member
  with no help-dump code change and the dumped contract stays
  platform-stable; `TestCaptureNodeRealTreeSelfExcludesAndDepth` pins the new
  count.
- **Principles 1/2/4/6/9 — PASS, with one defect found and fixed.** P1
  non-interactive (no prompts); P2 stream split (the `created <name>` report
  line is stdout's only data; diagnostics ride stderr); P4 exit codes (0/1/2
  toolkit convention — validation and the inherited `-L` rejection are usage
  via `usageArgs`/`usageError`, a live-socket collision and a mark failure are
  operational); P6 stateless retry-safe (a live-socket collision refuses
  cleanly, a stale socket proceeds). **The P9 defect the audit caught**: the
  `--ephemeral` flag help text backtick-quoted `rk mux reap --ephemeral`, and
  pflag consumes a backtick-quoted span in flag help as a metavar name,
  rendering `--ephemeral rk mux reap --ephemeral` in `-h`. Rule: **flag help
  strings carry no backticks** — fixed by dropping them.
- **readme-extraction: no README change needed.** The README carries no
  per-command table for agent-facing mux verbs; the standard's rule 7
  command/flag accuracy cross-check runs against help-dump, which includes
  `mux new`. The skill-topic edit lives under `docs/site/skill/`, inside the
  closed `docs/site/` tree.
- **The `skill` standard's `mux` topic carries an `rk mux new` section + the create/reap
  convention line** — the `mux` topic page (canonical
  `docs/site/skill/mux.md`, embedded copy byte-identical under
  `TestSkillMuxEmbedMatchesCanonical`) teaches the verb (usage, `--ephemeral`,
  collision behavior) and the Gotchas convention: create scratch servers with
  `rk mux new <name> --ephemeral`, bulk-clean with `rk mux reap --ephemeral`,
  never bare `tmux kill-server`. `docs/site/skill.md` carries the quickref
  one-liner; both stay within the 150-line budget.

The `rk code` group (`exec`/`hosts`/`commands` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `code` row; full
contract in [code-bridge](/run-kit/code-bridge.md)) is the fifteenth surface
measured against the same checks (260826-83jz-code-bridge-extension):

- **help-dump: the three children register unconditionally.** The parent and
  all three children register on `rootCmd` with `Long:` blocks (no platform
  gating, nothing hidden), so the dumped contract is platform-stable with no
  help-dump code change; `TestCaptureNodeRealTreeSelfExcludesAndDepth` pins
  the `code` subtree at exactly `exec`/`hosts`/`commands`.
- **Principle 9: result JSON is data, notes are chatter.** Every verb routes
  through `newSink(cmd)`: the result JSON (exec), the aligned host rows
  (`hosts`), and the sorted command ids (`commands`) are `Dataf` on stdout and
  survive `--quiet`; the `using host …` fallback note, prune notices, and the
  version-skew warning are `Notef` on stderr; `error: <kind>: <message>` lines
  are ungated stderr writes so they always survive.
- **Exit-code convention (P4)** — usage errors 2, operational failures 1: the
  children re-wrap their own `Args` validators with `usageArgs` in `init()`
  (root's wrap loop covers only direct children — the `code_server.go`
  idiom), so a missing command id, `--host` with `--folder`, or a stray arg is
  usage-class; a bridge-reported failure (`unknown-command`/`threw`/`timeout`/
  `bad-request`), a dial failure, and no-host/ambiguous resolution are
  operational (1).
- **The `skill` standard covers the `code` topic page + a core-bundle row** —
  `rk skill code` serves `docs/site/skill/code.md` (91 lines, within the
  150-line budget) via the per-topic embed + drift guard
  (`TestSkillCodeEmbedMatchesCanonical`), and the core bundle carries the
  topic-index line plus one capability row; the README command table carries
  the `run-kit code` row.

The `rk mux adopt` provenance verb (operator tier — converts an external server
to rk-managed, the bulk-migration path for pre-feature rk-born servers; full
contract in [agent-messaging](/run-kit/agent-messaging.md) § `rk mux adopt`) is
the sixteenth surface measured against the same checks
(260826-lv87-external-server-provenance-adopt):

- **help-dump: thirteen members dump.** `muxAdoptCmd` is registered
  unconditionally on `muxCmd` with `Short`/`Long`/`Example` in the family's
  style — no backticks in flag help (the `mux new --ephemeral` defect rule) —
  so the cobra tree walk publishes it as the twelfth member with no help-dump
  code change and the dumped contract stays platform-stable; the help-dump test
  asserts the thirteen-member subtree dynamically, with `adopt` in the
  captured-children check.
- **Principles 1/2/4/9 — PASS.** P1 non-interactive (invocation is consent —
  the bulk-migration role requires scriptability); P2 stream split (the
  `adopted <name>` / `already managed <name>` report lines are stdout's only
  data under the `outputSink` convention; diagnostics ride stderr); P4 exit
  codes (0 success including the already-managed no-op, 1 operational — dead
  socket, mark/reload failure — 2 usage: bad name, arg count, the
  inherited `-L` rejection); P9 nothing to bound (one report line).
- **The `skill` standard is a deliberate no-op here** — adopt is an operator
  config-mutation verb (the `reap` attractive-nuisance posture), so the `mux`
  topic page is NOT extended; the canonical and embedded copies stay
  byte-identical under `TestSkillMuxEmbedMatchesCanonical` with no churn.

The `rk mux send` delivery-hardening edit (the pane-mode guard on every
delivery path and the unknown-state warning's non-shell foreground naming —
full contract in [agent-messaging](/run-kit/agent-messaging.md) § The
agent-state gate / Delivery through the shared injection engine) modifies an
EXISTING surface, so it was re-audited in place against the same checks
(260904-kppn-mux-send-delivery-hardening):

- **help-dump: PASS, no diff needed.** The change adds no mux member and touches only `Long:` prose, which the dump does not publish
  — `UsageString` and flags are untouched, so the mux subtree's dump is
  byte-unchanged and the help-dump test's member-count assertions pass
  unmodified. `rk help-dump` (HEAD build) exits 0 with valid JSON, empty
  stderr, and no `captured_at`.
- **Principles 2/4/9 — PASS.** P2 stream split: the foreground-naming warning
  rides stderr via `sink.Notef` while the one-line stdout report contract and
  report words stay byte-unchanged (pinned by the gate-matrix tests). P9: the
  warning is one bounded line, suppressible by `--quiet` exactly like the
  pre-existing unknown-state warning. P4: a guard failure exits 1 naming what
  failed (`clear pane mode: …`).
- **The `skill` standard's `mux` topic page documents both behaviors** — the
  gate matrix's unknown row names the non-shell-foreground warning, and the
  delivery contract teaches the pane-mode guard (no manual `copy-mode -q`
  before sending); canonical `docs/site/skill/mux.md` and the embedded copy
  stay byte-identical under `TestSkillMuxEmbedMatchesCanonical`.

The `rk tutorial` verb (`tutorial.go` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `tutorial` row; the
composition seam in [rk-riff](/run-kit/rk-riff.md) § Shell-String Composition)
is the eighteenth surface measured against the same checks
(260903-7ajq-rk-tutorial-entry):

- **help-dump: platform-stable registration.** `tutorialCmd` is registered
  unconditionally on `rootCmd` (`root.go`'s `init()`) and carries a `Long:`
  block (with `Examples` and an `Exit codes` list), so the cobra tree walk
  picks it up with no help-dump code change; the `$TMUX` precondition is an
  operational exit 1 at run time, not a registration condition.
- **Principle 9: the outcome line is data; there is no chatter.** Success
  prints exactly one stdout line via `cmd.OutOrStdout()` — `Switched to
  existing tutorial tab.` or `Opened tutorial tab (window "tutorial", tier
  "fast").` — surviving `--quiet` (silence would misreport the mutation); there
  is no progress narration to drop. Errors ride the riff `ExitCodeError`
  discipline to stderr.
- **Exit-code convention (P4)** — 0 success, 1 operational precondition
  (`$TMUX` unset), 3 subprocess (tmux non-zero, timeout); cobra flag-parse
  errors inherit root's `FlagErrorFunc` (usage, 2).
- **The `skill` standard is load-bearing in the other direction** — `rk
  tutorial` is the human-typable entry to the tour the `tutorial` topic page
  teaches; the page and its embedded copy stay byte-identical under
  `TestSkillTopicsMatchCanonical` (the command is a launcher, not new topic
  content), and the README names `run-kit tutorial` in Quick start and the
  command-reference table (readme-extraction stays closed over the tree).

The `rk operator` verb (`operator.go` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `operator` row; the
composition seam in [rk-riff](/run-kit/rk-riff.md) § Shell-String Composition)
is the nineteenth surface measured against the same checks
(260903-a8e4-rk-operator-launcher):

- **help-dump: platform-stable registration.** `operatorCmd` is registered
  unconditionally on `rootCmd` (`root.go`'s `init()`) and carries a `Long:`
  block (with `Examples`, a `Prerequisites` list, and an `Exit codes` list), so
  the cobra tree walk picks it up with no help-dump code change; the two hard
  preconditions (inside tmux, fab on PATH) are operational exit 1s at run time,
  not registration conditions.
- **Principle 9: the outcome line is data; there is no chatter.** Success
  prints exactly one stdout line via `cmd.OutOrStdout()` — `Switched to
  existing operator tab.` or `Opened operator tab (window "operator").` —
  surviving `--quiet`; the kickoff-delivery degrade note is an error-class
  stderr write (always survives). There is no progress narration to drop.
- **Exit-code convention (P4)** — 0 success (including a degraded kickoff
  delivery), 1 operational precondition (`$TMUX` unset, fab absent), 2 usage
  (a `--workers` value outside `^[A-Za-z0-9_-]+$` via the CLI-local
  `usageError` path; cobra flag-parse errors inherit root's `FlagErrorFunc`),
  3 subprocess (tmux non-zero, timeout, empty pane id).
- **The `skill` standard is a deliberate no-op here** — the command is a
  launcher for the fab-kit operator agent, not new topic content; no topic
  page changes, and the README gains a `run-kit operator` command-reference
  row (readme-extraction stays closed over the tree).

The `sessions` enumeration (`rk mux sessions` — the session-grain facts query
with name-derived roles; full contract in
[agent-messaging](/run-kit/agent-messaging.md) § `rk mux sessions`) is the
twentieth surface measured against the same checks
(260905-csk9-mux-sessions-role-query):

- **help-dump: thirteen members dump.** `muxSessionsCmd` registers
  unconditionally on `muxCmd` with `Short`/`Long`/`Example` in the family's
  style, so the cobra tree walk publishes it with no help-dump code change;
  the help-dump test asserts the thirteen-member subtree dynamically, with
  `sessions` in the captured-children check and in
  `TestMuxHelpPresentsThreeGroups`' mechanics-group membership.
- **Principle 9: rows are data, diagnostics are chatter.** The aligned table
  rows and the `--json` array route through the shared `outputSink` as data
  (surviving `--quiet`); an operational failure carries tmux's diagnostic on
  stderr.
- **Exit-code convention (P4)** — 0 success including an empty enumeration on
  a live server (`[]` under `--json`; the `tmux.ServerAlive` probe separates
  "alive, nothing to list" from a dead socket), 1 operational, 2 usage (stray
  positional argument) — the `panes` scheme exactly.
- **The `skill` standard's `mux` topic covers `sessions`** — the enumeration
  section of the topic page (canonical `docs/site/skill/mux.md`, embedded copy
  byte-identical under the drift guard) teaches both server-wide queries: the
  role taxonomy, the default user-facing filter vs `--all`, and the 6-key
  `--json` schema, within the page's 150-line budget.

The `rk cron` family (`cron.go` + per-verb files — seven members: `add`,
`edit`, `list`, `rm`, `mute`, `pin`, `tick`; the subsystem contract in
[cron](/run-kit/cron.md)) is the twenty-first surface measured against the same
checks (260906-bi3v-rk-cron-cli):

- **help-dump: seven members dump.** `cronCmd` is registered unconditionally on
  `rootCmd` (`root.go`'s `init()`) and every node carries a `Long:` block, so
  the cobra tree walk picks the subtree up with no help-dump code change and
  the dumped contract is identical on every platform — nothing about the family
  is build- or host-conditional (the outside-tmux target requirement and the
  `tick -L` refusal are run-time usage errors, not registration conditions).
  The help-dump test asserts the seven-member subtree dynamically in
  `TestCaptureNodeRealTreeSelfExcludesAndDepth`'s captured-children check.
- **Principle 9: confirmations and listings are data, notes are chatter.**
  Every verb routes through the shared `outputSink` (`newSink(cmd)`): `add`'s
  assigned-id summary line, `edit`'s one `edited <id> <name> [<schedule> ->
  <target>]` data line (the `rescheduled` log append is not separately
  announced), the `rm`/`mute`/`pin` one-line confirmations, `list`'s table and
  `--json` array, and `tick`'s one-line sweep summary are data on stdout,
  surviving `--quiet`; `add`'s `--cron` not-yet-evaluated note and the
  window-role-unreadable degrade note are chatter on stderr. A held tick lock
  is the deliberate silent success — zero output, exit 0 (a summary there would
  misreport a skipped sweep as work done).
- **Exit-code convention (P4)**: usage errors exit 2 via the CLI-local
  `usageError` path — the verbs re-wrap their `Args` validators with
  `usageArgs` (root's central wrap loop covers only `rootCmd`'s direct
  children), and the four-way schedule-flag mutual exclusion
  (`--every`/`--idle-every`/`--backoff`/`--cron`, shared by `add` and `edit`
  via `cronScheduleFromFlags`), `--min`/`--max` without `--backoff`, enum
  values outside the schema's closed sets, invalid `--pane`/`--role`, an
  explicitly-set `-L` on `tick`, a missing target outside tmux, and `edit`'s
  own classes (a bare `edit <id>` — the nothing-to-edit error; the immutable
  target flags `--role`/`--session`/`--pane`, rejected as unknown flags;
  `--respawn` without `--if-absent respawn` on the merged entry) all take the
  same path; operational failures (a corrupt entry file refusing to mutate,
  `no entry <id>`, dir/lock failures, `edit`'s tick-flock contention
  `cron tick in progress — retry`) exit 1.
- **The `skill` standard covers the `cron` topic page** — canonical
  `docs/site/skill/cron.md` (≤150 lines, static-only), synced to the embedded
  copy by `scripts/sync-skill.sh`, drift-guarded and budget-tested by the
  shared `TestSkillTopics*` tables, and registered as `skillTopics["cron"]` so
  the `Topics:` help line and `rk skill topics` enumerate it; the core
  bundle's § Topics carries the capability line. The `rk cron` parent `Long`
  closes with the pointer `Agent briefing: `run-kit skill cron`.` — tolerated
  by the help-dump check (the standard's discovery mandates are the `Topics:`
  line and `rk skill topics`; the pointer is help text, not a new surface).
  (hcon)

The `rk gui` family (`gui.go` + `gui_supervise.go` + `gui_exec.go` + `gui_shot.go` + `gui_launch.go` — eight visible members: `on`, `off`, `status`, `env`, `restart`, `exec`, `shot`, `launch`, plus the hidden `supervise` pane command; the subsystem contract in [gui](/run-kit/gui.md)) is the twenty-second surface measured against the same checks (260909-fkh1-gui-backend-switch-and-relay; `exec`/`shot` audited with 260909-bbv1-gui-agent-verbs; `launch` audited with 260910-2jl3-gui-desktop-icewm-and-launcher):

- **help-dump: eight members dump; the pane command doesn't.** `guiCmd` is registered unconditionally on `rootCmd` (`root.go`'s `init()`) and every visible node carries a `Long:` block in the `code-server` family's shape (Use/Short/Long with a Subcommands list — the `launch` row reads `launch   Open a terminal or browser on the GUI display (the allowlisted launcher)`), so the cobra tree walk picks the subtree up with no help-dump code change and the dumped contract is identical on every platform — nothing about the family is build- or host-conditional (the macOS refusal on `exec`/`shot`/`launch` and the daemon-down lines are run-time operational outcomes, not registration conditions). `supervise` is `Hidden: true` — the dump's hidden-node rule drops it like the other plumbing commands. The help-dump test asserts the subtree dynamically.
- **Principle 9: outcome lines and the status document are data; hints are errors.** `on`'s outcome lines (`started (<bin> :N)` / `already running` / the daemon-down and no-backend lines), `off`'s `gui off` confirmation, `restart`'s `restarted (<bin> :N)`, `env`'s two `export` lines, `status`'s human line / `--json` document, `exec --detach`'s `started <pid> on :N` line, `shot`'s absolute PNG path, `launch`'s `started <name> (pid <pid>) on :N` line, `wm --list`'s candidate table (the pickers' `NAME LABEL KIND INSTALLED HINT` derivation), and `wm --list --json`'s `wm_candidates` array are each the verb's one bounded stdout datum (Dataf via the sink, surviving `--quiet`; `--list` is read-only — LookPath only, no settings write, no tmux); a foreground `exec` replaces the process, so the command's own output contract applies. The WM chatter after `on`/`restart` (`  window manager: <wm>` or the two-line bare-display install hint) is `Notef` on stderr, so `--quiet` and scripts keep the one-line datum. The `off` refusal (`re-run with --yes`), the disabled/not-running hints, the macOS refusals, `not found on PATH`, `launch`'s ladder-miss install line, and `aborted` ride stderr with non-zero exits.
- **Exit-code convention (P4)**: 0 success (including the daemon-down `rk gui on` and every `status` state — state, not verdict), 1 operational (refusals without `--yes` on a non-tty, declined confirms, disabled/daemon-down `restart`, `env`/`exec`/`shot`/`launch` when off or not running, the macOS refusals, an unknown program, a failed or missing screenshot tool, a `launch` ladder miss or start failure), 2 usage (arg-count violations via the family's `usageArgs` re-wrap — root's central wrap loop covers only `rootCmd`'s direct children — including `exec` with no command word and `launch` with a role outside `terminal`/`browser`; `wm`'s `--json` without `--list`, `--list` with a positional argument, and `--list` combined with `--restart`/`--force` go through the CLI-local `usageError`).
- **The `skill` standard covers the `gui` topic page** — canonical `docs/site/skill/gui.md` (≤150 lines), synced to the embedded copy by `scripts/sync-skill.sh`, drift-guarded and budget-tested by the shared `TestSkillTopics*` tables, and registered as `skillTopics["gui"]` so the `Topics:` help line and `rk skill topics` enumerate it; the page teaches `rk gui launch` (the allowlisted launcher) and the seeded profile directory beside `exec`/`shot`, and the core bundle carries the topic-index line plus one capability row for `rk gui exec <cmd…>` / `rk gui shot [--out f.png]` (gated on the user's `gui.enabled` switch). (bbv1) (2jl3)
- **readme-extraction: the README and docs/site carry the GUI surface.** The README's `## GUI — the host's desktop in a tile` section (between the boards section and the phone section) links `docs/site/gui.md` naturally, and § Command reference carries a `rk gui` row; `docs/site/gui.md` is the human GUI guide (the boards/notifications guide shape — H1, the absolute back-link to the README, ten sections from *What it is* to *Troubleshooting*) and names only commands present in `rk help-dump`; `docs/site/install.md` § Prerequisites carries the optional-GUI bullet (`tigervnc-standalone-server icewm` on Debian/Ubuntu) with a relative `gui.md` link. Links between `docs/site` pages are relative; anything leaving the published set is an absolute `https://github.com/sahil87/hexokit/blob/main/…` URL. (91px)

The `rk mcp` verb (`mcp.go` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `mcp` row; the
subsystem contract in [mcp](/run-kit/mcp.md)) is the twenty-third surface
measured against the same checks (260910-nuf6-rk-mcp-stdio):

- **help-dump: the visible root verb dumps.** `mcpCmd` is registered
  unconditionally on `rootCmd` (`root.go`'s `init()`, next to `skillCmd`) and
  carries `Short`/`Long` blocks, so the cobra tree walk publishes it with no
  help-dump code change; `cmd/rk/mcp_test.go` asserts the dump contains a
  visible `run-kit mcp` node and that `rk mcp --help` names the connector
  command `ssh <box> rk mcp`.
- **Principle 9: stdout is the protocol channel — the strictest data/chatter
  split.** Nothing but MCP protocol may be written to stdout; every diagnostic
  goes to stderr (an `slog` text handler on `cmd.ErrOrStderr()`). The
  inherited persistent `--quiet` is therefore irrelevant (nothing but protocol
  reaches stdout either way), and the verb takes no flags of its own.
- **Exit-code convention (P4)**: 0 when the client disconnects or the context
  is cancelled, 1 operational (the startup drift guard failing — the error
  names the offending policy row), 2 usage (a stray positional via
  `usageArgs(cobra.NoArgs)`).
- **The `skill` standard is the instructions source, not a new topic** — the
  server's MCP `instructions` field is the core skill bundle bytes verbatim
  (byte-identical to `rk skill`; the E2E asserts equality with
  `docs/site/skill.md`), and the bundle itself is unchanged: `rk mcp` is a
  transport, not an agent capability, so no topic page changes and the 150-line
  budget is untouched.

The `rk url --mcp` flag (a flag on an existing verb, not a new surface — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `url` row) satisfies the
same two checks by inheritance: the cobra tree walk publishes the flag via
`UsageString` with no help-dump change, and stdout stays one data line (the
endpoint) with empty stderr. (260911-cl9j-mcp-http-route)

The `rk board` family (`board.go` + `board_test.go` — four members: `show`,
`pin`, `unpin`, `reorder`; the subsystem contract in
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `board` row) is the
twenty-fourth surface measured against the same checks (260911-u49l-rk-board-verb):

- **help-dump: the family tree dumps.** `boardCmd` is registered
  unconditionally on `rootCmd` (`root.go`'s `init()`, immediately after
  `tabCmd`) and the parent plus all four children carry `Short`/`Long` blocks,
  so the cobra tree walk publishes the `board` node with its
  `show`/`pin`/`unpin`/`reorder` leaves with no help-dump code change; nothing
  about the family is build- or host-conditional (the daemon-down refusal is a
  run-time operational outcome, not a registration condition).
- **Principle 9: every member prints one data line (or document) on stdout.**
  `show`'s tabwriter rows and its byte-for-byte `--json` body, the mutations'
  one report line (`pinned @N to <board>` / `unpinned @N from <board>` /
  `reordered @N on <board> → <key>`), and the `--json` receipts are each the
  verb's one bounded stdout datum (`newSink(cmd).Dataf`, surviving `--quiet`;
  an empty `show` prints nothing and exits 0); nothing is written to stdout on
  failure, and diagnostics ride stderr.
- **Exit-code convention (P4)**: 0 success, 1 operational (an unreachable
  daemon — the `unreachable at <origin>` hint — or a daemon non-2xx with the
  body's `error` verbatim), 2 usage (a bad board name, a malformed `@N` window
  or neighbour id, `--before`/`--after` off `reorder`, and arg-count
  violations via the family's own `usageArgs` re-wrap — root's central wrap
  loop covers only `rootCmd`'s direct children), each CLI-side class failing
  before any HTTP request.
- **The `skill` standard's core bundle carries the capability** —
  `docs/site/skill.md` carries one `rk board` bullet next to the `rk tab`
  bullets (the four verbs; needs `rk serve` up), synced to the embedded copy
  by `scripts/sync-skill.sh` and byte-drift-guarded by the skill embed tests.

The `rk operator request` verb (`operator_request.go` — the CLI door onto the
operator-request lane; see [cli](/run-kit/architecture/cli.md) § CLI
Subcommands, `operator` row, and
[operator-actuation](/run-kit/operator-actuation.md)) is the twenty-fifth
surface measured against the same checks (sjs1):

- **help-dump: registered on the existing `operator` parent.**
  `operatorRequestCmd` registers unconditionally on `operatorCmd` (whose own
  no-argument behavior is unchanged) with `Short`/`Long` blocks, so the cobra
  tree walk picks up the child with no help-dump code change and the dumped
  contract is platform-stable — the pre-flight registry checks are run-time
  exit 2s, not registration conditions.
- **Principle 9: the report line or the JSON document is data; the queued note
  is chatter.** stdout carries exactly one report line
  (`delivered <template>` / `queued <template>`) or, under `--json`, exactly
  one envelope document — both `Dataf` on the data channel, surviving
  `--quiet`; the 202 busy note (`operator is busy; the request is queued and
  drains when it is idle`) is `Notef` chatter on stderr. `--list` is entirely
  data (a requested listing).
- **Exit-code convention (P4)** — 0 success (the 202 queued case included), 1
  operational (any non-2xx other than 400, a transport failure — carrying the
  `start it with rk daemon start` hint), 2 usage (every pre-flight registry
  check — scope, `--text`/`--session` acceptors, malformed `--window`/`-L` —
  runs before any HTTP).
- **The `skill` standard covers the verb on the `messaging` topic page** — the
  `## Handing the operator a request` section (canonical
  `docs/site/skill/messaging.md`, embedded copy byte-identical under the shared
  `TestSkillTopics*` guards) teaches `--list`, the window/server split, and the
  `queued:true` meaning; the README command-reference row carries
  `request <template>` (readme-extraction stays closed over the tree).

#### Scenario: A new subcommand group keeps the help tree platform-stable
- **GIVEN** the `rk desktop` group on a Linux host
- **WHEN** `rk desktop install` runs
- **THEN** it exits 1 with the macOS-only message on stderr
- **AND** `rk help-dump` still lists the whole `desktop` subtree, so the dumped
  contract is identical to the one a macOS build produces

#### Scenario: `--quiet` keeps a new surface's machine-consumable lines
- **GIVEN** `rk remote add sahil@buildbox --quiet`
- **WHEN** the registration succeeds
- **THEN** stdout carries exactly the `Name:`/`Target:`/`Local:` lines and stderr
  is empty (the `Next: rk remote connect …` hint dropped)
- **AND GIVEN** `rk remote connect <name> --quiet`, the progress chain is dropped
  while the final origin line still prints — the desktop shell parses both
  contracts, so gating either would break a consumer

### Requirement: The standards set is enumerated at runtime, not assumed
Each audit MUST re-run `shll standards` for the authoritative list and
`shll standards <name>` for each entry's full text — never work from memory or
the website. If `shll standards` fails, run `shll update` once; if it still
fails, STOP and report.

## Standards Audited @ shll v0.0.23

The audit pinned **`shll v0.0.23`** (the `shll version` shll row at audit time) —
standards are versioned with the shll release, so a conformance claim is only
meaningful against a named version. `shll standards` enumerated four:

| Standard | Kind | Governs |
|----------|------|---------|
| `principles` | foundation | the ten toolkit CLI principles |
| `help-dump` | binary | the machine-readable help contract |
| `readme-extraction` | repo | README + `docs/site/` structure |
| `skill` | binary+repo | the `<tool> skill` agent-bundle contract |

**Version pin**: the four cited standards are **unchanged** at shll `v0.1.0`, so
every conformance claim stays valid at the audited **`shll v0.0.23`**.

### help-dump — PASS
The envelope is exactly `{tool, version, schema_version, root}` (see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `help-dump` row). It
carries **no** `captured_at` — the standard forbids it as a rule "with teeth" (the
capture timestamp is owned by the shll.ai puller; a tool cannot know its own
capture time). The rest of the checklist passes: exit 0, stdout-only JSON, stderr
empty, no `completion`/`help`/hidden nodes, `version` from the built binary
(ldflags), re-verified against the flag-added command tree (R8).
(260717-c424-toolkit-standards-conformance)

*Nuance, not a violation*: the `version` field is `v`-prefixed (`v3.8.0`); the
standard's example shows bare semver but its text mandates only "from the built
binary", and `shll version` itself renders `v`-prefixed rows — left as-is.

### readme-extraction — PASS
Closure holds: every relative link stays inside the published set (the README
slice + `docs/site/**`), so none 404s on the rendered shll.ai page. The two links
that would have escaped are absolute:
- `README.md`'s link to `docs/specs/agent-state.md` (outside the published set) is
  the absolute
  `https://github.com/sahil87/hexokit/blob/main/docs/specs/agent-state.md`.
- `docs/site/install.md`'s link to the README anchor (a `..` escape out of
  `docs/site/`) is the absolute
  `https://github.com/sahil87/hexokit/blob/main/README.md#agent-state`.

The remaining relative forms are correct and stay relative: README →
`docs/site/*.md` hub links, and between-`docs/site/` links. A closure sweep over
`README.md` + `docs/site/**` shows zero escapes.
(260717-c424-toolkit-standards-conformance)

The README agent-state section and `docs/site/install.md` describe the
multi-harness install reality — `rk agent setup` supports seven agent harnesses —
and link `docs/site/agent-hooks.md`, the versioned per-harness capability
matrix. `agent-hooks` is a non-reserved page name inside the published set, and
its outbound links (vendor documentation) are absolute, so link closure still
holds. (nnqu)

**HexoKit README head.** The readme-extraction standard's canonical README
blockquote is
`> Part of [HexoKit](https://hexokit.com) — see all projects there.`
and `README.md` line 3 carries it **byte-exact** under the mandated head order
H1 → blockquote → badges; the H1 reads `HexoKit`, and the badge lines point at
the renamed `sahil87/hexokit` repo, as does the logo `src` raw URL.
Identifiers stay by design: `sahil87/tap` formula names and the constitution's
`sahil87/shll` canonical-source reference.
(260718-oa9b-shll-toolkit-rename, 260911-mljj-hexokit-brand-prose)

### skill — PASS
`rk skill` + `docs/site/skill.md` exist at HEAD (PR #381), so the standard's
"deferred, not yet adopted" contingency does NOT apply — it passes in full:
byte-identical stdout to canonical, ≤150 lines, static-only, in-genre briefing.
The bundle pages' H1s name the product — `# HexoKit skill` and
`# HexoKit skill: <topic>` — with the embedded copies byte-identical under the
drift guards (260911-mljj-hexokit-brand-prose).
See [cli](/run-kit/architecture/cli.md) § CLI Subcommands (`skill` row) for
the embed mechanism and drift guard.
(260717-agst-rk-skill-agent-setup-hooks-only)

**Setup/skill ownership split.** `shll setup agent` places the shared bootstrap
skill and delegates hook installation to `rk agent setup`; `rk agent setup`
installs no skill — the `rk skill` bundle owns usage knowledge. The legacy
`rk-display` skill cleanup is a one-release courtesy removal. (nnqu)

**Topic pages.** The shll skill standard has **topic pages** (`<tool> skill
<topic>`, each canonical at `docs/site/skill/<topic>.md`, ≤150 lines, static-only,
byte-identical, drift-guarded, rendered at `/<tool>/skill/<topic>` on shll.ai —
shll PR #47). run-kit ships seven topic pages: `code`, `cron`, `display`,
`gui`, `messaging`, `mux`, and `tutorial` (fvpu) (bbv1) (hcon). Each uses the per-topic embed mechanism and the shared
`TestSkillTopicsMatchCanonical` / `TestSkillTopicsWithinLineBudget` guards; the
command cases in `TestSkillTopicsPrintByteIdentical` pin the stdout contract.
The tutorial uses a bidirectional page↔companion guard:
`TestTutorialPagesMatchTopic` requires the topic to reference the single
companion page `tutorial/tutorial.html` at each of its five chapter hashes
(`#ch1`–`#ch5`), requires that page to exist under
`app/frontend/public/tutorial/`, and rejects any other `.html` file there;
`TestTutorialLayoutValuesParse` checks the tour's layout and surface literals.
The standard's fail-fast rule holds: an **unknown topic** exits usage-class (2)
via the `usageError` helper with all seven valid topics named on stderr and
**empty stdout** — never a silent empty document; bare `rk skill` **never
inlines** a topic page. Topic pages are a clause of the already-passing `skill`
standard, not a separate standard. (6uu0)

**Topic discovery.** The standard's two topic-discovery mandates both hold
(`app/backend/cmd/rk/skill.go`): the `skill` subcommand's long help carries a
`Topics:` line naming the shipped content topics, composed from `skillTopicNames()`
(static by construction — topic embeds are fixed at build time; a new
`skillTopics` row updates the help line, the unknown-topic error, and the
enumeration in one place), and the **reserved positional topic** `rk skill
topics` prints the content-topic names one per line, sorted, raw to stdout with
empty stderr and exit 0 — the scriptable enumeration the shll composer reaches
as `shll skill rk topics`. The name `topics` is reserved outside the topic
namespace: it is intercepted in `RunE` before the `skillTopics` map lookup,
never becomes a map key (`TestSkillReservedTopicsNameStaysReserved`), has no
canonical `docs/site/skill/topics.md`, and appears in neither the `Topics:`
help line nor the core bundle's `## Topics` index. A `--list` flag is ruled out
by the standard itself: the shll composer forwards positional args verbatim,
so a flag would be intercepted by the composer's own flag parsing.
`TestSkillReservedTopicsEnumerates` pins the output shape and
`TestSkillHelpEnumeratesTopics` pins the help-line mandate. (mzpw)

The `display` topic documents the same-origin target form
`rk present "$(rk url)/path"`: the stored target is `/path`, so the viewer loads
it from its own run-kit origin. This form is covered by the parser and caller
tests and preserves the page's static, version-locked contract. (6uu0)
See § Design Decisions → "Static derivation recipes replace `rk context`
(a recipe is static content)". (260718-icxz-skill-display-topic-url-retire-context)

### principles — PASS
Each of the ten principles is assessed against `bin/rk` behavior + source, and all
PASS — no principle gaps remain open. The conformance mechanisms:

**P1/P2/P5 — additive per-command flags:**
- **P1 (Non-interactive by default)** — `rk agent setup` consents non-interactively
  via `--yes`/`-y` + `--dry-run`, and refuses a non-TTY prompt naming `--yes`. See
  [agent-state](/run-kit/agent-state.md) § `rk agent setup` for the consent flow.
- **P2 (stdout is data)** — every `rk … --json` read verb emits one stable
  machine format: the `{ok,result|error}` envelope —
  `{"ok":true,"result":<doc>}` on success,
  `{"ok":false,"error":{"code":"usage"|"operational","message":…}}` on failure
  (verdict-bearing verbs also carry `result` on the failure branch). `ok`
  mirrors the exit code; the verb's document keeps its shape verbatim inside
  `result` — the envelope wraps, never reshapes, so shape-stability guarantees
  apply to the document inside `result`. Seventeen verbs emit it (`mux
  sessions`/`panes`/`capture`/`process`, `status`, `cron list`, `gui
  status`/`windows`, `tab show`/`web ls`/`new`, `code exec` (single and
  `--all`), `code hosts`, `doctor`, `daemon status`, `mux snapshot list`,
  `gui shot`); the convention is owned by `outputSink.Envelope`
  (`cmd/rk/output.go`) plus the central failure writer (`cmd/rk/root.go`), and
  there is no unwrapped `--json` form. The one boundary: pre-`RunE` usage
  errors (flag-parse, `Args` validators) emit no envelope — bare stderr, exit
  2. `doctor`'s human diagnostic stays on stderr. See
  [cli](/run-kit/architecture/cli.md) § CLI Subcommands.
  (260911-ehm2-cli-json-read-verbs)
  The
  mutating verbs carry the same envelope as opt-in `--json` receipts — exactly
  one document on stdout, human output and exit codes unchanged: `riff`
  (`{"windows":[…]}`), `mux new` / `mux kill` (`{report, …}`),
  `cron add` / `rm` / `mute`, `tab layout` / `tab web add|rm|select|mv` /
  `tab code set`, `gui exec --detach` (`{pid, display}`), `operator`
  (`{window, server, created}`), and `notify` (`{delivered}` — the fail-silent
  contract's verdict field). See [cli](/run-kit/architecture/cli.md) § CLI
  Subcommands and [mcp](/run-kit/mcp.md) § the seeded table. (260911-fr5t-cli-spawn-and-steer-receipts)
- **P5 (Visible mutation boundaries)** — the `agent-setup --dry-run` above also
  satisfies P5's destructive-write preview requirement.

(260717-c424-toolkit-standards-conformance)

**P4 (Fail fast — exit-code convention):** usage errors exit `2`, operational
failures `1`. The model (all in `cmd/rk`, extending the existing `exitCodeError`
plumbing rather than a parallel mechanism):
  - **Pure classification seam** — `execute()` (`root.go`) calls `os.Exit(exitCode(err))`
    instead of a blanket `os.Exit(1)`. `exitCode(err) int` (`exit_code.go`) is pure
    (no `os.Exit`/I/O, unit-testable in-process): `errors.As` on `*exitCodeError`
    yields its carried `.code`; else default `1`.
  - **`usageError(err)` constructor** (`exit_code.go`) wraps any error as
    `*exitCodeError{code: 2}` (named `exitUsage`), preserving the message verbatim
    so cobra's existing stderr (`Error: …` line + usage) is byte-identical — only the
    exit code changes.
  - **Flag-parse errors** — one `rootCmd.SetFlagErrorFunc(→ usageError)` in `init()`;
    cobra's own-wins inheritance covers every subcommand.
  - **Arg-count validators** — a central wrap loop in `init()` over `rootCmd.Commands()`
    re-tags each non-nil `c.Args` via `usageArgs` (inert for `ArbitraryArgs` commands),
    a one-place root-cause fix rather than editing the five declaration sites
    (`shell-init`/`help-dump`/`agent-setup`/`skill`/`notify`).
  - **Unknown command** — classified at the `execute()` seam by the stable
    `unknown command ` message prefix (`unknownCommandPrefix`) with root `Args: nil`.
    Keeping `Args: nil` lets cobra print the unknown-command line, Levenshtein
    suggestions, and the `Run '… --help' for usage.` hint natively (byte-identical);
    the prefix match fails safe (2→1, never wrong output) if cobra's wording ever
    changes. (Note the case-sensitivity: cobra's help-topic error `Unknown help topic`
    has a capital U and does NOT match, so `rk help bogus` stays exit 0.) See
    § Design Decisions → "Unknown-command classification at the `execute()` seam".
  - **riff exit classes** — `internal/riff` constants conform:
    `ExitValidation` 2 (usage), `ExitPrecondition` 1 (operational), `ExitSubprocess`
    3. The `POST /api/riff` HTTP mapping keys on the constant **identity**
    (`ExitValidation` → 400), so no api-layer change. riff's manual `Flags().Parse`
    error (`DisableFlagParsing` bypasses the root FlagErrorFunc) is wrapped locally
    as `usageError` (exit 2). See [rk-riff](rk-riff.md) § Exit Code Discipline and
    [cli](architecture/cli.md) § CLI Subcommands (`riff` row), and § Design
    Decisions → "riff exit-class renumbering is a value change, not a mapping change".
  - **agent-hook never-fail carve-out** — both hook command instances (the
    `agent hook` family member and the permanent hidden root alias `agent-hook`)
    keep their own
    `SetFlagErrorFunc(→ nil)`, which shadows the root's (cobra own-wins), plus
    `ArbitraryArgs` + `FParseErrWhitelist.UnknownFlags`, so every malformed invocation
    exits `0` on either form. This is safety-critical: Claude Code treats a hook exit **2 as
    *blocking***, so the hook must surface neither 1 nor 2. A regression test
    asserts `exitCode == 0` on `--nope` / missing `--agent` value / bad arg counts
    for both invocation forms.
    See [agent-state](agent-state.md).
  - **Docs surfaces in lockstep** — the exit-code contract line in the embedded
    `rk skill` bundle (`cmd/rk/skill/skill.md`) + its byte-identical mirror
    `docs/site/skill.md` state the 0/1/2/3 convention; the `## Exit codes` table in
    `docs/site/workflows.md` and riff's `-h` `Exit codes:` block state
    `0` success / `1` precondition / `2` validation-usage / `3` subprocess. Command
    tree unchanged (no flags added/removed), so the help-dump contract is unaffected.

(260717-rex1-unify-usage-error-exit-codes)

**P9 (Bounded, high-signal output)** — see § Requirement: Bounded, high-signal
output (Principle 9) for the shipped mechanism.
(260717-f8yv-cli-output-volume-controls)

Principles 3, 6, 7, 8, 10 PASS (help published; stateless/derive-from-tmux;
wraps `wt`/`fab`/`brew`; degrades gracefully; README + docs/site + `rk skill`
bundle discoverable).

## `update` + `version` Standards

The `update` and `version` standards (`shll standards update` / `shll standards
version`) are separate binary standards from the four above. run-kit conforms to
both. The audit measures against the **current** update-standard text, which
carries a **brew-handling safety clause** (incident "Observed 2026-07-19": a
`SIGKILL` landing mid keg-swap).
(260719-er5k-update-version-standards-conformance)

### update — PASS
The subcommand contract passes throughout: `update` (alias `upgrade`) runs
in-place with post-upgrade side effects (daemon restart), works standalone,
advertises + honors `--skip-brew-update`, exits 0 on success (incl.
already-up-to-date) and non-zero only on genuine failure, self-updates via brew
only when brew-installed (the `/Cellar/` gate with a clear non-brew degrade
message), and satisfies the naming/release clauses (`hexokit` is one string
across repo / roster / formula leaf / binary, with `rk`/`xk`/`run-kit` as
symlinked aliases; `v{semver}` tags; the tap's `formula_renames.json` maps the
`rk` leaf to `run-kit` — the standard's own cited precedent — and `run-kit` to
`hexokit`). See [cli](/run-kit/architecture/cli.md) § CLI Subcommands
(`update` row) for the mechanism.

**The umbrella holds the same conformance across all three legs** — `rk
update` updates the CLI, the macOS desktop app, and the rk-managed code-server
install, and every clause the standard cares about holds across them
(260731-3byh-umbrella-update-auto-restart) (260813-oid2-own-code-server-install).
The brew
leg is governed by the mutation bounds and graceful-cancel discipline below. `--skip-brew-update` is a literal substring of
`rk update --help`. Exit 0 covers success, already-up-to-date, **and every
skip** (not brew-installed, non-darwin, no desktop app, no managed
code-server), with non-zero reserved for a genuine leg failure — the
code-server leg is **best-effort** and never contributes to the exit code at
all (its failures warn only — see the dedicated paragraph below). The non-brew
guidance is a clear degradation and a
*leg* skip: it prints and execution continues to the desktop leg, so a
Homebrew-less CLI still gets its app updated. The **command tree carries the
`code-server` group** (registered unconditionally — see §
Requirement: A new command surface is checked against help-dump and Principle
9), and the help-dump goldens cover it.

**The code-server third leg is best-effort by design**
(260813-oid2-own-code-server-install); mechanism in
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `update` row. It
runs **only when the managed install root exists** — `apphome.CodeServerBinDir()`,
`<state>/code-server/bin` where `<state>` is `${XDG_STATE_HOME:-~/.local/state}/hexokit/` — the ownership gate, the
mirror of the standard's "self-update only when brew-installed" clause; a
user-managed PATH install is never touched, and no managed dir is a silent
skip. (3ht0) It shares `runCodeServerUpdateFlow` with `rk code-server update`
in-process (no subprocess self-call): install the latest digest-verified
release, then kill and respawn the `rk-code-server` session on a version
change so the flipped `current` symlink takes effect (the daemon restart
deliberately never touches sibling sessions, so this leg owns the respawn).
**Any failure is a warning on the chatter surface and NEVER joins the
command's exit code** — deliberately NOT taking the standard's allowance for
non-zero on a failed post-upgrade step: the rk upgrade itself succeeded, the
daemon's install job retries acquisition later, and a false red row in
`shll update`'s summary is worse than a warning. The download is in-process
HTTP under a generous ~15m context bound — no package-manager subprocess, so
the SIGTERM-with-grace brew discipline does not apply, and the atomic symlink
flip makes the swap corruption-proof regardless.

Updating additional artifacts beyond the CLI is what the standard's own "the tool's own
post-upgrade side effects" clause contemplates — the same clause the daemon
restart sits under. The **composition consequence is worth stating plainly**:
`shll update` delegates run-kit's leg to `rk update`, so a composed toolkit
update on a Mac also updates and restarts the desktop app. That is conformant
(a tool owns its own post-upgrade side effects), and it costs the
`install-composition` Policy A posture nothing — no sibling tool is probed or
assumed. A custom-`--path` desktop install stays outside the umbrella's reach
(Constitution II bars an install-path state store), documented in `update`'s
help rather than papered over by path scanning.

Both update entry points share the brew seam: the web one-click upgrade
(`POST /api/update` → `rk update` in the managed `update` job window, via
`daemon.RunJob`) routes through the same `updateCmd`, so the brew discipline
below governs both.

### Brew invocation discipline — the read-only vs mutating split
run-kit splits brew calls by whether they mutate the install, and treats the two
classes differently (the mechanism lives in `newBrewCmd` — see
[cli](/run-kit/architecture/cli.md) § CLI Subcommands, `update` row):

- **Mutating brew subcommands (`brew update`, `brew upgrade`)** — keg
  transactions that must never be `SIGKILL`ed mid-swap. They run under
  **generous, network-sized bounds** (`brewUpgradeTimeout = 30m`,
  `brewUpdateTimeout = 10m`) with **graceful termination**: `newBrewCmd` sets
  `cmd.Cancel` to deliver **`SIGTERM`** and `cmd.WaitDelay = brewCancelGrace`
  (**30s**), so on context expiry brew gets a trappable signal plus a 30s grace
  window to unwind the keg swap before the runtime's final kill. `brew update`
  is included (not just `brew upgrade`) because the MUST-NOT-`SIGKILL` clause
  covers "a package-manager subprocess mid-transaction" generally and `brew
  update` is network-bound with the same stall profile.
- **Read-only brew queries (`brew info --json=v2`; `internal/updatecheck`'s
  `brew list --versions`)** keep their **short 10s bounds and Go's default
  cancel** (immediate kill). A killed query corrupts nothing, so fast-fail is
  correct. `newBrewCmd` keys the graceful-cancel config on `args[0]`, so an
  unmatched brew subcommand inherits the safe read-only default.

`exec.CommandContext` with a timeout bounds **every** brew call
(Constitution § Process Execution) — the bounds are simply generous with
graceful cancel for mutations, satisfying both the constitution and the
standard's "if any bound exists, it SHOULD be generous and terminate gracefully".
The constitution's 5–10s / 30s figures name tmux / build operations; brew is
neither. `HOMEBREW_NO_GITHUB_API=1` is deliberately **not** set — the standard
only says a bounded caller "should also consider" it, and the generous bound +
`SIGTERM` already satisfies the SHOULD (trivially addable later if wanted).

#### Scenario: A mid-transaction stall terminates gracefully, never mid-swap
- **GIVEN** a `brew upgrade sahil87/tap/hexokit` that stalls past its bound on an
  un-timed `api.github.com` call
- **WHEN** the (30-minute) context finally expires
- **THEN** brew receives a trappable `SIGTERM` (not `SIGKILL`) and a 30s grace
  window to finish or roll back the keg swap
- **AND** a read-only `brew info` in the same run keeps immediate-kill fast-fail,
  since killing a query corrupts nothing

### version — PASS
`--version` exits 0 with the version token on the first non-empty line
(`hexokit version vX.Y.Z`, cobra's default template — the RECOMMENDED canonical
shape, satisfying `versionPrefixRE`), responds within 2s with no network I/O
The version line's first word is the root command name `hexokit`, which is
also the formula (`sahil87/tap/hexokit`) and shll roster name — and the
standard's parse is `<word> version <rest>`, so shll's probes do not depend on
that word anyway (260911-mvuv-hexokit-brand-surfaces).
(pure local ldflags string), and the on-PATH binary name equals the tool name.
The release-shape path is unit-pinned: `TestDisplayVersion` in `root_test.go`
covers `displayVersion`'s three input shapes — `"1.2.3" → "v1.2.3"` (the release
shape shll actually parses), `"v1.2.3"` passthrough, and the `"dev"` sentinel
passthrough (no `"vdev"`) — so the release-shape path (the one shll parses in
production) is pinned, not just the `dev` sentinel. See
[build-and-release](/run-kit/build-and-release.md) § Version Management.

## `install-composition` Standard

The `install-composition` standard (`shll standards install-composition`,
authoritative at `sahil87/shll` `docs/site/standards/install-composition.md`,
rendered on https://shll.ai) is a separate **binary+repo** standard from the six
above. It has two halves, each audited and passing: **Policy A** (no
inter-tool Homebrew dependencies; a sibling invoked at runtime is *probed*, never
assumed, and degrades with an actionable install hint) audited @ **`shll
v0.1.18`** (260814-mx8e-install-policy-a-binary-audit), and **Policy B**
(install *documentation* is centralized on hexokit.com — per-tool READMEs and
doc pages MUST NOT carry per-formula `brew install sahil87/tap/<tool>` install
*instructions*; they point at the curl bootstrap
`curl -fsSL https://hexokit.com/install | sh` and `shll install <tool>` for
subsets)
audited @ **`shll v0.1.12`** (260720-ec6i-install-docs-policy-b; the
hexokit.com bootstrap host per the standard's current text,
260911-mljj-hexokit-brand-prose). Policy A binds all seven tap formulas + every sibling-invoking binary; Policy B binds the
six roster-tool repos + the tap README. Individual formula installs remain
*supported* — only *documenting* them per-repo is prohibited.

### Requirement: Install documentation carries no per-formula brew instructions (Policy B)
run-kit's install *documentation* — `README.md` and `docs/site/`, the pages the
shll.ai site extracts — MUST NOT carry per-formula `brew install sahil87/tap/…`
install instructions, and MUST NOT reference the retired `sahil87/tap/all`
meta-formula. Install guidance points to the centralized hexokit.com bootstrap
(`curl -fsSL https://hexokit.com/install | sh`, subset `sh -s -- run-kit`) and,
for sibling-tool prerequisites, `shll install <tool>` + a https://shll.ai link.
(260720-ec6i-install-docs-policy-b, 260911-mljj-hexokit-brand-prose)

### install-composition — Policy B (docs half) PASS
The docs half passes: `README.md` and `docs/site/` carry **no per-formula
`brew install sahil87/tap/…` install instruction**. The audit grep
(`grep -rn -iE 'brew install|sahil87/tap' README.md docs/site/`) is a screen, not
a zero-hit assertion — it also matches `docs/site/install.md`'s
**formula-rename note** ("Coming from an older formula name?" — `rk` → `run-kit`
→ `hexokit`), which explains how to clear a keg stranded under an old formula
name, and the Linux `brew install tmux` prerequisite line. The first is migration
troubleshooting and the second a third-party prerequisite, not per-formula
install guidance, and both are deliberately kept; every hit the grep produces
must be classified, and today those two are the only ones. The
install guidance matches the wording in the conformant sibling READMEs
(wt/hop/idea/tu):

- **`README.md`** — the Install section carries the centralized
  `curl -fsSL https://hexokit.com/install | sh` one-liner and no per-formula
  escape hatch; the Quick-start `wt`-prereq fragment and the
  Troubleshooting *"wt not found"* entry both point at `shll install wt` + a
  https://shll.ai link. The Troubleshooting entry earns its place: it is
  doc-carried install guidance, not the Policy-A binary hint.
- **`docs/site/install.md`** — the Install lead-in names the bootstrap and
  carries the curl block (`curl -fsSL https://hexokit.com/install | sh -s --
  run-kit` — the hexokit.com host per Policy B; the roster name is `hexokit`, and
  `run-kit` is a legacy name shll ≥ v0.1.34 still resolves) plus the PATH sentence; the
  Prerequisites `wt` bullet points at the full-toolkit shll.ai link + `shll
  install wt`. The heading
  structure is load-bearing — shll.ai extraction anchors key on it.
- **No `sahil87/tap/all` reference** in `README.md` or `docs/site/` — the
  standard's Precedent states the meta-formula "is retired in favor of
  `shll install`".

**Explicitly out of scope (KEPT).** The curl bootstrap blocks are the
centralized pointer, not per-formula instructions — kept inline. Upgrade/update
prose (`run-kit update` Homebrew behavior), the README toolkit banner +
command-reference links, `docs/site/skill.md`'s gating instruction, and
historical references in `fab/changes/` / `docs/memory/` / changelogs are
behavior/pointer/history, not install instructions — outside Policy B's reach.

#### Scenario: An audit grep over the install docs finds no per-formula brew instruction
- **GIVEN** `README.md` + `docs/site/`
- **WHEN** `grep -rn -iE 'brew install|sahil87/tap' README.md docs/site/` runs
- **THEN** its only hits are the `docs/site/install.md` formula-rename
  troubleshooting note (migration guidance, deliberately kept) and the
  `brew install tmux` prerequisite — no per-formula install instruction and
  no `sahil87/tap/all` reference; install guidance points to the hexokit.com
  bootstrap + `shll install <tool>`
- **AND** the desktop-app install section introduces no new hit — it leads with
  `run-kit desktop install` and its manual fallback is a GitHub Releases download,
  never a brew formula (260730-pl4v-rk-desktop-install)
- **AND** the Policy-A binary hint in `app/backend/cmd/rk/upgrade.go` still prints
  `brew install sahil87/tap/hexokit` on a non-brew install — conformant binary
  output (Policy A mandates the hint there; Policy B binds docs only)

### install-composition — Policy A (binary half) PASS
Audited @ **`shll v0.1.18`** against a HEAD `bin/rk`
(260814-mx8e-install-policy-a-binary-audit); full evidence lives in that change
folder's `conformance-report.md`, lifted into the PR body per the
report-lives-in-PR-body convention. All three checklist items of the standard's
"Verifying conformance" section hold:

- **Formula**: `sahil87/tap/hexokit` declares zero `depends_on` of any class
  (`brew info --json=v2` + tap source). The formula's only `depends_on` text is
  a comment explaining two deliberate non-declarations — code-server (rk manages
  its own digest-verified install; brew's formula is deprecated/pinned) and tmux
  (host-provided) — neither a toolkit sibling.
- **Probe coverage**: the siblings run-kit's binary invokes are exactly `wt`,
  `fab`, and `shll` (`idea`/`hop`/`tu` never; `scripts/*.sh` and the shipped
  skill pages invoke no sibling — the skill pages carry only the `command -v rk`
  consumer self-gate). Literal `exec.LookPath` probes sit at the user-facing
  entry seams: `cmd/rk/riff.go` `checkPreconditions` (wt),
  `internal/updatecheck` `defaultCheck` (shll), and `api/update.go` `lookShllFn`
  (shll — absent routes fail-silent to the run-kit-self update path). The five
  internal exec sites (`internal/riff` fab launcher + wt create/delete,
  `internal/wt` list/open) degrade gracefully
  by handled exec error — silent feature skips (default launcher, `[]` app
  registry) or surfaced HTTP errors. **No
  crash-capable sibling path exists**; the standard's failure mode (one tool's
  absence crashing another) occurs nowhere.
- **Hints**: the non-brew self-install hint (`cmd/rk/upgrade.go`,
  `brew install sahil87/tap/hexokit`; HTTP twin in `api/update.go`'s 409 body)
  is live-verified conformant. Two hint strings fall short of the standard's
  actionable shape (`<tool> is not installed. Install it: brew install
  sahil87/tap/<tool>`) and are deferred as backlog `[gq7f]`: riff's wt-absent
  message (repo URL, no install command) and updatecheck's bare
  `shll not found on PATH`. Wording only — never-crash conformance holds.

#### Scenario: A missing sibling degrades gracefully with a hint, never a crash
- **GIVEN** a host without `wt` on PATH (scratch-PATH simulation)
- **WHEN** `bin/rk riff echo hi` runs inside tmux
- **THEN** it fast-fails pre-spawn with operational exit 1 and the message
  `run-kit riff: wt not found on PATH (required companion tool — see
  https://github.com/sahil87/wt)` (hint-shape alignment deferred to `[gq7f]`)
- **AND GIVEN** a non-Homebrew `bin/rk`, `rk update` prints the manual-update
  guidance ending `brew install sahil87/tap/hexokit` and exits 0 (a leg skip,
  not a failure)

## Design Decisions

### Handled exec errors satisfy Policy A's probe clause at internal Go seams
**Decision**: internal sibling exec sites (wt/fab in `internal/riff`,
`internal/wt`) rely on handled `exec.CommandContext` errors
rather than a preceding `exec.LookPath`; literal probes live at the user-facing
entry seams (CLI riff precondition, both shll consumers).
**Why**: a handled exec error is authoritative and TOCTOU-free — it never
*assumes* presence, which is the clause's substance (principle №8's
skip-don't-crash); a LookPath at each internal seam would duplicate the check
without changing any observable behavior.
**Rejected**: sprinkling `exec.LookPath` before every internal exec (redundant,
and it races the exec it guards); grading the missing literal probes as
nonconformance (the standard's failure mode — crash on sibling absence — is
structurally absent at every site).
*Introduced by*: `260814-mx8e-install-policy-a-binary-audit`

### Brew mutations run under generous bounds, never a short hard timeout
**Decision**: `brew upgrade` and `brew update` run under network-sized bounds
(`brewUpgradeTimeout` 30m, `brewUpdateTimeout` 10m) with `SIGTERM` plus a 30s
`WaitDelay` grace — never a short hard timeout under `exec.CommandContext`'s
default `SIGKILL` cancel.
**Why**: Homebrew 6 makes an un-timed `api.github.com` call inside every
tap-formula upgrade, so a short bound stalls and then `SIGKILL`s brew between
`brew unlink` and `brew link`, leaving a corrupted keg and a dead binary. That is
precisely what the update standard's safety clause prohibits ("MUST NOT send
`SIGKILL` to a package-manager subprocess mid-transaction" / "MUST NOT impose a
short hard timeout on `brew upgrade`"). Both update entry points — the CLI and
the web one-click upgrade via `daemon.RunJob` — route through the same
`updateCmd`, so the discipline has exactly one place to hold.
**Rejected**: a short hard timeout (e.g. `120s`) on the brew mutation seam — it
produces the corrupted-keg, dead-binary failure above.
*Introduced by*: `260719-er5k-update-version-standards-conformance`

### Graceful brew-mutation cancel lives in an extracted `newBrewCmd` helper
**Decision**: extract `exec.Cmd` construction into `newBrewCmd(ctx, args...)
*exec.Cmd`; the default `runBrewFn` calls it, and mutating subcommands
(`update`, `upgrade`) get `cmd.Cancel` = `SIGTERM` + `cmd.WaitDelay` = 30s grace,
keyed on `args[0]`. Read-only subcommands inherit Go's default cancel.
**Why**: makes the cancel configuration unit-testable without spawning a real
brew (tests assert on the returned `*exec.Cmd` fields), and keeps the single
`runBrewFn` seam that all brew calls and all existing stubbed-`runBrewFn` tests
route through — so the fix is invisible to those tests. Keying on `args[0]` (the
same idiom as `runBrewFn`'s per-subcommand stream wiring) means a future brew
subcommand fails safe to the read-only default rather than silently getting
graceful-cancel it may not want.
**Rejected**: configuring the cmd inline in `runBrewFn` (untestable without a
real brew, or forces duplicating the wiring); a separate mutating-vs-readonly
seam pair (splits the single seam existing tests stub); setting
`HOMEBREW_NO_GITHUB_API=1` (the standard makes it optional — "should also
consider" — and it alters brew behavior beyond this path; the generous bound +
`SIGTERM` already satisfies the SHOULD).
*Introduced by*: `260719-er5k-update-version-standards-conformance`

### `status --json` empty-vs-error semantics (absent ≠ unreachable)
**Decision**: `status --json` splits by the **nature** of the condition, not by
a flag. A **cleanly-absent** server (no tmux server running for the `runkit`
socket) is **empty-success** — `[]` on stdout, exit 0, stderr empty — deliberate
`internal/tmux.ListSessions` behavior, matching the human path's
`No tmux sessions found` + exit 0. An **errorful unreachability** (stale socket,
permission error — a genuine tmux failure) surfaces the error on stderr with a
non-zero exit and a complete `{"ok":false,"error":{…}}` envelope on stdout —
**never a partial JSON document**.
**Why**: an empty result is data, not a failure, so a machine consumer must be
able to distinguish "nothing running" (parse `[]`) from "tmux broke" (non-zero
exit) — and must never parse a truncated document as complete. Both paths were
verified empirically.
**Rejected**: treating a cleanly-absent server as an error (would force callers
to special-case the common no-server case); emitting partial JSON on failure
(a machine consumer would parse it as a complete, empty result).
*Introduced by*: `260717-c424-toolkit-standards-conformance`

### Deferred gaps go to fab/backlog.md, report lives in the PR body
**Decision**: restructural principle gaps (P4, P9) are recorded as
`fab/backlog.md` entries ([rex1], [f8yv]) and referenced from the report by
backlog id; the conformance report itself is written to the change folder for
the ship stage to lift into the PR body, with no committed copy under `docs/`.
**Why**: `fab/backlog.md` is the repo's freshly-committed deferral convention
(over GitHub issues or draft changes); the report's only consumer is the PR body,
so a parallel in-repo doc would drift with no reader. Deferring the restructural
gaps (rather than a half-covered fix) honors "fix root causes, not symptoms" and
the toolkit's phased-adoption posture.
**Rejected**: GitHub issues / draft changes for the deferrals (not the repo's
visible convention); committing the report under `docs/` (drift, no consumer).
*Introduced by*: `260717-c424-toolkit-standards-conformance`

### Unknown-command classification at the `execute()` seam, not an explicit validator
**Decision**: `run-kit bogus` is classified usage-class (exit 2) at the central
`execute()` seam by matching the stable `unknown command ` prefix on cobra's
error, with the root command's `Args` left `nil` — rather than by an explicit
`rootCmd.Args` validator that replicates cobra's `legacyArgs`/Find check.
**Why**: `Args: nil` keeps cobra's native Find/legacyArgs path, which prints the
`unknown command %q` line, the Levenshtein "Did you mean this?" suggestions, and
the trailing `Run 'run-kit --help' for usage.` hint, and detects `run-kit help
bogus` as an unknown help topic (exit 0). An explicit `rootCmd.Args` validator
relocates detection from Find-time to ValidateArgs-time and regresses all three:
it drops the help hint, disables suggestions (`SuggestionsMinimumDistance` never
bumped 0→2), and breaks `help bogus`. Byte-identity of user-facing output outranks
string-coupling elegance; the prefix match fails safe (2→1, never wrong output) if
cobra ever changes the wording, and the capital-U `Unknown help topic` message
deliberately does not match (so `help bogus` stays exit 0).
**Rejected**: an explicit `rootCmd.Args` validator replicating `legacyArgs` (three
distinct stderr regressions); patching each regression inside the validator (would
replicate ever more cobra internals to reproduce what `Args: nil` gives for free).
*Introduced by*: `260717-rex1-unify-usage-error-exit-codes`

### riff exit-class renumbering is a value change, not a mapping change
**Decision**: swap `internal/riff`'s `ExitValidation` (1→2) and `ExitPrecondition`
(2→1) numeric values to conform to Principle 4, and touch no mapping code.
**Why**: both the CLI `os.Exit` wrapper and the HTTP `riffStatusForError` map key
on the **constant identity** (`ExitValidation` → 400), never the literal value, so
the value swap propagates to every consumer with zero mapping edits — the HTTP
`400` for an unknown preset is unchanged. A locking test (`TestRiffExitClassMapping`)
pins the new numeric values so a future accidental re-swap is caught.
**Rejected**: leaving riff's codes inverted (permanent P4 nonconformance for the
one command already using explicit codes); adding a numeric translation layer at
the boundaries (unnecessary once consumers key on identity).
*Introduced by*: `260717-rex1-unify-usage-error-exit-codes`

### Static derivation recipes replace `rk context` (a recipe is static content)
**Decision**: **delete `rk context` outright** (no stub/alias) and absorb its two
halves into the skill standard's static surface: (1) its ~100 lines of static
capability prose (terminal/iframe windows, proxy, Visual Display Recipe,
conventions) move to the new **`rk skill display`** topic page; (2) its genuinely
**dynamic** residue — the ~4-line "where am I" Environment block (pane id, session,
window, window type, server URL) — is taught to agents as a **static derivation
recipe** in the core `rk skill` bundle: a fixed `$TMUX_PANE` / `tmux
display-message -p '#S'`/`'#W'` / `tmux show-option -w @rk_win_lens` / **`rk url`**
snippet. A **derivation recipe is static content even though its result is
dynamic** — the recipe text never varies by where/when it runs, so the bundle can
teach it without violating the standard's static-only rule.
**Why**: `rk context` duplicated the bundle-owned static prose (drift risk — no
guard pinned the two copies) and cost an extra CLI subcommand (Constitution §IV
minimal surface). The standard's own static/dynamic split, plus Constitution §X's
"when a fact is available both ways, derivation wins", applied to rk's own CLI:
every Environment value is derivable by the agent directly (`$TMUX_PANE`, `tmux
display-message`, env-backed config), so the command was pure duplication once the
topic page existed. The one derivation that earns a stable command seam is the
server URL → **`rk url`** (a resolver over explicit `RK_HOST`/`RK_PORT` env →
the pane server's `@rk_srv_origin` tmux option → the `127.0.0.1:6123` default, so
it stays accurate on non-default deployments where panes carry no `RK_*` env;
ecosystem precedent
`gh browse --no-browser` / `docker port` / `minikube service --url`), which also
keeps a natural home for smarter port-owner discovery later without freezing a
heuristic into prose. Net CLI surface: −1 `context`, +1 `url`, +topic arg on
`skill` — zero growth, less duplication. Env-derived content is reached via
`rk url` + the taught tmux derivations; the bundle carries no `rk context`
reference.
**Rejected**: a deprecation stub/alias for `rk context` ("completely get rid of";
the version-locked binary embed makes removal atomic per-install — a binary lacking
the command also ships the bundle that does not reference it, and external callers
follow the fail-silent rk discipline and degrade to no-op); merging context INTO
`rk skill` as a `context` subcommand (topic pages are static-only, and the dynamic
Environment block has no place there — the recipe belongs in the bundle, the URL in
its own command); keeping the static prose in BOTH `rk context` and the topic page
(the exact drift the deletion removes). The fab-kit `_cli-external.md` § rk update
(it documents `rk context` as carrying the recipes) is a **sibling change** in the
fab-kit repo, out of scope here.
*Introduced by*: `260718-icxz-skill-display-topic-url-retire-context`

### Three installer kinds share the existing consent/diff/ownership machinery
**Decision**: `rk agent setup` installs native hooks/plugins for the seven
supported harnesses via three installer kinds — jsonHooksMerge, markerFile,
markerBlock — all sharing the existing consent/diff/dry-run/uninstall machinery.
**Why**: the verified native config formats fall into exactly these three shapes,
and sharing the machinery keeps the P1/P5 conformance posture (non-interactive
consent via `--yes`, visible mutation boundaries via `--dry-run`) uniform across
every harness.
**Rejected**: a TOML parser dependency for kimi (only the documented fields are
emitted; marker blocks preserve user content byte-exactly) and JSON-merging into
a foreign copilot file (its hooks dir is one-file-per-source — whole-file
ownership is the native shape).
*Introduced by*: `260908-nnqu-fix-agent-neutral-detection`
