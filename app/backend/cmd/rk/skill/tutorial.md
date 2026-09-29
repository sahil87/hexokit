# HexoKit skill: tutorial

An agent-run, live first-use tour of HexoKit: five chapters in about ten minutes. This is a static topic page (`rk skill tutorial`); the [core bundle](../skill.md) is the general usage briefing.

**Who it serves**: a first-time HexoKit user — assume a product manager, not a terminal native. They care about outcomes: delegating work, knowing when an agent needs them, seeing results, running several at once. Teach through **their** actions, never command narration. Don't explain internals (tmux, options, state models) unless asked — answer briefly, return to the tour.

Gate first:

```sh
command -v rk >/dev/null 2>&1 && [ -n "$TMUX_PANE" ]
```

If either check fails, STOP: tell the user to open the HexoKit dashboard, create a session/window for this directory, run the agent inside it, then ask again.

## Pacing and failure posture

- One chapter per reply. End with: *Say **next** when ready, or ask me anything.* Answer questions, then re-offer.
- `skip` advances one chapter; `stop` or `done` jumps to Cleanup.
- 1–3 sentences per beat, then the user acts, then one line on where to look. **The user does something in every chapter** — a beat with no user action gets cut.
- Degrade, never error: a missing piece (no operator, no push permission) gets one line on what it would show, then continue.
- Shell-side changes repaint on the server poll: allow ~10s ("give it a few seconds", first time only).

## Preflight — run silently, then end the turn

1. Read and skim `rk skill`; read `rk skill display` before Chapter 2 and `rk skill mux` before Chapter 3.
2. If `/tmp/rk-tutorial/original-state.json` exists, a prior run is stale: perform Cleanup against those captures first.
3. Capture, then detect the operator:

   ```sh
   mkdir -p /tmp/rk-tutorial
   rk tab show --json > /tmp/rk-tutorial/original-state.json   # envelope — the tab data sits under .result
   rk tab web ls --json > /tmp/rk-tutorial/original-webtabs.json 2>/dev/null || true
   RK="$(rk url)"
   tmux list-windows -a -f '#{||:#{==:#{@rk_win_role},operator},#{==:#{window_name},operator}}' -F '#{window_id} #{window_name}' || true
   ```

**Greeting** (the whole first turn — no mechanics): HexoKit is **mission control for AI agents** — start, watch, and unblock them from any browser, phone included; one operator agent can drive all of it. Promise: *delegate, get interrupted only when needed, run two at once, get pinged when done — in ~10 minutes.* **next / skip / stop**; plain language; nothing can break. One ask: **enable notifications now** (the top-bar bell) — how agents reach you in Chapter 4. End the turn.

## Chapter 1 — You have an agent (`#ch1`)

```sh
rk present "$RK/tutorial/tutorial.html#ch1"
```

Every sidebar row is an agent (or plain terminal); the dot is its state. **Have the user ask you something** ("try: what's in this project?") and watch this row — busy, then idle. A yellow **waiting halo** = an agent needs a human (the session row adds a ⚠ count) — the whole game; Chapter 4 triggers it for real. Sessions group by project; this row is me.

## Chapter 2 — Make it show you things (`#ch2`)

```sh
rk present "$RK/tutorial/tutorial.html#ch2"
```

Teach the phrase: end any request with **"…and present it to me"** — results arrive as live pages beside the terminal. Offer picks: *project brief · tour cheat sheet · mock KPI dashboard* — they ask in their own words, phrase included. Build it small, dark, self-contained; `rk present /tmp/rk-tutorial/<name>.html`; point at the new tab. Invite one tweak — edit, re-present: **asking again is the refresh**. Also: any URL or dev server (`:port`). Tile hidden? `rk tab layout 'h(tty,web)'` restores it.

## Chapter 3 — Hire a second agent (`#ch3`)

```sh
rk present "$RK/tutorial/tutorial.html#ch3"
```

HexoKit is agents in **parallel**, and the operator hires — from anywhere: **⌘J** (⇧Ctrl+J) drops the quake terminal under the top bar; type into the quake launcher ("Ask…"), Enter sends, the reply streams in the drawer; ⌘J or Esc tucks it away. Everything can start from that launcher.

- **Console path (preferred)**: operator found in Preflight → the **user** presses ⌘J and types: *"Start an agent in a new window — call it tour-worker — that builds a one-page brief of this project; have it ask me ONE question first, then present the result and notify me."*
- **No operator**: run `rk operator` — it opens the pinned singleton and boots the operator agent; hire via ⌘J as above — or press **Start operator** in the quake terminal (⌘J) / the `Operator: Start operator` palette entry. If fab is missing it fails — one line, then hire directly: `rk tab new --name tour-worker`, start the same agent CLI, deliver the same brief (one question — "exec or engineer?" — then present + notify).

While it boots: **two rows busy at once** — have them find both. That's the product.

## Chapter 4 — It needs you (`#ch4`)

```sh
rk present "$RK/tutorial/tutorial.html#ch4"
```

Wait for the worker's question (`rk mux await` / `rk mux capture`; don't narrate mechanics). When it lands: the **waiting halo** on its dot, a **⚠ badge** on its session row, and — if enabled — a **push on their device**. For real: *click its row, read the question, answer right there, come back.* It finishes alone, presents, notifies — **delegate → interrupted only when needed → unblock → receive**. Degrade: no push → badge and halo carry it; never asks → nudge from its pane; died → show last output, move on.

## Chapter 5 — Everywhere, and what's next (`#ch5`)

```sh
rk present "$RK/tutorial/tutorial.html#ch5"
```

Three closers, user-driven. **Phone**: same address, any device — offer `rk notify "open me on your phone" --title HexoKit` (fail-silent if unsubscribed); the pull-tab **tongue** under the top bar jumps to the operator. **Habit pair**: **⌘J to ask, ⌘K to find** (⇧Ctrl+J / ⇧Ctrl+K) — have them try ⌘K: `color`, then `settings`; every action lives there. **Challenge**: start one real agent on something they actually want — ⌘J the operator ("Start a claude session on <repo>") — phrase included. Engineers: `rk skill` (+ `display`, `mux`, `code`).

## Cleanup and recap

Ask first: keep or remove the worker window and its brief (their first artifact — default keep). Restore this tab: both captures and the live reads are envelopes, so compare `rk tab web ls --json`'s `.result` with the web-tab capture's `.result` and remove tabs absent from it, highest index first; restore every `@rk_win_*` key from the original-state capture's `.result` with `tmux set-option -w <key> <value>`; unset (`tmux set-option -wu <key>`) current keys absent from it; verify with `rk tab show --json` (again reading `.result`); then `rm -rf /tmp/rk-tutorial`.

Recap in their words: **rows are agents; the halo means "needs you"; "present it to me" gets pages; ⌘J asks the operator; ⌘K finds everything; your phone works too.** Invite the solo experiment and end.
