package inject

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Boot-readiness defaults — the field-proven settle heuristic values: a
// freshly spawned agent TUI is typed into only once its screen has stopped
// animating (or its hooks have stamped state), bounded well under a minute.
const (
	defaultReadyDeadline     = 25 * time.Second
	defaultReadyPollInterval = 600 * time.Millisecond
	// readyCaptureLines is the tail depth captured for the settle comparison —
	// enough to cover a full-height terminal's visible screen.
	readyCaptureLines = 50
	// readySnippetMaxRunes caps the last-capture fragment carried by ErrNotReady
	// and ParkedError.
	readySnippetMaxRunes = 120
	// readySentinel is the fixed probe text pasted into a settled pane to
	// classify it. The `#` prefix makes even a worst-case accidental submit
	// into a cooked-mode shell a no-op comment; novelty counting (a strict
	// occurrence-count increase over the pre-probe baseline) provides collision
	// soundness, so the text stays fixed rather than random.
	readySentinel = "#rk-ready-probe"
	// defaultReadyBuffer is the fallback named buffer for the sentinel paste
	// when ReadyOpts.BufferName is unset. Callers pass a per-invocation name so
	// a probe can never clobber a concurrent send buffer.
	defaultReadyBuffer = "rk-ready"
	// loginWallSignature is Claude Code's unauthenticated-boot notice, drawn
	// right-aligned on the line above its composer. The composer still echoes
	// and hooks may still fire behind it, so neither ready signal sees the wall.
	// It is drawn asynchronously — observed 2-20 s after boot, after the hooks
	// stamp state — so a verdict reached before it paints cannot see it.
	loginWallSignature = "Not logged in · Run /login"
)

// The readiness floor: the conventional minimum geometry agent TUIs assume.
// Below either dimension, a bordered composer reflows or is not drawn at all,
// so the sentinel echo probe cannot be trusted — the pane is classified narrow
// instead of probed. Fixed constants, never a setting: the value has no
// per-instance reason to vary.
const (
	ReadyMinCols = 80
	ReadyMinRows = 20
)

// belowReadyFloor is the pure floor decision: either dimension below its floor
// makes the pane narrow.
func belowReadyFloor(width, height int) bool {
	return width < ReadyMinCols || height < ReadyMinRows
}

// ErrNotReady is the sentinel AwaitReady returns when neither readiness signal
// fires before the deadline. The wrapped message carries the last capture's
// trailing snippet so the caller can show what the pane looked like.
var ErrNotReady = errors.New("pane not boot-ready")

// ErrParked is the sentinel ParkedError wraps: the pane settled on a screen
// that does not echo typed input — a trust dialog, survey, theme picker, or
// login wall — or shows Claude Code's login-wall notice, whose composer does
// echo but whose agent cannot act on a delivery. It is an error (not a
// Readiness) so every consumer fails closed: no delivery is ever attempted
// into a wall.
var ErrParked = errors.New("pane parked behind a wall")

// ErrGone is the sentinel AwaitReady returns when a capture error satisfies
// the injected ReadyOpts.IsGone predicate — the target pane died mid-wait.
var ErrGone = errors.New("pane gone")

// ErrNarrow is the sentinel NarrowError wraps: the pane is below the readiness
// floor (ReadyMinCols x ReadyMinRows), so the sentinel probe cannot be trusted
// and delivery must not proceed. An error (not a Readiness) so every consumer
// fails closed — no delivery into a pane whose composer may not exist.
var ErrNarrow = errors.New("pane below readiness floor")

// ParkedError carries the settled screen's trailing snippet (bounded by
// readySnippetMaxRunes) so the caller can judge what the wall wants. rk
// classifies mechanically; judgment stays caller-side.
type ParkedError struct {
	Snippet string
}

func (e *ParkedError) Error() string {
	return fmt.Sprintf("%s: screen: %q", ErrParked, e.Snippet)
}

func (e *ParkedError) Unwrap() error { return ErrParked }

