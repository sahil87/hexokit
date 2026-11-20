package operatorloop

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"

	"rk/internal/fsatomic"
	"rk/internal/operator"
)

// checkrecord.go — one durable record per fire whose check ran, beside the run
// records in the same runs dir: `<fire-id>.check.json`. A fire that launches a
// run shares its id with the run, so `<id>.check.json` sits next to
// `<id>.json`. Listing and pruning of run records ignore these files (their
// stem `<id>.check` is not a run id), so they are listed by their own suffix.

const (
	checkRecordSuffix = ".check.json"

	// CheckRetention is how many check records per server survive pruning,
	// independent of RunRetention.
	CheckRetention = 200
)

// CheckRecord is what one fire's check found. Run is set only when the fire
// persisted a run record.
type CheckRecord struct {
	FiredAt   string                 `json:"fired_at"`
	Reason    string                 `json:"reason"`
	CheckedAt string                 `json:"checked_at"`
	Changed   bool                   `json:"changed"`
	Changes   []operator.CheckDelta  `json:"changes"`
	Open      []operator.CheckDelta  `json:"open"`
	Notices   []operator.CheckNotice `json:"notices"`
	Run       string                 `json:"run,omitempty"`
}

// newCheckRecord snapshots a check result for a fire. The slices marshal as
// arrays even when the check left them nil.
func newCheckRecord(firedAt, reason string, res operator.CheckResult, run string) CheckRecord {
	rec := CheckRecord{
		FiredAt: firedAt, Reason: reason, CheckedAt: res.CheckedAt, Changed: res.Changed,
		Changes: res.Changes, Open: res.Open, Notices: res.Notices, Run: run,
	}
	if rec.CheckedAt == "" {
		rec.CheckedAt = firedAt
	}
	if rec.Changes == nil {
		rec.Changes = []operator.CheckDelta{}
	}
	if rec.Open == nil {
		rec.Open = []operator.CheckDelta{}
	}
	if rec.Notices == nil {
		rec.Notices = []operator.CheckNotice{}
	}
	return rec
}

// CheckRecordPath is FilePath for a check record.
func CheckRecordPath(dir, id string) (string, error) { return FilePath(dir, id, checkRecordSuffix) }

// WriteCheckRecord writes the fire's check record atomically (0600) into dir,
// creating the runs dir when absent.
func WriteCheckRecord(dir, id string, rec CheckRecord) error {
	path, err := CheckRecordPath(dir, id)
	if err != nil {
		return err
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return fsatomic.WriteFile(path, append(data, '\n'), fileMode)
}

// ListCheckIDs returns the fire ids that have a check record in dir,
// ascending (the id sorts chronologically). An absent dir is no records.
func ListCheckIDs(dir string) ([]string, error) { return listIDs(dir, checkRecordSuffix) }

// pruneChecks deletes every check record past the newest CheckRetention.
func pruneChecks(dir string) error {
	ids, err := ListCheckIDs(dir)
	if err != nil || len(ids) <= CheckRetention {
		return err
	}
	var firstErr error
	for _, id := range ids[:len(ids)-CheckRetention] {
		p, _ := CheckRecordPath(dir, id)
		if rmErr := os.Remove(p); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) && firstErr == nil {
			firstErr = rmErr
		}
	}
	return firstErr
}
