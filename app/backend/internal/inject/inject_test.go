package inject

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fastProbe shrinks the probe settle/gap so the retry loop runs quickly under
// test, restoring the production values after.
func fastProbe(t *testing.T) {
	t.Helper()
	ps, pg := ProbeSettle, ProbeGap
	ProbeSettle = time.Millisecond
	ProbeGap = time.Millisecond
	t.Cleanup(func() { ProbeSettle, ProbeGap = ps, pg })
}

func fastSubmit(t *testing.T) {
	t.Helper()
	backoff := append([]time.Duration(nil), SubmitBackoff...)
	retries, retrySteps, clears := SubmitRetries, SubmitRetryBackoffSteps, ClearAttempts
	SubmitBackoff = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond}
	SubmitRetries = 1
	SubmitRetryBackoffSteps = 3
	ClearAttempts = 4
	t.Cleanup(func() {
		SubmitBackoff = backoff
		SubmitRetries = retries
		SubmitRetryBackoffSteps = retrySteps
		ClearAttempts = clears
	})
}

// fakeTmux is a scriptable inject.Tmux: captures are consumed from
// captureResults in order (falling back to captureResult), and every call is
// recorded in calls for order assertions.
type fakeTmux struct {
	mu             sync.Mutex
	calls          []string
	captureResult  string
	captureResults []string
	captureErr     error
	captureErrs    []error
	clearModeErr   error
	setBufferErr   error
	pasteErr       error
	pasteRawErr    error
	enterErr       error
	enterErrs      []error
	keyErr         error
	sizeW          int
	sizeH          int
	sizeErr        error
	sizeErrs       []error
	bufferName     string
	bufferText     string
	pastedPane     string
	pastedRawPane  string
	enteredPane    string
	enterCalled    bool
	enterHook      func()
	pasteHook      func()
	keysSent       [][]string
}

func (f *fakeTmux) record(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s)
}

func (f *fakeTmux) callStream() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeTmux) ClearPaneMode(_ context.Context, _ string, _ string) error {
	f.record("clear-pane-mode")
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clearModeErr
}

func (f *fakeTmux) CapturePane(_ context.Context, _ string, lines int, _ string) (string, error) {
	f.record("capture-pane")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.captureErrs) > 0 {
		err := f.captureErrs[0]
		f.captureErrs = f.captureErrs[1:]
		if err != nil {
			return "", err
		}
	} else if f.captureErr != nil {
		return "", f.captureErr
	}
	if len(f.captureResults) > 0 {
		r := f.captureResults[0]
		f.captureResults = f.captureResults[1:]
		return tailLines(r, lines), nil
	}
	return tailLines(f.captureResult, lines), nil
}

// tailLines simulates capture-pane's tail-depth window: the last `lines`
// newline-separated rows of the pane content. The depth is observable so tests
// can pin the single-capture-depth invariant the settle/probe/clear
// comparisons depend on.
func tailLines(s string, lines int) string {
	if lines <= 0 {
		return s
	}
	rows := strings.Split(s, "\n")
	if len(rows) <= lines {
		return s
	}
	return strings.Join(rows[len(rows)-lines:], "\n")
}

func (f *fakeTmux) SetBuffer(_ context.Context, name, text, _ string) error {
	f.record("set-buffer")
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bufferName = name
	f.bufferText = text
	return f.setBufferErr
}

func (f *fakeTmux) PasteBuffer(_ context.Context, _, paneID, _ string) error {
	f.record("paste-buffer")
	f.mu.Lock()
	f.pastedPane = paneID
	hook := f.pasteHook
	err := f.pasteErr
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return err
}

func (f *fakeTmux) PasteBufferRaw(_ context.Context, _, paneID, _ string) error {
	f.record("paste-buffer-raw")
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pastedRawPane = paneID
	return f.pasteRawErr
}

func (f *fakeTmux) SendEnter(_ context.Context, paneID, _ string) error {
	f.record("send-keys")
	f.mu.Lock()
	f.enterCalled = true
	f.enteredPane = paneID
	hook := f.enterHook
	err := f.enterErr
	if len(f.enterErrs) > 0 {
		err = f.enterErrs[0]
		f.enterErrs = f.enterErrs[1:]
	}
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return err
}

func countCalls(calls []string, want string) int {
	count := 0
	for _, call := range calls {
		if call == want {
			count++
		}
	}
	return count
}

func (f *fakeTmux) SendKeys(_ context.Context, paneID, _ string, keys ...string) error {
	f.record("send-keys " + strings.Join(keys, " "))
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keysSent = append(f.keysSent, append([]string{paneID}, keys...))
	return f.keyErr
}

// PaneSize scripts the readiness geometry read. Errors are consumed from
// sizeErrs in order (falling back to sizeErr); a nil consumed error falls
// through to the size. Zero size fields read as exactly AT the readiness
// floor, so a test that never sets a size keeps the probe path.
func (f *fakeTmux) PaneSize(_ context.Context, _ string, _ string) (int, int, error) {
	f.record("pane-size")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sizeErrs) > 0 {
		err := f.sizeErrs[0]
		f.sizeErrs = f.sizeErrs[1:]
		if err != nil {
			return 0, 0, err
		}
	} else if f.sizeErr != nil {
		return 0, 0, f.sizeErr
	}
	if f.sizeW == 0 && f.sizeH == 0 {
		return ReadyMinCols, ReadyMinRows, nil
	}
	return f.sizeW, f.sizeH, nil
}

func TestSendRawOrder(t *testing.T) {
	ft := &fakeTmux{}
	err := NewEngine("rk-send-raw").SendRaw(context.Background(), ft, "default", "%5", "a\tb\nc")
	if err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if got, want := strings.Join(ft.callStream(), ","), "clear-pane-mode,set-buffer,paste-buffer-raw"; got != want {
		t.Fatalf("calls = %s, want %s", got, want)
	}
	if ft.bufferText != "a\tb\nc" || ft.pastedRawPane != "%5" {
		t.Fatalf("delivery = text %q pane %q", ft.bufferText, ft.pastedRawPane)
	}
	if ft.enterCalled {
		t.Fatal("Enter sent during raw delivery")
	}
}

func TestPressEnterOrder(t *testing.T) {
	ft := &fakeTmux{}
	if err := NewEngine("rk-send-enter").PressEnter(context.Background(), ft, "default", "%5"); err != nil {
		t.Fatalf("PressEnter: %v", err)
	}
	if got, want := strings.Join(ft.callStream(), ","), "clear-pane-mode,send-keys"; got != want {
		t.Fatalf("calls = %s, want %s", got, want)
	}
	if ft.enteredPane != "%5" {
		t.Fatalf("pane = %q, want %%5", ft.enteredPane)
	}
}

// TestSendGuardRunsBeforeBaseline: the pane-mode guard is the first
// pane-touching step of all three engine paths — a mode cancel repaints the
// frame, so a baseline captured first would poison the probe floor.
func TestSendGuardRunsBeforeBaseline(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{"❯ ", "❯ hi", "hi\nworking"}}
	if err := NewEngine("rk-guard-order").Send(context.Background(), ft, "default", "%5", "hi", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	calls := ft.callStream()
	if len(calls) < 2 || calls[0] != "clear-pane-mode" || calls[1] != "capture-pane" {
		t.Fatalf("calls = %v, want clear-pane-mode before the baseline capture-pane", calls)
	}
}

