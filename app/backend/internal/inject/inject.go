// Package inject is the shared pane-injection engine extracted out of the
// send HTTP handler (api/send.go) so BOTH the daemon route and the CLI
// verb (`rk mux send`) drive one implementation: sanitize (at the caller's
// boundary) → named-buffer set-buffer → bracketed paste-buffer (-d -p) →
// NOVELTY echo probe → probe-gated Enter → post-Enter observation and bounded
// recovery. All tmux access goes through the small Tmux interface so both
// consumers stay testable without a live tmux.
package inject

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Tmux is the tmux substrate the engine needs — context-bound primitives.
// The daemon adapts its TmuxOps seam onto this (buffer name fixed to
// AgentSendBuffer); the CLI adapts internal/tmux's name-parameterized buffer
// functions (per-invocation buffer names).
type Tmux interface {
	// ClearPaneMode is the pane-mode guard: the first pane-touching step of
	// every delivery sequence. The probe-vs-cancel decision lives in the
	// implementation's single decision site (tmux.ClearPaneModeCtx) — the
	// engine only places the call (inside the per-pane lock, before the
	// baseline capture, whose frame a mode cancel would repaint).
	ClearPaneMode(ctx context.Context, paneID, server string) error
	CapturePane(ctx context.Context, paneID string, lines int, server string) (string, error)
	SetBuffer(ctx context.Context, name, text, server string) error
	PasteBuffer(ctx context.Context, name, paneID, server string) error
	PasteBufferRaw(ctx context.Context, name, paneID, server string) error
	SendEnter(ctx context.Context, paneID, server string) error
	SendKeys(ctx context.Context, paneID, server string, keys ...string) error
	// PaneSize reports the pane's current width and height in cells. Only the
	// readiness path calls it (the engine never does); a failure is "not yet",
	// never fatal — see AwaitReady.
	PaneSize(ctx context.Context, paneID, server string) (width, height int, err error)
}

// Probe timing. A short settle lets the TUI redraw after the paste before the
// first echo capture; a bounded retry tolerates a slow redraw. The probe's own
// wall-clock worst case is settle + (attempts-1)*gap = 80 + 7*80 = 640ms.
// That ceiling, the post-Enter SubmitBackoff tail, and bounded recovery all
// share the caller's one 4s injection deadline. Package vars (not consts)
// exist solely so tests can shrink them; production always uses these values.
var (
	ProbeSettle = 80 * time.Millisecond
	ProbeGap    = 80 * time.Millisecond
	// SubmitBackoff gives responsive panes a cheap first check while retaining
	// a patient tail for slower post-Enter repaints.
	SubmitBackoff = []time.Duration{
		40 * time.Millisecond,
		80 * time.Millisecond,
		160 * time.Millisecond,
		320 * time.Millisecond,
		640 * time.Millisecond,
	}
	// SubmitRetries bounds recovery because every additional paste requires the
	// pane to match its pre-paste frame first.
	SubmitRetries = 1
	// SubmitRetryBackoffSteps keeps recovery within the callers' existing
	// deadlines after the first pass has already spent the patient tail.
	SubmitRetryBackoffSteps = 3
	// ClearAttempts bounds attempts to restore the complete pre-paste frame;
	// exhaustion must leave the engine unable to re-paste.
	ClearAttempts = 4
)

const (
	// ProbeAttempts bounds the echo-probe retry loop.
	ProbeAttempts = 8
	// ProbeCaptureLines is the tail depth captured for the echo probe — enough
	// to catch the pasted message even when the TUI input box wraps it across
	// several rows, without capturing the whole scrollback.
	ProbeCaptureLines = 40
	// NeedleMaxLen caps the probe needle length so an ~80-col TUI wrap cannot
	// split the fragment we look for; taken from the END of the last line (most
	// recently typed characters are the most reliable to have landed).
	NeedleMaxLen = 40
	// CollapseMinRunes is the single-line rune length at or above which the
	// paste-collapse placeholder is counted as a valid echo signal. Claude Code
	// collapses a single-line paste over 800 chars into a suffix-less
	// "[Pasted text #N]" chip (empirical, CC 2.1.215, INDEPENDENT of TUI width —
	// the observed threshold is 801). 200 is a deliberately conservative lower
	// bound so an upstream threshold reduction cannot silently rebreak
	// long-single-line sends, while short interactive sends (which never
	// collapse) keep exact-needle-only matching and so keep the narrowest
	// false-positive window.
	CollapseMinRunes = 200
)

