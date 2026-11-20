package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"rk/internal/cron"
	"rk/internal/inject"
	"rk/internal/riff"
	"rk/internal/snapshot"
	"rk/internal/tmux"
)

// NOTE (tmux safety): these tests never touch a real tmux server, snapshot
// store, or push subscription — the ring scan, spawn, restamp, record drop,
// delivery, and escalation all route through the stubbed cronSession* seams.

const cronSessionTestRef = "4fe2a1b3-1234-4abc-8def-0123456789ab"

// cronSessionRespawnStub owns the stubbed seam state for one session-respawn
// test.
type cronSessionRespawnStub struct {
	records    []snapshot.ClosedWindow
	listErr    error
	gitRoot    string // "" ⇒ cwd is not inside a repo
	spawnErr   error
	spawnOpts  riff.Options
	spawned    bool
	stampOps   []tmux.WindowOptionOp
	stampWinID string
	stampErr   error
	deletedID  string
	deleteErr  error

	readiness   inject.Readiness
	deliverErr  error
	deliverText string
	deliverSrv  string
	deliverPane string
	delivered   bool

	notifyCalls []string
	notifyURLs  []string
	notifyErr   error
}

// cronSessionTestRecord is a ring record that passes every gate for ref.
func cronSessionTestRecord(ref string) snapshot.ClosedWindow {
	return snapshot.ClosedWindow{
		ID:            "1700000000000000001",
		Server:        "work",
		Session:       "proj",
		Window:        snapshot.Window{ID: "@9", Name: "agent", Panes: []snapshot.Pane{{ID: "%9", Cwd: "/repo/proj"}}},
		AgentProvider: "claude",
		AgentRef:      ref,
	}
}

// stubCronSessionRespawnSeams installs recording stubs for every session-
// respawner seam and returns the stub. The store argument to the seam
// functions is ignored — the stub owns the ring data.
func stubCronSessionRespawnSeams(t *testing.T) *cronSessionRespawnStub {
	t.Helper()
	s := &cronSessionRespawnStub{
		records:   []snapshot.ClosedWindow{cronSessionTestRecord(cronSessionTestRef)},
		gitRoot:   "/repo/proj",
		readiness: inject.ReadyByEcho,
	}

	origList := cronSessionListClosedFn
	cronSessionListClosedFn = func(_ *snapshot.Store, server string) ([]snapshot.ClosedWindow, error) {
		if s.listErr != nil {
			return nil, s.listErr
		}
		return s.records, nil
	}
	origDelete := cronSessionDeleteClosedFn
	cronSessionDeleteClosedFn = func(_ *snapshot.Store, _, id string) error {
		s.deletedID = id
		return s.deleteErr
	}
	origGit := cronSessionFindGitRootFn
	cronSessionFindGitRootFn = func(string) string { return s.gitRoot }
	origSpawn := cronSessionSpawnFn
	cronSessionSpawnFn = func(_ context.Context, opts riff.Options) (riff.Result, error) {
		s.spawnOpts = opts
		if s.spawnErr != nil {
			return riff.Result{}, s.spawnErr
		}
		s.spawned = true
		return riff.Result{Server: opts.Server, Session: opts.Session, WindowName: "agent", WindowID: operatorTestWindow, PaneID: operatorTestPane}, nil
	}
	origStamp := cronSessionSetWindowOptionsFn
	cronSessionSetWindowOptionsFn = func(_ context.Context, windowID, _ string, ops []tmux.WindowOptionOp) error {
		s.stampWinID = windowID
		s.stampOps = ops
		return s.stampErr
	}
	origDeliver := cronSessionRespawnDeliverFn
	cronSessionRespawnDeliverFn = func(_ context.Context, _ *inject.Engine, _ inject.Tmux, server, paneID, text string, _ inject.ReadyOpts) (inject.Readiness, error) {
		s.delivered = true
		s.deliverSrv, s.deliverPane, s.deliverText = server, paneID, text
		return s.readiness, s.deliverErr
	}
	origNotify := cronSessionRespawnNotifyFn
	cronSessionRespawnNotifyFn = func(_ context.Context, title, body, url string) error {
		s.notifyCalls = append(s.notifyCalls, title+" | "+body)
		s.notifyURLs = append(s.notifyURLs, url)
		return s.notifyErr
	}

	t.Cleanup(func() {
		cronSessionListClosedFn = origList
		cronSessionDeleteClosedFn = origDelete
		cronSessionFindGitRootFn = origGit
		cronSessionSpawnFn = origSpawn
		cronSessionSetWindowOptionsFn = origStamp
		cronSessionRespawnDeliverFn = origDeliver
		cronSessionRespawnNotifyFn = origNotify
	})
	return s
}

