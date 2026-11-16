package operatorloop

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"rk/internal/operator"
)

func TestExecMechanicalOnlySkipsLauncherAndRecordsOutcome(t *testing.T) {
	r := newRig(t)
	recPath := execRigPathOnly(t, r)
	launcher := r.runsDir() + "/launched"
	var stdout, stderr bytes.Buffer
	res, err := Exec(context.Background(), ExecOptions{
		Server: testServer, RunID: runA, Argv: []string{"sh", "-c", "touch " + launcher}, Stdout: &stdout, Stderr: &stderr,
		Pass: func(context.Context) (*PassRecord, error) {
			return &PassRecord{Actions: 2, Escalations: []string{}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 || res.Outcome != "mechanical · 2 actions" || res.Failed {
		t.Fatalf("result = %+v", res)
	}
	if exists(t, launcher) {
		t.Fatal("mechanical run invoked its launcher")
	}
	rec, _ := ReadRecord(recPath)
	if rec.Pass == nil || rec.Pass.Actions != 2 || rec.ExitCode == nil || *rec.ExitCode != 0 || rec.Outcome != "mechanical · 2 actions" {
		t.Fatalf("record = %+v", rec)
	}
	if lines := Transcribe(context.Background(), testServer); len(lines) != 1 || !strings.HasPrefix(lines[0].Outcome, "ran · mechanical · 2 actions · ") {
		t.Fatalf("transcription = %+v", lines)
	}
}

func TestExecBusyAndErrorPassContinueToJudgment(t *testing.T) {
	for _, tc := range []struct {
		name string
		pass *PassRecord
		err  error
	}{
		{"busy", &PassRecord{Busy: true, Escalations: []string{}}, nil},
		{"error", &PassRecord{Escalations: []string{}}, errors.New("pass failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			recPath := execRigPathOnly(t, r)
			UpdateRecord(recPath, func(rec *Record) { rec.Changes = []ChangeRecord{{ID: "gone", Reasons: []string{"due 5m"}}} })
			var stdout, stderr bytes.Buffer
			res, err := Exec(context.Background(), ExecOptions{
				Server: testServer, RunID: runA, Argv: []string{"sh", "-c", "cat >/dev/null; echo 'outcome: judgment'"}, Stdout: &stdout, Stderr: &stderr,
				Pass: func(context.Context) (*PassRecord, error) { return tc.pass, tc.err },
			})
			if err != nil || res.Outcome != "judgment" {
				t.Fatalf("result = %+v, err=%v", res, err)
			}
			rec, _ := ReadRecord(recPath)
			if rec.Pass == nil || rec.Pass.Busy != tc.pass.Busy || (tc.err != nil && !strings.Contains(rec.Pass.Error, "pass failed")) {
				t.Fatalf("pass record = %+v", rec.Pass)
			}
			brief, err := os.ReadFile(r.runsDir() + "/" + runA + briefSuffix)
			if err != nil || !strings.Contains(string(brief), "gone · gone · due 5m") {
				t.Fatalf("judgment brief = %q, err=%v", brief, err)
			}
		})
	}
}

func execRigPathOnly(t *testing.T, r *rig) string {
	t.Helper()
	recPath := r.writeRun(Record{ID: runA, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:15:00Z",
		Changed: []string{"gone"}, Changes: []ChangeRecord{{ID: "gone", Reasons: []string{"stage_advance apply→review"}}}, Window: "run-aaaa"})
	return recPath
}

func TestExecSetupAndMechanicalFailuresRecordEndAndFailureNote(t *testing.T) {
	for _, tc := range []struct {
		name       string
		setupError error
		loadError  error
	}{
		{name: "environment setup", setupError: errors.New("environment failed")},
		{name: "mechanical ledger load", loadError: errors.New("ledger failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			recPath, _ := execRig(t, r, "pr-41")
			previousLoad := loadStateFn
			if tc.loadError != nil {
				loadStateFn = func(string) (*operator.State, error) { return nil, tc.loadError }
			}
			t.Cleanup(func() { loadStateFn = previousLoad })
			var stdout, stderr bytes.Buffer
			var notifications []string
			res, err := Exec(context.Background(), ExecOptions{
				Server: testServer, RunID: runA, Argv: []string{"true"}, Stdout: &stdout, Stderr: &stderr,
				SetupError: tc.setupError,
				Pass: func(context.Context) (*PassRecord, error) {
					return &PassRecord{Actions: 0, Escalations: []string{}}, nil
				},
				Notify: func(_ context.Context, title, body string) { notifications = append(notifications, title+"|"+body) },
			})
			if err != nil {
				t.Fatal(err)
			}
			if res.ExitCode != exitStartFailed || res.Outcome != "" || !res.Failed {
				t.Fatalf("result = %+v", res)
			}
			rec, readErr := ReadRecord(recPath)
			if readErr != nil || rec.StartedAt == "" || !rec.Ended() || rec.ExitCode == nil || *rec.ExitCode != exitStartFailed {
				t.Fatalf("record = %+v, err=%v", rec, readErr)
			}
			notes := itemNotes(t, r, "pr-41")
			if len(notes) != 2 || !strings.HasPrefix(notes[1].Text, "run failed: exit 127") {
				t.Fatalf("failure notes = %+v", notes)
			}
			if len(notifications) != 1 {
				t.Fatalf("notifications = %v", notifications)
			}
		})
	}
}