// TestGuardFailureAbortsPrePaste: a guard failure aborts every delivery path
// before any buffer/paste/Enter — nothing was delivered, so the wrapped error
// keeps the plain pre-paste failure class (CLI exit 1 / daemon 500).
func TestGuardFailureAbortsPrePaste(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	guardErr := errors.New("pane gone")

	t.Run("Send", func(t *testing.T) {
		ft := &fakeTmux{clearModeErr: guardErr}
		err := NewEngine("rk-guard-fail").Send(context.Background(), ft, "default", "%5", "hi", true)
		if !errors.Is(err, guardErr) {
			t.Fatalf("err = %v, want the wrapped guard error", err)
		}
		if got := ft.callStream(); strings.Join(got, ",") != "clear-pane-mode" {
			t.Fatalf("calls = %v, want the guard only — no capture/paste/Enter", got)
		}
	})
	t.Run("SendRaw", func(t *testing.T) {
		ft := &fakeTmux{clearModeErr: guardErr}
		err := NewEngine("rk-guard-fail").SendRaw(context.Background(), ft, "default", "%5", "hi")
		if !errors.Is(err, guardErr) {
			t.Fatalf("err = %v, want the wrapped guard error", err)
		}
		if got := ft.callStream(); strings.Join(got, ",") != "clear-pane-mode" {
			t.Fatalf("calls = %v, want the guard only — no set/paste", got)
		}
	})
	t.Run("PressEnter", func(t *testing.T) {
		ft := &fakeTmux{clearModeErr: guardErr}
		err := NewEngine("rk-guard-fail").PressEnter(context.Background(), ft, "default", "%5")
		if !errors.Is(err, guardErr) {
			t.Fatalf("err = %v, want the wrapped guard error", err)
		}
		if ft.enterCalled {
			t.Fatal("Enter sent despite the guard failure")
		}
	})
}

func TestSendRawSamePaneSerializesWithSend(t *testing.T) {
	fastProbe(t)
	ft := &fakeTmux{captureResult: "unrelated pane output"}
	engine := NewEngine("rk-send-shared")

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = engine.Send(context.Background(), ft, "default", "%5", "message", true)
	}()
	go func() {
		defer wg.Done()
		_ = engine.SendRaw(context.Background(), ft, "default", "%5", "raw")
	}()
	wg.Wait()

	sendBlock := []string{"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer"}
	for range ProbeAttempts {
		sendBlock = append(sendBlock, "capture-pane")
	}
	rawBlock := []string{"clear-pane-mode", "set-buffer", "paste-buffer-raw"}
	first := append(append([]string(nil), sendBlock...), rawBlock...)
	second := append(append([]string(nil), rawBlock...), sendBlock...)
	got := strings.Join(ft.callStream(), ",")
	if got != strings.Join(first, ",") && got != strings.Join(second, ",") {
		t.Fatalf("same-pane operations interleaved: %v", ft.callStream())
	}
}

func TestSendShortNeedleOccurrenceCounts(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)

	t.Run("flat count fails closed", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"old ok\n❯ ", "❯ ok"}, captureResult: "❯ ok"}
		err := NewEngine("rk-short-flat").Send(context.Background(), ft, "default", "%5", "ok", true)
		var probeErr ProbeFailure
		if !errors.As(err, &probeErr) {
			t.Fatalf("err = %v, want ProbeFailure", err)
		}
		if ft.enterCalled {
			t.Fatal("Enter sent after a flat occurrence count")
		}
	})

	t.Run("fresh occurrence passes", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"old ok\n❯ ", "old ok\n❯ ok", "working"}}
		if err := NewEngine("rk-short-fresh").Send(context.Background(), ft, "default", "%5", "ok", true); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if !ft.enterCalled {
			t.Fatal("Enter was not sent after a fresh occurrence")
		}
	})
}

// TestSendOrderAndEnter: a paste whose text newly echoes runs the exact order
// pane-mode guard → baseline capture → set-buffer → paste-buffer → probe
// capture → Enter, all targeting the pane, through the engine's named buffer.
func TestSendOrderAndEnter(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{"❯ ", "❯ hello world", "hello world\nworking"}}
	e := NewEngine("rk-send-123")

	if err := e.Send(context.Background(), ft, "default", "%5", "hello world", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	want := []string{"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer", "capture-pane", "send-keys", "capture-pane"}
	if got := strings.Join(ft.callStream(), ","); got != strings.Join(want, ",") {
		t.Errorf("call order = %v, want %v", got, want)
	}
	if ft.bufferName != "rk-send-123" {
		t.Errorf("buffer = %q, want the engine's named buffer", ft.bufferName)
	}
	if ft.bufferText != "hello world" || ft.pastedPane != "%5" || ft.enteredPane != "%5" {
		t.Errorf("delivery = text %q paste %q enter %q, want the message into %%5", ft.bufferText, ft.pastedPane, ft.enteredPane)
	}
}

// TestSendProbeFailsClosed: the pasted text never echoes across all retries →
// ProbeFailure and NO Enter (never a blind Enter).
func TestSendProbeFailsClosed(t *testing.T) {
	fastProbe(t)
	ft := &fakeTmux{captureResult: "unrelated pane output"}
	e := NewEngine("rk-agent-send")

	err := e.Send(context.Background(), ft, "default", "%5", "hello world", true)
	var pf ProbeFailure
	if !errors.As(err, &pf) {
		t.Fatalf("err = %v, want ProbeFailure", err)
	}
	if ft.enterCalled {
		t.Error("Enter sent despite a failed probe")
	}
	captures := 0
	for _, c := range ft.callStream() {
		if c == "capture-pane" {
			captures++
		}
	}
	if want := 1 + ProbeAttempts; captures != want {
		t.Errorf("captures = %d, want %d (baseline + full bounded retry)", captures, want)
	}
}

// TestSendInsertSkipsEnter: submit=false runs the full sequence up to a passing
// probe, then skips ONLY the Enter (text stays staged).
func TestSendInsertSkipsEnter(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{"❯ ", "❯ stage me"}}
	e := NewEngine("rk-send-9")

	if err := e.Send(context.Background(), ft, "default", "%5", "stage me", false); err != nil {
		t.Fatalf("Send: %v", err)
	}
	want := []string{"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer", "capture-pane"}
	if got := strings.Join(ft.callStream(), ","); got != strings.Join(want, ",") {
		t.Errorf("call order = %v, want %v (no send-keys)", got, want)
	}
	if ft.enterCalled {
		t.Error("Enter sent despite submit=false")
	}
	if len(ft.keysSent) != 0 {
		t.Errorf("keys sent despite submit=false: %v", ft.keysSent)
	}
}

// TestSendTmuxFailureVerbatim: a substrate failure (paste here) propagates as a
// wrapped tmux error — NOT a ProbeFailure — and no Enter is sent.
func TestSendTmuxFailureVerbatim(t *testing.T) {
	fastProbe(t)
	ft := &fakeTmux{captureResult: "❯ ", pasteErr: errors.New("tmux exploded")}
	e := NewEngine("rk-agent-send")

	err := e.Send(context.Background(), ft, "default", "%5", "hi", true)
	var pf ProbeFailure
	if errors.As(err, &pf) {
		t.Fatalf("err = %v, must not be a ProbeFailure (tmux fault is distinct)", err)
	}
	var staged StagedSendFailure
	if errors.As(err, &staged) {
		t.Fatalf("err = %v, must not be a StagedSendFailure before paste succeeds", err)
	}
	var unverified SubmitUnverified
	if errors.As(err, &unverified) {
		t.Fatalf("err = %v, must not be SubmitUnverified before Enter", err)
	}
	if err == nil || !strings.Contains(err.Error(), "tmux exploded") {
		t.Fatalf("err = %v, want the wrapped tmux failure", err)
	}
	if ft.enterCalled {
		t.Error("Enter sent despite a paste failure")
	}
}

