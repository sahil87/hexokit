package cron

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWakePathValidatesSlug(t *testing.T) {
	got, err := WakePath("/d", "work")
	if err != nil || got != filepath.Join("/d", "work.wake") {
		t.Fatalf("WakePath = %q, %v", got, err)
	}
	for _, bad := range []string{"", "../x", "a/b", "a b"} {
		if _, err := WakePath("/d", bad); err == nil {
			t.Errorf("WakePath accepted slug %q", bad)
		}
	}
}

func TestWriteWakeMarkerFormatAndMode(t *testing.T) {
	dir := t.TempDir()
	at := time.Unix(1_700_000_000, 0)
	if err := WriteWakeMarker(dir, "work", "note", at); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "work.wake")
	data, _ := os.ReadFile(path)
	if string(data) != "1700000000 note\n" {
		t.Fatalf("marker = %q", data)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
	m, ok, err := ReadWakeMarker(dir, "work")
	if err != nil || !ok || m.Reason != "note" || m.At != at.Unix() {
		t.Fatalf("read = %+v ok=%v err=%v", m, ok, err)
	}
}

func TestWriteWakeMarkerOverwritesAndDefaultsReason(t *testing.T) {
	dir := t.TempDir()
	T := time.Unix(1_700_000_000, 0)
	if err := WriteWakeMarker(dir, "work", "first", T); err != nil {
		t.Fatal(err)
	}
	if err := WriteWakeMarker(dir, "work", "  ", T.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	m, ok, _ := ReadWakeMarker(dir, "work")
	if !ok || m.Reason != DefaultWakeReason || m.At != T.Add(time.Minute).Unix() {
		t.Fatalf("marker = %+v", m)
	}
}

func TestWriteWakeMarkerRejectsBadReasonWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	for _, reason := range []string{"a\nb", "a\x00b", "tab\there", strings.Repeat("x", MaxWakeReasonRunes+1)} {
		if err := WriteWakeMarker(dir, "work", reason, time.Now()); err == nil {
			t.Errorf("reason %q accepted", reason)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "work.wake")); !os.IsNotExist(err) {
		t.Fatalf("a rejected reason left a marker behind: %v", err)
	}
}

func TestNormalizeWakeReason(t *testing.T) {
	cap := strings.Repeat("é", MaxWakeReasonRunes)
	for in, want := range map[string]string{
		"":                                     DefaultWakeReason,
		"  note  ":                             "note",
		"pr:sahil87/hexokit#1161:pull_request": "pr:sahil87/hexokit#1161:pull_request",
		cap:                                    cap,
	} {
		got, err := NormalizeWakeReason(in)
		if err != nil || got != want {
			t.Errorf("NormalizeWakeReason(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestReadWakeMarkerAbsentAndUnparseable(t *testing.T) {
	dir := t.TempDir()
	if _, ok, err := ReadWakeMarker(dir, "work"); ok || err != nil {
		t.Fatalf("absent marker: ok=%v err=%v", ok, err)
	}
	for _, content := range []string{"garbage\n", "notanumber reason\n", "", "1700000000\n"} {
		if err := os.WriteFile(filepath.Join(dir, "work.wake"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		m, ok, err := ReadWakeMarker(dir, "work")
		if err != nil || !ok || m.Reason != DefaultWakeReason {
			t.Errorf("content %q: marker=%+v ok=%v err=%v, want present with reason manual", content, m, ok, err)
		}
	}
}

func TestRemoveWakeMarker(t *testing.T) {
	dir := t.TempDir()
	if err := RemoveWakeMarker(dir, "work"); err != nil {
		t.Fatalf("removing an absent marker: %v", err)
	}
	if err := WriteWakeMarker(dir, "work", "x", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := RemoveWakeMarker(dir, "work"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := ReadWakeMarker(dir, "work"); ok {
		t.Error("marker still present after remove")
	}
}

func TestEntrySlugsIgnoresWakeMarkers(t *testing.T) {
	dir := t.TempDir()
	writeEntryFile(t, dir, "dev", "entries: []\n")
	if err := WriteWakeMarker(dir, "other", "x", time.Now()); err != nil {
		t.Fatal(err)
	}
	slugs, err := entrySlugs(dir)
	if err != nil || len(slugs) != 1 || slugs[0] != "dev" {
		t.Fatalf("slugs = %v, %v", slugs, err)
	}
}