// ProbeFailure is the sentinel error type for a failed echo probe — the pasted
// text did not echo into the pane's live input buffer within the retry budget,
// so Enter was withheld. Callers map it to their surface's recoverable-state
// signal (the HTTP handler's structured 409; the CLI's staged-text exit 1).
type ProbeFailure struct{}

func (ProbeFailure) Error() string {
	// The retry hint matters because the pasted text is left sitting in the
	// agent's composer (Enter was withheld, not the paste). An identical retry
	// would paste a SECOND copy on top of the first and submit doubled text — so
	// steer the user to check the terminal view before resending.
	return "agent input not ready — message pasted but not echoed; Enter withheld. " +
		"The text remains in the agent's input — check the terminal view before retrying, as a resend would duplicate it."
}

// StagedSendFailure reports that text reached the pane but Enter was not sent.
type StagedSendFailure struct {
	Err error
}

func (e StagedSendFailure) Error() string {
	message := "send not completed — text is staged in the pane and a resend would duplicate it; press Enter in the pane to submit"
	if e.Err != nil {
		return message + ": " + e.Err.Error()
	}
	return message
}

func (e StagedSendFailure) Unwrap() error { return e.Err }

// SubmitUnverified reports that the pane remained unchanged after Enter and
// the engine could not safely recover without risking a duplicate.
type SubmitUnverified struct {
	Err error
}

func (e SubmitUnverified) Error() string {
	message := "submit not confirmed — Enter was sent but the pane did not advance. " +
		"The message may or may not have been submitted; capture the pane before resending."
	if e.Err != nil {
		return message + ": " + e.Err.Error()
	}
	return message
}

func (e SubmitUnverified) Unwrap() error { return e.Err }

type observationVerdict uint8

const (
	observationInconclusive observationVerdict = iota
	observationNoClaim
	observationNonSubmission
)

var errComposerNotCleared = errors.New("composer did not clear")

// Engine runs the injection sequence for ONE named-buffer owner, carrying the
// serialization state that owner needs:
//
//   - the per-(server, paneID) lock map serializes the WHOLE sequence per pane
//     (baseline capture → set → paste → probe → Enter), so a second send to the
//     same pane only begins after the first finished and can never merge two
//     pastes into one doubled submission. Entries are created on demand and
//     never evicted: the key space is bounded by the live pane set, and eviction
//     would reintroduce a drop-the-last-reference race.
//   - the set → paste critical-section mutex serializes the two-subprocess
//     window across ALL panes of this engine, because the named buffer is
//     shared by every send through it (A-set / B-set / A-paste would deliver B's
//     text to pane A). The daemon's single shared buffer needs this guard; the
//     CLI's per-invocation buffer (rk-send-<pid>) gets it for free and harmless.
//
// Distinct engines (distinct buffer owners) never share locks — the CLI's
// unique buffer needs no cross-process guard, and same-pane cross-process paste
// races are inherent to tmux and accepted.
//
// The Engine holds no Tmux: the substrate is passed per Send call, so one
// package-level engine can serve requests routed through per-Server (mocked)
// seams while keeping the lock domain process-wide — the serialization domain
// is the tmux server, not the Server value.
type Engine struct {
	buffer string

	locksMu    sync.Mutex
	paneLocks  map[string]*sync.Mutex
	setPasteMu sync.Mutex
}

// NewEngine returns an engine bound to a named buffer. The daemon passes
// tmux.AgentSendBuffer; the CLI passes its per-invocation rk-send-<pid> name.
func NewEngine(buffer string) *Engine {
	return &Engine{buffer: buffer, paneLocks: make(map[string]*sync.Mutex)}
}

// Buffer reports the engine's named buffer.
func (e *Engine) Buffer() string { return e.buffer }

// lockFor returns the mutex for a (server, paneID) pair, creating it on first
// use. The returned mutex is NOT locked — the caller Lock/Unlocks it.
func (e *Engine) lockFor(server, paneID string) *sync.Mutex {
	key := server + "\x00" + paneID
	e.locksMu.Lock()
	defer e.locksMu.Unlock()
	mu, ok := e.paneLocks[key]
	if !ok {
		mu = &sync.Mutex{}
		e.paneLocks[key] = mu
	}
	return mu
}

// SendRaw writes text through the shared named buffer without probing or
// appending Enter. It uses the same pane and buffer locks as Send so raw bytes
// cannot interleave with another injection sequence.
func (e *Engine) SendRaw(ctx context.Context, t Tmux, server, paneID, text string) error {
	paneLock := e.lockFor(server, paneID)
	paneLock.Lock()
	defer paneLock.Unlock()

	if err := t.ClearPaneMode(ctx, paneID, server); err != nil {
		return fmt.Errorf("clear pane mode: %w", err)
	}
	e.setPasteMu.Lock()
	defer e.setPasteMu.Unlock()
	if err := t.SetBuffer(ctx, e.buffer, text, server); err != nil {
		return fmt.Errorf("set-buffer: %w", err)
	}
	if err := t.PasteBufferRaw(ctx, e.buffer, paneID, server); err != nil {
		return fmt.Errorf("paste-buffer: %w", err)
	}
	return nil
}

