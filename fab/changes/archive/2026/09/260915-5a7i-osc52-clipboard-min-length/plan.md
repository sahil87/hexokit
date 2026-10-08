# Plan: OSC 52 Clipboard Sink — Minimum Copy Length

**Change**: 260915-5a7i-osc52-clipboard-min-length
**Intake**: `intake.md`

## Requirements

### Terminal Frontend: OSC 52 clipboard sink

#### R1: Sub-threshold OSC 52 payloads never reach the system clipboard
`clipboardProvider.writeText` in `app/frontend/src/components/terminal-client.tsx` MUST return without calling `copyToClipboard` when the payload's whitespace-trimmed length (`text.trim().length`, i.e. Unicode whitespace and line terminators stripped from both ends) is below `OSC52_MIN_COPY_LENGTH`. The drop MUST be silent: no toast, no console output, no state change.

- **GIVEN** tmux emits an OSC 52 write for selection target `""` or `"c"`
- **WHEN** the payload is `""`, `" "`, `"   \n"`, `" \t "`, `"a"`, or `"  a "`
- **THEN** `copyToClipboard` is not invoked and the system clipboard is unchanged

#### R2: Passing payloads are written verbatim
When the trimmed length is at or above the threshold, `writeText` MUST pass the ORIGINAL `text` argument to `copyToClipboard` — trimming is measurement only, never a transformation of the written value.

- **GIVEN** an OSC 52 write for a valid selection target
- **WHEN** the payload is `"rk"`, `"-v"`, or `"  hello world\n"`
- **THEN** `copyToClipboard` receives exactly that string, surrounding whitespace intact

#### R3: The selection-target guard stays first and `readText` is unchanged
The existing selection-target check (`selection !== "c" && selection !== ""` ⇒ return) MUST remain the first statement of `writeText` and MUST be evaluated before the length check, so `"p"`, `"s"`, `"0"`–`"7"` are rejected regardless of payload length. `readText` MUST NOT change.

- **GIVEN** an OSC 52 write for selection target `"p"` with a long payload
- **WHEN** `writeText("p", "long enough text")` runs
- **THEN** `copyToClipboard` is not invoked
- **AND** `readText("")`/`readText("c")` still return the clipboard content and `readText("p")` still returns `""`

#### R4: The threshold is a named, exported constant with a constraint comment
`terminal-client.tsx` MUST export `OSC52_MIN_COPY_LENGTH = 2`, declared beside `clipboardProvider`. Its doc comment MUST state the constraint the code cannot show: a one-cell pointer-jitter drag under tmux's default `MouseDragEnd1Pane → copy-pipe-and-cancel` + `set-clipboard on` copies exactly one character or one space, and two-character tokens (`rk`, `-v`, `..`) are legitimate copies, so the threshold MUST NOT exceed 2; measurement only, passing payloads written untrimmed. The `clipboardProvider` doc comment gains one line pointing at the constant. No magic literal `2` appears in `writeText`.

- **GIVEN** the module `terminal-client.tsx`
- **WHEN** it is imported by a test
- **THEN** `OSC52_MIN_COPY_LENGTH` is importable and equals `2`

#### R5: Unit coverage in the existing `clipboardProvider` block
`app/frontend/src/components/terminal-client.test.ts` MUST gain cases inside the existing `describe("clipboardProvider")` block (a nested `describe` is acceptable) covering: whitespace-only dropped (two payloads), single char dropped, single char padded with spaces dropped, two chars written verbatim, longer text with surrounding whitespace written verbatim (untrimmed), non-`c`/`""` selection rejected even with a long payload, and the constant pinned to `2`. The nine existing cases in the block MUST pass unmodified.

- **GIVEN** `just test-frontend` runs
- **WHEN** the `clipboardProvider` block executes
- **THEN** every existing and new case passes

### Non-Goals

- The Cmd/Ctrl+C handler on a local xterm selection (`term.attachCustomKeyEventHandler` in `terminal-client.tsx`) — untouched; it is the escape hatch for a deliberate one-character copy.
- `app/frontend/src/lib/clipboard.ts` (`copyToClipboard`) and all its other callers — untouched.
- `configs/tmux/default.conf` — untouched (no managed-conf hash bump). tmux's own paste buffer still receives the junk; nothing in rk pastes from it.
- Rebinding tmux `DoubleClick1Pane` (double-click-to-focus copies the word under the cursor) — a separate decision, possible follow-up.
- Playwright coverage — the trigger is a sub-cell pointer jitter turning into a tmux drag, not deterministically reproducible via Playwright's mouse API; the sink is a pure function fully covered at the unit layer.

### Design Decisions

#### OSC 52 junk is filtered at the sink by trimmed length, not at tmux or the pointer
**Decision**: `clipboardProvider.writeText` drops OSC 52 payloads whose `trim()`ed length is below `OSC52_MIN_COPY_LENGTH` (2) and writes every other payload verbatim, untrimmed; the Cmd/Ctrl+C local-selection copy is unfiltered.
**Why**: xterm reports mouse motion to tmux at cell granularity with no click-vs-drag threshold, so a one-cell jitter on a focus-click is a tmux drag, and tmux's default `MouseDragEnd1Pane → copy-pipe-and-cancel` with `set-clipboard on` then emits an OSC 52 copy of exactly one character (over text) or one space (over a blank row) — measured on tmux 3.7c. "Trimmed length < 2" is therefore the complete junk class, and 2 is the floor because two-character tokens (`rk`, `-v`, `..`) are legitimate copies. `writeText` is the single OSC 52 → system clipboard sink, so one guard covers every tmux-originated copy with no config churn.
**Rejected**: A tmux-side `pipe-and-cancel` into a filter script that calls `load-buffer -w` for passing payloads (same semantics, but a script or hidden `rk` verb, a managed-conf hash bump forcing a reload on every host, and a process per selection); a frontend pixel drag threshold via a capture-phase `mousemove` suppressor on the terminal container (root-cause-shaped, but xterm attaches its drag reporter to `document` in the bubble phase, so suppression shifts the selection anchor by up to one cell and jitters over ~5 px still pass); a threshold above 2 (blocks legitimate two-character copies); rebinding tmux `DoubleClick1Pane` (a separate decision, out of scope).
*Introduced by*: 260915-5a7i-osc52-clipboard-min-length