// NarrowError carries the observed geometry so the caller can report and act
// (resize or relocate the pane); rk classifies mechanically, never resizes.
type NarrowError struct {
	Width  int
	Height int
}

func (e *NarrowError) Error() string {
	return fmt.Sprintf("%s: %dx%d (floor %dx%d)", ErrNarrow, e.Width, e.Height, ReadyMinCols, ReadyMinRows)
}

func (e *NarrowError) Unwrap() error { return ErrNarrow }

// Readiness reports which signal judged a pane boot-ready.
type Readiness int

const (
	// ReadyByState — the injected state reader returned a state (the pane's
	// hooks fired, so the TUI is up).
	ReadyByState Readiness = iota + 1
	// ReadyByEcho — the sentinel echo probe pasted readySentinel into the
	// settled pane and saw it newly echo into the live input box (the
	// classification path for hook-less agents).
	ReadyByEcho
)

// ReadyOpts parameterize AwaitReady. The zero value is usable: Deadline
// defaults to 25s and PollInterval to 600ms.
type ReadyOpts struct {
	// State, when non-nil, is the caller's reconciled agent-state reader
	// (e.g. tmux.PaneAgentState). It MUST return "" for an absent or unknown
	// state; any non-empty, error-free value counts as present. Errors and
	// empty values mean "not yet" — never fatal — so a hook-less pane falls
	// through to the settle-triggered sentinel probe. inject deliberately does
	// not import the tmux state layer; the reader is injected here.
	State func(ctx context.Context, paneID, server string) (string, error)
	// IsGone, when non-nil, classifies a capture error as pane death (e.g.
	// tmux's "can't find pane"); a matching error ends the wait promptly with
	// ErrGone instead of being tolerated until the deadline. Injected so inject
	// stays tmux-error-string-agnostic, matching the State reader pattern.
	IsGone func(err error) bool
	// BufferName is the named tmux buffer the sentinel probe pastes through.
	// Empty = defaultReadyBuffer. Callers pass a per-invocation name so a probe
	// never clobbers a concurrent send's buffer.
	BufferName string
	// Deadline bounds the whole wait. Zero = defaultReadyDeadline.
	Deadline time.Duration
	// PollInterval paces the signal checks. Zero = defaultReadyPollInterval.
	PollInterval time.Duration
	// Sleep is the test seam for the inter-poll wait. Nil = time.Sleep.
	Sleep func(time.Duration)
	// WaitThroughWalls keeps polling after a parked classification instead of
	// returning ParkedError: the settle → probe cycle repeats until the pane
	// echoes (ready), goes away (ErrGone), or the Deadline expires. At expiry
	// the error is the LAST classification — ParkedError (with the final
	// screen's snippet) when the pane is still walled, ErrNotReady otherwise —
	// so a caller still learns why delivery never happened. Default false:
	// every existing consumer keeps the fail-fast classification.
	WaitThroughWalls bool
}