// PressEnter joins the engine's per-pane serialization domain so a recovery
// Enter cannot land inside another send's paste-and-probe sequence.
func (e *Engine) PressEnter(ctx context.Context, t Tmux, server, paneID string) error {
	paneLock := e.lockFor(server, paneID)
	paneLock.Lock()
	defer paneLock.Unlock()
	if err := t.ClearPaneMode(ctx, paneID, server); err != nil {
		return fmt.Errorf("clear pane mode: %w", err)
	}
	if err := t.SendEnter(ctx, paneID, server); err != nil {
		return fmt.Errorf("send-keys: %w", err)
	}
	return nil
}

// Send runs the pane-targeted injection sequence (Constitution I — all argv
// slices, no shell strings, text as a discrete argv element via the named
// buffer): pane-mode guard → baseline capture → set-buffer → paste-buffer
// (-d -p, bracketed) → NOVELTY echo probe → composer-popup guard (consumePopup;
// submit only) → send-keys Enter (only on probe success AND submit) →
// whole-frame observation with evidence-gated recovery.
// Every step targets paneID, never the window, and shares the caller's ctx
// deadline. submit=false (insert-without-submit) skips ONLY the final
// SendEnter — baseline, set/paste, probe (a probe failure still returns
// ProbeFailure), locks, and the shared budget are unchanged — leaving the
// verified paste staged in the agent's input box.
//
// text MUST already be sanitized (see Sanitize) — both callers sanitize at
// their own boundary so the emptiness decision sees the cleaned text.
//
// The probe verifies NOVELTY, not mere presence: it counts the needle (and, for
// a COLLAPSIBLE paste, the paste-collapse placeholder; for an IMAGEISH paste,
// the "[Image #N]" chip — see imageCollapseRe) in a PRE-PASTE baseline
// capture and requires the count to strictly INCREASE after the paste. This is
// what makes the guard sound: a stale "[Pasted text #N …]" chip already
// in-frame (a prior probe failure leaves the pasted text in the composer) or a
// short/common needle like "y"/"ok" already on screen no longer
// false-positives the probe — only the CURRENT paste, which adds a fresh
// occurrence, satisfies it. If the pane scrolls between baseline and probe the
// count cannot rise, so it fails CLOSED (ProbeFailure, no blind Enter) — the
// exact hazard (blind Enter into e.g. a permission dialog) the probe exists to
// prevent.
//
// Pre-paste failures remain plain wrapped errors. After a successful paste,
// infrastructure failures distinguish staged text from an unverified submit at
// the Enter boundary. A clean echo miss remains ProbeFailure (Enter withheld).
// A changed post-Enter frame returns nil without interpreting why it changed;
// an unchanged frame may drive bounded recovery.
func (e *Engine) Send(ctx context.Context, t Tmux, server, paneID, text string, submit bool) error {
	needle := Needle(text)
	if needle == "" {
		// Whitespace-only text is rejected upstream; a non-empty text always
		// yields a non-empty needle. Defensive: an empty needle means "cannot
		// verify", so fail closed BEFORE touching the buffer — never a blind Enter.
		return ProbeFailure{}
	}
	// The TUI can collapse a paste into a chip instead of echoing the raw text —
	// for MULTILINE text or for a long single line (Claude's "[Pasted text #N …]"
	// forms and the other observed renderer placeholders in pasteChipRes —
	// Codex's "[Pasted Content N chars]", Kimi's "[paste #K N chars]",
	// OpenCode's "[Pasted ~N lines]"). A paste is "collapsible" when either is
	// possible, and only then is a chip a valid echo signal (see
	// CollapseMinRunes). Short single-line pastes keep exact-needle-only
	// matching.
	collapsible := strings.Contains(text, "\n") || utf8.RuneCountInString(text) >= CollapseMinRunes
	// A bare image path MAY render as an "[Image #N]" chip instead of echoing
	// (see imageCollapseRe); the gate admits the chip as a second valid echo
	// signal without dropping the raw-needle arm.
	imageish := isBareImagePath(text)

	// Serialize the WHOLE sequence per (server, paneID): a second send to the SAME
	// pane only begins after this one has fully finished (baseline → set → paste →
	// probe → Enter or probe failure), so it can never paste into a composer
	// already holding this send's in-flight paste (which would merge into one
	// doubled submission). Distinct panes run concurrently — each takes its own
	// lock.
	paneLock := e.lockFor(server, paneID)
	paneLock.Lock()
	defer paneLock.Unlock()

	// Pane-mode guard: a copy-mode pane would eat the paste (keys bind to
	// copy-mode), and its cancel repaints the frame — so this runs FIRST,
	// before the baseline capture below (a pre-cancel baseline would be the
	// copy-mode screen, poisoning the novelty floor and recovery's
	// baseline-equality check). A guard failure aborts pre-paste: nothing was
	// delivered, retry is safe.
	if err := t.ClearPaneMode(ctx, paneID, server); err != nil {
		return fmt.Errorf("clear pane mode: %w", err)
	}

	// PRE-PASTE baseline: the occurrence count the probe must beat. Captured
	// BEFORE mutating the buffer so any stale needle/placeholder already in-frame
	// is included in the floor rather than mistaken for this paste's echo.
	baseline, err := t.CapturePane(ctx, paneID, ProbeCaptureLines, server)
	if err != nil {
		return fmt.Errorf("capture-pane (baseline): %w", err)
	}
	baseCount := CountOccurrences(baseline, needle, collapsible, imageish)

	// The set → paste critical section is additionally serialized across ALL panes
	// (setPasteMu) because the named buffer is shared by this engine; held only
	// for these two fast subprocesses. The probe below runs with only the per-pane
	// lock held.
	if err := e.setAndPaste(ctx, t, server, paneID, text); err != nil {
		return err
	}

	preFrame, err := e.probeEcho(ctx, t, server, paneID, needle, collapsible, imageish, baseCount)
	if err != nil {
		var probeErr ProbeFailure
		if errors.As(err, &probeErr) {
			return err
		}
		return StagedSendFailure{Err: err}
	}
	if !submit {
		// Insert-without-submit: the probe verified the paste landed; leave it
		// staged in the input box — and any popup open, for the human — and
		// send no Enter.
		return nil
	}
	preFrame, err = consumePopup(ctx, t, server, paneID, preFrame, baseline)
	if err != nil {
		return StagedSendFailure{Err: err}
	}
	if err := t.SendEnter(ctx, paneID, server); err != nil {
		return StagedSendFailure{Err: fmt.Errorf("send-keys: %w", err)}
	}

	verdict, err := verifySubmit(ctx, t, server, paneID, preFrame, needle, collapsible, imageish, baseCount, SubmitBackoff)
	if err != nil {
		return SubmitUnverified{Err: err}
	}
	switch verdict {
	case observationNoClaim:
		return nil
	case observationInconclusive:
		return SubmitUnverified{}
	default:
		return e.retrySubmit(ctx, t, server, paneID, text, needle, collapsible, imageish, baseline)
	}
}