// respawnSessionTestFire is the due-but-absent session-target fire the tick
// hands the seam.
func respawnSessionTestFire(server string) cron.Fire {
	return cron.Fire{
		Server: server,
		Entry: cron.Entry{
			ID:       "b7k2",
			Name:     "sweep",
			Target:   cron.Target{Kind: cron.TargetSession, Session: cronSessionTestRef},
			Payload:  "sweep the queue",
			IfAbsent: cron.IfAbsentRespawn,
		},
	}
}

// TestCronRespawnSessionResumesAndDeliversPayload: the happy path — the
// matching record gates clean, the spawn composes checkout mode at the record
// cwd with ResumePlain (no fork), the record's options are re-stamped and the
// record dropped, and the ENTRY'S PAYLOAD ITSELF (never a kickoff) is
// delivered on a ready classification. Outcome: respawned, no escalation.
func TestCronRespawnSessionResumesAndDeliversPayload(t *testing.T) {
	s := stubCronSessionRespawnSeams(t)
	rec := cronSessionTestRecord(cronSessionTestRef)
	rec.Window.Color = "blue"
	rec.Window.Marker = "pin"
	s.records = []snapshot.ClosedWindow{rec}

	outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, respawnSessionTestFire("work"))
	if outcome.Status != "respawned" {
		t.Fatalf("outcome = %+v, want respawned", outcome)
	}

	if !s.spawned {
		t.Fatal("no spawn")
	}
	wantOpts := riff.Options{
		Server:           "work",
		Session:          "proj",
		Where:            "checkout",
		RepoRoot:         "/repo/proj",
		ResumeSessionRef: cronSessionTestRef,
		ResumePlain:      true,
		WindowNameBase:   "agent",
	}
	if s.spawnOpts != wantOpts {
		t.Errorf("spawn opts = %+v, want %+v (checkout at the record cwd, PLAIN resume — a fork would orphan the entry's session id)", s.spawnOpts, wantOpts)
	}

	if s.stampWinID != operatorTestWindow {
		t.Errorf("restamp window = %q, want the spawned window %s", s.stampWinID, operatorTestWindow)
	}
	if len(s.stampOps) != len(snapshot.WindowOptionOps(rec.Window)) || len(s.stampOps) == 0 {
		t.Errorf("stamp ops = %v, want the record's @rk_win_* set", s.stampOps)
	}
	if s.deletedID != rec.ID {
		t.Errorf("dropped record = %q, want the consumed record %q", s.deletedID, rec.ID)
	}

	if !s.delivered {
		t.Fatal("no payload delivery")
	}
	if s.deliverSrv != "work" || s.deliverPane != operatorTestPane {
		t.Errorf("delivery target = %s/%s, want work/%s", s.deliverSrv, s.deliverPane, operatorTestPane)
	}
	if s.deliverText != "sweep the queue" {
		t.Errorf("delivered text = %q, want the entry's bare payload %q — a resumed conversation has its context restored, so no kickoff exists", s.deliverText, "sweep the queue")
	}
	if len(s.notifyCalls) != 0 {
		t.Errorf("notify calls = %v, want none on success", s.notifyCalls)
	}
}

