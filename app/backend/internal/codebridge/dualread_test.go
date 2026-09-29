package codebridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The legacy dual-read window: for one release after the run-kit → hexokit
// rename, an old code-bridge VSIX keeps writing <state>/run-kit/cb until the
// extension is reinstalled, so host and boot discovery read both dirs when
// the resolved state home is the new one. Records under the resolved dir win
// on a hostId collision.

func newCbHostsDir(t *testing.T, stateRoot, home string) string {
	t.Helper()
	dir := filepath.Join(stateRoot, home, "cb", "hosts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func newCbBootsDir(t *testing.T, stateRoot, home string) string {
	t.Helper()
	dir := filepath.Join(stateRoot, home, "cb", "boots")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeBootMarkerFile(t *testing.T, dir string, m BootMarker) {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, m.HostID+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// R11: a migrated state home (hexokit exists) plus an old VSIX writing legacy
// run-kit/cb/hosts/h1.json — discovery finds h1.
func TestReadRecordsMergedLegacyWindow(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	newCbHostsDir(t, state, "hexokit")
	writeRecord(t, newCbHostsDir(t, state, "run-kit"), HostRecord{HostID: "h1", Folder: "/legacy", PID: 1})

	records, err := ReadRecordsMerged()
	if err != nil {
		t.Fatalf("ReadRecordsMerged: %v", err)
	}
	if len(records) != 1 || records[0].HostID != "h1" || records[0].Folder != "/legacy" {
		t.Errorf("records = %+v, want the legacy h1", records)
	}
}

// R11: on a hostId collision the resolved (new) dir's record wins.
func TestReadRecordsMergedCollisionNewWins(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	writeRecord(t, newCbHostsDir(t, state, "hexokit"), HostRecord{HostID: "h1", Folder: "/new", PID: 1})
	writeRecord(t, newCbHostsDir(t, state, "run-kit"), HostRecord{HostID: "h1", Folder: "/legacy", PID: 2})

	records, err := ReadRecordsMerged()
	if err != nil {
		t.Fatalf("ReadRecordsMerged: %v", err)
	}
	if len(records) != 1 || records[0].Folder != "/new" || records[0].PID != 1 {
		t.Errorf("records = %+v, want only the new-dir h1", records)
	}
}

// R11: a legacy-only home (pre-migration) reads the legacy dir exactly as
// before — the record appears once, not twice.
func TestReadRecordsMergedLegacyOnlyHome(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	writeRecord(t, newCbHostsDir(t, state, "run-kit"), HostRecord{HostID: "h1", Folder: "/legacy", PID: 1})

	records, err := ReadRecordsMerged()
	if err != nil {
		t.Fatalf("ReadRecordsMerged: %v", err)
	}
	if len(records) != 1 || records[0].HostID != "h1" {
		t.Errorf("records = %+v, want h1 exactly once", records)
	}
}

// Boot markers get the same dual-read: a legacy-only marker is found after
// migration, and the resolved dir wins a collision.
func TestReadBootMarkersMerged(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	writeBootMarkerFile(t, newCbBootsDir(t, state, "hexokit"), BootMarker{HostID: "m1", WorkspaceFile: "/new/@1-x.code-workspace"})
	writeBootMarkerFile(t, newCbBootsDir(t, state, "run-kit"), BootMarker{HostID: "m1", WorkspaceFile: "/legacy/@1-x.code-workspace"})
	writeBootMarkerFile(t, newCbBootsDir(t, state, "run-kit"), BootMarker{HostID: "m2", WorkspaceFile: "/legacy/@2-x.code-workspace"})

	markers, err := ReadBootMarkersMerged()
	if err != nil {
		t.Fatalf("ReadBootMarkersMerged: %v", err)
	}
	if len(markers) != 2 {
		t.Fatalf("markers = %+v, want m1 and m2", markers)
	}
	if markers[0].HostID != "m1" || markers[0].WorkspaceFile != "/new/@1-x.code-workspace" {
		t.Errorf("m1 = %+v, want the new-dir marker", markers[0])
	}
	if markers[1].HostID != "m2" {
		t.Errorf("markers[1] = %+v, want the legacy-only m2", markers[1])
	}
}

// A fresh install (neither home exists) reads nothing and errors on nothing.
func TestReadRecordsMergedFresh(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	records, err := ReadRecordsMerged()
	if err != nil || len(records) != 0 {
		t.Errorf("ReadRecordsMerged on fresh state root = (%v, %v), want empty", records, err)
	}
}

// LiveHostsMerged sweeps both dirs: a live legacy record counts, and dead
// records are pruned from the dir they were found in.
func TestLiveHostsMerged(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	sock := startFakeBridge(t, func(line string) (string, bool) {
		return `{"id":"__ping","ok":true,"result":{"folder":"/repo","pid":1,"version":"3.19.0"},"ms":1}`, true
	})

	newDir := newCbHostsDir(t, state, "hexokit")
	legacyDir := newCbHostsDir(t, state, "run-kit")
	writeRecord(t, newDir, HostRecord{HostID: "live-new", Folder: "/repo", PID: os.Getpid(), Sock: sock})
	writeRecord(t, newDir, HostRecord{HostID: "dead-new", Folder: "/dead", PID: deadPID(t)})
	writeRecord(t, legacyDir, HostRecord{HostID: "live-legacy", Folder: "/old", PID: os.Getpid(), Sock: sock})
	writeRecord(t, legacyDir, HostRecord{HostID: "dead-legacy", Folder: "/dead", PID: deadPID(t)})

	live, pruned, err := LiveHostsMerged(context.Background())
	if err != nil {
		t.Fatalf("LiveHostsMerged: %v", err)
	}
	if len(live) != 2 {
		t.Errorf("live = %+v, want live-new and live-legacy", live)
	}
	if len(pruned) != 2 {
		t.Errorf("pruned = %+v, want dead-new and dead-legacy", pruned)
	}
	for _, dirID := range [][2]string{{newDir, "dead-new"}, {legacyDir, "dead-legacy"}} {
		if _, err := os.Stat(recordPath(dirID[0], dirID[1])); !os.IsNotExist(err) {
			t.Errorf("pruned record %s still on disk in %s: %v", dirID[1], dirID[0], err)
		}
	}
	for _, dirID := range [][2]string{{newDir, "live-new"}, {legacyDir, "live-legacy"}} {
		if _, err := os.Stat(recordPath(dirID[0], dirID[1])); err != nil {
			t.Errorf("live record %s removed from %s: %v", dirID[1], dirID[0], err)
		}
	}
}