func (e *Engine) retrySubmit(ctx context.Context, t Tmux, server, paneID, text, needle string, collapsible, imageish bool, baseline string) error {
	for range SubmitRetries {
		clearedFrame, err := clearComposer(ctx, t, server, paneID, baseline)
		if errors.Is(err, errComposerNotCleared) {
			return SubmitUnverified{}
		}
		if err != nil {
			return SubmitUnverified{Err: err}
		}

		retryBaseCount := CountOccurrences(clearedFrame, needle, collapsible, imageish)
		if err := e.setAndPaste(ctx, t, server, paneID, text); err != nil {
			return err
		}
		preFrame, err := e.probeEcho(ctx, t, server, paneID, needle, collapsible, imageish, retryBaseCount)
		if err != nil {
			var probeErr ProbeFailure
			if errors.As(err, &probeErr) {
				return err
			}
			return StagedSendFailure{Err: err}
		}
		// The recovery re-paste can reopen a composer popup; the retry's floor
		// is its own cleared frame, not the original baseline.
		preFrame, err = consumePopup(ctx, t, server, paneID, preFrame, clearedFrame)
		if err != nil {
			return StagedSendFailure{Err: err}
		}
		if err := t.SendEnter(ctx, paneID, server); err != nil {
			return StagedSendFailure{Err: fmt.Errorf("send-keys: %w", err)}
		}

		steps := SubmitBackoff
		if SubmitRetryBackoffSteps < len(steps) {
			steps = steps[:max(SubmitRetryBackoffSteps, 0)]
		}
		verdict, err := verifySubmit(ctx, t, server, paneID, preFrame, needle, collapsible, imageish, retryBaseCount, steps)
		if err != nil {
			return SubmitUnverified{Err: err}
		}
		if verdict == observationNoClaim {
			return nil
		}
		if verdict == observationInconclusive {
			return SubmitUnverified{}
		}
	}
	return SubmitUnverified{}
}

