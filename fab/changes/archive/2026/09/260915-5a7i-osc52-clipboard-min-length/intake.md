# Intake: OSC 52 Clipboard Sink — Minimum Copy Length

**Change**: 260915-5a7i-osc52-clipboard-min-length
**Created**: 2026-09-15

## Origin

Promptless dispatch from `/fab-proceed` (create-new). The user reported the problem, the mechanism was verified live (tmux 3.7c, xterm.js 6, desktop font), and the user approved the exact fix below before this intake was generated. No questions were asked during intake; every decision the dispatcher would otherwise have asked is recorded in `## Assumptions`.

> **Problem (user-reported).** In run-kit's web terminal, copying by selecting text works, but the clipboard is replaced far too easily: after selecting text, switching tabs and simply clicking on the terminal to focus it usually overwrites the clipboard, so the paste on the other tab is already gone.
>
> **Decision (user approved).** Filter at the OSC 52 sink: in `clipboardProvider.writeText`, ignore payloads whose whitespace-trimmed length is below 2 — whitespace-only payloads and single-character payloads are dropped and never reach `copyToClipboard`. Payloads with trimmed length ≥ 2 are written unchanged (the text itself is NOT trimmed before writing; trimming is only the measurement). Name the threshold as a named constant (`OSC52_MIN_COPY_LENGTH = 2`) with a comment stating the constraint. Add vitest cases next to the existing `clipboardProvider` tests. Only the OSC 52 `writeText` path changes; the Cmd/Ctrl+C handler and `copyToClipboard` are untouched; no tmux.conf change.

Interaction mode: one-shot dispatch (no conversational refinement).

## Why

### The pain point

The web terminal's clipboard is overwritten by ordinary focus-clicks. A user selects text in one tab, switches to another tab, clicks the terminal there to give it focus, and pastes — but the paste is a single space (or a single character), because the focus-click already replaced the clipboard. Copy-by-select is therefore unreliable for the most common multi-tab workflow.

### The verified mechanism (state as fact — do not re-investigate)

