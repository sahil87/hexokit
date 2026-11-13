package operatorloop

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunIDFormat(t *testing.T) {
	id, err := NewRunID(time.Date(2026, 11, 12, 10, 15, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !ValidRunID(id) || !strings.HasPrefix(id, "20261112T101500-") || len(ShortID(id)) != 4 {
		t.Fatalf("id = %q", id)
	}
	for _, bad := range []string{"", "x", "20261112T101500", "20261112T101500-AB12", "20261112T101500-ab1", "../20261112T101500-ab12", "20261112T101500-ab12/x"} {
		if ValidRunID(bad) {
			t.Errorf("ValidRunID(%q) = true", bad)
		}
	}
	if ShortID("20261112T101500-ab12") != "ab12" {
		t.Error("ShortID")
	}
}

func TestDirValidatesServerAndSlug(t *testing.T) {
	r := newRig(t)
	got, err := Dir(context.Background(), testServer)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(filepath.Dir(r.statePath), "runs", "test"); got != want {
		t.Errorf("Dir = %q, want %q", got, want)
	}
	for _, bad := range []string{"", "../x", "a/b", "a b"} {
		if _, err := Dir(context.Background(), bad); err == nil {
			t.Errorf("Dir(%q) accepted a bad server name", bad)
		}
	}
	statePathFn = func(context.Context, string) (string, error) { return "/state/operator/we ird.yaml", nil }
	if _, err := Dir(context.Background(), testServer); err == nil {
		t.Error("Dir accepted a slug that is not a valid path component")
	}
	if _, err := RecordPath(got, "../../etc/passwd"); err == nil {
		t.Error("RecordPath accepted a traversal id")
	}
}

func TestRecordRoundTripAndPerms(t *testing.T) {
	r := newRig(t)
	zero := 0
	rec := Record{ID: "20261112T101500-ab12", Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:15:00Z",
		Changed: []string{"a", "b"}, Window: "run-ab12", ExitCode: &zero, Outcome: "ok"}
	path := r.writeRun(rec)

	got, err := ReadRecord(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.ExitCode == nil || *got.ExitCode != 0 || got.Outcome != "ok" || len(got.Changed) != 2 {
		t.Fatalf("round trip = %+v", got)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"exit_code": 0`) {
		t.Errorf("exit_code 0 must be serialized: %s", raw)
	}
	if strings.Contains(string(raw), "ended_at") || strings.Contains(string(raw), "logged") {
		t.Errorf("zero values must be omitted: %s", raw)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("record perm = %v", st.Mode().Perm())
	}
	if st, _ := os.Stat(filepath.Dir(path)); st.Mode().Perm() != 0o700 {
		t.Errorf("runs dir perm = %v", st.Mode().Perm())
	}

	if err := UpdateRecord(path, func(r *Record) { r.Logged = true }); err != nil {
		t.Fatal(err)
	}
	if got, _ = ReadRecord(path); !got.Logged || got.Outcome != "ok" {
		t.Fatalf("update = %+v", got)
	}
}

func TestRecordDuration(t *testing.T) {
	rec := Record{FiredAt: "2026-11-12T10:15:00Z", StartedAt: "2026-11-12T10:15:02Z", EndedAt: "2026-11-12T10:17:15Z"}
	if d := rec.Duration(); d != 133*time.Second {
		t.Errorf("duration = %v", d)
	}
	rec.StartedAt = ""
	if d := rec.Duration(); d != 135*time.Second {
		t.Errorf("fallback to fired_at = %v", d)
	}
	if (Record{}).Duration() != 0 || (Record{EndedAt: "garbage"}).Duration() != 0 {
		t.Error("missing/garbage times must give 0")
	}
}

func TestPruneKeepsNewestFiftyLoggedAndUnlogged(t *testing.T) {
	r := newRig(t)
	dir := r.runsDir()
	mk := func(i int, logged bool) string {
		id := fmt.Sprintf("20261112T%06d-aaaa", i)
		r.writeRun(Record{ID: id, Server: testServer, Logged: logged})
		for _, suffix := range []string{briefSuffix, logSuffix} {
			p, _ := FilePath(dir, id, suffix)
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return id
	}
	var ids []string
	for i := 0; i < RunRetention+5; i++ {
		// run 1 is an old record still awaiting transcription
		ids = append(ids, mk(i, i != 1))
	}
	if err := Prune(dir); err != nil {
		t.Fatal(err)
	}
	for i, id := range ids {
		rec, _ := RecordPath(dir, id)
		brief, _ := BriefPath(dir, id)
		logf, _ := LogPath(dir, id)
		wantKept := i >= 5 || i == 1
		for _, p := range []string{rec, brief, logf} {
			if exists(t, p) != wantKept {
				t.Errorf("run %d file %s kept=%v, want %v", i, filepath.Base(p), exists(t, p), wantKept)
			}
		}
	}
}

func TestPruneNoopUnderRetention(t *testing.T) {
	r := newRig(t)
	r.writeRun(Record{ID: "20261112T000001-aaaa", Logged: true})
	if err := Prune(r.runsDir()); err != nil {
		t.Fatal(err)
	}
	if ids, _ := listRunIDs(r.runsDir()); len(ids) != 1 {
		t.Fatalf("ids = %v", ids)
	}
	if ids, err := listRunIDs(filepath.Join(t.TempDir(), "absent")); err != nil || ids != nil {
		t.Fatalf("absent dir = %v, %v", ids, err)
	}
}
