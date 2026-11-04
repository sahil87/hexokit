# Verification: Codex waiting indicator

## Automated checks

- Focused hook, installer, shared transcript projection, runtime protocol, and tmux reader regressions: passed through `just test-backend`.
- `just check`: passed after rework.
- `just test-e2e codex-waiting-indicator.spec.ts`: **9 passed** again after the final T010 correction, covering desktop/mobile automatic review, async and blocking questions, approval resume before completion, ordinary steering while questions remain pending, and Claude regression. Runtime replay cases require an isolated `CODEX_HOME=RK_CODEX_REPLAY_HOME` directory from `mktemp -d /tmp/rk-test-codex-XXXXXX`; other cases run without it.
- Full `just test-backend` passed before rework and the final smoke run's backend stage passed after rework. An intervening run failed `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`; fixed ten-trial comparisons reproduced the identical failure twice on both base `7dab7839` and the changed tree (8 passed, 2 failed each). The changed Codex path returns immediately for its no-agent fixture before relay attachment; attachment/teardown files are unchanged. The test has a pre-existing attachment-readiness race. Logs: `/tmp/a24w-terminal-{base,current}-ten.log`.
- Full `just test` before rework: backend and **5,777 frontend unit tests** passed; browser results were **540 passed, 3 flaky, 1 skipped, 1 failed**. The failure was `web-tabs.spec.ts`'s zero-tab draft materialization case. A subsequent full run of that spec passed **17/17**.
- Final `just test` after runtime rework: full backend and all **5,777 frontend unit tests** passed; browser results were **544 passed, 1 flaky, 3 skipped, 1 failed**. The failure was the mobile-heading overlap case in `mobile-layout.spec.ts`. A combined focused run passed all nine Codex cases and three mobile cases but reproduced that layout failure. The unchanged mobile spec passed 4/4 against base `7dab7839`; a current-only cold diagnostic also passed (switcher right190, surface left210), whereas failing runs measured surface left184. The PR Review button is26px wide, but a baseline probe could not load that tile even after status refresh, so the proposed metadata/layout explanation remains unverified. No production frontend, dependency, or mobile-test code changed; the full-suite failure remains disclosed. Two skipped cases are the optional private runtime-socket cases already passed in the nine-case targeted run.
- `just build`: passed after the final timestamp correction. Scoped tmux and cron regressions passed, including state/epoch consistency and suppression of backoff schedules when transition time is unknown.

Backend runs use process-only Git settings to isolate the suite from this machine's `/tmp/.git` ancestry and `diff.mnemonicPrefix=true`: `GIT_CEILING_DIRECTORIES=/tmp GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.mnemonicPrefix GIT_CONFIG_VALUE_0=false`.

## Actual external integration

Installed Codex **0.164.0** passed both opt-in tests through `just test-backend` with `RK_CODEX_RUNTIME_TEST=1` and an individual `GOFLAGS=-run=...` filter. Both use disposable workspaces/homes, a mode-0600 temporary copy of existing authentication, private tmux servers, and bounded process cleanup.

### Automatic approval review

`TestCodexRuntimeAutoReview` installs the real hook registry in a temporary Codex home and runs an actual turn with a read-only sandbox and automatic reviewer, requesting only creation of `probe.txt` in its disposable workspace. Observed production-hook states:

| Actual Codex event | State |
|---|---|
| SessionStart | idle |
| UserPromptSubmit | active |
| PreToolUse | active |
| PermissionRequest | active |
| PostToolUse | active |
| Stop | idle |
| SessionEnd | idle |

The file had the expected content. No automatic-review event generated waiting. The passing run completed in 81.6 seconds. Earlier recorder/socket mistakes and model timeouts were corrected or excluded from passing evidence.

### Manual approval and resumed execution

`TestCodexRuntimeHumanApproval` passed in 63.6 seconds against an owned actual Codex app-server. It approves only the exact disposable-workspace command `printf hook-started > started.txt; sleep 8; printf hook-probe > probe.txt` (including Codex's displayed shell wrapper), with matching thread and cwd. Unexpected requests are cancelled. Shell startup also uses a temporary home.

The initial `PermissionRequest` hook is **explicitly replayed** using the actual request's thread, turn, and transcript; app-server hook trust is not exercised. The approval request, answer, execution, and runtime reads are real:

1. Pending approval produces waiting; neither marker exists.
2. After approval, `started.txt` exists and production `PaneAgentState` returns active while `probe.txt` is absent: the command has resumed but has not finished. No completion hook is replayed.
3. Actual turn completion produces idle through the production runtime reader.

Earlier attempts safely rejected Codex's shell-wrapped command until the exact wrapper was included in the guard; these are not counted as passing runs.

Async questions/replies and guardian ownership use previously observed Codex payloads plus deterministic production regressions. A new live async-dialog or child-overwrite reproduction is not claimed. Claude coverage is deterministic hook-to-browser regression, not a fresh live Claude model session.

## Browser recordings

`just demo codex-waiting-indicator --before 7dab7839` passed all four Before/After desktop/mobile recordings, including both review fixes. Frames from all four were visually inspected. The final refresh with ordinary-steering coverage passed all four recordings (Before: 2 passed; After: 2 passed). It replaces the earlier PR #1089 attachments.

Recordings are explicitly labeled **Codex 0.164.0 event replay**: sanitized hook/transcript events and a private runtime-status socket drive the real installer, hook, tmux, backend, SSE, and browser. Separate live integration above establishes external compatibility. Desktop is 1280×800; mobile 375×812. Scenarios cover automatic review, human approval and resume before completion, async and blocking questions surviving unrelated tools, ordinary steering, answers, and idle. Motion is enabled. Videos live under `.demo/`, are attached to GitHub, and are not committed. No desktop-shell-specific path changes require a shell recording.

## Capability limits

- Effective reviewer/ownership/question facts use Codex's version-sensitive transcript format, with a 64 KiB metadata head and an 8 MiB tail. Missing, malformed, or out-of-window facts cannot establish unverified attention.
- Immediate manual-approval clearing requires the managed daemon's local Unix control socket in the rk process's `CODEX_HOME` (default `~/.codex`), a matching thread and transcript path, and a complete known question projection. Requests are read-only, share a 300 ms batch deadline, and cover at most 32 distinct waiting Codex sessions per batch. No daemon is started or mutated.
- Standalone `--no-daemon`, different per-pane homes, unavailable/incompatible runtime status, or uncertain/truncated transcripts retain hook state. In those fallback cases manual approval can remain waiting until the next lifecycle hook, usually `PostToolUse`. Known pending questions retain attention even when runtime is active or idle.
- Confirmed child sessions are suppressed; independent non-subagent roots sharing a pane/process are not disambiguated.
- Added PostToolUse/Interrupt mappings require installation and Codex trust. Live hook installation is outside the remaining work, per the user's instruction.

Sources: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [app-server protocol](https://learn.chatgpt.com/docs/app-server), and isolated runtime records described above.
