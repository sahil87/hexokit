package cron

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"rk/internal/fsatomic"
)

// log.go — the append-only per-server delivery log (<slug>.log, JSON lines).
// The log is HISTORY (recovery-backup class per Constitution II): the
// derivation source for `every`'s last-delivery and the backoff anchor-join
// streak, never a live-state source. Trimming loses only old history.

// logCapBytes caps the delivery log; an append that pushes past it trims the
// log atomically to its newest ~half (R11).
const logCapBytes = 512 * 1024

// LogLine is one delivery record.
type LogLine struct {
	TS      int64  `json:"ts"`
	Entry   string `json:"entry"`
	Target  string `json:"target"`
	Reason  string `json:"reason"`
	Outcome string `json:"outcome"`
	// Run is the operator-loop run id a transcribed outcome belongs to; empty
	// on every other line.
	Run string `json:"run,omitempty"`
}

// AppendLog appends one delivery line, then trims to the newest tail when the
// append pushed the file past the cap.
func AppendLog(path string, line LogLine) error {
	data, err := json.Marshal(line)
	if err != nil {
		return fmt.Errorf("marshaling log line: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, fileMode)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	if st.Size() > logCapBytes {
		return trimLog(path)
	}
	return nil
}

// trimLog retains the newest ~half of the log, cut at a line boundary, written
// atomically (temp + rename via fsatomic) so a crash mid-trim never leaves a
// torn file.
func trimLog(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(data) <= logCapBytes {
		return nil
	}
	tail := data[len(data)-logCapBytes/2:]
	if i := bytes.IndexByte(tail, '\n'); i >= 0 {
		tail = tail[i+1:]
	}
	return fsatomic.WriteFile(path, tail, fileMode)
}

// ParseLog decodes log bytes tolerantly: unparseable lines are skipped.
func ParseLog(data []byte) []LogLine {
	var lines []LogLine
	for _, raw := range bytes.Split(data, []byte{'\n'}) {
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 {
			continue
		}
		var l LogLine
		if err := json.Unmarshal(raw, &l); err != nil {
			continue
		}
		lines = append(lines, l)
	}
	return lines
}

// ReadLog reads and parses a delivery log; an absent or unreadable log yields
// nil (the evaluator treats it as "no deliveries").
func ReadLog(path string) []LogLine {
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return nil
	}
	return ParseLog(data)
}

// OwnDeliveries returns the entry's delivery lines in log (chronological)
// order. It is the UNFILTERED view — every own line, any outcome (deliveries,
// suppressions, and schedule history such as `missed` and `rescheduled`).
func OwnDeliveries(lines []LogLine, entryID string) []LogLine {
	var own []LogLine
	for _, l := range lines {
		if l.Entry == entryID {
			own = append(own, l)
		}
	}
	return own
}

// ScheduleHistory is the backoff anchor-join view of the log: the entry's own
// lines strictly newer than its newest "rescheduled" line — an edit's anchor
// reset, which is schedule history like "missed", not a delivery, so the
// boundary line itself is excluded. With no "rescheduled" line it is identical
// to OwnDeliveries. Cutting at the edit keeps pre-edit deliveries from being
// walked as rungs of the new ladder.
func ScheduleHistory(lines []LogLine, entryID string) []LogLine {
	own := OwnDeliveries(lines, entryID)
	for i := len(own) - 1; i >= 0; i-- {
		if own[i].Outcome == "rescheduled" {
			return own[i+1:]
		}
	}
	return own
}

// LastDelivery returns the entry's newest delivery line.
func LastDelivery(lines []LogLine, entryID string) (LogLine, bool) {
	for i := len(lines) - 1; i >= 0; i-- {
		if lines[i].Entry == entryID {
			return lines[i], true
		}
	}
	return LogLine{}, false
}