func TestSendPostPasteFailuresAreStaged(t *testing.T) {
	fastProbe(t)
	wantErr := errors.New("tmux failed")
	tests := []struct {
		name string
		ops  *fakeTmux
		ctx  func() context.Context
	}{
		{
			name: "probe capture",
			ops: &fakeTmux{
				captureResults: []string{"pane\n❯ "},
				captureErrs:    []error{nil, wantErr},
			},
			ctx: context.Background,
		},
		{
			name: "probe context",
			ops:  &fakeTmux{captureResults: []string{"pane\n❯ "}},
			ctx: func() context.Context {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx
			},
		},
		{
			name: "send Enter",
			ops: &fakeTmux{
				captureResults: []string{"pane\n❯ ", "pane\n❯ hello"},
				enterErr:       wantErr,
			},
			ctx: context.Background,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := NewEngine("rk-send-staged").Send(tt.ctx(), tt.ops, "default", "%5", "hello", true)
			var staged StagedSendFailure
			if !errors.As(err, &staged) {
				t.Fatalf("err = %v, want StagedSendFailure", err)
			}
			var unverified SubmitUnverified
			if errors.As(err, &unverified) {
				t.Fatalf("err = %v, must not be SubmitUnverified", err)
			}
			if tt.name != "probe context" && !errors.Is(err, wantErr) {
				t.Fatalf("err = %v, want wrapped cause %v", err, wantErr)
			}
			if tt.name == "probe context" && !errors.Is(err, context.Canceled) {
				t.Fatalf("err = %v, want wrapped context cancellation", err)
			}
		})
	}
}

func TestSendPrePasteFailuresRemainPlain(t *testing.T) {
	wantErr := errors.New("tmux failed")
	for _, tt := range []struct {
		name string
		ops  *fakeTmux
	}{
		{"set buffer", &fakeTmux{captureResult: "pane\n❯ ", setBufferErr: wantErr}},
		{"paste buffer", &fakeTmux{captureResult: "pane\n❯ ", pasteErr: wantErr}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := NewEngine("rk-send-plain").Send(context.Background(), tt.ops, "default", "%5", "hello", true)
			if !errors.Is(err, wantErr) {
				t.Fatalf("err = %v, want wrapped cause %v", err, wantErr)
			}
			var staged StagedSendFailure
			var unverified SubmitUnverified
			var probe ProbeFailure
			if errors.As(err, &staged) || errors.As(err, &unverified) || errors.As(err, &probe) {
				t.Fatalf("err = %v, want plain wrapped error", err)
			}
		})
	}
}

// TestSendWhitespaceOnlyNeedleFailsClosed: a text that yields no needle fails
// closed BEFORE touching the buffer (defensive — callers reject empty text
// upstream).
func TestSendWhitespaceOnlyNeedleFailsClosed(t *testing.T) {
	ft := &fakeTmux{}
	e := NewEngine("rk-agent-send")

	err := e.Send(context.Background(), ft, "default", "%5", "  \n\t ", true)
	var pf ProbeFailure
	if !errors.As(err, &pf) {
		t.Fatalf("err = %v, want ProbeFailure", err)
	}
	if len(ft.callStream()) != 0 {
		t.Errorf("tmux was touched (%v) for a needle-less text", ft.callStream())
	}
}

// TestSendSamePaneSerializes: two concurrent sends to the SAME pane produce two
// contiguous, non-overlapping per-send blocks in the call stream (the per-pane
// lock holds the whole sequence).
func TestSendSamePaneSerializes(t *testing.T) {
	fastProbe(t)
	// Every capture is stale → both sends deterministically fail the probe, so
	// each block is a fixed shape regardless of goroutine order.
	ft := &fakeTmux{captureResult: "❯ stale line"}
	e := NewEngine("rk-agent-send")

	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = e.Send(context.Background(), ft, "default", "%5", "msg", true)
		}()
	}
	wg.Wait()

	var oneBlock []string
	oneBlock = append(oneBlock, "clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer")
	for range ProbeAttempts {
		oneBlock = append(oneBlock, "capture-pane")
	}
	want := append(append([]string(nil), oneBlock...), oneBlock...)
	if got := ft.callStream(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("same-pane sends interleaved — stream = %v, want two contiguous blocks %v", got, want)
	}
}

// TestSendCrossPaneSetPasteAtomic: concurrent sends to DIFFERENT panes keep the
// set → paste subsequence well-nested (a set-buffer is always immediately
// followed by its paste-buffer — never set,set,…,paste,paste).
func TestSendCrossPaneSetPasteAtomic(t *testing.T) {
	fastProbe(t)
	ft := &fakeTmux{captureResult: "❯ stale line"}
	e := NewEngine("rk-agent-send")

	var wg sync.WaitGroup
	for _, pane := range []string{"%1", "%2"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = e.Send(context.Background(), ft, "default", pane, "msg", true)
		}()
	}
	wg.Wait()

	inCritical := false
	for _, c := range ft.callStream() {
		switch c {
		case "set-buffer":
			if inCritical {
				t.Fatalf("two set-buffers with no intervening paste: %v", ft.callStream())
			}
			inCritical = true
		case "paste-buffer":
			if !inCritical {
				t.Fatalf("paste-buffer with no preceding set-buffer: %v", ft.callStream())
			}
			inCritical = false
		}
	}
	if inCritical {
		t.Fatalf("a set-buffer never reached its paste-buffer: %v", ft.callStream())
	}
}