// TestCronRespawnSessionNewestRecordWins: multiple records carry the same
// AgentRef; the FIRST in the newest-first list supplies the cwd/options.
func TestCronRespawnSessionNewestRecordWins(t *testing.T) {
	s := stubCronSessionRespawnSeams(t)
	older := cronSessionTestRecord(cronSessionTestRef)
	older.ID = "1700000000000000000"
	older.Window.Panes[0].Cwd = "/repo/old"
	newer := cronSessionTestRecord(cronSessionTestRef)
	s.records = []snapshot.ClosedWindow{newer, older}

	outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, respawnSessionTestFire("work"))
	if outcome.Status != "respawned" {
		t.Fatalf("outcome = %+v, want respawned", outcome)
	}
	if s.spawnOpts.RepoRoot != "/repo/proj" {
		t.Errorf("spawn RepoRoot = %q, want the NEWEST record's cwd %q", s.spawnOpts.RepoRoot, "/repo/proj")
	}
	if s.deletedID != newer.ID {
		t.Errorf("dropped record = %q, want the newest record %q", s.deletedID, newer.ID)
	}
}

// TestCronRespawnSessionGateFailuresEscalate: every pre-spawn gate failure
// (no record / ring fault / non-claude / malformed ref / non-repo cwd)
// escalates with exactly one fail-silent notify naming the entry and server,
// returns respawn-failed, and creates NOTHING — no spawn, no restamp, no
// record drop, no delivery.
func TestCronRespawnSessionGateFailuresEscalate(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(s *cronSessionRespawnStub)
		wantDetail string
	}{
		{"no record", func(s *cronSessionRespawnStub) { s.records = nil }, "no closed-window record"},
		{"ring fault", func(s *cronSessionRespawnStub) { s.listErr = errors.New("store read failed") }, "list closed: "},
		{"non-claude provider", func(s *cronSessionRespawnStub) {
			recs := append([]snapshot.ClosedWindow(nil), s.records...)
			recs[0].AgentProvider = "codex"
			s.records = recs
		}, "cannot resume a \"codex\" session"},
		{"malformed ref", func(s *cronSessionRespawnStub) {
			recs := append([]snapshot.ClosedWindow(nil), s.records...)
			recs[0].AgentRef = "not-a-uuid; rm -rf /"
			s.records = recs
			// The fire targets the malformed ref so the scan still matches.
		}, "malformed agent session ref"},
		{"non-repo cwd", func(s *cronSessionRespawnStub) { s.gitRoot = "" }, "not inside a git repository"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := stubCronSessionRespawnSeams(t)
			tc.mutate(s)
			fire := respawnSessionTestFire("work")
			if tc.name == "malformed ref" {
				fire.Entry.Target.Session = "not-a-uuid; rm -rf /"
			}

			outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, fire)
			if outcome.Status != "respawn-failed" {
				t.Fatalf("outcome = %+v, want respawn-failed", outcome)
			}
			if !strings.Contains(outcome.Detail, tc.wantDetail) {
				t.Errorf("detail = %q, want it containing %q", outcome.Detail, tc.wantDetail)
			}
			if len(s.notifyCalls) != 1 {
				t.Fatalf("notify calls = %v, want exactly one escalation", s.notifyCalls)
			}
			if !strings.Contains(s.notifyCalls[0], "sweep") || !strings.Contains(s.notifyCalls[0], "work") {
				t.Errorf("notify = %q, want it naming the entry and server", s.notifyCalls[0])
			}
			if s.notifyURLs[0] != "" {
				t.Errorf("notify url = %q, want empty (nothing was spawned)", s.notifyURLs[0])
			}
			if s.spawned || s.delivered || s.stampWinID != "" || s.deletedID != "" {
				t.Errorf("gate failure leaked work: spawned=%v delivered=%v stamped=%q dropped=%q",
					s.spawned, s.delivered, s.stampWinID, s.deletedID)
			}
		})
	}
}

// TestCronRespawnSessionNilStoreEscalates: an unwired store escalates like a
// missing record — the clock never guesses a cwd.
func TestCronRespawnSessionNilStoreEscalates(t *testing.T) {
	s := stubCronSessionRespawnSeams(t)
	outcome := cronRespawnSession(context.Background(), nil, respawnSessionTestFire("work"))
	if outcome.Status != "respawn-failed" {
		t.Fatalf("outcome = %+v, want respawn-failed", outcome)
	}
	if len(s.notifyCalls) != 1 || s.spawned {
		t.Errorf("notify calls = %v, spawned = %v; want one escalation and no spawn", s.notifyCalls, s.spawned)
	}
}

