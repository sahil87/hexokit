# Plan: Cycle hosts with ⌥⌘←/⌥⌘→ (Alt+PageUp/PageDown on Windows/Linux)

**Change**: 261124-itlc-host-cycle-accelerators
**Intake**: `intake.md`

## Requirements

### Desktop: Cycle model

#### R1: Pure wrap-around helper
The desktop shell MUST provide an electron-free `adjacentHostId(hostIds, currentId, direction)` in `app/desktop/src/host-cycle.ts` that returns the next (`1`) or previous (`-1`) host id in list order, wrapping at both ends, and `null` when fewer than 2 hosts exist. A `currentId` that is `null` or absent from the list MUST start from "before the first" (next → first, previous → last).

- **GIVEN** hosts `[a,b,c]` and current `c`
- **WHEN** direction is `1`
- **THEN** the result is `a`
- **AND** current `a`, direction `-1` yields `c`
- **AND** `[a]` or `[]` yields `null`

#### R2: Per-platform menu-item model
`host-cycle.ts` MUST export `hostCycleMenuItems(isMac, hostCount)` returning `[]` below 2 hosts, else "Previous Host" then "Next Host" with accelerators `Alt+Cmd+Left`/`Alt+Cmd+Right` on mac and `Alt+PageUp`/`Alt+PageDown` otherwise.

- **GIVEN** `hostCount >= 2`
- **WHEN** the model is built for mac or win/linux
- **THEN** the accelerator strings are the ones above, Previous before Next

### Desktop: Hosts menu and main

#### R3: Hosts-menu items
`menu.ts` `hostsMenu` MUST render the model's items after the switcher radios, preceded by a separator, and omit the group and its separator entirely below 2 hosts. Each click MUST call `MenuCallbacks.onCycleHost(direction)`. Radios, `MAX_SWITCHER_ACCELERATORS`, Add/Remove and every other menu MUST be unchanged.

- **GIVEN** 2+ hosts
- **WHEN** the Hosts menu builds
- **THEN** it shows radios, separator, Previous Host, Next Host, separator, Add Host…, Remove items
- **AND** with 0–1 hosts the layout is identical to before

#### R4: Accelerator-policy comment
The `menu.ts` header policy comment MUST be updated to list host cycling in the shell-tier claims, the mac bound list, and the win/linux exhaustive bound list, and to record why win/linux uses Alt+PageUp/PageDown rather than Alt+←/→ or Ctrl+Alt.

#### R5: Click-time resolution through the one switch seam
`main.ts` `rebuildMenu` MUST supply `onCycleHost`, which resolves the target at click time from the focused window's attached host (`activeHostForWindow`) and the current host list via `adjacentHostId`, and switches through `switchToHost(win, id)` so the popout refusal, `strip:attached` slide signal, `trackActiveId` and `rebuildMenu` apply unchanged.

- **GIVEN** a focused non-popout window on host `b` of `[a,b,c]`
- **WHEN** the Next Host accelerator fires
- **THEN** the window switches to `c` and the strip's light slides from `b` to `c`
- **AND** on a focused popout the chord does nothing

### Frontend: Palette, hints, shortcuts, claims

#### R6: Palette entries (Constitution V)
`lib/palette/shell.ts` MUST export `buildShellHostCycleActions(servers, platform, onCycle)` returning `[]` below 2 servers, else ids `shell-host-prev` / `shell-host-next` labelled `Host: Previous` / `Host: Next` with literal shortcut hints (`⌥⌘←`/`⌥⌘→` on mac, `Alt+PgUp`/`Alt+PgDn` otherwise). `use-global-palette-actions.ts` MUST include them beside `hostMenuActions`; selecting one MUST fetch a fresh `listShellServers()`, compute the target with a pure `adjacentShellServer(servers, direction)` (in `lib/shell-strip.ts`, same wrap semantics, current = `isSelfHost`), call `switchShellServer`, and toast `"Host switch failed"` on failure.

- **GIVEN** 3 shell servers
- **WHEN** the palette opens in the shell
- **THEN** `Host: Previous` and `Host: Next` appear with chord hints
- **AND** with fewer than 2 servers, or in a plain browser, neither appears

#### R7: Pill tip
`keyHintTip` MUST name the cycle chords: mac `⌥⌘1–9 switches host · ⌥⌘←/→ cycles · ⇧⌘H focuses the squares`; other `Alt+1–9 switches host · Alt+PgUp/PgDn cycles · ⇧Ctrl+H focuses the squares`.

