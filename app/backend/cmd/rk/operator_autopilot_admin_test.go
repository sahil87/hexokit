package main

import (
	"strings"
	"testing"
)

func TestAutopilotRemoveAndResumeCommands(t *testing.T) {
	t.Run("remove unspawned", func(t *testing.T) {
		path, _ := autopilotSandbox(t, "")
		if _, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue"); err != nil {
			t.Fatal(err)
		}
		out, err := autopilotCLI(t, "", "rm", "q1", "--json")
		if err != nil || !strings.Contains(out, `"removed"`) || !strings.Contains(out, `"q1"`) {
			t.Fatalf("rm = %q, err=%v", out, err)
		}
		if engine := readCLIEngine(t, path); len(engine.Queue) != 0 {
			t.Fatalf("queue = %+v", engine.Queue)
		}
	})

	t.Run("resume stopped", func(t *testing.T) {
		path, _ := autopilotSandbox(t, "")
		if _, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue"); err != nil {
			t.Fatal(err)
		}
		if _, err := autopilotCLI(t, "", "stop"); err != nil {
			t.Fatal(err)
		}
		out, err := autopilotCLI(t, "", "resume", "q1")
		if err != nil || !strings.Contains(out, "resumed q1") {
			t.Fatalf("resume = %q, err=%v", out, err)
		}
		if engine := readCLIEngine(t, path); len(engine.Queue) != 1 || engine.Queue[0].Paused {
			t.Fatalf("queue = %+v", engine.Queue)
		}
	})

	t.Run("usage error", func(t *testing.T) {
		autopilotSandbox(t, "")
		_, err := autopilotCLI(t, "", "resume", "missing")
		wantExit(t, err, 2, "unknown autopilot item")
	})
}
