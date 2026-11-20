package cron

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"rk/internal/fsatomic"
)

// wake_marker.go — the trigger door's pending-trigger file. A writer (the
// `rk operator wake` CLI, the wake endpoint) drops one line; the tick is the
// only consumer. The file needs no daemon to write and survives a restart.

const (
	// DefaultWakeReason is the reason a marker carries when the writer gave none
	// (and for a marker whose content does not parse).
	DefaultWakeReason = "manual"
	// MaxWakeReasonRunes caps a marker's reason; the marker is one line.
	MaxWakeReasonRunes = 120

	// TriggerReasonPrefix prefixes a marker's reason in the fire reason and the
	// cron log line it writes.
	TriggerReasonPrefix = "trigger:"
)

// WakeMarker is a pending trigger: when it was written and why.
type WakeMarker struct {
	At     int64
	Reason string
}

// NormalizeWakeReason trims a marker reason, maps empty to DefaultWakeReason,
// and rejects control characters (a newline would split the one-line marker)
// and reasons past MaxWakeReasonRunes.
func NormalizeWakeReason(reason string) (string, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return DefaultWakeReason, nil
	}
	for _, r := range reason {
		if unicode.IsControl(r) {
			return "", errors.New("wake reason must not contain control characters")
		}
	}
	if utf8.RuneCountInString(reason) > MaxWakeReasonRunes {
		return "", fmt.Errorf("wake reason must be at most %d characters", MaxWakeReasonRunes)
	}
	return reason, nil
}

// WriteWakeMarker writes the server's marker atomically: `<unix-ts> <reason>\n`,
// mode fileMode. A later write overwrites (one pending trigger per server; the
// newest reason wins). The reason must already be normalized.
func WriteWakeMarker(dir, slug, reason string, now time.Time) error {
	path, err := WakePath(dir, slug)
	if err != nil {
		return err
	}
	reason, err = NormalizeWakeReason(reason)
	if err != nil {
		return err
	}
	return fsatomic.WriteFile(path, []byte(strconv.FormatInt(now.Unix(), 10)+" "+reason+"\n"), fileMode)
}

// ReadWakeMarker reads the server's pending marker. ok is false when none is
// pending. A marker whose content does not parse is still a trigger: it reads
// as present with DefaultWakeReason.
func ReadWakeMarker(dir, slug string) (m WakeMarker, ok bool, err error) {
	path, err := WakePath(dir, slug)
	if err != nil {
		return WakeMarker{}, false, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return WakeMarker{}, false, nil
	}
	if err != nil {
		return WakeMarker{}, false, err
	}
	m = WakeMarker{Reason: DefaultWakeReason}
	ts, reason, found := strings.Cut(strings.TrimSpace(string(data)), " ")
	if !found {
		return m, true, nil
	}
	at, perr := strconv.ParseInt(ts, 10, 64)
	if perr != nil {
		return m, true, nil
	}
	m.At = at
	if r, nerr := NormalizeWakeReason(reason); nerr == nil {
		m.Reason = r
	}
	return m, true, nil
}

// RemoveWakeMarker deletes the server's marker; an absent marker is not an
// error.
func RemoveWakeMarker(dir, slug string) error {
	path, err := WakePath(dir, slug)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
