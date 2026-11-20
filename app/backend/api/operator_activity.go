package api

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/operatorloop"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// operator_activity.go — the read side of the Activity tab. GET
// /api/operator/activity?server=<name> joins the operator-loop entries' own
// cron-log lines with the check record and run record each fire left under the
// server's runs dir; GET /api/operator/runs/{server}/{id}/brief|log serves a
// run's brief and log contents. Everything is derived from plain files at
// request time (the daemon holds nothing), and every route is a read.

const (
	// maxActivityRows is the newest-first row cap; it matches
	// operatorloop.CheckRetention, past which a row has no check record.
	maxActivityRows = operatorloop.CheckRetention

	// maxRunFileBytes caps a served run file: the brief's head or the log's
	// tail.
	maxRunFileBytes = 256 * 1024

	// truncatedHeader flags a run file served short of its full length.
	truncatedHeader = "X-Rk-Truncated"
)

// activityCheck is a row's check record: what the fire's check found. items
// counts distinct item ids across changes and open.
type activityCheck struct {
	CheckedAt string                 `json:"checked_at"`
	Changed   bool                   `json:"changed"`
	Changes   []operator.CheckDelta  `json:"changes"`
	Open      []operator.CheckDelta  `json:"open"`
	Notices   []operator.CheckNotice `json:"notices"`
	Items     int                    `json:"items"`
}

// activityRun is a row's run record plus which run files exist.
type activityRun struct {
	ID        string                   `json:"id"`
	Pass      *operatorloop.PassRecord `json:"pass,omitempty"`
	Outcome   string                   `json:"outcome,omitempty"`
	Lost      string                   `json:"lost,omitempty"`
	ExitCode  *int                     `json:"exit_code,omitempty"`
	StartedAt string                   `json:"started_at,omitempty"`
	EndedAt   string                   `json:"ended_at,omitempty"`
	DurationS int64                    `json:"duration_s"`
	HasBrief  bool                     `json:"has_brief"`
	HasLog    bool                     `json:"has_log"`
}

// activityRow is one fire. Fire is the id joining the check and run records:
// the line's fire id, else its run id. Rung is the ladder position at the line.
type activityRow struct {
	TS      int64          `json:"ts"`
	Entry   string         `json:"entry"`
	Reason  string         `json:"reason"`
	Outcome string         `json:"outcome"`
	Rung    int            `json:"rung"`
	Fire    string         `json:"fire,omitempty"`
	Running bool           `json:"running,omitempty"`
	Check   *activityCheck `json:"check,omitempty"`
	Run     *activityRun   `json:"run,omitempty"`
}

type activityInFlight struct {
	ID        string `json:"id"`
	StartedAt string `json:"started_at"`
}

type activityResponse struct {
	Server   string            `json:"server"`
	InFlight *activityInFlight `json:"in_flight"`
	Rows     []activityRow     `json:"rows"`
}

// listRunWindows lists the server's live run windows through the test seam;
// tmux.ListOperatorRunWindows carries its own timeout.
func (s *Server) listRunWindows(ctx context.Context, server string) ([]tmux.RunWindow, error) {
	if s.listRunWindowsFn != nil {
		return s.listRunWindowsFn(ctx, server)
	}
	return tmux.ListOperatorRunWindows(ctx, server)
}

// operatorRunsDir resolves a server's runs dir through the cronRunsDirFn seam;
// an unwired seam (the test router) has no runs dir.
func (s *Server) operatorRunsDir(ctx context.Context, server string) (string, error) {
	if s.cronRunsDirFn == nil {
		return "", errors.New("runs directory unavailable")
	}
	return s.cronRunsDirFn(ctx, server)
}

