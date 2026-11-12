package operatorloop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// exec.go — the body of the hidden `rk operator run-exec` wrapper: it runs
// inside the run window, so it (not the daemon) is the run's parent and the
// only writer of the run's end state. It never touches the cron log — the tick
// transcribes the record it leaves behind.

const (
	// ExecCeiling bounds a hung provider; normal runs take seconds to minutes.
	ExecCeiling = 2 * time.Hour

	// failureTailBytes caps the log tail carried into a failure note.
	failureTailBytes = 200

	// Exit statuses the wrapper records when the child produced none.
	exitStartFailed = 127
	exitTimedOut    = 124

	killWaitDelay = 2 * time.Second

	notifyTitle = "operator run failed"
)

// outcomeLine matches the run's exit-contract line (the LAST one wins).
var outcomeLine = regexp.MustCompile(`^outcome: (.*)$`)

// ExecOptions configures one wrapper invocation.
type ExecOptions struct {
	Server string
	RunID  string
	// Argv is the launcher command, run with the brief on stdin.
	Argv []string
	// Stdout and Stderr are the window's streams; the child's output is
	// tee'd to them and to the run log.
	Stdout, Stderr io.Writer
	// Ceiling overrides ExecCeiling (tests).
	Ceiling time.Duration
	// Notify is the fail-silent push on a failed run; nil sends nothing.
	Notify func(ctx context.Context, title, body string)
}

// ExecResult is what the wrapper recorded.
type ExecResult struct {
	ExitCode int
	Outcome  string
	Failed   bool
}

// Exec runs the launcher for a run: record the start, feed the brief to the
// launcher's stdin, tee its output to the run log, then record the end. A run
// that exits non-zero or prints no outcome line leaves a `run failed` note on
// every changed item still in the ledger and sends a push — the check already
// consumed those items' edges, so nothing else would surface the failure.
func Exec(ctx context.Context, opts ExecOptions) (ExecResult, error) {
	if len(opts.Argv) == 0 {
		return ExecResult{}, errors.New("run-exec needs a launcher command after --")
	}
	dir, err := Dir(ctx, opts.Server)
	if err != nil {
		return ExecResult{}, err
	}
	recPath, err := RecordPath(dir, opts.RunID)
	if err != nil {
		return ExecResult{}, err
	}
	briefPath, _ := BriefPath(dir, opts.RunID)
	logPath, _ := LogPath(dir, opts.RunID)

	if err := UpdateRecord(recPath, func(r *Record) { r.StartedAt = FormatTime(nowTime()) }); err != nil {
		return ExecResult{}, fmt.Errorf("recording run start: %w", err)
	}

	exit, outcome := runLauncher(ctx, opts, briefPath, logPath)
	res := ExecResult{ExitCode: exit, Outcome: outcome, Failed: exit != 0 || outcome == ""}

	rec, _ := ReadRecord(recPath)
	if res.Failed {
		reportFailure(ctx, opts, rec, exit, logPath)
	}
	if err := UpdateRecord(recPath, func(r *Record) {
		r.EndedAt = FormatTime(nowTime())
		r.ExitCode = &exit
		r.Outcome = outcome
	}); err != nil {
		return res, fmt.Errorf("recording run end: %w", err)
	}
	return res, nil
}

// runLauncher executes the launcher and returns its exit status and the last
// `outcome:` line it printed. SIGTERM/SIGHUP/SIGINT (the window being killed)
// stop the child and are recorded like any other end.
func runLauncher(parent context.Context, opts ExecOptions, briefPath, logPath string) (int, string) {
	ceiling := opts.Ceiling
	if ceiling <= 0 {
		ceiling = ExecCeiling
	}
	ctx, stop := signal.NotifyContext(parent, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, ceiling)
	defer cancel()

	logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, fileMode)
	if err != nil {
		fmt.Fprintf(opts.Stderr, "run-exec: opening run log: %v\n", err)
		return exitStartFailed, ""
	}
	defer logFile.Close()
	brief, err := os.Open(briefPath)
	if err != nil {
		fmt.Fprintf(opts.Stderr, "run-exec: opening brief: %v\n", err)
		return exitStartFailed, ""
	}
	defer brief.Close()

	capture := &outcomeCapture{}
	cmd := exec.CommandContext(ctx, opts.Argv[0], opts.Argv[1:]...)
	// The launcher runs in its own process group so a ceiling or a killed
	// window stops its whole tree (a provider spawns children that would
	// otherwise keep the output pipes open); WaitDelay bounds the wait for
	// those pipes after the kill.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = killWaitDelay
	cmd.Stdin = brief
	cmd.Stdout = io.MultiWriter(opts.Stdout, logFile, capture)
	cmd.Stderr = io.MultiWriter(opts.Stderr, logFile)

	err = cmd.Run()
	switch {
	case err == nil:
		return 0, capture.Outcome()
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		fmt.Fprintf(opts.Stderr, "run-exec: launcher exceeded %s\n", ceiling)
		return exitTimedOut, capture.Outcome()
	default:
		return exitStatus(err, opts.Stderr), capture.Outcome()
	}
}

// exitStatus maps a Run error to an exit status: the child's own, 128+signal
// when it was signalled, else a start failure.
func exitStatus(err error, stderr io.Writer) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ee.ExitCode()
	}
	fmt.Fprintf(stderr, "run-exec: starting launcher: %v\n", err)
	return exitStartFailed
}

// reportFailure leaves the failure note on each changed item and pushes a
// fail-silent notification.
func reportFailure(ctx context.Context, opts ExecOptions, rec Record, exit int, logPath string) {
	text := fmt.Sprintf("run failed: exit %d — %s", exit, logTail(logPath))
	if statePath, err := statePathFn(ctx, opts.Server); err == nil {
		NoteFailure(statePath, rec.Changed, text)
	} else {
		slog.Warn("operator loop: no state path for failure notes", "server", opts.Server, "err", err)
	}
	if opts.Notify != nil {
		opts.Notify(ctx, notifyTitle, fmt.Sprintf("%s on %s: %s", rec.ID, opts.Server, text))
	}
}

// logTail is the last failureTailBytes of the run log, whitespace-collapsed to
// one line of valid UTF-8 — a note is one line of text.
func logTail(path string) string {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return "no output"
	}
	if len(data) > failureTailBytes {
		data = data[len(data)-failureTailBytes:]
	}
	tail := strings.Join(strings.Fields(strings.ToValidUTF8(string(data), "")), " ")
	if tail == "" {
		return "no output"
	}
	for len(tail) > failureTailBytes || !utf8.ValidString(tail) {
		tail = tail[:len(tail)-1]
	}
	return tail
}

// outcomeCapture is an io.Writer that remembers the last complete
// `outcome: <text>` line written through it, across arbitrary write splits.
type outcomeCapture struct {
	mu      sync.Mutex
	partial bytes.Buffer
	last    string
}

func (c *outcomeCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.partial.Write(p)
	for {
		line, err := c.partial.ReadString('\n')
		if err != nil {
			// No newline yet: keep the fragment for the next write.
			c.partial.Reset()
			c.partial.WriteString(line)
			return len(p), nil
		}
		c.take(line)
	}
}

// Outcome is the last outcome line, counting a final line with no newline.
func (c *outcomeCapture) Outcome() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.partial.Len() > 0 {
		c.take(c.partial.String())
		c.partial.Reset()
	}
	return c.last
}

func (c *outcomeCapture) take(line string) {
	line = strings.TrimRight(line, "\r\n")
	if m := outcomeLine.FindStringSubmatch(line); m != nil {
		c.last = strings.TrimSpace(m[1])
	}
}
