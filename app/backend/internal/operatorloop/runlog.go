package operatorloop

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"rk/internal/shellq"
)

// runlog.go — the self-log every rk invocation inside a run appends to the
// run's log, so a failing tool call is diagnosable from the log alone. The
// wrapper (exec.go) exports RunLogEnv; cmd/rk's execute() writes the record.

const (
	// RunLogEnv names the absolute run-log path the wrapper hands the
	// launcher. Unset, empty or relative disables self-logging.
	RunLogEnv = "RK_OPERATOR_RUN_LOG"

	// RunLogStderrCap and RunLogStdoutCap bound the stream tails one record
	// keeps.
	RunLogStderrCap = 4 << 10
	RunLogStdoutCap = 2 << 10

	truncatedMarker = "…[truncated]"
	recordBinary    = "rk"
	continuation    = "\n  "
)

// TailBuffer is an io.Writer that keeps only the last max bytes written.
type TailBuffer struct {
	mu        sync.Mutex
	max       int
	buf       []byte
	truncated bool
}

// NewTailBuffer returns a TailBuffer holding at most max bytes.
func NewTailBuffer(max int) *TailBuffer { return &TailBuffer{max: max} }

func (b *TailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = b.buf[over:]
		b.truncated = true
	}
	return len(p), nil
}

// String is the retained tail, prefixed with the truncation marker when bytes
// were dropped.
func (b *TailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := strings.ToValidUTF8(string(b.buf), "")
	if b.truncated {
		return truncatedMarker + s
	}
	return s
}

// Invocation is one finished rk process.
type Invocation struct {
	Time     time.Time
	PID      int
	ExitCode int
	Argv     []string
	Err      error
	Stderr   string
	Stdout   string
}

// RunLogPath returns the run-log path from the environment and whether
// self-logging is enabled.
func RunLogPath() (string, bool) {
	p := os.Getenv(RunLogEnv)
	return p, filepath.IsAbs(p)
}

// AppendInvocation appends the invocation's record to the run log in one
// write. It is fail-silent: a relative path, or one that cannot be opened or
// written, does nothing.
func AppendInvocation(path string, inv Invocation) {
	if !filepath.IsAbs(path) {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, fileMode)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(formatInvocation(inv))
}

func formatInvocation(inv Invocation) string {
	var b strings.Builder
	fmt.Fprintf(&b, "--- rk %s pid=%d exit=%d\n", inv.Time.UTC().Format(time.RFC3339), inv.PID, inv.ExitCode)
	argv := append([]string{recordBinary}, inv.Argv...)
	b.WriteString("argv: " + shellq.QuoteArgv(argv) + "\n")
	if inv.Err != nil {
		b.WriteString("error: " + indentContinuations(inv.Err.Error()) + "\n")
	}
	writeStream(&b, "stderr", inv.Stderr)
	writeStream(&b, "stdout", inv.Stdout)
	return b.String()
}

func writeStream(b *strings.Builder, label, text string) {
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return
	}
	b.WriteString(label + ": " + indentContinuations(text) + "\n")
}

func indentContinuations(s string) string {
	return strings.ReplaceAll(s, "\n", continuation)
}