// handleOperatorActivity serves GET /api/operator/activity. 400 for a bad
// server name; an absent log, entries file or runs dir is 200 with no rows.
// A tmux listing failure reports no run in flight rather than failing the
// response, and a missing or corrupt record drops only its sub-object.
func (s *Server) handleOperatorActivity(w http.ResponseWriter, r *http.Request) {
	server := r.URL.Query().Get("server")
	if msg := validate.ValidateServerName(server); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	out := activityResponse{Server: server, Rows: []activityRow{}}
	dir, err := s.cronDir()
	if err != nil {
		s.logger.Error("failed to resolve cron dir for operator activity", "server", server, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve cron dir")
		return
	}
	var entries []cron.Entry
	var lines []cron.LogLine
	if path, err := cron.EntriesPath(dir, server); err == nil {
		entries, _ = cron.LoadEntries(path)
	}
	if path, err := cron.LogPath(dir, server); err == nil {
		lines = cron.ReadLog(path)
	}
	runsDir, err := s.operatorRunsDir(r.Context(), server)
	if err != nil {
		runsDir = ""
	}

	rows := loopActivityRows(entries, lines)
	if len(rows) > maxActivityRows {
		rows = rows[:maxActivityRows]
	}
	for i := range rows {
		joinActivityRecords(runsDir, &rows[i])
	}

	if wins, err := s.listRunWindows(r.Context(), server); err == nil && len(wins) > 0 {
		id := wins[0].RunID
		running, started := runningActivityRow(runsDir, id, entries, lines)
		out.InFlight = &activityInFlight{ID: id, StartedAt: started}
		if !hasFire(rows, id) {
			rows = append([]activityRow{running}, rows...)
		}
	}
	out.Rows = rows
	writeJSON(w, http.StatusOK, out)
}

// loopActivityRows turns every operator-loop entry's own log lines into rows,
// newest first, each carrying the ladder rung in effect at its line.
func loopActivityRows(entries []cron.Entry, lines []cron.LogLine) []activityRow {
	rows := []activityRow{}
	for _, e := range entries {
		if !e.IsLoop() {
			continue
		}
		own := cron.OwnDeliveries(lines, e.ID)
		rungs := cron.LoopRungs(own)
		for i, l := range own {
			fire := l.Fire
			if fire == "" {
				fire = l.Run
			}
			rows = append(rows, activityRow{
				TS: l.TS, Entry: l.Entry, Reason: l.Reason, Outcome: l.Outcome, Rung: rungs[i], Fire: fire,
			})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].TS < rows[j].TS })
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows
}

// joinActivityRecords attaches the check and run records named by the row's
// fire id. An unreadable record is simply absent.
func joinActivityRecords(runsDir string, row *activityRow) {
	if runsDir == "" || !operatorloop.ValidRunID(row.Fire) {
		return
	}
	row.Check = readActivityCheck(runsDir, row.Fire)
	row.Run, _ = readActivityRun(runsDir, row.Fire)
}

func readActivityCheck(runsDir, id string) *activityCheck {
	path, err := operatorloop.CheckRecordPath(runsDir, id)
	if err != nil {
		return nil
	}
	rec, err := operatorloop.ReadCheckRecord(path)
	if err != nil {
		return nil
	}
	ids := map[string]struct{}{}
	for _, d := range rec.Changes {
		ids[d.ID] = struct{}{}
	}
	for _, d := range rec.Open {
		ids[d.ID] = struct{}{}
	}
	return &activityCheck{
		CheckedAt: rec.CheckedAt, Changed: rec.Changed, Changes: nonNilDeltas(rec.Changes),
		Open: nonNilDeltas(rec.Open), Notices: nonNilNotices(rec.Notices), Items: len(ids),
	}
}

func nonNilDeltas(d []operator.CheckDelta) []operator.CheckDelta {
	if d == nil {
		return []operator.CheckDelta{}
	}
	return d
}

func nonNilNotices(n []operator.CheckNotice) []operator.CheckNotice {
	if n == nil {
		return []operator.CheckNotice{}
	}
	return n
}

// readActivityRun reads the run record and stats its brief and log. The record
// is also returned for callers that need its reason and times.
func readActivityRun(runsDir, id string) (*activityRun, operatorloop.Record) {
	path, err := operatorloop.RecordPath(runsDir, id)
	if err != nil {
		return nil, operatorloop.Record{}
	}
	rec, err := operatorloop.ReadRecord(path)
	if err != nil {
		return nil, operatorloop.Record{}
	}
	return &activityRun{
		ID: rec.ID, Pass: rec.Pass, Outcome: rec.Outcome, Lost: rec.Lost, ExitCode: rec.ExitCode,
		StartedAt: rec.StartedAt, EndedAt: rec.EndedAt, DurationS: int64(rec.Duration() / time.Second),
		HasBrief: runFileExists(operatorloop.BriefPath, runsDir, id),
		HasLog:   runFileExists(operatorloop.LogPath, runsDir, id),
	}, rec
}