// setAndPaste runs the set-buffer → paste-buffer critical section under
// setPasteMu so two concurrent sends to DIFFERENT panes (each holding its own
// per-pane lock) cannot interleave on the shared named buffer as
// A-set / B-set / A-paste. See Engine.
func (e *Engine) setAndPaste(ctx context.Context, t Tmux, server, paneID, text string) error {
	e.setPasteMu.Lock()
	defer e.setPasteMu.Unlock()
	if err := t.SetBuffer(ctx, e.buffer, text, server); err != nil {
		return fmt.Errorf("set-buffer: %w", err)
	}
	if err := t.PasteBuffer(ctx, e.buffer, paneID, server); err != nil {
		return fmt.Errorf("paste-buffer: %w", err)
	}
	return nil
}

// probeEcho verifies the pasted text NEWLY echoed into the pane's live input
// buffer before Enter is committed. It waits a short settle, then captures the
// pane tail up to ProbeAttempts times (bounded retry with a small gap),
// returning the first capture whose needle/placeholder occurrence count
// strictly exceeds baseCount (the pre-paste floor) — proof THIS paste added an
// occurrence, not that a stale one was already present. That winning capture is
// the frame the post-Enter observation compares against, so it must come from
// here rather than a second capture that could have drifted. A tmux capture
// failure is returned wrapped (distinct from a clean probe miss); an exhausted
// retry returns ProbeFailure. All captures and sleeps share the caller's ctx
// deadline.
func (e *Engine) probeEcho(ctx context.Context, t Tmux, server, paneID, needle string, collapsible, imageish bool, baseCount int) (string, error) {
	for attempt := 0; attempt < ProbeAttempts; attempt++ {
		d := ProbeGap
		if attempt == 0 {
			d = ProbeSettle
		}
		// ctx-aware settle/gap: on caller cancellation or a shared deadline
		// firing, abort the probe promptly rather than sleeping out the full
		// interval before the next capture would notice the cancelled ctx.
		if err := sleepCtx(ctx, d); err != nil {
			return "", err
		}
		capture, err := t.CapturePane(ctx, paneID, ProbeCaptureLines, server)
		if err != nil {
			return "", fmt.Errorf("capture-pane: %w", err)
		}
		if CountOccurrences(capture, needle, collapsible, imageish) > baseCount {
			return capture, nil
		}
	}
	return "", ProbeFailure{}
}

// composerPopupMarkers are footer lines of known agent-TUI popups that consume
// the next Enter as a popup action (insert/close) instead of submitting the
// composer. Empirical TUI strings, the same class as CollapseMinRunes /
// imageCollapseRe; matched through CountOccurrences' exact-substring arm so
// markers and captures share the one stripForProbe normalization.
var composerPopupMarkers = []string{
	// codex skill-autocomplete footer: "Press enter to insert or esc to close".
	// Opens when the composer holds exactly a bare skill token ($name); Enter
	// then inserts instead of submitting (verified codex 0.153.4).
	"Press enter to insert",
}

// popupNewlyOpen reports whether a composer popup newly appeared in frame
// relative to floor: any marker whose occurrence count strictly increased.
// Strict increase makes a stale marker copy in scrollback a floor to beat,
// never a trigger — the same discipline as the novelty echo probe.
func popupNewlyOpen(frame, floor string) bool {
	for _, m := range composerPopupMarkers {
		// CountOccurrences strips only the capture; needles arrive pre-stripped
		// (Needle's contract), so the display-form marker is stripped here.
		needle := stripForProbe(m)
		if CountOccurrences(frame, needle, false, false) > CountOccurrences(floor, needle, false, false) {
			return true
		}
	}
	return false
}

// consumePopup guards the submit Enter against a composer popup opened by the
// paste itself (popupNewlyOpen over two frames already in hand — the no-popup
// path adds no tmux calls and no waits). A detected popup gets one Enter to
// consume it (the pty processes it before the submit Enter, so ordering — not
// the re-capture — carries correctness), one ProbeSettle for the TUI to
// repaint, and a fresh capture so verifySubmit baselines on the post-popup
// frame rather than reading the popup's disappearance as submission evidence.
// A false positive is benign: on a popup-less composer the extra Enter submits
// the staged text and the follow-up Enter no-ops on the emptied composer.
// Returns the frame verifySubmit should compare against; errors are post-paste
// pre-submit failures for the caller to classify (staged-text discipline).
func consumePopup(ctx context.Context, t Tmux, server, paneID, preFrame, floor string) (string, error) {
	if !popupNewlyOpen(preFrame, floor) {
		return preFrame, nil
	}
	if err := t.SendEnter(ctx, paneID, server); err != nil {
		return "", fmt.Errorf("send-keys (popup): %w", err)
	}
	if err := sleepCtx(ctx, ProbeSettle); err != nil {
		return "", err
	}
	capture, err := t.CapturePane(ctx, paneID, ProbeCaptureLines, server)
	if err != nil {
		return "", fmt.Errorf("capture-pane (popup): %w", err)
	}
	return capture, nil
}