#### R8: Settings → Shortcuts rows
`settings-shortcuts-panel.tsx` shell rows MUST gain locked "Previous host" and "Next host" rows after "Switch to host 1–9", with caps `⌥ ⌘ ←` / `⌥ ⌘ →` on mac and `Alt PgUp` / `Alt PgDn` elsewhere.

#### R9: Keybinding claims and docs
`lib/keybindings.ts` doc comments MUST mention host cycling, and `claimedKeys` MUST add shell-only mac `optcmd` claims for `ArrowLeft` / `ArrowRight` so a rebind capture onto ⌥⌘←/→ warns. Win/linux needs no claim rows (Alt is uncapturable there).

### Evidence

#### R10: Shell demo
A shell-lane demo spec under `app/desktop/tests/demo/` MUST register ≥3 hosts and cycle forward through the wrap with Alt+PageDown and back with Alt+PageUp, using a path that exercises the real native accelerator (X-level key injection if CDP-dispatched keys do not trigger Electron menu accelerators).

### Design Decisions

#### Host cycling is Alt+PageUp/PageDown on win/linux, not Alt+←/→
**Decision**: win/linux cycle chords are Alt+PageUp / Alt+PageDown; mac is ⌥⌘←/→.
**Why**: A menu accelerator steals the key from every page and terminal; Alt+PageUp/PageDown is unused by shells and stays in the Alt+1–9 family.
**Rejected**: Alt+←/→ (shell word-jump and the focused-square reorder chord); Ctrl+Alt+… (AltGr on European layouts); mac-only.
*Introduced by*: 261124-itlc-host-cycle-accelerators

#### Wrap math is duplicated across the main/renderer boundary
**Decision**: `adjacentHostId` (desktop) and `adjacentShellServer` (SPA) are separate ~10-line copies; the palette resolves its target SPA-side from a fresh list, with no new IPC channel.
**Why**: Electron main cannot import the SPA bundle; SPA and shell ship separately so a new bridge channel would add version skew; a mount-time `useShellServers` snapshot goes stale after square reorders.
**Rejected**: a new `servers:cycle` IPC (skew); using the cached snapshot (wrong neighbour after reorder).
*Introduced by*: 261124-itlc-host-cycle-accelerators

## Tasks

### Phase 1: Desktop core

- [x] T001 Add `app/desktop/src/host-cycle.ts` (`adjacentHostId`, `hostCycleMenuItems`, types) <!-- R1 R2 -->
- [x] T002 [P] Add `app/desktop/src/host-cycle.test.ts` node:test covering the intake case table and per-platform accelerators <!-- R1 R2 -->

### Phase 2: Desktop wiring

- [x] T003 `app/desktop/src/menu.ts`: render cycle items in `hostsMenu`, add `MenuCallbacks.onCycleHost`, update header policy comment <!-- R3 R4 -->
- [x] T004 `app/desktop/src/main.ts`: add `onCycleHost` callback in `rebuildMenu` using `adjacentHostId` + `switchToHost` <!-- R5 -->

### Phase 3: Frontend

- [x] T005 [P] `app/frontend/src/lib/shell-strip.ts`: add `adjacentShellServer`, update `keyHintTip`; extend `shell-strip.test.ts` <!-- R6 R7 -->
- [x] T006 [P] `app/frontend/src/lib/palette/shell.ts`: add `buildShellHostCycleActions`; extend `shell.test.ts` <!-- R6 -->
- [x] T007 `app/frontend/src/hooks/use-global-palette-actions.ts`: wire the cycle actions beside `hostMenuActions` with fresh-list select-time resolution and failure toast <!-- R6 -->
- [x] T008 [P] `app/frontend/src/components/settings-shortcuts-panel.tsx`: add Previous/Next host rows; extend its test <!-- R8 -->
- [x] T009 [P] `app/frontend/src/lib/keybindings.ts`: update comments, add mac-shell `optcmd` claims; extend test <!-- R9 -->

### Phase 4: Evidence and verification

- [x] T010 Add `app/desktop/tests/demo/host-cycle-accelerators.demo.ts` (shell lane) with Test Intent Comments <!-- R10 -->
- [x] T011 Run `just check`, `just test-frontend`, desktop node:test, and a desktop e2e/demo smoke; fix failures <!-- R1 R2 R3 R5 R6 R7 R8 R9 R10 -->