// TestSendDistinctEnginesShareNothing: two engines (two buffer owners, e.g. the
// daemon and a CLI invocation) hold no shared locks — a blocked send on one
// engine does not stall the other.
func TestSendDistinctEnginesShareNothing(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	slow := &fakeTmux{captureResults: []string{"❯ ", "❯ hi", "hi\nworking"}}
	fast := &fakeTmux{captureResults: []string{"❯ ", "❯ hi", "hi\nworking"}}
	e1 := NewEngine("rk-agent-send")
	e2 := NewEngine("rk-send-42")

	done := make(chan error, 1)
	go func() { done <- e2.Send(context.Background(), fast, "default", "%5", "hi", true) }()
	if err := e1.Send(context.Background(), slow, "default", "%5", "hi", true); err != nil {
		t.Fatalf("e1.Send: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("e2.Send: %v", err)
	}
}

func TestSendChangedFrameReturnsNilWithoutRecovery(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{"❯ ", "pane\n❯ hello", "hello\nworking"}}

	if err := NewEngine("rk-send-fast").Send(context.Background(), ft, "default", "%5", "hello", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if captures := countCalls(ft.callStream(), "capture-pane"); captures != 3 {
		t.Fatalf("captures = %d, want baseline + echo + one observation", captures)
	}
	if len(ft.keysSent) != 0 {
		t.Fatalf("recovery keys sent after a changed frame: %v", ft.keysSent)
	}
}

func TestSendStatusChurnReturnsNilWithoutRecovery(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{
		"pane\n❯ ",
		"pane\n❯ hello\nstatus: ready",
		"pane\n❯ hello\nstatus: working",
	}}

	if err := NewEngine("rk-send-busy").Send(context.Background(), ft, "default", "%5", "hello", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !ft.enterCalled {
		t.Fatal("Enter was not sent after the echo probe passed")
	}
	if captures := countCalls(ft.callStream(), "capture-pane"); captures != 3 {
		t.Fatalf("captures = %d, want baseline + echo + one observation", captures)
	}
	if len(ft.keysSent) != 0 {
		t.Fatalf("recovery keys sent after status churn: %v", ft.keysSent)
	}
}

func TestSendObservationWaitsForFourthChangedFrame(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	pre := "pane\n❯ hello"
	ft := &fakeTmux{captureResults: []string{"pane\n❯ ", pre, pre, pre, pre, "pane\nhello\nworking"}}

	if err := NewEngine("rk-send-patient").Send(context.Background(), ft, "default", "%5", "hello", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if captures := countCalls(ft.callStream(), "capture-pane"); captures != 6 {
		t.Fatalf("captures = %d, want baseline + echo + four observations", captures)
	}
}

func TestSendTrapRetriesAfterBaselineMatchedClear(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	pre := "pane\n❯ hello"
	ft := &fakeTmux{captureResults: []string{
		"pane\n❯ ", pre,
		pre, pre, pre, pre, pre,
		"pane\n❯ ",
		pre,
		"pane\nhello\nworking",
	}}

	if err := NewEngine("rk-send-retry").Send(context.Background(), ft, "default", "%5", "hello", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	calls := ft.callStream()
	if countCalls(calls, "paste-buffer") != 2 || countCalls(calls, "send-keys") != 2 {
		t.Fatalf("calls = %v, want two pastes and two Enters", calls)
	}
	if countCalls(calls, "send-keys C-u") != 1 {
		t.Fatalf("calls = %v, want one baseline-matching clear", calls)
	}
}

func TestSendRetryExhaustionIsUnverified(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	pre := "pane\n❯ hello"
	ft := &fakeTmux{
		captureResult: pre,
		captureResults: []string{
			"pane\n❯ ", pre,
			pre, pre, pre, pre, pre,
			"pane\n❯ ", pre,
			pre, pre, pre,
		},
	}

	err := NewEngine("rk-send-retry").Send(context.Background(), ft, "default", "%5", "hello", true)
	var unverified SubmitUnverified
	if !errors.As(err, &unverified) {
		t.Fatalf("err = %v, want SubmitUnverified", err)
	}
	var probeFailure ProbeFailure
	if errors.As(err, &probeFailure) {
		t.Fatalf("err = %v, must remain distinct from ProbeFailure", err)
	}
	if captures := countCalls(ft.callStream(), "capture-pane"); captures != 12 {
		t.Fatalf("captures = %d, want baseline + two echo probes + five initial observations + one clear + three retry observations", captures)
	}
}

func TestSendInconclusiveDoesNotRetry(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	SubmitBackoff = nil
	ft := &fakeTmux{captureResults: []string{"pane\n❯ ", "pane\n❯ hello"}}

	err := NewEngine("rk-send-inconclusive").Send(context.Background(), ft, "default", "%5", "hello", true)
	var unverified SubmitUnverified
	if !errors.As(err, &unverified) {
		t.Fatalf("err = %v, want SubmitUnverified", err)
	}
	calls := ft.callStream()
	if countCalls(calls, "paste-buffer") != 1 || countCalls(calls, "send-keys C-u") != 0 {
		t.Fatalf("calls = %v, inconclusive submit must not clear or re-paste", calls)
	}
}

func TestSendMultilineClearRequiresBaselineEquality(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	baseline := "pane\n❯ "
	pre := "pane\n❯ first\nsecond\nthird"
	ft := &fakeTmux{captureResults: []string{
		baseline, pre,
		pre, pre, pre, pre, pre,
		"pane\n❯ first\nsecond", "pane\n❯ first", baseline,
		pre, "pane\nhello\nworking",
	}}

	if err := NewEngine("rk-send-clear").Send(context.Background(), ft, "default", "%5", "first\nsecond\nthird", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	calls := ft.callStream()
	if got := countCalls(calls, "send-keys C-u"); got != 3 {
		t.Fatalf("clear attempts = %d, want one per staged line", got)
	}
	thirdClear, secondPaste, clears, pastes := -1, -1, 0, 0
	for i, call := range calls {
		switch call {
		case "send-keys C-u":
			clears++
			if clears == 3 {
				thirdClear = i
			}
		case "paste-buffer":
			pastes++
			if pastes == 2 {
				secondPaste = i
			}
		}
	}
	if thirdClear < 0 || secondPaste <= thirdClear {
		t.Fatalf("calls = %v, second paste occurred before baseline equality", calls)
	}
}

func TestSendClearExhaustionNeverRepastes(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	baseline := "pane\n❯ "
	pre := "pane\n❯ first\nsecond\nthird"
	ft := &fakeTmux{captureResults: []string{
		baseline, pre,
		pre, pre, pre, pre, pre,
		"pane\n❯ first\nsecond", "pane\n❯ first", "pane\n❯ first", "pane\n❯ first",
	}}

	err := NewEngine("rk-send-clear").Send(context.Background(), ft, "default", "%5", "first\nsecond\nthird", true)
	var unverified SubmitUnverified
	if !errors.As(err, &unverified) {
		t.Fatalf("err = %v, want SubmitUnverified", err)
	}
	calls := ft.callStream()
	if countCalls(calls, "paste-buffer") != 1 || countCalls(calls, "set-buffer") != 1 {
		t.Fatalf("calls = %v, a composer that never cleared was re-pasted", calls)
	}
	if countCalls(calls, "send-keys C-u") != ClearAttempts {
		t.Fatalf("calls = %v, want the full clear budget", calls)
	}
}

func TestSendSubmittedTranscriptNeverRepastes(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	baseline := "pane\n❯ "
	pre := "pane\n❯ hello"
	transcript := "pane\nhello\n❯ "
	ft := &fakeTmux{captureResults: []string{
		baseline, pre,
		pre, pre, pre, pre, pre,
		transcript, transcript, transcript, transcript,
	}}

	err := NewEngine("rk-send-transcript").Send(context.Background(), ft, "default", "%5", "hello", true)
	var unverified SubmitUnverified
	if !errors.As(err, &unverified) {
		t.Fatalf("err = %v, want SubmitUnverified", err)
	}
	calls := ft.callStream()
	if countCalls(calls, "paste-buffer") != 1 || countCalls(calls, "set-buffer") != 1 {
		t.Fatalf("calls = %v, submitted transcript triggered a second paste", calls)
	}
}

func TestSendCancellationDuringVerification(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ctx, cancel := context.WithCancel(context.Background())
	ft := &fakeTmux{
		captureResults: []string{"pane\n❯ ", "pane\n❯ hello"},
		enterHook:      cancel,
	}

	err := NewEngine("rk-send-cancel").Send(ctx, ft, "default", "%5", "hello", true)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want wrapped context cancellation", err)
	}
	var unverified SubmitUnverified
	if !errors.As(err, &unverified) {
		t.Fatalf("err = %v, want SubmitUnverified", err)
	}
}

func TestSendVerificationCaptureErrorPropagates(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	wantErr := errors.New("capture failed")
	ft := &fakeTmux{
		captureResults: []string{"pane\n❯ ", "pane\n❯ hello"},
		captureErrs:    []error{nil, nil, wantErr},
	}

	err := NewEngine("rk-send-error").Send(context.Background(), ft, "default", "%5", "hello", true)
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want observation capture error", err)
	}
	var unverified SubmitUnverified
	if !errors.As(err, &unverified) {
		t.Fatalf("err = %v, want SubmitUnverified", err)
	}
}

func TestSendRetryFailureClassification(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	wantErr := errors.New("retry failed")
	baseline := "pane\n❯ "
	preFrame := "pane\n❯ hello"
	retryCaptures := func() []string {
		captures := []string{baseline, preFrame}
		for range SubmitBackoff {
			captures = append(captures, preFrame)
		}
		return append(captures, baseline, preFrame)
	}

	t.Run("probe capture after repaste is staged", func(t *testing.T) {
		captures := retryCaptures()
		errs := make([]error, len(captures))
		errs[len(errs)-1] = wantErr
		ops := &fakeTmux{captureResults: captures, captureErrs: errs}
		err := NewEngine("rk-send-retry-probe").Send(context.Background(), ops, "default", "%5", "hello", true)
		var staged StagedSendFailure
		if !errors.As(err, &staged) || !errors.Is(err, wantErr) {
			t.Fatalf("err = %v, want StagedSendFailure wrapping %v", err, wantErr)
		}
	})

	t.Run("retry Enter failure is staged", func(t *testing.T) {
		ops := &fakeTmux{captureResults: retryCaptures(), enterErrs: []error{nil, wantErr}}
		err := NewEngine("rk-send-retry-enter").Send(context.Background(), ops, "default", "%5", "hello", true)
		var staged StagedSendFailure
		if !errors.As(err, &staged) || !errors.Is(err, wantErr) {
			t.Fatalf("err = %v, want StagedSendFailure wrapping %v", err, wantErr)
		}
	})

	t.Run("verification failure after retry Enter is unverified", func(t *testing.T) {
		captures := retryCaptures()
		captures = append(captures, preFrame)
		errs := make([]error, len(captures))
		errs[len(errs)-1] = wantErr
		ops := &fakeTmux{captureResults: captures, captureErrs: errs}
		err := NewEngine("rk-send-retry-verify").Send(context.Background(), ops, "default", "%5", "hello", true)
		var unverified SubmitUnverified
		if !errors.As(err, &unverified) || !errors.Is(err, wantErr) {
			t.Fatalf("err = %v, want SubmitUnverified wrapping %v", err, wantErr)
		}
	})

	t.Run("clear failure after initial Enter is unverified", func(t *testing.T) {
		captures := retryCaptures()
		ops := &fakeTmux{captureResults: captures[:len(captures)-2], keyErr: wantErr}
		err := NewEngine("rk-send-retry-clear").Send(context.Background(), ops, "default", "%5", "hello", true)
		var unverified SubmitUnverified
		if !errors.As(err, &unverified) || !errors.Is(err, wantErr) {
			t.Fatalf("err = %v, want SubmitUnverified wrapping %v", err, wantErr)
		}
	})
}

// A repaint is provider-neutral evidence only that the observation phase must
// make no claim and preserve the pre-existing success behavior.
func TestVerifySubmitClassifiesChangesAsNoClaim(t *testing.T) {
	fastSubmit(t)
	tests := []struct {
		name string
		pre  string
		post string
	}{
		{"bare composer", "log\n❯ hello", "log\nhello\nworking"},
		{"boxed composer", "┌ input ┐\n│ hello │\n└───────┘", "┌ input ┐\n│       │\n└───────┘"},
		{"collapsed paste", "❯ [Pasted text #2 +4 lines]", "submitted\n◐ working"},
		{"status line only", "hello\nstatus: ready", "hello\nstatus: working"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ft := &fakeTmux{captureResults: []string{tt.post}}
			verdict, err := verifySubmit(context.Background(), ft, "default", "%5", tt.pre, Needle("hello"), false, false, 0, []time.Duration{time.Millisecond})
			if err != nil {
				t.Fatalf("verifySubmit: %v", err)
			}
			if verdict != observationNoClaim {
				t.Fatalf("verdict = %v, want no claim", verdict)
			}
		})
	}
}

func TestVerifySubmitEvidenceUsesProbePredicate(t *testing.T) {
	needle := Needle("please review the implementation")
	tests := []struct {
		name  string
		frame string
		want  observationVerdict
	}{
		{"collapsed paste chip", "pane\n❯ [Pasted text #3 +4 lines]", observationNonSubmission},
		{"raw echo without chip", "pane\n❯ please review the implementation", observationNonSubmission},
		{"no chip or raw echo", "pane\n❯ ", observationInconclusive},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ft := &fakeTmux{captureResults: []string{tt.frame}}
			verdict, err := verifySubmit(context.Background(), ft, "default", "%5", tt.frame, needle, true, false, 0, []time.Duration{time.Millisecond})
			if err != nil {
				t.Fatalf("verifySubmit: %v", err)
			}
			if verdict != tt.want {
				t.Fatalf("verdict = %v, want %v", verdict, tt.want)
			}
		})
	}
}

