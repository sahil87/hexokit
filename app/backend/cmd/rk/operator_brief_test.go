package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const operatorBriefStateYAML = `tracked:
  - id: a
    kind: github-pr
    probe: {mode: shell, argv: [gh, pr, view, "1"], fields: [state]}
    check_every: 5m
    done_when: state == "MERGED"
    depends_on: []
    scope: {pr: 1}
    last: {state: OPEN}
    added_at: "2026-11-10T08:00:00Z"
    updated_at: "2026-11-10T08:00:00Z"
  - id: b
    kind: pane
    probe: {mode: pane}
    depends_on: [a]
    scope: {pane: null}
    added_at: "2026-11-10T08:05:00Z"
    updated_at: "2026-11-10T08:05:00Z"
`

var operatorBriefTestNow = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)

func briefStateFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ledger.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runBrief(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	prev := operatorBriefNowFn
	operatorBriefNowFn = func() time.Time { return operatorBriefTestNow }
	t.Cleanup(func() { operatorBriefNowFn = prev })
	return runOperatorCLI(t, "", append([]string{"brief"}, args...)...)
}

func TestOperatorBriefRendersFromStateFile(t *testing.T) {
	operatorSandbox(t)
	state := briefStateFile(t, operatorBriefStateYAML)
	before, _ := os.ReadFile(state)

	out, errOut, err := runBrief(t, "--state", state, "--changed", "a=merged", "--changed", "a=ci-green")
	if err != nil {
		t.Fatal(err)
	}
	if errOut != "" {
		t.Errorf("stderr = %q, want empty", errOut)
	}
	if !strings.HasPrefix(out, "# Operator run brief\n") {
		t.Errorf("stdout should be the brief only, starts %q", out[:40])
	}
	for _, want := range []string{
		"- rendered: 2026-11-11T12:00:00Z",
		"- a · github-pr · merged; ci-green\n",
		"### a (github-pr)",
		"### b (pane)",
		"- state: held",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("brief missing %q", want)
		}
	}
	if n := strings.Count(out, "- a · github-pr"); n != 1 {
		t.Errorf("a has %d What-changed rows, want 1", n)
	}
	if after, _ := os.ReadFile(state); string(after) != string(before) {
		t.Error("the state file changed")
	}
}

func TestOperatorBriefChangedGrammar(t *testing.T) {
	operatorSandbox(t)
	state := briefStateFile(t, operatorBriefStateYAML)

	out, _, err := runBrief(t, "--state", state, "--changed", "b", "--changed", "zzz=removed", "--changed", "b=spawned=now")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"- b · pane · spawned=now\n", "- zzz · gone · removed\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("brief missing %q", want)
		}
	}
	if strings.Index(out, "- b · pane") > strings.Index(out, "- zzz · gone") {
		t.Error("changed rows should keep first-seen order")
	}
}

func TestOperatorBriefNothingFlagged(t *testing.T) {
	operatorSandbox(t)
	out, _, err := runBrief(t, "--state", briefStateFile(t, operatorBriefStateYAML))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "nothing flagged — manual render") {
		t.Error("an empty --changed list should render the manual-render line")
	}
}

func TestOperatorBriefMissingStateIsEmptyLedger(t *testing.T) {
	operatorSandbox(t)
	out, _, err := runBrief(t, "--state", filepath.Join(t.TempDir(), "absent.yaml"), "--changed", "a")
	if err != nil {
		t.Fatalf("missing state file should render, got %v", err)
	}
	if !strings.Contains(out, "- a · gone\n") || !strings.Contains(out, "## Other tracked items\n\nnone\n") {
		t.Error("a missing state file should render an empty ledger")
	}
}

func TestOperatorBriefResolvesServerStateFile(t *testing.T) {
	state := operatorSandbox(t)
	if err := os.MkdirAll(filepath.Dir(state), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state, []byte(operatorBriefStateYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	out, _, err := runBrief(t, "-L", "opsrv", "--changed", "a")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "- server: opsrv") || !strings.Contains(out, "### a (github-pr)") {
		t.Error("brief should read the resolved server's state file")
	}
}

func TestOperatorBriefMalformedStateExitsOperational(t *testing.T) {
	operatorSandbox(t)
	out, _, err := runBrief(t, "--state", briefStateFile(t, "tracked: [unclosed\n"))
	wantExit(t, err, 1, "cannot parse")
	if out != "" {
		t.Errorf("stdout = %q, want empty on failure", out)
	}
}

func TestOperatorBriefUsageErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"empty changed id", []string{"--changed", "=reason"}, "item id is empty"},
		{"blank changed", []string{"--changed", " "}, "item id is empty"},
		{"bad server name", []string{"-L", "bad name"}, "Server name"},
		{"stray arg", []string{"stray"}, "unknown command"},
		{"unknown flag", []string{"--bogus"}, "unknown flag"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			operatorSandbox(t)
			out, _, err := runBrief(t, tc.args...)
			wantExit(t, err, 2, tc.want)
			if out != "" {
				t.Errorf("stdout = %q, want empty", out)
			}
		})
	}
}

func TestOperatorBriefHelpDocumentsSurface(t *testing.T) {
	operatorSandbox(t)
	out, _, err := runBrief(t, "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--changed", "--state", "-L, --server", "Examples:", "Exit codes:"} {
		if !strings.Contains(out, want) {
			t.Errorf("help missing %q", want)
		}
	}
}

func TestOperatorBriefIsRegisteredAndInHelpDump(t *testing.T) {
	found := false
	for _, c := range operatorCmd.Commands() {
		found = found || c.Name() == "brief"
	}
	if !found {
		t.Fatal("brief is not registered on operatorCmd")
	}
	op, ok := childByName(buildDump(rootCmd, displayVersion()).Root, "operator")
	if !ok {
		t.Fatal("operator missing from the help-dump tree")
	}
	if _, ok := childByName(op, "brief"); !ok {
		t.Error("operator brief missing from the help-dump tree")
	}
}
