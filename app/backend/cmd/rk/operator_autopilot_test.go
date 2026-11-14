package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"rk/internal/autopilot"
	"rk/internal/operator"

	"github.com/spf13/cobra"
)

// cliRunner answers the engine's subprocesses without a real git or gh: the
// repo validation sees the requested directory as a git root, and nothing else
// is reachable.
type cliRunner struct{ calls []string }

func (r *cliRunner) Run(_ context.Context, dir string, argv ...string) (string, error) {
	r.calls = append(r.calls, strings.Join(argv, " "))
	if len(argv) >= 3 && argv[0] == "git" && argv[1] == "rev-parse" && argv[2] == "--show-toplevel" {
		return dir + "\n", nil
	}
	return "", &autopilot.ExecError{Argv: argv, Stderr: "unscripted in the CLI test", Err: fmt.Errorf("exit status 1")}
}

type cliPanes struct{}

func (cliPanes) Snapshot(context.Context) (map[string]operator.PaneInfo, error) {
	return map[string]operator.PaneInfo{}, nil
}
func (cliPanes) Send(context.Context, string, string) error { return nil }

// autopilotSandbox stubs the engine environment and the setting, leaving the
// real state file under a temp state home.
func autopilotSandbox(t *testing.T, setting string) (statePath string, runner *cliRunner) {
	t.Helper()
	statePath = operatorSandbox(t)
	runner = &cliRunner{}
	prevEnv, prevSetting := autopilotEnvFn, autopilotSettingsFn
	autopilotEnvFn = func(cmd *cobra.Command, by string, dry bool) (autopilot.Env, error) {
		_, path, err := operatorStateTarget(cmd)
		if err != nil {
			return autopilot.Env{}, err
		}
		return autopilot.Env{
			Server: "autopilot-test-none", StatePath: path, Run: runner, Panes: cliPanes{},
			Session: func(context.Context, string) (string, error) { return "work", nil },
			By:      by, DryRun: dry,
		}, nil
	}
	autopilotSettingsFn = func() string { return setting }
	t.Cleanup(func() { autopilotEnvFn, autopilotSettingsFn = prevEnv, prevSetting })
	return statePath, runner
}

func autopilotCLI(t *testing.T, stdin string, args ...string) (string, error) {
	t.Helper()
	out, _, err := runOperatorCLI(t, stdin, append([]string{"autopilot"}, args...)...)
	return out, err
}

func queueJSON(repos ...string) string {
	entries := make([]string, 0, len(repos))
	for i, r := range repos {
		entries = append(entries, fmt.Sprintf(`{"id":"q%d","repo":%q,"task":"work %d"}`, i+1, r, i+1))
	}
	return "[" + strings.Join(entries, ",") + "]"
}

func TestAutopilotQueueHumanOutputAndModeSource(t *testing.T) {
	cases := []struct {
		name, setting string
		args          []string
		want          string
	}{
		{"default", "", nil, "mode: cherry-pick-ladder (default)"},
		{"setting", "stacked-prs", nil, "mode: stacked-prs (setting)"},
		{"flag over setting", "stacked-prs", []string{"--mode", "merge-auto"}, "mode: merge-auto (flag)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, _ := autopilotSandbox(t, c.setting)
			repo := t.TempDir()
			out, err := autopilotCLI(t, queueJSON(repo), append([]string{"queue"}, c.args...)...)
			if err != nil {
				t.Fatalf("queue: %v", err)
			}
			if !strings.Contains(out, c.want) || !strings.Contains(out, "queued q1") {
				t.Fatalf("output = %q", out)
			}
			st, lerr := operator.Load(path)
			if lerr != nil || len(st.Tracked) != 1 {
				t.Fatalf("state = %+v err %v", st, lerr)
			}
		})
	}
}

