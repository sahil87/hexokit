# Verification: Fix Shared Agent Paste Submission

**Change:** 261026-ejam-fix-shared-agent-paste-submission
**Before base:** `ef50f162895d1a480024f43b237f54b04a711afa` (merged constitution PR #1088)
**Date:** 2026-10-26

## Result

Six supported CLIs passed real-agent Playwright submission checks. Gemini's composer formats were observed and regression-tested, but replies remain unverified because its existing API credentials return `401 ACCOUNT_STATE_INVALID` (disabled/deleted service account). Desktop and mobile cron recordings reproduce the original Codex failure on the base and pass two successive deliveries on the fixed tree.

## Isolation and prerequisites

`just setup` completed. Tests use repository `just` recipes with throwaway `rk-test-e2e-sylvanshrewf4-*` tmux sockets, per-run temporary state, and derived ports (21111/21112/21113). No test input was sent to live user panes or live cron entries. Fab worker panes on `loom` host the pipeline only. Agents inherit existing authentication; credentials were not inspected or changed. Ordinary CLI session history is a normal launch side effect.

Gemini 0.65.0 was temporarily installed under `/tmp/ejam-gemini-validation`, not globally. Its test folder was left untrusted and the probe-created folder entry was removed afterward. Copilot's trust answer was session-only; Antigravity's preselected folder-trust answer was accepted. Recon/probe servers were cleaned up. No hooks or permanent model/provider overrides were installed.

All media and matrix JSON remain gitignored under `.demo/`; the PR carries uploaded inline recordings.

## Real-agent matrix

Command per agent: `DEMO_AGENTS=<agent> just demo agent-injection-matrix --desktop-only`. The corrected fixture sends exactly one production `mode: submit` request per scenario, with no extra Enter. It samples the baseline before delivery and asks the model to concatenate fragments, so the expected full reply is absent from the prompt. A standalone reply line (allowing UI bullets/borders/scrollbar glyphs), no staged chip, and an idle composer establish the turn; the browser also verifies the reply in its xterm buffer. Async polling keeps the recording continuous. HTTP 200 and delivery logs are supporting evidence only.

| Agent | Tested version / model | Short | 1,433 chars | Multiline | Successive | Operator-role comparison |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.310, configured model | Pass | Pass | Pass | Pass | Pass |
| Codex | 0.164.0, GPT-6-Luna low (invocation-only) | Pass | Pass | Pass | Pass | Pass |
| Copilot CLI | 1.0.103, Claude Sonnet 5.5 | Pass | Pass | Pass | Pass | Not required |
| Kimi | 2.3.2, Kimi K3 Fast high | Pass | Pass | Pass | Pass | Not required |
| OpenCode | 1.18.25, DeepSeek V4.1 Flash Free | Pass | Pass | Pass | Pass | Not required |
| Antigravity | 1.4.7, Gemini 4 Argon high | Pass | Pass | Pass | Pass | Not required |
| Gemini CLI | 0.65.0, temporary install | Unverified | Unverified | Unverified | Unverified | Not required |

The operator comparison stamps `@rk_win_role operator` on the isolated Claude/Codex test window; it does not launch an autonomous operator workflow. Both pass the long-paste response check in that role.

Codex's configured GPT-6-Astra xhigh completed ordinary cases and the cron recordings, but some later matrix turns stayed in `Working` beyond the 240-second reply deadline after submission. This is an observed response stall, not proof of quota exhaustion. The final complete matrix uses a temporary PATH wrapper invoking the same Codex CLI with `--model gpt-6-luna -c 'model_reasoning_effort="low"'`; all 5 cases passed in one run (exit 0, `/tmp/ejam-codex-luna-matrix.log`). No saved configuration changed. Final JSON/video backups are `/tmp/ejam-codex-luna-matrix.{json,webm}` and copied to the canonical `.demo/` paths. Root visually checked the final operator reply and cleared composer.

OpenCode's saved Cloudflare route lacks required account/gateway IDs; an existing Bedrock token was also rejected. Its successful real TUI matrix uses a temporary wrapper with `--pure --model opencode/deepseek-v4.1-flash-free`. This route was first checked with a harmless acknowledgement, then all four Playwright cases passed with actual replies. Copilot auto-updated from the initially inventoried 1.0.78 to 1.0.103 before its final run.

Per-agent files are `.demo/agent-injection-matrix-{claude,codex,copilot,kimi,opencode,agy}.json` and corresponding `-desktop.webm` videos. All six final clips were frame-inspected and show readable real replies. Other final logs: `/tmp/ejam-final-matrix-claude.log`, `-kimi.log`, `-opencode.log`, `-agy.log`, and `/tmp/ejam-final-matrix2-copilot.log`.

## Observed renderer formats

Recon used real CLI composers with long or multiline bracketed pastes. Counts below reflect the sampled payload, not a matching requirement.

| Agent | Observed collapsed-paste format |
|---|---|
| Claude | `[Pasted text #1]`, `[Pasted text #N +M lines]`; a repeated identical paste can expand to raw text |
| Codex | `[Pasted Content 1433 chars]`, repeated `[Pasted Content 1433 chars] #2` |
| Copilot | Raw wrapped echo at this payload size |
| Kimi | `[paste #1 1426 chars]`; repeated paste can expand to raw text |
| OpenCode | `[Pasted ~1 lines]` |
| Antigravity | `[Pasted text #1 1426 chars]`, with incrementing ordinal on repeats |
| Gemini | `[Pasted Text: 1433 chars]`, `[Pasted Text: 1433 chars #2]`, `[Pasted Text: 20 lines]`, `[Pasted Text: 20 lines #2]` |

Gemini rendering probes sent no Enter/model request after the failed authentication prerequisite. Captures: `/tmp/ejam-gemini-long-rendering.txt` and `/tmp/ejam-gemini-multiline-rendering.txt`. Its recognition tests failed before `geminiPasteCollapseRe` was added and passed afterward. Real reply compatibility remains explicitly unverified.

## Before / after cron recordings

Command: `just demo agent-injection --before ef50f162895d1a480024f43b237f54b04a711afa` — exit 0; log `/tmp/ejam-final-cron-demo.log`, result `/tmp/ejam-final-cron-result.json`.

Both sides use Codex 0.164.0 / GPT-6-Astra xhigh and the identical 1,433-character payload. An isolated pane-targeted cron entry fires via the real scheduler. The unchanged prompt asks for replies `ACK-EJAM-CRON-1`, then `ACK-EJAM-CRON-2` through fragment concatenation and message counting; complete expected tokens are absent from the prompt. No manual Enter is sent. Replies are checked as they arrive because a narrow terminal can redraw earlier history.

| Artifact under `.demo/` | Viewport | Duration | Outcome |
|---|---|---|---|
| `agent-injection-before-desktop.webm` | 1280×800 | 82s | Bug reproduced: unsubmitted paste chips accumulate; reply assertion intentionally fails |
| `agent-injection-after-desktop.webm` | 1280×800 | 65s | Pass: two actual numbered replies, composer clears, two delivered outcomes |
| `agent-injection-before-mobile.webm` | 375×812 | 80s | Same bug reproduction |
| `agent-injection-after-mobile.webm` | 375×812 | 59s | Same two-reply pass |

All four clips are complete and were visually inspected. Before failures are expected reproductions, not missing evidence. An earlier mobile assertion depended on retaining two replies in narrow scrollback; transcript inspection disproved its initial quota explanation. The final numbered-reply fixture passes without that assumption. Environmental model-selection nags and OpenCode's update modal are dismissed only when detected, using Escape, never an extra Enter.

## Regression and project checks

The production change is limited to shared chip recognition in `inject.go`; cron already passes `submit=true`. Collapsible-payload gating, strict count increase against the pre-paste baseline, insertion-only behavior, sanitization, pane locks, deadlines, popup handling, image handling, and bounded recovery remain unchanged.

| Check | Result |
|---|---|
| Initial provider regression proof | Existing engine rejected fresh Codex/Kimi/Antigravity/OpenCode chips and withheld Enter; new regressions passed after recognition was added |
| Gemini regression proof | Scoped `just test-backend` failed before Gemini recognition; log `/tmp/ejam-gemini-regression-before.log` |
| Final full `just test-backend` | Pass after Gemini addition; `/tmp/ejam-backend-with-gemini.log` |
| `just check` | Pass on final source, including the new demo fixtures |
| `just test` | Exit 0: backend passed; 260 frontend files / 5,777 tests passed; Playwright 537 passed, 2 passed on retry, 1 skipped (18.9m) |
| `just build` | Pass on final source; `dist/rk` built |
| Final six agent demos | All six pass with actual replies, including 5/5 Codex and Claude comparisons |
| Final cron before/after | Both before runs reproduce the bug; both after runs pass |

Backend/full-suite invocation uses `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.mnemonicPrefix GIT_CONFIG_VALUE_0=false`. The machine's existing global `diff.mnemonicPrefix=true` makes the unrelated `wtdiff/TestReadAgainstARealRepository` fail at the base as well (unhandled `c/`/`w/` prefixes). The override is command-scoped; global Git configuration was not changed.

Full-suite log `/tmp/ejam-full-suite-standard-prefix.log`, summary `/tmp/ejam-full-suite-result.md`. Its two retry passes are untouched `gui-toolbar-fold.spec.ts:135` and `:229`. The full suite preceded the final Gemini matcher addition; the whole backend suite was rerun after that addition, and final check/build/demos passed. A duplicate worker e2e run reported 536 passed, 3 passed on retry, 1 skipped; its cleanup prints `ELIFECYCLE` when terminating dev services, as successful demo runs also do. The root full-suite exit 0 is the definitive gate result.