// AwaitReady blocks until the pane is boot-ready — safe to type into. State
// (opts.State, the preferred signal: hooks have fired, so the TUI finished
// booting) is checked first every poll, so the sentinel is only ever typed
// into a pane with no reconciled agent state. When no state appears and the
// capture settles (non-blank, byte-identical across two consecutive polls),
// the settle is the TRIGGER for a sentinel echo probe, gated on geometry:
// the pane's size is read once per settle, and below the readiness floor
// (ReadyMinCols x ReadyMinRows — a bordered composer reflows or is not drawn
// at all, so an echo miss carries no information) the wait returns NarrowError
// immediately instead of probing. At/above the floor: paste readySentinel
// through the named buffer, look for a novel echo (CountOccurrences strictly
// above the pre-probe baseline), then clear with C-u. An echo returns
// ReadyByEcho; no echo on a still-settled screen returns ParkedError (the pane
// sits behind a wall that would eat a delivery).
//
// Boot churn, blank screens, geometry read failures, and probe infrastructure
// errors never classify — they re-enter polling bounded only by the Deadline
// (ErrNotReady at expiry, carrying the last capture's trailing snippet). A
// capture or geometry error matching opts.IsGone returns ErrGone promptly. A
// sentinel whose C-u clear cannot restore the settled baseline within
// ClearAttempts fails closed with an operational error rather than reporting
// ready over a polluted composer. ctx cancellation returns ctx.Err().
//
// Every successful capture is checked for Claude Code's login-wall notice
// (hasLoginWall) before either ready verdict: a walled pane returns a
// ParkedError whose snippet is the notice, even when its hooks fired or its
// composer would echo. The capture therefore precedes the state verdict; a
// non-gone capture error with state present still returns ReadyByState.
//
// With opts.WaitThroughWalls a parked classification is not a verdict: the
// wait remembers the parked frame and keeps polling, re-probing only after
// the frame has changed and re-settled (a static wall is never re-pasted).
// Deadline expiry then reports the LAST classification — the most recent
// ParkedError when the pane still shows the parked frame, ErrNotReady
// otherwise.
func AwaitReady(ctx context.Context, t Tmux, server, paneID string, opts ReadyOpts) (Readiness, error) {
	deadline := opts.Deadline
	if deadline <= 0 {
		deadline = defaultReadyDeadline
	}
	poll := opts.PollInterval
	if poll <= 0 {
		poll = defaultReadyPollInterval
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	buffer := opts.BufferName
	if buffer == "" {
		buffer = defaultReadyBuffer
	}
	stop := time.Now().Add(deadline)

	prev := ""
	havePrev := false
	lastCapture := ""
	// WaitThroughWalls state: the last parked classification and the frame it
	// settled on. lastParked stays nil with the flag off, so the skip and the
	// deadline arms below can never fire on the default path.
	var lastParked *ParkedError
	parkedFrame := ""
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		stateReady := false
		if opts.State != nil {
			if state, err := opts.State(ctx, paneID, server); err == nil && state != "" {
				stateReady = true
			}
		}
		cur, capErr := t.CapturePane(ctx, paneID, readyCaptureLines, server)
		switch {
		case capErr == nil && hasLoginWall(cur):
			lastCapture = cur
			parked := &ParkedError{Snippet: loginWallSignature}
			if !opts.WaitThroughWalls {
				return 0, parked
			}
			// Recording the walled frame as the parked frame lets the
			// deadline arm report the wall while the pane still shows it.
			lastParked = parked
			parkedFrame = cur
			prev = cur
			havePrev = true
		case capErr == nil && stateReady:
			return ReadyByState, nil
		case capErr == nil:
			lastCapture = cur
			// A settle on the unchanged parked frame is the static wall: skip
			// the probe. The probe re-arms only once the frame has changed and
			// re-settled — the wall clearing changes the frame.
			if havePrev && cur == prev && strings.TrimSpace(cur) != "" && (lastParked == nil || cur != parkedFrame) {
				// The probe is only trustworthy at/above the readiness floor:
				// read the geometry once per settle, before any pane-touching
				// probe step. A read failure is "not yet" (re-enter polling;
				// an IsGone match ends the wait); below the floor the pane
				// classifies narrow instead of probing.
				w, h, sizeErr := t.PaneSize(ctx, paneID, server)
				switch {
				case sizeErr != nil && opts.IsGone != nil && opts.IsGone(sizeErr):
					return 0, fmt.Errorf("%w: %w", ErrGone, sizeErr)
				case sizeErr != nil:
					// Unknown geometry — skip this settle's probe.
				case belowReadyFloor(w, h):
					return 0, &NarrowError{Width: w, Height: h}
				default:
					probe, err := probeReadiness(ctx, t, server, paneID, buffer, cur, opts.IsGone)
					if err != nil {
						var parked *ParkedError
						if opts.WaitThroughWalls && errors.As(err, &parked) {
							// A wall is not a verdict here: record the parked
							// frame as the probe's skip key and re-enter
							// polling. Every probe has already cleaned up
							// after itself, so the wall saw nothing.
							lastParked = parked
							parkedFrame = cur
							break
						}
						return 0, err
					}
					if probe == probeEchoed {
						return ReadyByEcho, nil
					}
					// probeNotYet: churn or infrastructure failure — keep
					// polling; a later settle may probe again (each probe
					// cleans up after itself).
				}
			}
			prev = cur
			havePrev = true
		case opts.IsGone != nil && opts.IsGone(capErr):
			return 0, fmt.Errorf("%w: %w", ErrGone, capErr)
		case stateReady:
			return ReadyByState, nil
		}
		if !time.Now().Before(stop) {
			// WaitThroughWalls deadline: report the LAST classification — the
			// pane still on the parked frame is still walled, so the most
			// recent ParkedError (with its snippet) is the answer; a frame
			// that moved on gets plain ErrNotReady.
			if lastParked != nil && lastCapture == parkedFrame {
				return 0, lastParked
			}
			return 0, fmt.Errorf("%w after %s: last capture: %q", ErrNotReady, deadline, readySnippet(lastCapture))
		}
		sleep(poll)
	}
}