// verifySubmit compares complete normalized frames without interpreting a
// repaint; only a frame unchanged through every step can establish that Enter
// had no visible effect.
func verifySubmit(ctx context.Context, t Tmux, server, paneID, preFrame, needle string, collapsible, imageish bool, baseCount int, steps []time.Duration) (observationVerdict, error) {
	preFrame = stripForProbe(preFrame)
	var capture string
	for _, delay := range steps {
		if err := sleepCtx(ctx, delay); err != nil {
			return observationInconclusive, err
		}
		var err error
		capture, err = t.CapturePane(ctx, paneID, ProbeCaptureLines, server)
		if err != nil {
			return observationInconclusive, err
		}
		if stripForProbe(capture) != preFrame {
			return observationNoClaim, nil
		}
	}
	// Evidence must use the same predicate that established the echo: the chip
	// terms (paste-collapse and image) keep collapsed and image-chipped pastes
	// recovery-eligible where chips are rendered and match nothing elsewhere,
	// so they add no portability constraint.
	if CountOccurrences(capture, needle, collapsible, imageish) > baseCount {
		return observationNonSubmission, nil
	}
	return observationInconclusive, nil
}

// clearComposer permits another paste only after the complete normalized pane
// returns to its pre-paste frame, proving no staged prefix was left behind.
func clearComposer(ctx context.Context, t Tmux, server, paneID, baseline string) (string, error) {
	return clearToBaseline(ctx, t, server, paneID, ProbeCaptureLines, baseline, nil)
}

// clearToBaseline is the shared C-u/capture/baseline-compare clear discipline:
// send C-u, re-capture at the given depth, and repeat until the pane returns
// to the baseline frame, proving no staged prefix was left behind. Baseline
// and verification captures MUST share one depth — a baseline captured deeper
// than the verification captures can never compare equal on a pane with
// scrollback beyond the shallower window. isGone (nil for the engine) lets the
// readiness probe classify a capture error as pane death.
func clearToBaseline(ctx context.Context, t Tmux, server, paneID string, lines int, baseline string, isGone func(error) bool) (string, error) {
	baseline = stripForProbe(baseline)
	var capture string
	for range ClearAttempts {
		if err := t.SendKeys(ctx, paneID, server, "C-u"); err != nil {
			return "", fmt.Errorf("send-keys: %w", err)
		}
		var err error
		capture, err = t.CapturePane(ctx, paneID, lines, server)
		if err != nil {
			if isGone != nil && isGone(err) {
				return "", fmt.Errorf("%w: %w", ErrGone, err)
			}
			return "", err
		}
		if stripForProbe(capture) == baseline {
			return capture, nil
		}
	}
	return capture, errComposerNotCleared
}

// sleepCtx sleeps for d but returns early with ctx.Err() if ctx is cancelled or
// its deadline fires first. Used by the echo probe so a client disconnect (or a
// shared injection deadline) aborts the settle/gap wait promptly instead of
// sleeping out the full interval. A ctx error propagates up as the injection
// error, never a false ProbeFailure.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ansiEscapeRe matches the ANSI CSI / OSC escape sequences CapturePane preserves
// (it captures with -e). Stripped before probe matching so styling never breaks
// the echo check.
var ansiEscapeRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