## Execution Order

- T003 depends on T001; T004 depends on T001 and T003
- T007 depends on T005 and T006
- T010/T011 run last

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `adjacentHostId` wraps and returns null as specified, node:test green
- [ ] A-002 R2: `hostCycleMenuItems` yields the exact per-platform accelerator strings and `[]` below 2 hosts
- [ ] A-003 R3: Hosts menu shows Previous/Next Host after the radios with separators only at ≥2 hosts; `onCycleHost` is invoked with the direction
- [ ] A-004 R4: menu.ts header lists host cycling in all three places and records the Alt+PageUp/PageDown rationale
- [ ] A-005 R5: main.ts `onCycleHost` resolves at click time and goes through `switchToHost`
- [ ] A-006 R6: palette `Host: Previous` / `Host: Next` appear only at ≥2 servers with literal hints and select-time fresh-list resolution
- [ ] A-007 R7: `keyHintTip` copy matches the spec on both platforms
- [ ] A-008 R8: Settings → Shortcuts shows the two new locked rows with correct caps on both displays
- [ ] A-009 R9: keybindings docs updated and mac-shell ⌥⌘←/→ claims present; none for win/linux
- [ ] A-010 R10: demo spec cycles through the wrap with a real chord

### Behavioral Correctness

- [ ] A-011 R5: a focused popout window ignores the chord via `switchToHost`'s refusal

### Scenario Coverage

- [ ] A-012 R1: unknown/null current id yields first (next) / last (previous)
- [ ] A-013 R6: `adjacentShellServer` uses `isSelfHost` with the same wrap semantics

### Edge Cases & Error Handling

- [ ] A-014 R6: a failed `switchShellServer` toasts "Host switch failed"; a null list from `listShellServers` is a no-op
- [ ] A-015 R3: 0/1-host Hosts menu layout is unchanged

### Removal Verification

- [ ] A-016: nothing deprecated; ⌥⌘1–9 / Alt+1–9 radios, reorder chord and browser behaviour are unchanged

### Code Quality

- [ ] A-017 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [ ] A-018 No unnecessary duplication: Existing utilities reused (`isSelfHost`, `switchToHost`, `activeHostForWindow`); only the intended wrap-math duplication
- [ ] A-019 Anti-patterns: no comment narration, no magic strings, tests colocated, Playwright `test()` carries Proves/Steps comments

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Chords, wrap order, native Hosts-menu mechanism and discoverability surfaces are as in the intake | Intake is authoritative; decided in discussion | S:95 R:80 A:95 D:95 |
| 2 | Confident | `host-cycle.ts` holds both the wrap helper and the menu-item model | Intake assumption 9; follows `daemonMenuModel` precedent | S:70 R:85 A:80 D:70 |
| 3 | Confident | Demo injects the real chord via xdotool only if Playwright key presses do not reach Electron menu accelerators under Xvfb; otherwise Playwright keyboard is used; limitation documented in the spec header | Intake open question; must be determined empirically at apply | S:45 R:80 A:50 D:55 |
| 4 | Confident | Palette `platform` argument comes from `bindingHost.platform` already in the hook | Existing hook already reads it for `withShortcutHints` | S:60 R:90 A:80 D:70 |
| 6 | Certain | Playwright `keyboard.press` (CDP) does NOT trigger Electron native menu accelerators under Xvfb; a real X key event does. The demo and a new e2e spec (`tests/e2e/host-cycle.spec.ts`) inject the chord via `pressXChord` (`_shell.ts`) → `_xkey.py` (XTest through libX11/libXtst by ctypes, no xdotool) | Verified empirically at apply: the CDP-press cycle test failed to switch; the X-injected one passed. xdotool is not installed on the rig, libXtst is | S:90 R:80 A:90 D:85 |
| 7 | Confident | Third demo/e2e host is `c.localhost` (Chromium resolves `*.localhost` to loopback) so three hosts share the rig's one port | Needs no host-map preload; verified working in both specs | S:70 R:90 A:80 D:75 |
| 5 | Confident | Win/linux compact spelling `Alt+PgUp`/`Alt+PgDn` in palette hints, pill tip and caps | Intake open question chose compact keycap spelling | S:65 R:95 A:75 D:65 |

7 assumptions (2 certain, 5 confident, 0 tentative).
