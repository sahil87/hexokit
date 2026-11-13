package operatorloop

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"rk/internal/operator"
)

// TestMain doubles as the run window's wrapper binary for the integration
// test: a run window runs `<this test binary> operator run-exec …` (the hidden
// `rk operator run-exec` argv), and the stub launcher's note step runs
// `<this test binary> note <state file> <id> <text>`. Both are handled before
// the test framework starts, so the real tmux window exercises the real Exec
// without building rk.
func TestMain(m *testing.M) {
	args := os.Args[1:]
	switch {
	case len(args) >= 2 && args[0] == "operator" && args[1] == "run-exec":
		os.Exit(helperRunExec(args[2:]))
	case len(args) == 4 && args[0] == "note":
		if err := operator.AddNote(args[1], args[2], "run", args[3]); err != nil {
			fmt.Fprintln(os.Stderr, "note helper:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// helperRunExec parses `--server S --run ID -- argv…` like the cobra verb and
// runs Exec with the process's own streams.
func helperRunExec(args []string) int {
	var opts ExecOptions
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--server" && i+1 < len(args):
			opts.Server = args[i+1]
			i++
		case args[i] == "--run" && i+1 < len(args):
			opts.RunID = args[i+1]
			i++
		case args[i] == "--":
			opts.Argv = args[i+1:]
			i = len(args)
		}
	}
	opts.Stdout, opts.Stderr = os.Stdout, os.Stderr
	res, err := Exec(context.Background(), opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "run-exec:", strings.TrimSpace(err.Error()))
		return 1
	}
	return res.ExitCode
}
