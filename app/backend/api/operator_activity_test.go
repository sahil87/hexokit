package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/operatorloop"
	"rk/internal/tmux"
)

const (
	actServer = "work"
	actFireA  = "20261112T101500-aaaa"
	actFireB  = "20261112T101800-bbbb"
	actRunC   = "20261112T102100-cccc"
)

type activityRig struct {
	s       *Server
	cronDir string
	runsDir string
	windows []tmux.RunWindow
	winErr  error
}

// newActivityRig builds a bare Server over temp cron and runs dirs with one
// operator-loop entry (lp01) and an injectable run-window list.
func newActivityRig(t *testing.T) *activityRig {
	t.Helper()
	base := t.TempDir()
	rig := &activityRig{cronDir: filepath.Join(base, "cron"), runsDir: filepath.Join(base, "runs")}
	if err := os.MkdirAll(rig.cronDir, 0o700); err != nil {
		t.Fatal(err)
	}
	rig.s = &Server{
		logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		cronDirFn:     func() (string, error) { return rig.cronDir, nil },
		cronRunsDirFn: func(context.Context, string) (string, error) { return rig.runsDir, nil },
		listRunWindowsFn: func(context.Context, string) ([]tmux.RunWindow, error) {
			return rig.windows, rig.winErr
		},
	}
	rig.writeEntries(`entries:
  - id: lp01
    name: operator loop
    run: operator-loop
    schedule: {kind: backoff, min: 3m, max: 24m}
    pinned: true
    created_by: {at: 1700000000}
  - id: zz01
    name: other
    schedule: {kind: every, interval: 5m}
    target: {kind: role, role: operator}
    payload: hi
    created_by: {at: 1700000000}
`)
	return rig
}

func (r *activityRig) writeEntries(yaml string) {
	if err := os.WriteFile(filepath.Join(r.cronDir, actServer+".yaml"), []byte(yaml), 0o600); err != nil {
		panic(err)
	}
}

func (r *activityRig) appendLine(t *testing.T, l cron.LogLine) {
	t.Helper()
	if err := cron.AppendLog(filepath.Join(r.cronDir, actServer+".log"), l); err != nil {
		t.Fatal(err)
	}
}

func (r *activityRig) writeCheck(t *testing.T, id string, rec operatorloop.CheckRecord) {
	t.Helper()
	if err := operatorloop.WriteCheckRecord(r.runsDir, id, rec); err != nil {
		t.Fatal(err)
	}
}

func (r *activityRig) writeRun(t *testing.T, rec operatorloop.Record) {
	t.Helper()
	if err := operatorloop.EnsureDir(r.runsDir); err != nil {
		t.Fatal(err)
	}
	path, _ := operatorloop.RecordPath(r.runsDir, rec.ID)
	if err := operatorloop.WriteRecord(path, rec); err != nil {
		t.Fatal(err)
	}
}