func TestSanitize(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain text unchanged", "hello world", "hello world"},
		{"newline preserved", "line one\nline two", "line one\nline two"},
		{"tab preserved", "col1\tcol2", "col1\tcol2"},
		{"CRLF normalized to LF", "line one\r\nline two", "line one\nline two"},
		{"lone CR normalized to LF", "line one\rline two", "line one\nline two"},
		{"ESC stripped leaving inert 201~", "before\x1b[201~after", "before[201~after"},
		{"NUL stripped", "a\x00b", "ab"},
		{"BEL stripped", "a\x07b", "ab"},
		{"DEL stripped", "a\x7fb", "ab"},
		{"C1 CSI stripped", "a\u009bb", "ab"},
		{"other C1 stripped", "a\u0085b", "ab"},
		{"emoji preserved", "ship it 🚀", "ship it 🚀"},
		{"all-control collapses to empty", "\x1b\x00\x07\x7f\u009b", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Sanitize(tt.in); got != tt.want {
				t.Errorf("Sanitize(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestNeedle(t *testing.T) {
	tests := []struct {
		name string
		text string
		want string
	}{
		{"single line", "hello world", "helloworld"},
		{"last non-empty line wins", "first\nsecond line\n\n", "secondline"},
		{"length-capped from the end", strings.Repeat("a", 100), strings.Repeat("a", NeedleMaxLen)},
		{"whitespace stripped", "  spaced   out  ", "spacedout"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Needle(tt.text); got != tt.want {
				t.Errorf("Needle(%q) = %q, want %q", tt.text, got, tt.want)
			}
		})
	}
}

// TestCountOccurrences pins the counting rules the baseline-comparison probe
// rests on: raw needle, collapsible-gated placeholder (BOTH chip forms),
// imageish-gated image chip, ANSI/whitespace normalization.
func TestCountOccurrences(t *testing.T) {
	needle := Needle("please run the tests")
	tests := []struct {
		name        string
		capture     string
		collapsible bool
		imageish    bool
		want        int
	}{
		{"echo present once", "❯ please run the tests", false, false, 1},
		{"echo absent", "unrelated scrollback\n❯ ", false, false, 0},
		{"echo present twice", "❯ please run the tests\n❯ please run the tests", false, false, 2},
		{"wrapped across rows", "❯ please run the\n  tests", false, false, 1},
		{"ansi-styled echo", "\x1b[1m❯\x1b[0m please run \x1b[32mthe tests\x1b[0m", false, false, 1},
		{"multiline chip counted when collapsible", "❯ [Pasted text #1 +12 lines]", true, false, 1},
		{"multiline chip ignored when not collapsible", "❯ [Pasted text #1 +12 lines]", false, false, 0},
		{"suffix-less chip counted when collapsible", "❯ [Pasted text #7]", true, false, 1},
		{"suffix-less chip ignored when not collapsible", "❯ [Pasted text #7]", false, false, 0},
		{"placeholder singular line", "❯ [Pasted text #3 +1 line]", true, false, 1},
		{"ansi-styled placeholder", "\x1b[2m[Pasted text #2 +40 lines]\x1b[0m", true, false, 1},
		{"two chips both forms", "[Pasted text #1 +2 lines]\n[Pasted text #2]", true, false, 2},
		{"non-placeholder bracketed text", "❯ [some other note]", true, false, 0},
		{"codex chip counted when collapsible", "› [Pasted Content 1433 chars]", true, false, 1},
		{"codex chip ignored when not collapsible", "› [Pasted Content 1433 chars]", false, false, 0},
		{"codex numbered repeats counted independently", "› [Pasted Content 1433 chars][Pasted Content 1433 chars] #2[Pasted Content 1433 chars] #3", true, false, 3},
		{"codex chip singular char", "› [Pasted Content 1 char]", true, false, 1},
		{"ansi-styled codex chip", "\x1b[2m[Pasted Content 1433 chars]\x1b[0m", true, false, 1},
		{"codex chip wrapped mid-marker", "› [Pasted Content 1433\n  chars] #2", true, false, 1},
		{"codex chip inside border", "│ › [Pasted Content 1433 chars] │\n╰────────╯", true, false, 1},
		{"agy chip with char count", "> [Pasted text #1 1426 chars]", true, false, 1},
		{"agy numbered repeat chips", "> [Pasted text #1 1426 chars][Pasted text #2 1426 chars]", true, false, 2},
		{"agy chip ignored when not collapsible", "> [Pasted text #1 1426 chars]", false, false, 0},
		{"kimi chip counted when collapsible", "│ > [paste #1 1426 chars] │", true, false, 1},
		{"kimi chip ignored when not collapsible", "│ > [paste #1 1426 chars] │", false, false, 0},
		{"kimi numbered repeat chip", "│ > [paste #2 1426 chars] │", true, false, 1},
		{"opencode chip counted when collapsible", "┃ [Pasted ~1 lines]", true, false, 1},
		{"opencode chip ignored when not collapsible", "┃ [Pasted ~1 lines]", false, false, 0},
		{"opencode multiline chip", "┃ [Pasted ~12 lines]", true, false, 1},
		{"gemini character-count chip", "> [Pasted Text: 1433 chars]", true, false, 1},
		{"gemini multiline chip", "> [Pasted Text: 20 lines]", true, false, 1},
		{"gemini repeated character-count chips", "[Pasted Text: 1433 chars][Pasted Text: 1433 chars #2]", true, false, 2},
		{"gemini repeated multiline chips", "[Pasted Text: 20 lines][Pasted Text: 20 lines #2]", true, false, 2},
		{"gemini chip ignored when not collapsible", "> [Pasted Text: 1433 chars]", false, false, 0},
		{"gemini chip not counted by imageish alone", "> [Pasted Text: 1433 chars]", false, true, 0},
		{"gemini styled wrapped chip", "\x1b[2m[Pasted Text: 1433\n chars #2]\x1b[0m", true, false, 1},
		{"claude chip not inflated by codex suffix", "❯ [Pasted text #7] #2", true, false, 1},
		{"image chip counted when imageish", "❯ [Image #1]", false, true, 1},
		{"image chip ignored when not imageish", "❯ [Image #1]", false, false, 0},
		{"image chip ignored under collapsible alone", "❯ [Image #1]", true, false, 0},
		{"paste chip not counted by imageish alone", "❯ [Pasted text #7]", false, true, 0},
		{"ansi-styled image chip", "\x1b[2m[Image #4]\x1b[0m", false, true, 1},
		{"two image chips", "[Image #1]\n❯ [Image #2]", false, true, 2},
		{"needle and image chip add", "❯ please run the tests\n❯ [Image #3]", false, true, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CountOccurrences(tt.capture, needle, tt.collapsible, tt.imageish); got != tt.want {
				t.Errorf("CountOccurrences(%q, %q, collapsible=%v, imageish=%v) = %d, want %d", tt.capture, needle, tt.collapsible, tt.imageish, got, tt.want)
			}
		})
	}
}

// TestStripForProbeDropsFrameGlyphs pins the frame-glyph tolerance: every rune
// in the adjacent Box Drawing (U+2500–U+257F) and Block Elements
// (U+2580–U+259F) blocks is removed alongside whitespace, while everything
// outside the ranges — prompt glyphs, CJK, emoji, and the bordering
// U+249F/U+25A0 — is retained.
func TestStripForProbeDropsFrameGlyphs(t *testing.T) {
	if got := stripForProbe("│ > #rk-ready-probe │\n└────┘ ░▒▓ keep > # 日本語 🚀"); got != ">#rk-ready-probekeep>#日本語🚀" {
		t.Errorf("stripForProbe = %q, want frame glyphs and whitespace gone, content kept", got)
	}
	if got := stripForProbe("a├─b▀▄c"); got != "abc" {
		t.Errorf("stripForProbe = %q, want mid-string frame glyphs dropped", got)
	}
	if got := stripForProbe("x\u249Fy\u25A0z"); got != "x\u249Fy\u25A0z" {
		t.Errorf("stripForProbe = %q, want runes bordering the ranges (U+249F/U+25A0) retained", got)
	}
}

// TestCountOccurrencesWrappedInBorder pins the wrapped-in-border fixtures: a
// TUI composer narrow enough to reflow its border around the wrapped sentinel
// interleaves frame glyphs mid-needle, and novelty counting still sees the
// echo (and a stale occurrence above it).
func TestCountOccurrencesWrappedInBorder(t *testing.T) {
	fixture := "│ > #rk-ready-   │\n│ probe          │"
	if got := CountOccurrences(fixture, "#rk-ready-probe", false, false); got != 1 {
		t.Errorf("CountOccurrences(wrapped fixture) = %d, want 1", got)
	}
	stale := "last probe: #rk-ready-probe\n" + fixture
	if got := CountOccurrences(stale, "#rk-ready-probe", false, false); got != 2 {
		t.Errorf("CountOccurrences(stale + wrapped) = %d, want 2 (novelty counting intact)", got)
	}
}

// TestCountOccurrencesChipInsideBorder: the collapse/image chip patterns carry
// no frame-glyph runes, so a chip rendered inside a bordered composer still
// matches under the shared normalization.
func TestCountOccurrencesChipInsideBorder(t *testing.T) {
	paste := "╭────────────────────────╮\n│ ❯ [Pasted text #2 +5 lines] │\n╰────────────────────────╯"
	if got := CountOccurrences(paste, "anything", true, false); got != 1 {
		t.Errorf("CountOccurrences(paste chip in border) = %d, want 1", got)
	}
	image := "│ ❯ [Image #3] │\n└──────────────┘"
	if got := CountOccurrences(image, "anything", false, true); got != 1 {
		t.Errorf("CountOccurrences(image chip in border) = %d, want 1", got)
	}
}

func TestNeedleFrameOnlyLineSkipped(t *testing.T) {
	// A last line that strips to empty (a pure frame row) is skipped in favor
	// of the previous non-empty line — the empty-line rule, now reachable via
	// frame glyphs.
	if got := Needle("hello\n└────┘"); got != "hello" {
		t.Errorf("Needle = %q, want it derived from the previous non-empty line", got)
	}
}

func TestSendFrameOnlyMessageFailsClosed(t *testing.T) {
	// A message consisting only of frame glyphs yields an empty needle, and the
	// empty-needle guard fails closed before the buffer is touched.
	ft := &fakeTmux{}
	err := NewEngine("rk-test").Send(context.Background(), ft, "default", "%5", "└────┘", true)
	var probeErr ProbeFailure
	if !errors.As(err, &probeErr) {
		t.Fatalf("Send() error = %v, want ProbeFailure", err)
	}
	if got := countCalls(ft.callStream(), "set-buffer"); got != 0 {
		t.Errorf("set-buffer calls = %d, want 0 (fail closed before touching the buffer)", got)
	}
}

// TestIsBareImagePath pins the image-chip gate: only a whitespace-trimmed
// single line ending in a recognized image extension qualifies — the one paste
// shape the TUI may render as an "[Image #N]" chip.
func TestIsBareImagePath(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{"bare png path", "/wt/.uploads/260904-shot.png", true},
		{"bare jpg path", "/wt/.uploads/a.jpg", true},
		{"bare jpeg path", "/wt/.uploads/a.jpeg", true},
		{"bare gif path", "/wt/.uploads/a.gif", true},
		{"bare webp path", "/wt/.uploads/a.webp", true},
		{"uppercase extension", "/wt/.uploads/SHOT.PNG", true},
		{"trailing newline trimmed", "/wt/.uploads/a.png\n", true},
		{"surrounding whitespace trimmed", "  /wt/.uploads/a.png\t", true},
		{"path with spaces", "/wt/.uploads/screen shot 1.png", true},
		{"relative path", "shot.png", true},
		{"svg excluded", "/wt/.uploads/a.svg", false},
		{"bmp excluded", "/wt/.uploads/a.bmp", false},
		{"mixed text and path", "look at /wt/.uploads/a.png please", false},
		{"two newline-separated paths", "/a/b.png\n/c/d.jpg", false},
		{"extension not at end", "/wt/.uploads/a.png.txt", false},
		{"empty", "", false},
		{"whitespace only", " \n\t", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isBareImagePath(tt.text); got != tt.want {
				t.Errorf("isBareImagePath(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

// TestSendImageChipEcho covers the imageish echo arm end to end: a bare
// image-path paste the TUI renders as an "[Image #N]" chip (never the raw
// path) passes the probe via the chip, a stale chip stays a baseline floor,
// a fresh chip beats a stale one, and a raw-text echo (the file does not
// exist, so no chip renders) still passes via the needle arm.
func TestSendImageChipEcho(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	const path = "/wt/.uploads/260904-121530-shot.png"

	t.Run("fresh chip passes without raw echo", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"❯ ", "❯ [Image #1]", "working"}}
		if err := NewEngine("rk-img-fresh").Send(context.Background(), ft, "default", "%5", path, true); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if !ft.enterCalled {
			t.Fatal("Enter was not sent after a fresh image chip")
		}
	})

	t.Run("stale chip is a floor to beat", func(t *testing.T) {
		ft := &fakeTmux{captureResult: "❯ [Image #1]"}
		err := NewEngine("rk-img-stale").Send(context.Background(), ft, "default", "%5", path, true)
		var pf ProbeFailure
		if !errors.As(err, &pf) {
			t.Fatalf("err = %v, want ProbeFailure", err)
		}
		if ft.enterCalled {
			t.Fatal("Enter sent on a stale image chip")
		}
	})

	t.Run("fresh chip beats a stale one", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"sent [Image #1]\n❯ ", "sent [Image #1]\n❯ [Image #2]", "working"}}
		if err := NewEngine("rk-img-incr").Send(context.Background(), ft, "default", "%5", path, true); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if !ft.enterCalled {
			t.Fatal("Enter was not sent after the count rose past the stale chip")
		}
	})

	t.Run("raw echo still passes for an imageish paste", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"❯ ", "❯ " + path, "working"}}
		if err := NewEngine("rk-img-raw").Send(context.Background(), ft, "default", "%5", path, true); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if !ft.enterCalled {
			t.Fatal("Enter was not sent after a raw-needle echo of an image path")
		}
	})

	t.Run("chip does not pass a non-imageish paste", func(t *testing.T) {
		ft := &fakeTmux{captureResult: "❯ [Image #1]"}
		err := NewEngine("rk-img-plain").Send(context.Background(), ft, "default", "%5", "hello world", true)
		var pf ProbeFailure
		if !errors.As(err, &pf) {
			t.Fatalf("err = %v, want ProbeFailure", err)
		}
		if ft.enterCalled {
			t.Fatal("Enter sent for plain text on the strength of an image chip")
		}
	})
}