- **The frontend never copies on select.** `configs/tmux/default.conf` — rk's managed tmux.conf, Go-embedded — sets `set -g mouse on` (line 15) and `set -g set-clipboard on` (line 47, "OSC 52 clipboard — works across relay and nested tmux"). tmux's **default** `MouseDragEnd1Pane → copy-pipe-and-cancel` binding (in both the `copy-mode` and `copy-mode-vi` tables) copies any drag selection into a tmux paste buffer and, because `set-clipboard` is on, emits an OSC 52 sequence to the attached client.
- **One sink.** The xterm `ClipboardAddon` is loaded in `app/frontend/src/components/terminal-client.tsx` (`terminal.loadAddon(new ClipboardAddon(undefined, clipboardProvider))`, ~line 436) with the exported custom `clipboardProvider` (~lines 73–83). Its `readText`/`writeText` accept the OSC 52 selection targets `""` (tmux's default) and `"c"` (explicit clipboard) and reject every other target. `writeText` calls `copyToClipboard(text)` from `app/frontend/src/lib/clipboard.ts`. **That `writeText` is the single OSC 52 → system clipboard sink** — every tmux-originated copy passes through it.
- **No click-vs-drag threshold anywhere in the chain.** xterm reports mouse motion to tmux at cell granularity, so crossing one cell boundary between mousedown and mouseup is a tmux drag. Measured on tmux 3.7c: a zero-movement click copies nothing; a one-cell drag over text copies exactly **1 character**; a one-cell drag on a blank row copies exactly **1 space**. Cells are ~7 px wide at the desktop font, so pointer jitter on a focus-click routinely produces a 1-char or 1-space copy that replaces the clipboard. Focus-clicks usually land on blank area, so the clipboard typically becomes a single space.

### What happens if we don't fix it

Every focus-click remains a coin-flip clipboard clobber. Users learn to distrust copy-by-select in the web terminal and fall back to shift-select + Cmd+C or to copying from another surface — a regression in the terminal's most basic affordance that gets worse as tabs multiply.

### Why this approach

A one-cell jitter drag copies **exactly one character or one space** — that is the whole junk class, and it is fully characterized by "trimmed length < 2". Filtering at the OSC 52 sink is the narrowest possible intervention: one function, one constant, no tmux config churn, no pointer-event surgery, and every legitimate copy (including two-character tokens like `rk`, `-v`, `..`) passes unchanged. The rejected alternatives are recorded below in § What Changes → Rejected alternatives.

## What Changes

### 1. `clipboardProvider.writeText` drops sub-threshold payloads (`app/frontend/src/components/terminal-client.tsx`)

Current code (lines 64–83):

```ts
/**
 * Custom ClipboardProvider for the xterm.js ClipboardAddon.
 * Accepts both "" (empty/default) and "c" (explicit clipboard) as valid OSC 52
 * selection targets. Tmux sends "" by default; the built-in provider only accepts "c".
 *
 * navigator.clipboard is undefined on plain-http non-localhost origins (e.g. a
 * Tailscale IP), so writes route through copyToClipboard (execCommand fallback,
 * never throws) and reads degrade to "" — there is no read fallback.
 */
export const clipboardProvider = {
  async readText(selection: string): Promise<string> {
    if (selection !== "c" && selection !== "") return "";
    if (!navigator.clipboard) return "";
    return navigator.clipboard.readText();
  },
  async writeText(selection: string, text: string): Promise<void> {
    if (selection !== "c" && selection !== "") return;
    await copyToClipboard(text);
  },
};
```

Target shape (exact semantics; naming per the constant below):

```ts
/**
 * Minimum whitespace-trimmed length an OSC 52 payload must have to reach the
 * system clipboard. tmux's default `MouseDragEnd1Pane → copy-pipe-and-cancel`
 * (with `set-clipboard on`) turns a one-cell pointer jitter on a focus-click
 * into a drag that copies exactly one character (over text) or exactly one
 * space (over a blank row) — clobbering the clipboard the user just filled in
 * another tab. Two-character tokens (`rk`, `-v`, `..`) are legitimate copies,
 * so this threshold MUST NOT exceed 2. Measurement only: the payload that
 * passes is written verbatim, untrimmed.
 */
export const OSC52_MIN_COPY_LENGTH = 2;

export const clipboardProvider = {
  async readText(selection: string): Promise<string> {
    // unchanged
  },
  async writeText(selection: string, text: string): Promise<void> {
    if (selection !== "c" && selection !== "") return;
    if (text.trim().length < OSC52_MIN_COPY_LENGTH) return;
    await copyToClipboard(text);
  },
};
```

Exact behavior contract:

| Payload (`text`) | `text.trim().length` | Outcome |
|------------------|----------------------|---------|
| `""` | 0 | dropped — `copyToClipboard` not called |
| `" "` (one space, the typical focus-click junk) | 0 | dropped |
| `"   "`, `"\n"`, `" \t "` | 0 | dropped |
| `"a"` (one-cell drag over text) | 1 | dropped |
| `" a "` (single char padded by selection whitespace) | 1 | dropped |
| `"rk"`, `"-v"`, `".."` | 2 | **written verbatim** |
| `"  hello world\n"` | 11 | **written verbatim** — `"  hello world\n"` with the surrounding whitespace intact |

- Measurement uses `String.prototype.trim()` (Unicode whitespace + line terminators). The written text is the original `text` argument — never the trimmed value.
- The selection-target guard stays first and stays identical: `"p"`, `"s"`, `"0"`–`"7"` are still rejected before the length check.
- A dropped payload is silent: no toast, no console output, no state change. The junk is a side effect the user never intended, so there is nothing to report.
- `readText` is unchanged.
- The constant lives in `terminal-client.tsx` beside `clipboardProvider` (it is OSC 52–specific, not a general clipboard rule) and is **exported** so the test file can assert against it rather than a literal.
- The existing provider doc comment gains one line pointing at the constant; the comment on the constant carries the constraint (the one-cell jitter measurement and the two-character floor). Per `fab/project/code-quality.md`, the comment states the constraint the code cannot show — it does not narrate the `if`.

### 2. Vitest cases beside the existing `clipboardProvider` block (`app/frontend/src/components/terminal-client.test.ts`)

The provider's unit tests already live in **`app/frontend/src/components/terminal-client.test.ts`** — `describe("clipboardProvider", …)` at line 113, using a `mockClipboard()` helper that stubs `navigator.clipboard.writeText`/`readText`. (The sibling `terminal-client.test.tsx` holds the React-mount tests and mocks `@xterm/addon-clipboard` wholesale; the pure-provider tests belong in the `.test.ts` file where they already are.) Add the new cases inside that existing `describe` (or a nested `describe("OSC52_MIN_COPY_LENGTH filter")` within it), importing `OSC52_MIN_COPY_LENGTH` alongside `clipboardProvider`:

| Case | Input | Assertion |
|------|-------|-----------|
| whitespace-only dropped | `writeText("", " ")`, `writeText("", "   \n")` | `clipboard.writeText` not called |
| single char dropped | `writeText("", "a")` | not called |
| single char padded with spaces dropped | `writeText("", "  a ")` | not called |
| two chars written verbatim | `writeText("", "rk")` | called with `"rk"` |
| longer text with surrounding whitespace written verbatim (untrimmed) | `writeText("c", "  hello world\n")` | called with exactly `"  hello world\n"` |
| non-`c`/`""` selection still rejected (even with a long payload) | `writeText("p", "long enough text")` | not called |
| `readText` unchanged | `readText("")` → `"clipboard content"`; `readText("p")` → `""` | existing cases keep passing |
| constant pinned | `expect(OSC52_MIN_COPY_LENGTH).toBe(2)` | guards against a silent threshold bump |

All nine existing cases in the block keep passing without modification — their payloads (`"test text"`, `"insecure origin"`) are well above the threshold, and the execCommand-fallback case still exercises the write path.

Gate: `just test-frontend` (full Vitest, ~1 min — per project memory, touched-files-only runs have missed cross-file breakage) plus `cd app/frontend && npx tsc --noEmit`. No Playwright coverage is added: the trigger is a sub-cell pointer jitter that produces a tmux drag, which is not deterministically reproducible through Playwright's mouse API against a real tmux, and the sink is a pure function fully covered at the unit layer.

### 3. Memory hydrate (`docs/memory/run-kit/ui/terminal.md`)

- **§ Terminal Addons table, `@xterm/addon-clipboard` row** (currently: "Custom `ClipboardProvider` accepts both `""` (empty/default, tmux's format) and `"c"` (explicit) selection targets. Rejects `"p"`, `"s"`, `"0"`–`"7"`. Provider exported as `clipboardProvider` for testability"): append the min-length rule — `writeText` drops payloads whose trimmed length is below `OSC52_MIN_COPY_LENGTH` (2) and writes the rest verbatim (untrimmed), because tmux's default `MouseDragEnd1Pane → copy-pipe-and-cancel` + `set-clipboard on` turns a one-cell focus-click jitter into a 1-char / 1-space OSC 52 copy; the Cmd/Ctrl+C local-selection copy is unfiltered.
- **§ Design Decisions**: add one entry in the four-field shape (**Decision** / **Why** / **Rejected** / *Introduced by*), e.g. heading "OSC 52 junk is filtered at the sink by trimmed length, not at tmux or the pointer" — Decision: the ≥2 trimmed-length gate in `clipboardProvider.writeText`, payload written untrimmed; Why: the one-cell jitter drag copies exactly one character or one space, so trimmed length < 2 is the complete junk class, and 2 is the floor because two-character tokens are legitimate copies; Rejected: the four alternatives below with their reasons; *Introduced by*: 260915-5a7i-osc52-clipboard-min-length.
- `docs/memory/run-kit/ui/dialogs-and-state.md` § Clipboard Utility documents `copyToClipboard` and its caller list ("terminal copy, Pane panel row copy, status-bar copy segments, the `Copy:` palette entries") — **unaffected**: `copyToClipboard`'s contract and callers do not change. Checked and deliberately not listed under Affected Memory.
- No spec is affected (`docs/specs/` has no OSC 52 / terminal-clipboard coverage; the only clipboard mentions are code-bridge's Copy Reference and `rk gui clip`).

### Scope boundaries

- **Only the OSC 52 `writeText` path changes.** The Cmd/Ctrl+C handler on a local xterm selection (`term.attachCustomKeyEventHandler` in `terminal-client.tsx`, ~line 513: `if (term.hasSelection()) { copyToClipboard(term.getSelection()) … }`) is untouched — an explicit copy of a single character via shift-select + Cmd/Ctrl+C still works, and is the documented escape hatch for a deliberate one-character copy.
- **`copyToClipboard` itself is untouched.** Other callers (palette version entry, sidebar/top-bar version copy, settings-panel config-path copy, gui-surface WM hint, `useCopyFeedback` register surfaces, `SurfaceLayout` export copy-visible) keep their unfiltered behavior.
- **No tmux.conf change.** tmux's own paste buffer still receives the 1-char junk; nothing in rk pastes from it — accepted.
- **Known, accepted consequence**: a deliberate single-character copy made *through tmux* (copy-mode `v` + `y` over one cell) is also dropped, since the sink cannot distinguish it from jitter. The Cmd/Ctrl+C path covers that case.

### Rejected alternatives (record for hydrate)

| Alternative | Why rejected |
|-------------|--------------|
| (a) tmux-side: rebind `MouseDragEnd1Pane` to `copy-pipe-and-cancel` into a filter script that calls `load-buffer -w` only for payloads ≥ 2 | Same semantics but more moving parts — a script or hidden `rk` verb, a managed-conf hash bump (forced reload on every host), and a process spawned per selection. |
| (b) Frontend pixel drag threshold: a capture-phase `mousemove` suppressor on the terminal container | Root-cause-shaped, but xterm attaches its drag reporter to `document` in the bubble phase, so suppression shifts the selection anchor by up to one cell, and jitters over ~5 px still get through. |
| (c) A threshold higher than 2 | Blocks legitimate two-character copies (`rk`, `-v`, `..`). |
| (d) Rebinding tmux `DoubleClick1Pane` (double-click-to-focus copies the word under the cursor) | A separate decision; explicitly out of scope. Possible follow-up. |

## Affected Memory

- `run-kit/ui/terminal`: (modify) § Terminal Addons `@xterm/addon-clipboard` row gains the `OSC52_MIN_COPY_LENGTH` (2) trimmed-length gate + its why; § Design Decisions gains the four-field entry "OSC 52 junk is filtered at the sink by trimmed length, not at tmux or the pointer" with the rejected alternatives (a)–(d).

## Impact

- **Code**: `app/frontend/src/components/terminal-client.tsx` — one exported constant + one guard line in `clipboardProvider.writeText` + comment. No other source file changes.
- **Tests**: `app/frontend/src/components/terminal-client.test.ts` — new cases inside the existing `describe("clipboardProvider")` block; all existing cases unchanged.
- **Memory**: `docs/memory/run-kit/ui/terminal.md` (row + Design Decision). `docs/memory/run-kit/ui/dialogs-and-state.md` verified unaffected.
- **Not touched**: `app/frontend/src/lib/clipboard.ts`, `configs/tmux/default.conf` (no managed-conf hash bump), the Cmd/Ctrl+C key handler, any other `copyToClipboard` caller, backend, specs, e2e specs.
- **Runtime**: pure frontend; no API, no tmux option, no settings key, no keyboard/palette registration (no new user action — Constitution V is not engaged).
- **Verification gates**: `just test-frontend`; `cd app/frontend && npx tsc --noEmit`.

## Open Questions

- None. The follow-up candidate (rebinding tmux `DoubleClick1Pane` so double-click-to-focus stops copying the word under the cursor) is recorded as out of scope, not as a question for this change.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Filter lives in `clipboardProvider.writeText` (terminal-client.tsx), the single OSC 52 → system clipboard sink | User approved this exact location; verified as the only sink | S:95 R:85 A:95 D:95 |
| 2 | Certain | Threshold is trimmed length ≥ 2; passing payloads are written verbatim, untrimmed | User approved the exact semantics; 2 is the floor because two-character tokens are legitimate copies | S:95 R:80 A:90 D:95 |
| 3 | Certain | Named exported constant `OSC52_MIN_COPY_LENGTH = 2` in terminal-client.tsx beside the provider, with a constraint-stating comment | User asked for a named constant with the constraint comment; export mirrors `clipboardProvider`'s export-for-testability pattern | S:80 R:95 A:90 D:80 |
| 4 | Certain | New tests go in `terminal-client.test.ts` (existing `describe("clipboardProvider")`, `mockClipboard()` helper), not `terminal-client.test.tsx` | The dispatch description named the `.tsx` file, but the provider's tests already live in the `.ts` sibling; colocating with the existing block follows the codebase | S:80 R:95 A:95 D:90 |
| 5 | Certain | Cmd/Ctrl+C local-selection handler and `copyToClipboard` (all other callers) are untouched | Explicit scope boundary from the user; the Cmd+C path is the documented escape hatch for deliberate one-char copies | S:95 R:90 A:95 D:95 |
| 6 | Certain | No tmux.conf change; tmux's paste buffer still receives the junk | Explicit user scope boundary; nothing in rk pastes from the tmux buffer | S:95 R:85 A:90 D:95 |
| 7 | Certain | Memory hydrate targets `ui/terminal.md` (addon row + Design Decision) only; `ui/dialogs-and-state.md` § Clipboard Utility is unaffected | User named the target; `copyToClipboard`'s contract and caller list do not change | S:85 R:95 A:90 D:85 |
| 8 | Confident | Measurement uses `String.prototype.trim()` (Unicode whitespace + line terminators), so `"\n"`, `"\t"`, NBSP-only payloads are also dropped | User said "whitespace-trimmed length"; `trim()` is the idiomatic reading — alternatives (spaces-only strip, count of non-whitespace code points) differ only on exotic payloads | S:70 R:90 A:80 D:70 |
| 9 | Certain | Dropped payloads are silent — no toast, no console output | The junk is an unintended side effect of a focus-click; any feedback would itself be noise. Trivially reversible | S:55 R:95 A:85 D:80 |
| 10 | Confident | Unit coverage only (Vitest); no Playwright e2e for the jitter path | User specified vitest; the trigger is a sub-cell pointer jitter turning into a tmux drag, not deterministically reproducible via Playwright's mouse API, and the sink is a pure function. code-quality's "e2e where possible" is judged not possible here | S:70 R:90 A:75 D:70 |
| 11 | Confident | Accepted consequence: a deliberate one-character copy via tmux copy-mode (`v` + `y` on one cell) is also dropped | Inherent to filtering at the sink; the user's approval of threshold 2 plus the untouched Cmd/Ctrl+C escape hatch covers it | S:65 R:85 A:80 D:75 |
| 12 | Certain | Change type stays `feat` | Dispatcher instruction: pin `feat` if `fab status refresh` re-infers `fix`/`docs`/`refactor` from the wording | S:85 R:95 A:90 D:80 |

12 assumptions (9 certain, 3 confident, 0 tentative, 0 unresolved).