func (r *activityRig) writeRunFile(t *testing.T, id string, pathFn func(string, string) (string, error), data []byte) {
	t.Helper()
	if err := operatorloop.EnsureDir(r.runsDir); err != nil {
		t.Fatal(err)
	}
	path, _ := pathFn(r.runsDir, id)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (r *activityRig) get(target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.s.buildRouter().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

type activityBody struct {
	Server   string `json:"server"`
	InFlight *struct {
		ID        string `json:"id"`
		StartedAt string `json:"started_at"`
	} `json:"in_flight"`
	Rows []struct {
		TS      int64  `json:"ts"`
		Entry   string `json:"entry"`
		Reason  string `json:"reason"`
		Outcome string `json:"outcome"`
		Rung    int    `json:"rung"`
		Fire    string `json:"fire"`
		Running bool   `json:"running"`
		Check   *struct {
			CheckedAt string                `json:"checked_at"`
			Changed   bool                  `json:"changed"`
			Changes   []operator.CheckDelta `json:"changes"`
			Open      []operator.CheckDelta `json:"open"`
			Notices   []map[string]any      `json:"notices"`
			Items     int                   `json:"items"`
		} `json:"check"`
		Run *struct {
			ID   string `json:"id"`
			Pass *struct {
				Actions int `json:"actions"`
			} `json:"pass"`
			Outcome   string `json:"outcome"`
			DurationS int64  `json:"duration_s"`
			HasBrief  bool   `json:"has_brief"`
			HasLog    bool   `json:"has_log"`
		} `json:"run"`
	} `json:"rows"`
}

func decodeActivity(t *testing.T, rec *httptest.ResponseRecorder) activityBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var body activityBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func activityURL() string { return "/api/operator/activity?server=" + actServer }

func staleDelta(id string) operator.CheckDelta {
	return operator.CheckDelta{Kind: operator.DeltaStale, ID: id, Age: "3d"}
}

// TestOperatorActivity_JoinsByFireAndByRun: a `no change` line joins its check
// record through `fire`; a transcribed `ran` line joins its check and run
// records through `run`; rows come newest first with the rung replayed per
// line, and other entries' lines never appear.
func TestOperatorActivity_JoinsByFireAndByRun(t *testing.T) {
	r := newActivityRig(t)
	r.appendLine(t, cron.LogLine{TS: 100, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange, Fire: actFireA})
	r.appendLine(t, cron.LogLine{TS: 150, Entry: "zz01", Target: "%1", Reason: "schedule", Outcome: "delivered"})
	r.appendLine(t, cron.LogLine{TS: 200, Entry: "lp01", Reason: "trigger:manual", Outcome: cron.OutcomeNoChange, Fire: actFireB})
	r.appendLine(t, cron.LogLine{TS: 300, Entry: "lp01", Reason: "wake", Outcome: cron.OutcomeRan("did it", 20*time.Second), Run: actRunC})
	r.appendLine(t, cron.LogLine{TS: 400, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeSkippedBusy("x")})

	r.writeCheck(t, actFireA, operatorloop.CheckRecord{
		CheckedAt: "2026-11-12T10:15:01Z", Changes: []operator.CheckDelta{},
		Open: []operator.CheckDelta{staleDelta("pr-41"), staleDelta("pr-42")},
	})
	r.writeCheck(t, actFireB, operatorloop.CheckRecord{
		CheckedAt: "2026-11-12T10:18:01Z", Changed: true,
		Changes: []operator.CheckDelta{{Kind: operator.DeltaNote, ID: "pr-41", At: "t"}},
		Open:    []operator.CheckDelta{staleDelta("pr-41")},
		Notices: []operator.CheckNotice{{ID: "pr-9", Kind: "paused", Error: "boom", Failures: 2}},
	})
	r.writeCheck(t, actRunC, operatorloop.CheckRecord{CheckedAt: "2026-11-12T10:21:01Z", Changed: true, Run: actRunC,
		Changes: []operator.CheckDelta{{Kind: operator.DeltaStageAdvance, ID: "ab12"}}})
	r.writeRun(t, operatorloop.Record{
		ID: actRunC, Server: actServer, Entry: "lp01", Reason: "wake", Pass: &operatorloop.PassRecord{Actions: 2},
		StartedAt: "2026-11-12T10:21:00Z", EndedAt: "2026-11-12T10:21:20Z", Outcome: "did it", Logged: true,
	})
	r.writeRunFile(t, actRunC, operatorloop.BriefPath, []byte("# brief"))

	body := decodeActivity(t, r.get(activityURL()))
	if body.Server != actServer || body.InFlight != nil {
		t.Fatalf("server/in_flight = %q / %+v", body.Server, body.InFlight)
	}
	if len(body.Rows) != 4 {
		t.Fatalf("rows = %d, want 4 (other entry's line excluded): %+v", len(body.Rows), body.Rows)
	}
	var tss []int64
	for _, row := range body.Rows {
		tss = append(tss, row.TS)
	}
	if fmt.Sprint(tss) != "[400 300 200 100]" {
		t.Errorf("ts order = %v, want newest first", tss)
	}

	busy, ran, manual, first := body.Rows[0], body.Rows[1], body.Rows[2], body.Rows[3]
	if busy.Check != nil || busy.Run != nil || busy.Fire != "" || busy.Outcome != cron.OutcomeSkippedBusy("x") || busy.Rung != 0 {
		t.Errorf("skipped-busy row = %+v", busy)
	}
	if ran.Fire != actRunC || ran.Rung != 2 || ran.Reason != "wake" || ran.Check == nil || ran.Run == nil {
		t.Fatalf("ran row = %+v", ran)
	}
	if ran.Run.ID != actRunC || ran.Run.Pass == nil || ran.Run.Pass.Actions != 2 || ran.Run.Outcome != "did it" ||
		ran.Run.DurationS != 20 || !ran.Run.HasBrief || ran.Run.HasLog {
		t.Errorf("ran run = %+v", ran.Run)
	}
	if manual.Fire != actFireB || manual.Rung != 1 || manual.Run != nil || manual.Check == nil {
		t.Fatalf("manual row = %+v", manual)
	}
	if manual.Check.Items != 1 || len(manual.Check.Changes) != 1 || len(manual.Check.Open) != 1 || len(manual.Check.Notices) != 1 || !manual.Check.Changed {
		t.Errorf("manual check = %+v", manual.Check)
	}
	if first.Fire != actFireA || first.Rung != 0 || first.Check == nil || first.Check.Items != 2 || first.Run != nil {
		t.Errorf("first row = %+v", first)
	}
}

// TestOperatorActivity_MissingAndCorruptRecordsKeepRow: a record that is
// absent or unparseable drops its sub-object, never the row or the response.
func TestOperatorActivity_MissingAndCorruptRecordsKeepRow(t *testing.T) {
	r := newActivityRig(t)
	r.appendLine(t, cron.LogLine{TS: 100, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange, Fire: actFireA})
	r.appendLine(t, cron.LogLine{TS: 200, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeRan("x", time.Second), Run: actRunC})
	r.appendLine(t, cron.LogLine{TS: 300, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange, Fire: actFireB})
	if err := operatorloop.EnsureDir(r.runsDir); err != nil {
		t.Fatal(err)
	}
	checkPath, _ := operatorloop.CheckRecordPath(r.runsDir, actFireA)
	if err := os.WriteFile(checkPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	runPath, _ := operatorloop.RecordPath(r.runsDir, actRunC)
	if err := os.WriteFile(runPath, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}

	body := decodeActivity(t, r.get(activityURL()))
	if len(body.Rows) != 3 {
		t.Fatalf("rows = %+v", body.Rows)
	}
	for _, row := range body.Rows {
		if row.Check != nil || row.Run != nil {
			t.Errorf("row %d has a sub-object from a missing or corrupt record: %+v", row.TS, row)
		}
	}
}

// TestOperatorActivity_CapsAtTwoHundredNewest: more lines than the cap return
// the newest 200.
func TestOperatorActivity_CapsAtTwoHundredNewest(t *testing.T) {
	r := newActivityRig(t)
	for i := 1; i <= maxActivityRows+25; i++ {
		r.appendLine(t, cron.LogLine{TS: int64(i), Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange})
	}
	body := decodeActivity(t, r.get(activityURL()))
	if len(body.Rows) != maxActivityRows {
		t.Fatalf("rows = %d, want %d", len(body.Rows), maxActivityRows)
	}
	if body.Rows[0].TS != int64(maxActivityRows+25) || body.Rows[maxActivityRows-1].TS != 26 {
		t.Errorf("window = %d..%d, want newest 200", body.Rows[0].TS, body.Rows[maxActivityRows-1].TS)
	}
}

// TestOperatorActivity_InFlightLeadsWithSyntheticRow: a live run window yields
// in_flight and a running row built from the run and check records, ahead of
// the logged rows.
func TestOperatorActivity_InFlightLeadsWithSyntheticRow(t *testing.T) {
	r := newActivityRig(t)
	r.appendLine(t, cron.LogLine{TS: 100, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange, Fire: actFireA})
	r.appendLine(t, cron.LogLine{TS: 200, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange})
	r.writeCheck(t, actRunC, operatorloop.CheckRecord{CheckedAt: "t", Changed: true, Run: actRunC,
		Changes: []operator.CheckDelta{{Kind: operator.DeltaStageAdvance, ID: "ab12"}}})
	r.writeRun(t, operatorloop.Record{ID: actRunC, Server: actServer, Entry: "lp01", Reason: "trigger:manual",
		FiredAt: "2026-11-12T10:21:00Z", StartedAt: "2026-11-12T10:21:05Z", Window: "run-cccc"})
	r.windows = []tmux.RunWindow{{RunID: actRunC, Name: "run-cccc"}}

	body := decodeActivity(t, r.get(activityURL()))
	if body.InFlight == nil || body.InFlight.ID != actRunC || body.InFlight.StartedAt != "2026-11-12T10:21:05Z" {
		t.Fatalf("in_flight = %+v", body.InFlight)
	}
	if len(body.Rows) != 3 {
		t.Fatalf("rows = %d, want synthetic + 2 logged", len(body.Rows))
	}
	lead := body.Rows[0]
	if !lead.Running || lead.Outcome != "" || lead.Fire != actRunC || lead.Reason != "trigger:manual" ||
		lead.Check == nil || lead.Run == nil || lead.Run.ID != actRunC || lead.Rung != 2 {
		t.Errorf("synthetic row = %+v", lead)
	}
	if body.Rows[1].Running || body.Rows[2].Running {
		t.Error("only the lead row is running")
	}
}

// TestOperatorActivity_InFlightAlreadyLoggedAddsNoRow: a run whose line was
// transcribed while its window lingers is not shown twice.
func TestOperatorActivity_InFlightAlreadyLoggedAddsNoRow(t *testing.T) {
	r := newActivityRig(t)
	r.appendLine(t, cron.LogLine{TS: 100, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeRan("x", time.Second), Run: actRunC})
	r.writeRun(t, operatorloop.Record{ID: actRunC, Server: actServer, Entry: "lp01"})
	r.windows = []tmux.RunWindow{{RunID: actRunC}}
	body := decodeActivity(t, r.get(activityURL()))
	if body.InFlight == nil || len(body.Rows) != 1 || body.Rows[0].Running {
		t.Errorf("body = %+v", body)
	}
}

// TestOperatorActivity_TmuxErrorMeansNoInFlight: a failed window listing is a
// normal response with in_flight null.
func TestOperatorActivity_TmuxErrorMeansNoInFlight(t *testing.T) {
	r := newActivityRig(t)
	r.appendLine(t, cron.LogLine{TS: 100, Entry: "lp01", Reason: "schedule", Outcome: cron.OutcomeNoChange})
	r.winErr = errors.New("tmux: no server running")
	r.windows = []tmux.RunWindow{{RunID: actRunC}}
	rec := r.get(activityURL())
	body := decodeActivity(t, rec)
	if body.InFlight != nil || len(body.Rows) != 1 {
		t.Errorf("body = %+v", body)
	}
	if !strings.Contains(rec.Body.String(), `"in_flight":null`) {
		t.Errorf("in_flight must serialize as null: %s", rec.Body.String())
	}
}

// TestOperatorActivity_AbsentFilesYieldEmptyRows: no entries file, no log and
// no runs dir is an empty list, not an error.
func TestOperatorActivity_AbsentFilesYieldEmptyRows(t *testing.T) {
	r := newActivityRig(t)
	if err := os.Remove(filepath.Join(r.cronDir, actServer+".yaml")); err != nil {
		t.Fatal(err)
	}
	r.s.cronRunsDirFn = func(context.Context, string) (string, error) { return "", errors.New("no socket") }
	rec := r.get(activityURL())
	body := decodeActivity(t, rec)
	if len(body.Rows) != 0 || !strings.Contains(rec.Body.String(), `"rows":[]`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestOperatorActivity_BadServerIs400(t *testing.T) {
	r := newActivityRig(t)
	for _, target := range []string{"/api/operator/activity", "/api/operator/activity?server=a%2Fb", "/api/operator/activity?server=.."} {
		if rec := r.get(target); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", target, rec.Code)
		}
	}
}

func runFileURL(server, id, kind string) string {
	return "/api/operator/runs/" + server + "/" + id + "/" + kind
}

// TestOperatorRunFile_ServesRawText: brief and log come back verbatim as
// text/plain with no truncation header.
func TestOperatorRunFile_ServesRawText(t *testing.T) {
	r := newActivityRig(t)
	r.writeRunFile(t, actRunC, operatorloop.BriefPath, []byte("# the brief\n"))
	r.writeRunFile(t, actRunC, operatorloop.LogPath, []byte("line 1\nline 2\n"))
	for kind, want := range map[string]string{"brief": "# the brief\n", "log": "line 1\nline 2\n"} {
		rec := r.get(runFileURL(actServer, actRunC, kind))
		if rec.Code != http.StatusOK || rec.Body.String() != want {
			t.Errorf("%s: status=%d body=%q", kind, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
			t.Errorf("%s: content type = %q", kind, ct)
		}
		if rec.Header().Get(truncatedHeader) != "" {
			t.Errorf("%s: unexpected truncation header", kind)
		}
	}
}

// TestOperatorRunFile_CapsHeadForBriefAndTailForLog: an oversized file is cut
// to the cap — the brief keeps its first bytes, the log its last — and the
// response says so.
func TestOperatorRunFile_CapsHeadForBriefAndTailForLog(t *testing.T) {
	r := newActivityRig(t)
	const over = 300 * 1024
	data := make([]byte, over)
	for i := range data {
		data[i] = byte('a' + (i/1024)%26) // each KiB is one letter, so head and tail differ
	}
	r.writeRunFile(t, actRunC, operatorloop.BriefPath, data)
	r.writeRunFile(t, actRunC, operatorloop.LogPath, data)

	brief := r.get(runFileURL(actServer, actRunC, "brief"))
	if brief.Code != http.StatusOK || !bytes.Equal(brief.Body.Bytes(), data[:maxRunFileBytes]) {
		t.Errorf("brief: status=%d len=%d, want the first %d bytes", brief.Code, brief.Body.Len(), maxRunFileBytes)
	}
	if brief.Header().Get(truncatedHeader) != "true" {
		t.Error("brief: missing truncation header")
	}
	log := r.get(runFileURL(actServer, actRunC, "log"))
	if log.Code != http.StatusOK || !bytes.Equal(log.Body.Bytes(), data[over-maxRunFileBytes:]) {
		t.Errorf("log: status=%d len=%d, want the last %d bytes", log.Code, log.Body.Len(), maxRunFileBytes)
	}
	if log.Header().Get(truncatedHeader) != "true" {
		t.Error("log: missing truncation header")
	}
}

// TestOperatorRunFile_ExactCapIsNotTruncated: a file of exactly the cap is
// served whole.
func TestOperatorRunFile_ExactCapIsNotTruncated(t *testing.T) {
	r := newActivityRig(t)
	r.writeRunFile(t, actRunC, operatorloop.LogPath, bytes.Repeat([]byte("x"), maxRunFileBytes))
	rec := r.get(runFileURL(actServer, actRunC, "log"))
	if rec.Body.Len() != maxRunFileBytes || rec.Header().Get(truncatedHeader) != "" {
		t.Errorf("len=%d header=%q", rec.Body.Len(), rec.Header().Get(truncatedHeader))
	}
}

// TestReadCapped_KeepsValidUTF8AtTheCut: a cap landing mid-rune drops the
// partial sequence rather than serving broken text.
func TestReadCapped_KeepsValidUTF8AtTheCut(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(path, []byte("aé€b"), 0o600); err != nil { // a(1) é(2) €(3) b(1)
		t.Fatal(err)
	}
	head, truncated, err := readCapped(path, 4, false) // cuts € after 1 byte
	if err != nil || !truncated || string(head) != "aé" {
		t.Errorf("head = %q truncated=%v err=%v", head, truncated, err)
	}
	tail, truncated, err := readCapped(path, 5, true) // starts inside €
	if err != nil || !truncated || string(tail) != "b" && string(tail) != "€b" {
		t.Errorf("tail = %q truncated=%v err=%v", tail, truncated, err)
	}
}

// TestOperatorRunFile_RejectsBadInputAndMissingFiles: a traversal-shaped server
// or id is 400, an unknown (pruned) run is 404, and the validators run before
// any path is built.
func TestOperatorRunFile_RejectsBadInputAndMissingFiles(t *testing.T) {
	r := newActivityRig(t)
	r.writeRunFile(t, actRunC, operatorloop.LogPath, []byte("x"))
	cases := []struct {
		name, url string
		want      int
	}{
		{"traversal id", "/api/operator/runs/" + actServer + "/..%2Fx/log", http.StatusBadRequest},
		{"dotdot id", "/api/operator/runs/" + actServer + "/../log", http.StatusBadRequest},
		{"short id", runFileURL(actServer, "abc", "log"), http.StatusBadRequest},
		{"bad server", runFileURL("a%20b", actRunC, "log"), http.StatusBadRequest},
		{"traversal server", runFileURL("..%2F..", actRunC, "brief"), http.StatusBadRequest},
		{"pruned run", runFileURL(actServer, actFireA, "log"), http.StatusNotFound},
		{"brief absent", runFileURL(actServer, actRunC, "brief"), http.StatusNotFound},
		{"present log", runFileURL(actServer, actRunC, "log"), http.StatusOK},
	}
	for _, tc := range cases {
		if rec := r.get(tc.url); rec.Code != tc.want {
			t.Errorf("%s: status = %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}
	r.s.cronRunsDirFn = func(context.Context, string) (string, error) { return "", errors.New("no socket") }
	if rec := r.get(runFileURL(actServer, actRunC, "log")); rec.Code != http.StatusNotFound {
		t.Errorf("no runs dir: status = %d, want 404", rec.Code)
	}
}

// TestOperatorActivityRoutesAreReadOnly: the three routes answer GET only
// (Constitution IX — a POST finds no route).
func TestOperatorActivityRoutesAreReadOnly(t *testing.T) {
	r := newActivityRig(t)
	for _, target := range []string{activityURL(), runFileURL(actServer, actRunC, "brief"), runFileURL(actServer, actRunC, "log")} {
		rec := httptest.NewRecorder()
		r.s.buildRouter().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, target, nil))
		if rec.Code != http.StatusMethodNotAllowed && rec.Code != http.StatusNotFound {
			t.Errorf("POST %s: status = %d, want 404/405", target, rec.Code)
		}
	}
}