// TestSendCodexChipEcho covers the Codex paste-collapse arm end to end: a
// fresh "[Pasted Content N chars]" chip (the TUI replaces a long paste with
// the chip, never echoing the raw text) passes the novelty probe and
// authorizes Enter for submit=true; a stale chip already in the baseline stays
// a floor to beat; numbered repeats of an identical payload are counted
// independently; submit=false leaves the verified paste staged with no Enter;
// and a second send right after a successful submission passes on the fresh
// repeat chip.
func TestSendCodexChipEcho(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	payload := strings.Repeat("p", 1433)
	chip := "[Pasted Content 1433 chars]"

	t.Run("fresh chip passes without raw echo", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"› ", "› " + chip, "working"}}
		if err := NewEngine("rk-cdx-fresh").Send(context.Background(), ft, "default", "%5", payload, true); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if !ft.enterCalled {
			t.Fatal("Enter was not sent after a fresh Codex chip")
		}
	})

	t.Run("stale chip is a floor to beat", func(t *testing.T) {
		ft := &fakeTmux{captureResult: "› " + chip}
		err := NewEngine("rk-cdx-stale").Send(context.Background(), ft, "default", "%5", payload, true)
		var pf ProbeFailure
		if !errors.As(err, &pf) {
			t.Fatalf("err = %v, want ProbeFailure", err)
		}
		if ft.enterCalled {
			t.Fatal("Enter sent on a stale Codex chip")
		}
	})

	t.Run("numbered repeat beats the stale chip", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{
			"sent › " + chip,
			"sent › " + chip + chip + " #2",
			"working",
		}}
		if err := NewEngine("rk-cdx-repeat").Send(context.Background(), ft, "default", "%5", payload, true); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if !ft.enterCalled {
			t.Fatal("Enter was not sent after the numbered repeat chip")
		}
	})

	t.Run("insert-only leaves a fresh chip staged", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{"› ", "› " + chip}}
		if err := NewEngine("rk-cdx-insert").Send(context.Background(), ft, "default", "%5", payload, false); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if ft.enterCalled {
			t.Fatal("Enter sent despite submit=false")
		}
	})

	t.Run("successive submits each pass on a fresh chip", func(t *testing.T) {
		ft := &fakeTmux{captureResults: []string{
			"› ", "› " + chip, "turn one reply\n› ",
			"turn one reply\n› ", "› " + chip + " #2", "turn two reply\n› ",
		}}
		e := NewEngine("rk-cdx-twice")
		if err := e.Send(context.Background(), ft, "default", "%5", payload, true); err != nil {
			t.Fatalf("first Send: %v", err)
		}
		if err := e.Send(context.Background(), ft, "default", "%5", payload, true); err != nil {
			t.Fatalf("second Send: %v", err)
		}
		if got := countCalls(ft.callStream(), "send-keys"); got != 2 {
			t.Fatalf("Enter count = %d, want 2 (one per successive submission)", got)
		}
	})

	t.Run("non-submission evidence accepts the codex chip", func(t *testing.T) {
		frame := "› " + chip
		fv := &fakeTmux{captureResults: []string{frame}}
		verdict, err := verifySubmit(context.Background(), fv, "default", "%5", frame, Needle(payload), true, false, 0, []time.Duration{time.Millisecond})
		if err != nil {
			t.Fatalf("verifySubmit: %v", err)
		}
		if verdict != observationNonSubmission {
			t.Fatalf("verdict = %v, want non-submission (chip still present on an unchanged frame)", verdict)
		}
	})
}