## Tasks

### Phase 2: Core Implementation

- [x] T001 In `app/frontend/src/components/terminal-client.tsx`, add the exported `OSC52_MIN_COPY_LENGTH = 2` constant with its constraint doc comment directly above `clipboardProvider`, add one pointer line to the provider's doc comment, and insert `if (text.trim().length < OSC52_MIN_COPY_LENGTH) return;` after the selection-target guard in `writeText`; leave `readText` and everything else in the file untouched <!-- R1, R2, R3, R4 -->
- [x] T002 In `app/frontend/src/components/terminal-client.test.ts`, import `OSC52_MIN_COPY_LENGTH` alongside `clipboardProvider` and add a nested `describe("OSC52_MIN_COPY_LENGTH filter")` inside `describe("clipboardProvider")` with the eight cases from R5, reusing the existing `mockClipboard()` helper; do not modify the nine existing cases <!-- R5 -->

### Phase 3: Integration & Edge Cases

- [x] T003 Run the verification gates from the worktree root: `cd app/frontend && npx tsc --noEmit` and `just test-frontend` (full Vitest — never a touched-files-only run); fix anything red <!-- R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `writeText("", " ")` and `writeText("", "   \n")` leave `copyToClipboard`/`navigator.clipboard.writeText` uncalled
- [x] A-002 R1: `writeText("", "a")` and `writeText("", "  a ")` leave the clipboard uncalled
- [x] A-003 R2: `writeText("", "rk")` calls the clipboard with exactly `"rk"`
- [x] A-004 R2: `writeText("c", "  hello world\n")` calls the clipboard with exactly `"  hello world\n"` (surrounding whitespace intact — not trimmed)
- [x] A-005 R3: `writeText("p", "long enough text")` leaves the clipboard uncalled; the selection-target `return` is still the first statement of `writeText`
- [x] A-006 R3: `readText` is byte-identical to its pre-change body and the three existing `readText` cases pass unchanged
- [x] A-007 R4: `OSC52_MIN_COPY_LENGTH` is exported from `terminal-client.tsx`, equals `2`, sits beside `clipboardProvider`, and `writeText` references the constant rather than a literal

### Behavioral Correctness

- [x] A-008 R1: A dropped payload produces no toast, no `console.*` call, and no other side effect — the early `return` is the whole behavior
- [x] A-009 R2: The nine pre-existing `clipboardProvider` cases (payloads `"test text"`, `"insecure origin"`) pass without modification, including the execCommand-fallback write path

### Scenario Coverage

- [x] A-010 R5: The new cases live inside `describe("clipboardProvider")` in `terminal-client.test.ts` (nested `describe` acceptable), reuse `mockClipboard()`, and cover all eight rows from R5 including `expect(OSC52_MIN_COPY_LENGTH).toBe(2)`
- [x] A-011 R5: `just test-frontend` (full Vitest) and `cd app/frontend && npx tsc --noEmit` both pass

### Edge Cases & Error Handling

- [x] A-012 R1: Whitespace-only payloads built from tabs and newlines (`" \t "`, `"\n"`) are dropped — `trim()` semantics, not a spaces-only strip

### Code Quality

- [x] A-013 Pattern consistency: the constant follows the file's existing exported-constant style (`SCROLLBACK_DESKTOP`, `IMMEDIATE_WRITE_MAX_BYTES`) and the test style matches the surrounding block
- [x] A-014 No unnecessary duplication: no new helper is introduced — `String.prototype.trim()` and the existing `copyToClipboard` are the only mechanisms
- [x] A-015 Comment discipline (code-quality.md): the constant's comment states the constraint the code cannot show (one-cell jitter measurement, the two-character floor) and does not narrate the `if`, mirror the test, or cite change IDs / PR numbers
- [x] A-016 Scope discipline: `git diff --stat` shows exactly two source files changed — `terminal-client.tsx` and `terminal-client.test.ts` — with no change to `lib/clipboard.ts`, the Cmd/Ctrl+C handler, `configs/tmux/default.conf`, or any other `copyToClipboard` caller
- [x] A-017 Type narrowing: no `as` casts introduced in the new code

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | New tests go in a nested `describe` inside the existing `clipboardProvider` block rather than interleaved with the nine existing cases | Keeps the existing cases byte-unmodified (R5) while grouping the filter cases under one heading; the intake allows either | S:80 R:95 A:95 D:90 |
| 2 | Certain | The `writeText` length guard reads `text.trim().length < OSC52_MIN_COPY_LENGTH` — a single line, no helper | Intake's target shape verbatim; a helper for one comparison would be the duplication anti-pattern in reverse | S:90 R:95 A:95 D:90 |
| 3 | Confident | Verification gate is `just test-frontend` + `npx tsc --noEmit` only — no Go tests, no e2e | The diff is two frontend files; project memory says scoped Vitest has missed cross-file breakage, so the full unit run is the floor, and no e2e spec touches the provider | S:75 R:90 A:85 D:80 |

3 assumptions (2 certain, 1 confident).
