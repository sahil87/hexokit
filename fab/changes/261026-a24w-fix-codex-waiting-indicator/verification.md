# Verification: Codex waiting indicator

## Automated checks

- Full `just test-backend`: passed. Process-only Git settings isolate the suite
  from this machine's `/tmp/.git` ancestry and `diff.mnemonicPrefix=true`:
  `GIT_CEILING_DIRECTORIES=/tmp GIT_CONFIG_COUNT=1
  GIT_CONFIG_KEY_0=diff.mnemonicPrefix GIT_CONFIG_VALUE_0=false`.
- `just check`: passed.
- `just test-e2e codex-waiting-indicator.spec.ts`: 5 passed, including Codex
  approval/question lifecycles at desktop/mobile widths and Claude regression.
- `just build`: passed.
- Full `just test`: backend and all 5,777 frontend unit tests passed. The
  browser phase was interrupted to restart using four isolated rigs; the
  parallel run is pending and remains a ship gate.

## Actual external integration

Installed Codex **0.164.0** passed the opt-in `TestCodexRuntimeAutoReview`
through `just test-backend`, with `RK_CODEX_RUNTIME_TEST=1` and
`GOFLAGS='-run=^TestCodexRuntimeAutoReview$ -v'`.

The test installs the real registry into a temporary `CODEX_HOME`, runs Codex
with a read-only sandbox and automatic reviewer, and asks only for creation of
`probe.txt` in its disposable workspace. A private `rk-test-*` tmux socket
receives the production hook writes. The observed lifecycle was:

| Actual Codex event | State after production hook |
|---|---|
| SessionStart | idle |
| UserPromptSubmit | active |
| PreToolUse | active |
| PermissionRequest | active |
| PostToolUse | active |
| Stop | idle |
| SessionEnd | idle |

The probe file had the expected content. No automatic-review event generated
waiting. The final run completed in 81.6 seconds with low reasoning effort.
Earlier attempts exposed a test recorder's socket-selection mistake (corrected)
and two Codex turn timeouts; those attempts are not counted as passing.

Prior isolated Codex recordings established the `user` reviewer approval
sequence and accepted asynchronous-question/reply payloads. The changed
implementation's human approval, asynchronous question, cancellation, partial
answer, ordinary-text answer, and child-session handling are covered by
deterministic regressions; a fresh live human-dialog run is not claimed.
Claude coverage is deterministic hook-to-browser regression, not a new live
Claude model session. Child suppression is verified against observed session
metadata; a live child overwriting the root was not reproduced.

## Browser recordings

`just demo codex-waiting-indicator --before ef50f162` passed all four recordings:

- Before desktop (1280×800) and mobile (375×812), base `ef50f162`.
- After desktop and mobile, PR implementation.

Each recording is explicitly labeled **Codex 0.164.0 event replay**. Sanitized
captured event shapes drive the installed event mapping, production hook,
isolated tmux pane, backend, SSE, and real browser rendering. This is separate
from the live Codex execution above. The scenario shows automatic review,
completion, human approval, resumed work, an asynchronous question persisting
over tool work, its answer, and idle completion. The base falsely pulses during
automatic review and misses asynchronous-question attention; the changed
version has the expected settled states. Motion stays enabled. Desktop/mobile
frames were visually inspected.

Files are gitignored under `.demo/codex-waiting-indicator-{before,after}-{desktop,mobile}.webm`
and must be attached to the PR, not committed. No shell recording is required:
no desktop-shell or engine-specific path changes.

## Capability limits

- Codex has no observed approval-answer hook. Manual permission attention clears
  on the next lifecycle hook, normally `PostToolUse` when the approved tool
  finishes. Immediate clearing during a long approved command is not established.
  A separate third-party hook approving a `user`-reviewed request is likewise
  not observable from the permission event alone.
- The hook reads at most a 64 KiB metadata head and an 8 MiB transcript tail.
  Missing, malformed, or out-of-window reviewer/question context is unknown:
  it cannot establish permission attention or recover an older pending question.
  Codex's transcript format is version-sensitive, not a stable hooks API.
- Confirmed subagent sessions are suppressed. Independent non-subagent root
  conversations sharing a pane/process are not disambiguated by this change.
- Added PostToolUse/Interrupt mappings require reinstalling and trusting the
  updated entries. This change does not install anything into the live Codex
  home; the user's instruction to leave that hook file alone remains in force.

Sources: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
and the isolated runtime records described above.