// TestSendObservedAgentChipEchoes verifies that observed provider chips
// authorize Enter only as fresh evidence of a collapsible paste.
func TestSendObservedAgentChipEchoes(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	payload := strings.Repeat("p", 1433)
	for _, tt := range []struct {
		name, chip, text string
	}{
		{"kimi", "[paste #1 1433 chars]", payload},
		{"agy", "[Pasted text #1 1433 chars]", payload},
		{"opencode", "[Pasted ~1 lines]", payload},
		{"gemini characters", "[Pasted Text: 1433 chars]", payload},
		{"gemini lines", "[Pasted Text: 20 lines]", strings.Repeat("row\n", 19) + "row"},
	} {
		t.Run(tt.name+" fresh chip passes", func(t *testing.T) {
			ft := &fakeTmux{captureResults: []string{"> ", "> " + tt.chip, "working"}}
			if err := NewEngine("rk-chip-"+tt.name).Send(context.Background(), ft, "default", "%5", tt.text, true); err != nil {
				t.Fatalf("Send: %v", err)
			}
			if !ft.enterCalled {
				t.Fatal("Enter was not sent after a fresh chip")
			}
		})
		t.Run(tt.name+" stale chip fails closed", func(t *testing.T) {
			ft := &fakeTmux{captureResult: "> " + tt.chip}
			err := NewEngine("rk-chip-stale-"+tt.name).Send(context.Background(), ft, "default", "%5", tt.text, true)
			var pf ProbeFailure
			if !errors.As(err, &pf) {
				t.Fatalf("err = %v, want ProbeFailure", err)
			}
			if ft.enterCalled {
				t.Fatal("Enter sent on a stale chip")
			}
		})
		t.Run(tt.name+" insert-only stays staged", func(t *testing.T) {
			ft := &fakeTmux{captureResults: []string{"> ", "> " + tt.chip}}
			if err := NewEngine("rk-chip-insert").Send(context.Background(), ft, "default", "%5", tt.text, false); err != nil {
				t.Fatalf("Send: %v", err)
			}
			if ft.enterCalled {
				t.Fatal("Enter sent despite submit=false")
			}
		})
	}
}

