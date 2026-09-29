package codebridge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateDirXDGOverride(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	dir, err := StateDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(state, "hexokit", "cb") {
		t.Errorf("dir = %s", dir)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	dir, err = StateDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(home, ".local", "state", "hexokit", "cb") {
		t.Errorf("default dir = %s", dir)
	}
}

func TestHostsDir(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	dir, err := HostsDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(state, "hexokit", "cb", "hosts") {
		t.Errorf("hosts dir = %s", dir)
	}
}

func TestBootsDir(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	dir, err := BootsDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(state, "hexokit", "cb", "boots") {
		t.Errorf("boots dir = %s", dir)
	}
}

func TestReadRecords(t *testing.T) {
	dir := t.TempDir()
	writeRecord(t, dir, HostRecord{HostID: "b2", Folder: "/two", PID: 1})
	writeRecord(t, dir, HostRecord{HostID: "a1", Folder: "/one", PID: 2})
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}

	records, err := ReadRecords(dir)
	if err != nil {
		t.Fatalf("ReadRecords: %v", err)
	}
	// Sorted by host id; the undecodable file is skipped.
	if len(records) != 2 || records[0].HostID != "a1" || records[1].HostID != "b2" {
		t.Errorf("records = %+v", records)
	}
}

func TestReadRecordsMissingDir(t *testing.T) {
	records, err := ReadRecords(filepath.Join(t.TempDir(), "nope"))
	if err != nil || len(records) != 0 {
		t.Errorf("ReadRecords on missing dir = (%v, %v), want empty", records, err)
	}
}