// pasteCollapseRe matches Claude Code's paste-collapse placeholder — the TUI
// replaces a larger bracketed paste with a chip rather than echoing the raw text,
// so the raw needle would never be found and the probe would fail exactly the
// collapsed case. There are TWO chip forms:
//   - multiline collapse:            "[Pasted text #N +M lines]"
//   - long single-line collapse:     "[Pasted text #N]" (NO "+M lines" suffix)
//
// The single-line collapse is a pure character-count threshold (empirically
// >800 chars on Claude Code 2.1.215, INDEPENDENT of TUI width — verified at
// 60/80/200 cols), NOT a wrap effect, so the suffix-less chip carries no line
// count. The placeholder counts as a SUCCESSFUL echo (the paste demonstrably
// reached the input buffer — the TUI only renders this chip for content it
// accepted) — but ONLY when the paste is COLLAPSIBLE (see CountOccurrences /
// CollapseMinRunes), and ONLY as a fresh occurrence vs the pre-paste baseline
// (a stale chip from a prior send is in the baseline count).
//
// The Antigravity CLI renders the same chip WITH the character count appended
// ("[Pasted text #N 1426 chars]", agy 1.4.7), which the trailing optional
// digit-run-plus-"chars" alternative covers; its numbered repeats increment #N
// exactly like Claude's.
//
// The pattern matches the WHITESPACE-STRIPPED capture (stripForProbe removes all
// whitespace — spaces, tabs, newlines, etc.), i.e. "[Pastedtext#1+12lines]",
// "[Pastedtext#5]", or "[Pastedtext#11426chars]"; the "+M lines" part
// is optional and tolerant of singular/plural "line"/"lines" and any digit counts.
var pasteCollapseRe = regexp.MustCompile(`\[Pastedtext#\d+(?:\+\d+lines?|\d+chars?)?\]`)

// codexPasteCollapseRe matches Codex's paste-collapse placeholder
// ("[Pasted Content 1433 chars]", codex 0.164.0) — Codex replaces a long
// paste (single-line OR multiline, one char-count chip either way) with this
// chip instead of echoing the raw text. Repeating an IDENTICAL payload appends
// a repeat counter to the later chips ("[Pasted Content 1433 chars] #2"),
// which the optional "#K" suffix covers; each chip is still one occurrence, so
// identical-count repeats are counted independently.
var codexPasteCollapseRe = regexp.MustCompile(`\[PastedContent\d+chars?\](?:#\d+)?`)

// kimiPasteCollapseRe matches Kimi Code's paste-collapse placeholder
// ("[paste #1 1426 chars]", kimi 2.3.2) — chip ordinal and character count run
// together once the capture is whitespace-stripped ("[paste#11426chars]"), so
// one digit run covers both.
var kimiPasteCollapseRe = regexp.MustCompile(`\[paste#\d+chars?\]`)

// opencodePasteCollapseRe matches OpenCode's paste-collapse placeholder
// ("[Pasted ~1 lines]", opencode 1.18.25) — an approximate LINE count with a
// tilde, rendered even for a collapsed long single-line paste ("~1 lines").
var opencodePasteCollapseRe = regexp.MustCompile(`\[Pasted~\d+lines?\]`)

// Gemini CLI 0.65.0 uses "[Pasted Text: 1433 chars]" or
// "[Pasted Text: 20 lines]", with repeats numbered inside the closing bracket.
var geminiPasteCollapseRe = regexp.MustCompile(`\[PastedText:\d+(?:chars?|lines?)(?:#\d+)?\]`)

// pasteChipRes is the full set of recognized collapsed-paste placeholders, one
// entry per empirically observed renderer form. Every form counts only under
// the collapsible gate and the strict-increase baseline discipline — see
// CountOccurrences.
var pasteChipRes = []*regexp.Regexp{
	pasteCollapseRe,
	codexPasteCollapseRe,
	kimiPasteCollapseRe,
	opencodePasteCollapseRe,
	geminiPasteCollapseRe,
}

// imageCollapseRe matches Claude Code's image-attachment placeholder — the TUI
// replaces a bracketed paste that is exactly one existing image-file path with
// an "[Image #N]" chip instead of echoing the path text, so the raw needle
// would never be found and the probe would fail exactly the image-attachment
// case (the dashboard's attachment-only send shape). Empirical, CC 2.1.260:
//   - the chip renders for bare paths to EXISTING .png/.jpg/.gif/.webp files
//     (.svg/.bmp and nonexistent paths stay raw text), at EVERY paste length —
//     a 293-char image path chips as "[Image #N]", never "[Pasted text #N]",
//     so the collapsible arm can never catch it;
//   - a trailing newline still chips; mixed text+path and multiple
//     newline-separated paths stay raw text;
//   - the chip number increments per paste within a session.
//
// Like pasteCollapseRe, the pattern matches the WHITESPACE-STRIPPED capture,
// i.e. "[Image#1]". The chip counts as a successful echo ONLY when the paste
// is IMAGEISH (see isBareImagePath / CountOccurrences) and ONLY as a fresh
// occurrence vs the pre-paste baseline.
var imageCollapseRe = regexp.MustCompile(`\[Image#\d+\]`)

// imageExtensions are the path suffixes the image-chip gate recognizes — the
// Claude API image media types. .png/.jpg/.gif/.webp were observed to chip on
// CC 2.1.260; .jpeg is included by inference (image/jpeg covers both suffixes)
// without direct observation. Matched case-insensitively. A wrongly-gated
// extension is harmless: the TUI leaves such a paste as raw text and the
// needle arm still verifies it.
var imageExtensions = []string{".png", ".jpg", ".jpeg", ".gif", ".webp"}