// A repeated Gemini chip puts its counter inside the brackets. The old chip
// remains the baseline; only the additional occurrence authorizes submission.
func TestSendGeminiRepeatedChipEcho(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	chip := "[Pasted Text: 1433 chars]"
	ft := &fakeTmux{captureResults: []string{
		"> " + chip,
		"> " + chip + "[Pasted Text: 1433 chars #2]",
		"working",
	}}
	if err := NewEngine("rk-gemini-repeat").Send(context.Background(), ft, "default", "%5", strings.Repeat("p", 1433), true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if got := countCalls(ft.callStream(), "send-keys"); got != 1 {
		t.Fatalf("Enter count = %d, want 1", got)
	}
}

// TestPopupNewlyOpen: the pure strict-increase detection table — a marker is a
// trigger only when its count rose vs the floor, and matching is
// whitespace-insensitive through the shared stripForProbe normalization.
func TestPopupNewlyOpen(t *testing.T) {
	popup := "› $fab-operator\nPress enter to insert or esc to close"
	for _, tc := range []struct {
		name         string
		frame, floor string
		want         bool
	}{
		{"popup newly visible", popup, "❯ ", true},
		{"no marker anywhere", "› $fab-operator", "❯ ", false},
		{"stale marker in floor", popup, "Press enter to insert or esc to close\n❯ ", false},
		{"wrapped marker still matches", "Press enter\nto insert", "❯ ", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := popupNewlyOpen(tc.frame, tc.floor); got != tc.want {
				t.Errorf("popupNewlyOpen = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestSendPopupGuardConsumesPopup: a paste that opens a composer popup (codex
// bare-skill-token autocomplete) gets exactly one extra Enter before the submit
// Enter, and verifySubmit baselines on the fresh post-popup capture — never on
// the popup frame, whose disappearance would read as submission evidence.
func TestSendPopupGuardConsumesPopup(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{
		"❯ ",
		"❯ $fab-operator\nPress enter to insert or esc to close",
		"❯ $fab-operator",
		"› $fab-operator\n• Working",
	}}
	e := NewEngine("rk-popup-1")

	if err := e.Send(context.Background(), ft, "default", "%5", "$fab-operator", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	want := []string{
		"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer",
		"capture-pane", // echo probe (popup visible)
		"send-keys",    // popup-consuming Enter
		"capture-pane", // fresh preFrame after the popup closed
		"send-keys",    // submit Enter
		"capture-pane", // observation (changed frame → no claim)
	}
	if got := strings.Join(ft.callStream(), ","); got != strings.Join(want, ",") {
		t.Errorf("call order = %v, want %v", got, want)
	}
}

// TestSendPopupStaleMarkerDoesNotFire: a marker already present in the pre-paste
// baseline (stale popup copy in scrollback) is a floor to beat — the guard adds
// nothing and the call sequence stays byte-identical to the guardless engine
// (TestSendOrderAndEnter pins the same shape for marker-free frames).
func TestSendPopupStaleMarkerDoesNotFire(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	stale := "Press enter to insert or esc to close\n❯ "
	ft := &fakeTmux{captureResults: []string{
		stale,
		"Press enter to insert or esc to close\n❯ $fab-operator",
		"› $fab-operator\n• Working",
	}}
	e := NewEngine("rk-popup-2")

	if err := e.Send(context.Background(), ft, "default", "%5", "$fab-operator", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	want := []string{"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer", "capture-pane", "send-keys", "capture-pane"}
	if got := strings.Join(ft.callStream(), ","); got != strings.Join(want, ",") {
		t.Errorf("call order = %v, want %v (guard must not fire)", got, want)
	}
}

// TestSendInsertLeavesPopupUntouched: submit=false never runs the guard — the
// text stays staged and the popup stays open for the human to resolve.
func TestSendInsertLeavesPopupUntouched(t *testing.T) {
	fastProbe(t)
	ft := &fakeTmux{captureResults: []string{
		"❯ ",
		"❯ $fab-operator\nPress enter to insert or esc to close",
	}}
	e := NewEngine("rk-popup-3")

	if err := e.Send(context.Background(), ft, "default", "%5", "$fab-operator", false); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if ft.enterCalled {
		t.Error("Enter sent despite submit=false with a popup open")
	}
}

// TestSendPopupGuardEnterFailureIsStaged: a refused popup-consuming Enter is a
// post-paste, pre-submit infrastructure failure — StagedSendFailure, keeping the
// ProbeFailure / StagedSendFailure / SubmitUnverified taxonomy distinct.
func TestSendPopupGuardEnterFailureIsStaged(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{
		captureResults: []string{
			"❯ ",
			"❯ $fab-operator\nPress enter to insert or esc to close",
		},
		enterErrs: []error{errors.New("tmux exploded")},
	}
	e := NewEngine("rk-popup-4")

	err := e.Send(context.Background(), ft, "default", "%5", "$fab-operator", true)
	var staged StagedSendFailure
	if !errors.As(err, &staged) {
		t.Fatalf("err = %v, want StagedSendFailure", err)
	}
	if got := countCalls(ft.callStream(), "send-keys"); got != 1 {
		t.Errorf("send-keys calls = %d, want 1 (no submit Enter after a failed popup Enter)", got)
	}
}

// TestSendRetryPopupReopenedConsumed: the recovery re-paste can reopen the
// popup; the retry path consumes it against its own cleared-frame floor before
// its submit Enter.
func TestSendRetryPopupReopenedConsumed(t *testing.T) {
	fastProbe(t)
	fastSubmit(t)
	ft := &fakeTmux{captureResults: []string{
		"❯ ",              // baseline
		"❯ $fab-operator", // echo probe, no popup on the first pass
		// five unchanged observation frames with the needle still present →
		// non-submission verdict → recovery
		"❯ $fab-operator", "❯ $fab-operator", "❯ $fab-operator", "❯ $fab-operator", "❯ $fab-operator",
		"❯ ", // C-u clear back to baseline
		"❯ $fab-operator\nPress enter to insert or esc to close", // retry probe: popup reopened
		"❯ $fab-operator",            // fresh preFrame after popup Enter
		"› $fab-operator\n• Working", // retry observation: changed → no claim
	}}
	e := NewEngine("rk-popup-5")

	if err := e.Send(context.Background(), ft, "default", "%5", "$fab-operator", true); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if got := countCalls(ft.callStream(), "send-keys"); got != 3 {
		t.Errorf("Enter count = %d, want 3 (initial submit, retry popup-consume, retry submit)", got)
	}
	if got := countCalls(ft.callStream(), "send-keys C-u"); got != 1 {
		t.Errorf("C-u count = %d, want 1 (one clear before the re-paste)", got)
	}
}
