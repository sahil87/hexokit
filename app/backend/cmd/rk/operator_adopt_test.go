package main

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const adoptFabFile = `clock_override:
  schedule: {kind: every, every: 10m}
tracked:
  - id: a
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: b
    kind: note
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    text: from fab
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: broken
    kind: email
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
`

func adopt(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	return runOperatorCLI(t, "", append([]string{"adopt"}, args...)...)
}

func writeAdoptSource(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fab.yaml")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestOperatorAdoptRegisteredUnderOperator(t *testing.T) {
	var found bool
	for _, c := range operatorCmd.Commands() {
		if c.Name() == "adopt" {
			found = true
		}
	}
	if !found {
		t.Fatal("adopt is not registered on operatorCmd")
	}
	for _, name := range []string{"from", "server", "dry-run", "json"} {
		if operatorAdoptCmd.Flags().Lookup(name) == nil {
			t.Errorf("adopt lacks --%s", name)
		}
	}
}

func TestOperatorAdoptImportsAndReports(t *testing.T) {
	state := operatorSandbox(t)
	src := writeAdoptSource(t, adoptFabFile)
	before := sha256.Sum256([]byte(adoptFabFile))

	out, errOut, err := adopt(t, "--from", src)
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if !strings.HasPrefix(out, "adopted 2 item(s), skipped 0 (already present), 1 invalid\n") || !strings.Contains(out, "invalid broken: unknown kind") {
		t.Errorf("output = %q", out)
	}
	if errOut != "" {
		t.Errorf("stderr = %q", errOut)
	}
	if _, err := os.Stat(state); err != nil {
		t.Fatalf("no rk state file: %v", err)
	}
	if got := listJSON(t); len(got) != 2 || got[1].ID != "b" || len(got[1].Notes) != 1 || got[1].Notes[0].Text != "from fab" {
		t.Errorf("items = %+v", got)
	}

	// Idempotent re-run: nothing new, the present ids reported skipped.
	out, _, err = adopt(t, "--from", src)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out, "adopted 0 item(s), skipped 2 (already present), 1 invalid\n") || !strings.Contains(out, "skipped a (already present)") {
		t.Errorf("second output = %q", out)
	}

	raw, _ := os.ReadFile(src)
	if sha256.Sum256(raw) != before {
		t.Error("the fab file changed")
	}
}

func TestOperatorAdoptJSONShape(t *testing.T) {
	state := operatorSandbox(t)
	src := writeAdoptSource(t, adoptFabFile)

	out, _, err := adopt(t, "--from", src, "--dry-run", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		OK     bool `json:"ok"`
		Result struct {
			Source  string   `json:"source"`
			Target  string   `json:"target"`
			Adopted []string `json:"adopted"`
			Skipped []string `json:"skipped"`
			Invalid []struct {
				ID     string `json:"id"`
				Reason string `json:"reason"`
			} `json:"invalid"`
			DryRun bool `json:"dry_run"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not one JSON document: %v\n%s", err, out)
	}
	r := doc.Result
	if !doc.OK || r.Source != src || r.Target != state || !r.DryRun {
		t.Errorf("result = %+v", r)
	}
	if strings.Join(r.Adopted, ",") != "a,b" || len(r.Skipped) != 0 || len(r.Invalid) != 1 || r.Invalid[0].ID != "broken" {
		t.Errorf("result = %+v", r)
	}
	if _, err := os.Stat(filepath.Dir(state)); !os.IsNotExist(err) {
		t.Error("--dry-run created the state directory")
	}
}

func TestOperatorAdoptMissingSourceIsCleanAndCreatesNothing(t *testing.T) {
	state := operatorSandbox(t)
	missing := filepath.Join(t.TempDir(), "absent.yaml")

	out, _, err := adopt(t, "--from", missing)
	if err != nil {
		t.Fatalf("exit != 0: %v", err)
	}
	if want := "nothing to adopt (no fab operator state at " + missing + ")\n"; out != want {
		t.Errorf("output = %q, want %q", out, want)
	}
	if _, err := os.Stat(filepath.Dir(state)); !os.IsNotExist(err) {
		t.Error("a missing source created rk state")
	}

	out, _, err = adopt(t, "--from", missing, "--json")
	if err != nil || !strings.Contains(out, `"adopted": []`) {
		t.Errorf("json output = %q, err = %v", out, err)
	}
}

func TestOperatorAdoptDefaultSourceIsFabsFileForTheServer(t *testing.T) {
	state := operatorSandbox(t)
	xdg := os.Getenv("XDG_STATE_HOME")
	fabFile := filepath.Join(xdg, "fab", "operator", "tmp-tmux--1000-opsrv.yaml")
	if err := os.MkdirAll(filepath.Dir(fabFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fabFile, []byte(adoptFabFile), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := adopt(t); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(state); err != nil {
		t.Errorf("default source was not adopted: %v", err)
	}
}

func TestOperatorAdoptRunningLegacyQueueRefuses(t *testing.T) {
	state := operatorSandbox(t)
	src := writeAdoptSource(t, "autopilot:\n  queue: [a]\n  current: a\n  completed: []\n  state: running\n  mode: merge-auto\n")
	_, _, err := adopt(t, "--from", src)
	wantExit(t, err, 1, "running autopilot queue")
	if _, statErr := os.Stat(filepath.Dir(state)); !os.IsNotExist(statErr) {
		t.Error("a refusal created rk state")
	}
}

func TestOperatorAdoptUsageErrors(t *testing.T) {
	operatorSandbox(t)
	_, _, err := adopt(t, "stray")
	wantExit(t, err, 2, "unknown command")
	_, _, err = adopt(t, "--bogus")
	wantExit(t, err, 2, "unknown flag")
	_, _, err = adopt(t, "-L", "bad name")
	wantExit(t, err, 2, "Server name")
}

func TestOperatorAdoptUnparsableSourceIsOperational(t *testing.T) {
	operatorSandbox(t)
	src := writeAdoptSource(t, "tracked: [unclosed\n")
	_, _, err := adopt(t, "--from", src)
	wantExit(t, err, 1, src)
}