// DeliverWhenReady is the spawn-then-deliver composite: wait for boot
// readiness, then run the engine's verified send. It returns the Readiness on
// success and the first error otherwise (a readiness error — including the
// parked and narrow classifications, so delivery is never attempted into a
// wall or a too-small pane — returns the zero Readiness; a send error returns
// the readiness that fired).
func DeliverWhenReady(ctx context.Context, t Tmux, server, paneID, text string, submit bool, e *Engine, opts ReadyOpts) (Readiness, error) {
	readiness, err := AwaitReady(ctx, t, server, paneID, opts)
	if err != nil {
		return 0, err
	}
	if err := e.Send(ctx, t, server, paneID, text, submit); err != nil {
		return readiness, err
	}
	return readiness, nil
}

// probeVerdict is the sentinel echo probe's outcome.
type probeVerdict int

const (
	// probeNotYet — the probe could not classify (infrastructure failure, or
	// the frame changed under the probe without echoing): re-enter polling.
	probeNotYet probeVerdict = iota
	// probeEchoed — the sentinel newly echoed into the pane's live input box.
	probeEchoed
)

// probeReadiness runs the sentinel echo probe against a settled pane: clear
// any active pane mode first (the delivery-path guard — a scrolled copy-mode
// pane would eat the paste and read as parked; a repaint after the guard means
// the settled baseline is stale, so the probe re-enters polling), then paste
// readySentinel through the named buffer (bracketed paste — never submitted,
// no Enter anywhere on the path), then look for its NOVELTY (occurrence count
// strictly above the settled frame's baseline, so a stale same-text occurrence
// already on screen cannot satisfy the probe). Pacing reuses the engine's
// ProbeSettle/ProbeGap/ProbeAttempts constants. Every capture — settle, probe,
// and clear — uses the ONE readyCaptureLines depth: comparing frames captured
// at different depths can never hold on a pane with scrollback beyond the
// shallower window.
//
// Echo → C-u clear, verified against the settled baseline within ClearAttempts
// (a clear that cannot restore it fails closed with an operational error —
// never ready over a polluted composer). No echo → a best-effort C-u, then the
// frame decides: still the settled screen means parked (ParkedError with the
// snippet, returned immediately); a changed frame means boot resumed under the
// probe (probeNotYet). Once the paste has happened, every not-yet exit first
// attempts the C-u cleanup so a leftover sentinel cannot pollute the next
// probe's baseline. Capture/paste failures are probeNotYet, except a capture
// error matching isGone, which surfaces ErrGone.
func probeReadiness(ctx context.Context, t Tmux, server, paneID, buffer, settled string, isGone func(error) bool) (probeVerdict, error) {
	baseCount := CountOccurrences(settled, readySentinel, false, false)

	// Pane-mode guard (the engine's first pane-touching step, here too): a
	// copy-mode pane shows a static frame that settles like any other, then
	// eats the paste — without the guard that misclassifies a merely-scrolled
	// pane as parked. The guard cannot say whether it cancelled a mode, so the
	// frame is re-checked against the settled baseline: a repaint means the
	// baseline is stale — re-enter polling and let the pane re-settle on its
	// real screen. Guard failures are "not yet" like any other pre-paste
	// infrastructure failure.
	if err := t.ClearPaneMode(ctx, paneID, server); err != nil {
		if isGone != nil && isGone(err) {
			return probeNotYet, fmt.Errorf("%w: %w", ErrGone, err)
		}
		return probeNotYet, nil
	}
	afterGuard, err := t.CapturePane(ctx, paneID, readyCaptureLines, server)
	if err != nil {
		if isGone != nil && isGone(err) {
			return probeNotYet, fmt.Errorf("%w: %w", ErrGone, err)
		}
		return probeNotYet, nil
	}
	if stripForProbe(afterGuard) != stripForProbe(settled) {
		return probeNotYet, nil
	}

	if err := t.SetBuffer(ctx, buffer, readySentinel, server); err != nil {
		return probeNotYet, nil
	}
	if err := t.PasteBuffer(ctx, buffer, paneID, server); err != nil {
		return probeNotYet, nil
	}

	for attempt := 0; attempt < ProbeAttempts; attempt++ {
		d := ProbeGap
		if attempt == 0 {
			d = ProbeSettle
		}
		if err := sleepCtx(ctx, d); err != nil {
			return probeNotYet, err
		}
		capture, err := t.CapturePane(ctx, paneID, readyCaptureLines, server)
		if err != nil {
			if isGone != nil && isGone(err) {
				return probeNotYet, fmt.Errorf("%w: %w", ErrGone, err)
			}
			// The sentinel may be staged: best-effort cleanup before not-yet.
			_ = t.SendKeys(ctx, paneID, server, "C-u")
			return probeNotYet, nil
		}
		if CountOccurrences(capture, readySentinel, false, false) > baseCount {
			if _, err := clearToBaseline(ctx, t, server, paneID, readyCaptureLines, settled, isGone); err != nil {
				return probeNotYet, err
			}
			return probeEchoed, nil
		}
	}

	// No echo: clean up anything staged invisibly, then classify on the frame.
	if err := t.SendKeys(ctx, paneID, server, "C-u"); err != nil {
		return probeNotYet, nil
	}
	capture, err := t.CapturePane(ctx, paneID, readyCaptureLines, server)
	if err != nil {
		if isGone != nil && isGone(err) {
			return probeNotYet, fmt.Errorf("%w: %w", ErrGone, err)
		}
		return probeNotYet, nil
	}
	if stripForProbe(capture) == stripForProbe(settled) {
		return probeNotYet, &ParkedError{Snippet: readySnippet(settled)}
	}
	return probeNotYet, nil
}

// hasLoginWall reports Claude Code's login-wall notice: a capture line whose
// content ends with loginWallSignature and is preceded by nothing or by at
// least two spaces — the right-aligned notice slot. A transcript line that
// merely quotes the phrase inline does not match, so a healthy agent whose
// conversation mentions it is never refused delivery. ANSI escapes are
// stripped first: readiness captures carry them (capture-pane -e). Pure.
func hasLoginWall(capture string) bool {
	for _, line := range strings.Split(ansiEscapeRe.ReplaceAllString(capture, ""), "\n") {
		head, ok := strings.CutSuffix(strings.TrimRight(line, " \t\r"), loginWallSignature)
		if ok && (strings.TrimSpace(head) == "" || strings.HasSuffix(head, "  ")) {
			return true
		}
	}
	return false
}

// readySnippet extracts the trailing fragment of a capture for the ErrNotReady
// and ParkedError messages, rune-bounded. Pure.
func readySnippet(capture string) string {
	runes := []rune(strings.TrimSpace(capture))
	if len(runes) > readySnippetMaxRunes {
		runes = runes[len(runes)-readySnippetMaxRunes:]
	}
	return string(runes)
}