func TestAutopilotQueueJSONEnvelope(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	out, err := autopilotCLI(t, queueJSON(repo, repo), "queue", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		OK     bool `json:"ok"`
		Result struct {
			Mode    string   `json:"mode"`
			Source  string   `json:"source"`
			Items   []string `json:"items"`
			Misfits []string `json:"misfits"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("not one JSON document: %v\n%s", err, out)
	}
	if !env.OK || env.Result.Mode != "cherry-pick-ladder" || env.Result.Source != "default" || len(env.Result.Items) != 2 || env.Result.Misfits == nil {
		t.Fatalf("envelope = %+v", env)
	}
}

func TestAutopilotQueueMisfitIsPrinted(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	in := fmt.Sprintf(`[{"id":"a","repo":%q,"task":"a"},{"id":"b","repo":%q,"task":"b","depends_on":["a"]}]`, repo, repo)
	out, err := autopilotCLI(t, in, "queue", "--mode", "merge-auto")
	if err != nil || !strings.Contains(out, "misfit: merge-auto with same-repo depends_on") {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotQueueUsageErrors(t *testing.T) {
	repo := t.TempDir()
	cases := []struct {
		name, setting, stdin string
		args                 []string
		want                 string
	}{
		{"invalid setting", "bogus", queueJSON(repo), nil, "cherry-pick-ladder, stacked-prs, merge-auto"},
		{"invalid flag", "", queueJSON(repo), []string{"--mode", "bogus"}, "invalid --mode"},
		{"not json", "", "not json", nil, "invalid queue entries"},
		{"empty queue", "", "[]", nil, "queue is empty"},
		{"relative repo", "", `[{"id":"a","repo":"rel","task":"a"}]`, nil, "absolute"},
		{"bad author", "", queueJSON(repo), []string{"--by", "robot"}, "invalid --by"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, _ := autopilotSandbox(t, c.setting)
			_, err := autopilotCLI(t, c.stdin, append([]string{"queue"}, c.args...)...)
			wantExit(t, err, 2, c.want)
			if _, statErr := os.Stat(path); statErr == nil {
				t.Fatal("a rejected queue wrote the state file")
			}
		})
	}
}

func TestAutopilotQueueDryRunWritesNothing(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	out, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue", "--dry-run")
	if err != nil || !strings.Contains(out, "would queue q1") {
		t.Fatalf("out = %q err %v", out, err)
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Fatal("dry-run wrote the state file")
	}
}

func TestAutopilotStepAndStopOnAnEmptyLedger(t *testing.T) {
	autopilotSandbox(t, "")
	out, err := autopilotCLI(t, "", "step")
	if err != nil || strings.TrimSpace(out) != "nothing to do" {
		t.Fatalf("step out = %q err %v", out, err)
	}
	out, err = autopilotCLI(t, "", "step", "--dry-run")
	if err != nil || strings.TrimSpace(out) != "dry-run: nothing to do" {
		t.Fatalf("dry-run out = %q err %v", out, err)
	}
	out, err = autopilotCLI(t, "", "stop", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		OK     bool                 `json:"ok"`
		Result autopilot.StepResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil || !env.OK || env.Result.Actions == nil || env.Result.Escalations == nil || env.Result.Report == nil {
		t.Fatalf("stop envelope = %s (%v)", out, err)
	}
	if _, err := autopilotCLI(t, "", "step", "--by", "user"); err == nil {
		t.Fatal("step accepts only run or chat as author")
	} else {
		wantExit(t, err, 2, "invalid --by")
	}
}

func TestAutopilotStepDryRunPlansASpawn(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo), "queue"); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "step", "--dry-run")
	if err != nil || !strings.Contains(out, "dry-run: spawned q1 would spawn in "+repo) {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotMergeRefusesUnfinishedQueue(t *testing.T) {
	autopilotSandbox(t, "")
	if _, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue"); err != nil {
		t.Fatal(err)
	}
	_, err := autopilotCLI(t, "", "merge")
	wantExit(t, err, 1, "not done yet: q1")
	out, jerr := autopilotCLI(t, "", "merge", "--json")
	if jerr == nil || !strings.Contains(out, `"ok": false`) {
		t.Fatalf("out = %q err %v", out, jerr)
	}
}

func TestAutopilotStatus(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo, repo), "queue"); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "status")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "q1 · pending · cherry-pick-ladder · "+repo) || !strings.HasPrefix(lines[1], "q2 · held · ") {
		t.Fatalf("status = %q", out)
	}
	out, err = autopilotCLI(t, "", "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Result autopilot.StatusResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil || len(env.Result.Items) != 2 || env.Result.Complete {
		t.Fatalf("status envelope = %s (%v)", out, err)
	}
}

func TestAutopilotStatusOnNoQueue(t *testing.T) {
	autopilotSandbox(t, "")
	out, err := autopilotCLI(t, "", "status")
	if err != nil || strings.TrimSpace(out) != "no queue" {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotErrorMapping(t *testing.T) {
	if got := exitCode(autopilotError(&autopilot.InvalidError{})); got != 2 {
		t.Errorf("InvalidError exit = %d, want 2", got)
	}
	if got := exitCode(autopilotError(fmt.Errorf("busy"))); got != 1 {
		t.Errorf("operational exit = %d, want 1", got)
	}
}