func runFileExists(pathFn func(dir, id string) (string, error), dir, id string) bool {
	path, err := pathFn(dir, id)
	if err != nil {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}

// runningActivityRow builds the synthetic newest row for a run in flight: it
// has no log line until transcription, so its row comes from its records. The
// second return is the run's start time for the in_flight header.
func runningActivityRow(runsDir, id string, entries []cron.Entry, lines []cron.LogLine) (activityRow, string) {
	row := activityRow{Running: true, Fire: id, TS: time.Now().Unix()}
	started := ""
	if runsDir == "" || !operatorloop.ValidRunID(id) {
		return row, started
	}
	row.Check = readActivityCheck(runsDir, id)
	run, rec := readActivityRun(runsDir, id)
	row.Run = run
	if run == nil {
		return row, started
	}
	row.Entry = rec.Entry
	row.Reason = rec.Reason
	if row.Reason == "" {
		row.Reason = string(cron.FireSchedule)
	}
	started = rec.StartedAt
	if started == "" {
		started = rec.FiredAt
	}
	if t, err := time.Parse(time.RFC3339, rec.FiredAt); err == nil {
		row.TS = t.Unix()
	}
	for _, e := range entries {
		if e.ID == rec.Entry && e.IsLoop() {
			row.Rung = cron.LoopLadder(e, lines).Rung
		}
	}
	return row, started
}

func hasFire(rows []activityRow, id string) bool {
	for _, r := range rows {
		if r.Fire == id {
			return true
		}
	}
	return false
}

// handleOperatorRunFile serves GET /api/operator/runs/{server}/{id}/brief and
// .../log as raw text. The server and run id are validated and the path is
// built only by the operatorloop helpers, so no caller-supplied segment reaches
// the filesystem. 400 for a bad server or id; 404 when the file is absent.
func (s *Server) handleOperatorRunFile(pathFn func(dir, id string) (string, error), tail bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		server, id := chi.URLParam(r, "server"), chi.URLParam(r, "id")
		if msg := validate.ValidateServerName(server); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		if !operatorloop.ValidRunID(id) {
			writeError(w, http.StatusBadRequest, "invalid run id")
			return
		}
		dir, err := s.operatorRunsDir(r.Context(), server)
		if err != nil {
			writeError(w, http.StatusNotFound, "no run files for this server")
			return
		}
		path, err := pathFn(dir, id)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid run id")
			return
		}
		data, truncated, err := readCapped(path, maxRunFileBytes, tail)
		if errors.Is(err, fs.ErrNotExist) {
			writeError(w, http.StatusNotFound, "run file not found")
			return
		}
		if err != nil {
			s.logger.Error("failed to read operator run file", "server", server, "run", id, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to read run file")
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if truncated {
			w.Header().Set(truncatedHeader, "true")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

// readCapped reads at most max bytes of a regular file: its head, or its tail
// when tail is set. truncated reports that bytes were left out. The cut is
// moved off a split UTF-8 sequence so the body stays valid text.
func readCapped(path string, max int64, tail bool) (data []byte, truncated bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	if !st.Mode().IsRegular() {
		return nil, false, fs.ErrNotExist
	}
	size := st.Size()
	if tail && size > max {
		if _, err := f.Seek(size-max, io.SeekStart); err != nil {
			return nil, false, err
		}
		truncated = true
	}
	data, err = io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) > max {
		data, truncated = data[:max], true
	}
	if !truncated {
		return data, false, nil
	}
	if tail {
		for len(data) > 0 && !utf8.RuneStart(data[0]) {
			data = data[1:]
		}
	} else {
		for n := len(data); n > 0 && n > len(data)-utf8.UTFMax; n-- {
			if utf8.RuneStart(data[n-1]) {
				if !utf8.FullRune(data[n-1:]) {
					data = data[:n-1]
				}
				break
			}
		}
	}
	return data, true, nil
}