// isBareImagePath reports whether text, whitespace-trimmed, is a single line
// ending in a recognized image extension — the only paste shape Claude Code
// renders as an "[Image #N]" chip. Whether a gated paste actually chips
// depends on filesystem state the engine cannot see (the file must exist), so
// the gate WIDENS the accepted echo signals (fresh chip OR fresh raw needle)
// rather than selecting between them.
func isBareImagePath(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || strings.Contains(trimmed, "\n") {
		return false
	}
	lower := strings.ToLower(trimmed)
	for _, ext := range imageExtensions {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// Sanitize strips terminal control bytes from a message before it is pasted
// into an agent pane. Bracketed paste makes ordinary text inert, but control
// bytes ride through verbatim — most sharply ESC (0x1B), which can embed the
// bracketed-paste-end sequence (ESC[201~) and turn the tail of the message into
// live keystrokes (the classic paste-injection break-out). Defense: normalize
// CR/CRLF to \n, then drop every control rune — unicode.IsControl covers C0
// (U+0000–U+001F), DEL (U+007F), and the C1 range (U+0080–U+009F, incl. the
// single-byte CSI U+009B) — EXCEPT \n and \t, which are legitimate message content
// (multiline messages and indented code). CR-normalization (rather than bare
// stripping) keeps a CRLF-origin multiline message's line structure so it still
// counts as multiline downstream.
func Sanitize(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
}

// Needle derives the echo-probe needle from the message text: the LAST
// non-empty line, whitespace-stripped and capped to the last NeedleMaxLen
// runes (so an ~80-col TUI wrap cannot split the fragment we look for). Returns
// "" only for whitespace-only text (rejected upstream).
func Needle(text string) string {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		stripped := stripForProbe(lines[i])
		if stripped == "" {
			continue
		}
		runes := []rune(stripped)
		if len(runes) > NeedleMaxLen {
			runes = runes[len(runes)-NeedleMaxLen:]
		}
		return string(runes)
	}
	return ""
}

// CountOccurrences counts how many times this paste's echo signal appears
// in the pane capture: the raw needle occurrences PLUS, when the paste is
// COLLAPSIBLE, the paste-collapse placeholder occurrences PLUS, when the paste
// is IMAGEISH, the image-chip placeholder occurrences. Both the capture and
// the needle have ALL whitespace removed (stripForProbe) so a TUI wrap that
// inserts spaces/newlines mid-fragment (or a leading prompt glyph on the wrapped
// row) cannot defeat the match.
//
// The engine compares this count against a pre-paste BASELINE and requires a
// strict increase, so a stale needle/placeholder already in-frame is a floor to
// beat rather than a false positive. The gates matter: `collapsible` means the
// TUI may have collapsed THIS paste into a chip (multiline text, or a
// single line long enough to collapse — CollapseMinRunes), and `imageish` means
// the TUI may have rendered THIS paste as an "[Image #N]" chip (a bare
// single-line image path — isBareImagePath), so each chip is a valid fresh-echo
// signal only for a paste of its shape; counting a chip for any other paste
// would only widen the concurrent-fresh-chip false-positive window. Both chip
// arms are additive to the needle arm — the imageish gate cannot know whether
// the TUI chipped (that depends on the file existing), so a raw-text echo of an
// image path still counts. A short/common single-line needle ("y", "ok") could
// substring-match unrelated stale content, but that content is in the baseline
// too — the caller's strict-increase requirement, not this counter, is what makes
// short needles fail closed against stale content.
func CountOccurrences(capture, needle string, collapsible, imageish bool) int {
	stripped := stripForProbe(capture)
	n := strings.Count(stripped, needle)
	if collapsible {
		for _, re := range pasteChipRes {
			n += len(re.FindAllString(stripped, -1))
		}
	}
	if imageish {
		n += len(imageCollapseRe.FindAllString(stripped, -1))
	}
	return n
}

// stripForProbe normalizes a string for echo matching: strip ANSI escapes, then
// remove ALL whitespace (spaces, tabs, newlines) and every box-drawing /
// block-element rune (U+2500–U+259F — the adjacent Box Drawing and Block
// Elements blocks). Wrap-safe by construction — including a TUI composer that
// reflows its own border around the wrapped text, whose frame glyphs would
// otherwise interleave the needle.
func stripForProbe(s string) string {
	s = ansiEscapeRe.ReplaceAllString(s, "")
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' {
			continue
		}
		if r >= 0x2500 && r <= 0x259F {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