// TestCronRespawnSessionSpawnFailureEscalates: a riff spawn failure escalates;
// the postlude (restamp/drop) and delivery never run — they are gated on a
// successful spawn.
func TestCronRespawnSessionSpawnFailureEscalates(t *testing.T) {
	s := stubCronSessionRespawnSeams(t)
	s.spawnErr = errors.New("tmux new-window failed: exit status 1")

	outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, respawnSessionTestFire("work"))
	if outcome.Status != "respawn-failed" {
		t.Fatalf("outcome = %+v, want respawn-failed", outcome)
	}
	if !strings.HasPrefix(outcome.Detail, "spawn: ") {
		t.Errorf("detail = %q, want a spawn:-prefixed detail", outcome.Detail)
	}
	if len(s.notifyCalls) != 1 {
		t.Fatalf("notify calls = %v, want exactly one escalation", s.notifyCalls)
	}
	if s.stampWinID != "" || s.deletedID != "" || s.delivered {
		t.Errorf("spawn failure ran the postlude/delivery: stamped=%q dropped=%q delivered=%v", s.stampWinID, s.deletedID, s.delivered)
	}
}

// TestCronRespawnSessionWallsEscalate: every non-ready classification
// (parked / gone / readiness timeout) or a send error escalates fail-silently
// and returns respawn-failed — never a blind delivery, never an in-tick
// retry, and nothing killed. The spawned window stays live and deep-links the
// escalation notify.
func TestCronRespawnSessionWallsEscalate(t *testing.T) {
	cases := []struct {
		name       string
		readiness  inject.Readiness
		deliverErr error
		wantDetail string
	}{
		{"parked (trust wall)", 0, &inject.ParkedError{Snippet: "Do you trust?"}, "readiness: "},
		{"narrow", 0, inject.ErrNarrow, "readiness: "},
		{"gone", 0, inject.ErrGone, "readiness: "},
		{"readiness timeout", 0, inject.ErrNotReady, "readiness: "},
		{"send error after ready", inject.ReadyByEcho, errors.New("paste failed"), "send: paste failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := stubCronSessionRespawnSeams(t)
			s.readiness, s.deliverErr = tc.readiness, tc.deliverErr

			outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, respawnSessionTestFire("work"))
			if outcome.Status != "respawn-failed" {
				t.Fatalf("outcome = %+v, want respawn-failed", outcome)
			}
			if !strings.HasPrefix(outcome.Detail, tc.wantDetail) {
				t.Errorf("detail = %q, want prefix %q", outcome.Detail, tc.wantDetail)
			}
			if len(s.notifyCalls) != 1 {
				t.Fatalf("notify calls = %v, want exactly one escalation", s.notifyCalls)
			}
			if want := "/work/42?tab=cron"; s.notifyURLs[0] != want {
				t.Errorf("notify url = %q, want the spawned window's deep link %q", s.notifyURLs[0], want)
			}
		})
	}
}

// TestCronRespawnSessionPostludeFailuresTolerated: a restamp failure and a
// record-drop failure each log-and-continue — the respawn still delivers and
// reports respawned.
func TestCronRespawnSessionPostludeFailuresTolerated(t *testing.T) {
	s := stubCronSessionRespawnSeams(t)
	s.stampErr = errors.New("set-option failed")
	s.deleteErr = errors.New("remove failed")

	outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, respawnSessionTestFire("work"))
	if outcome.Status != "respawned" {
		t.Fatalf("outcome = %+v, want respawned (postlude failures are best-effort)", outcome)
	}
	if !s.delivered {
		t.Error("payload not delivered despite only postlude failures")
	}
	if len(s.notifyCalls) != 0 {
		t.Errorf("notify calls = %v, want none", s.notifyCalls)
	}
}

// TestCronRespawnSessionNotifyFailSilent: a failing notifier still yields the
// respawn-failed outcome — the escalation channel never changes the result.
func TestCronRespawnSessionNotifyFailSilent(t *testing.T) {
	s := stubCronSessionRespawnSeams(t)
	s.records = nil
	s.notifyErr = errors.New("push service unreachable")

	outcome := cronRespawnSession(context.Background(), &snapshot.Store{}, respawnSessionTestFire("work"))
	if outcome.Status != "respawn-failed" {
		t.Errorf("outcome = %+v, want respawn-failed even when the notify fails", outcome)
	}
}
