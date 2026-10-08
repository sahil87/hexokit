# Intake: Native Web Tile First Paint

**Change**: 260925-hcne-native-web-first-paint
**Created**: 2026-09-25

## Origin

> When I open RK present with the URL, it doesn't work. It keeps loading until I resize the window, then the page starts loading. And if I change the window, it happens again and I have to resize again.

This bug report came from the user testing the desktop app's native web tile in remote-native / tunnel mode (#1033, #1037, #1040). The orchestrating session found the root cause by reading the code, and the user verified the fix on a dev server built from this branch.

## Why

`WebFrameNative` sends the guest's bounds from `measure()` in a layout effect, and its visibility from an effect, both at mount. The guest does not exist yet at that point. The mount effect creates it only after `shellWebMode()` (which awaits `ensureHostProxy`, including a tunnel probe in remote-native mode) and `createShellWebView()` resolve. Main's `web:bounds` / `web:visible` handlers answer "Unknown tab" before the create lands, so both sends are dropped.

The dedupe refs (`lastSentBoundsRef`, `lastSentVisibleRef`) still record them as sent, so neither is ever re-sent. The guest sits at main's registry default of 0×0 bounds and keeps "loading" until something changes the rect: a window resize. Every window switch remounts the tile with a fresh `tabKey`, so the race repeats.

## What Changes

- `createdRef` gates `measure()`'s bounds send and the visibility effect until the create resolves. Before that they only track state (`rectNonZero`, and a `wantVisibleRef` mirror of the rule).
- The post-create block, beside the existing chord-table / zoom sends, clears the bounds dedupe and re-measures, then sends the current visibility. Bounds go first, so the guest never shows at 0×0. An adopted guest (retention) gets the same refresh.
- A failed or cancelled create sends nothing. The effect cleanup resets `createdRef`.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) native engine: bounds/visibility are held until the create resolves

## Impact

Frontend only: `app/frontend/src/components/web-frame-native.tsx` and its test. No desktop-main or IPC change; it works with every shell version.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix SPA-side (hold + post-create send) rather than making main buffer pre-create calls | Works with every shipped shell; mirrors the existing post-create chords/zoom send | S:90 R:90 A:90 D:85 |
| 2 | Certain | Root cause is the pre-create "Unknown tab" drop plus dedupe | Verified in main.ts handlers and the registry's 0×0 default; resize symptom matches exactly | S:95 R:90 A:95 D:90 |
