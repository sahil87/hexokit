# Plan: Native Web Tile First Paint

**Change**: 260925-hcne-native-web-first-paint
**Intake**: `intake.md`

## Requirements

#### R1: No bounds/visibility send before the guest exists
`WebFrameNative` SHALL NOT call `setShellWebViewBounds` or `setShellWebViewVisible` before `createShellWebView` resolves `true`.

#### R2: Post-create first paint
Once the create resolves, the engine SHALL send the current rect and then the current visibility rule. Bounds SHALL precede the show.

- **GIVEN** a native web tile whose create is slow (the remote-native tunnel probe)
- **WHEN** the create resolves
- **THEN** the guest receives its real bounds and becomes visible with no window resize
- **AND** a rect change during the pending create is the rect sent

#### R3: Failure and unmount send nothing
A failed or cancelled create SHALL send no bounds or visibility.

## Tasks

- [x] T001 `web-frame-native.tsx`: `createdRef` gate in `measure()` and the visibility effect; a `wantVisibleRef` mirror; a post-create bounds + visibility send; reset on cleanup <!-- R1, R2, R3 -->
- [x] T002 `web-frame-native.test.tsx`: a "first paint (create race)" suite (held create → nothing sent → bounds then visible; latest rect wins; inactive tab; failed create); existing bounds/visibility/posture/tileError tests await the create <!-- R1, R2, R3 -->

## Acceptance

- [x] A-001 R1: no bounds/visible calls while the create is pending
- [x] A-002 R2: after the create resolves, bounds are sent before visible(true); the latest rect wins
- [x] A-003 R3: a failed create sends neither
- [x] A-004 The regression tests fail against the pre-fix code (3 of 4; the inactive-tab case is behavioral)
- [x] A-005 Typecheck clean; full frontend suite green; user-verified in the desktop app
