package main

import (
	"io"
	"os"
	"time"

	"rk/internal/operatorloop"

	"github.com/spf13/cobra"
)

// runLogTee captures what one rk invocation wrote through the root's streams
// so execute() can append it to the operator run log (operatorloop.RunLogEnv).
type runLogTee struct {
	path           string
	stdout, stderr *operatorloop.TailBuffer
}

// activeRunLog is the running invocation's tee, set by execute(); verbs that
// must os.Exit inside RunE exit through exitRecorded so their record is still
// written.
var activeRunLog *runLogTee

// exitFn is the process-exit seam of exitRecorded.
var exitFn = os.Exit

// exitRecorded records the invocation under err with the given exit code, then
// exits with that code.
func exitRecorded(err error, code int) {
	activeRunLog.record(os.Args[1:], err, code)
	exitFn(code)
}

// attachRunLog routes the root's stdout through out and, when self-logging is
// enabled, tees both root streams into capped tails. It returns nil when
// disabled; record on a nil tee does nothing.
func attachRunLog(root *cobra.Command, out io.Writer) *runLogTee {
	path, ok := operatorloop.RunLogPath()
	if !ok {
		root.SetOut(out)
		return nil
	}
	tee := &runLogTee{
		path:   path,
		stdout: operatorloop.NewTailBuffer(operatorloop.RunLogStdoutCap),
		stderr: operatorloop.NewTailBuffer(operatorloop.RunLogStderrCap),
	}
	root.SetOut(io.MultiWriter(out, tee.stdout))
	root.SetErr(io.MultiWriter(os.Stderr, tee.stderr))
	return tee
}

// record appends the finished invocation to the run log, fail-silent.
func (t *runLogTee) record(argv []string, err error, code int) {
	if t == nil {
		return
	}
	operatorloop.AppendInvocation(t.path, operatorloop.Invocation{
		Time:     time.Now(),
		PID:      os.Getpid(),
		ExitCode: code,
		Argv:     argv,
		Err:      err,
		Stderr:   t.stderr.String(),
		Stdout:   t.stdout.String(),
	})
}
