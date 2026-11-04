package main

import (
	"testing"

	"rk/internal/tmux"
)

// TestMuxServerResolution pins the -L > $TMUX-derived > default precedence.
func TestMuxServerResolution(t *testing.T) {
	origFlag, origTMUX := muxServerFlag, muxOriginalTMUXFn
	t.Cleanup(func() { muxServerFlag, muxOriginalTMUXFn = origFlag, origTMUX })

	muxServerFlag = ""
	muxOriginalTMUXFn = func() string { return tmux.OriginalTMUX }

	muxOriginalTMUXFn = func() string { return "/tmp/tmux-1000/dev,123,0" }
	if got := muxServer(); got != "dev" {
		t.Errorf("muxServer() = %q, want %q (socket basename)", got, "dev")
	}

	muxServerFlag = "other"
	if got := muxServer(); got != "other" {
		t.Errorf("muxServer() = %q, want -L flag to win", got)
	}
	muxServerFlag = ""

	muxOriginalTMUXFn = func() string { return "" }
	if got := muxServer(); got != "default" {
		t.Errorf("muxServer() = %q, want %q outside tmux", got, "default")
	}

	muxOriginalTMUXFn = func() string { return ",," }
	if got := muxServer(); got != "default" {
		t.Errorf("muxServer() = %q, want %q for a malformed $TMUX", got, "default")
	}
}

// TestMuxFamilyRegistered: the root gains exactly one mux row, and the family
// lists its thirteen members with the shared -L flag inherited; snapshot nests its
// three children.
func TestMuxFamilyRegistered(t *testing.T) {
	found := false
	count := 0
	for _, c := range rootCmd.Commands() {
		if c.Name() == "mux" {
			count++
			for _, sub := range c.Commands() {
				switch sub.Name() {
				case "send":
				case "await":
				case "capture":
				case "kill":
				case "process":
				case "panes":
				case "sessions":
				case "inventory":
				case "new":
				case "adopt":
				case "reap":
				case "init-conf":
				case "guard":
				case "snapshot":
					for _, grand := range sub.Commands() {
						switch grand.Name() {
						case "list", "show", "restore":
						default:
							t.Errorf("unexpected mux snapshot subcommand %q", grand.Name())
						}
					}
					if len(sub.Commands()) != 3 {
						t.Errorf("mux snapshot has %d subcommands, want exactly 3 (list, show, restore)", len(sub.Commands()))
					}
				default:
					t.Errorf("unexpected mux subcommand %q", sub.Name())
				}
				if sub.Flag("server") == nil {
					t.Errorf("mux %s does not inherit the -L/--server flag", sub.Name())
				}
			}
			if len(c.Commands()) != 14 {
				t.Errorf("mux has %d subcommands, want exactly 14 (send, await, capture, kill, process, panes, sessions, inventory, new, adopt, reap, snapshot, init-conf, guard)", len(c.Commands()))
			}
			found = true
		}
	}
	if !found {
		t.Fatal("mux command not registered on root")
	}
	if count != 1 {
		t.Errorf("mux registered %d times on root, want 1", count)
	}
}
