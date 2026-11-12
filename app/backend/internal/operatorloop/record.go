package operatorloop

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"rk/internal/cron"
	"rk/internal/fsatomic"
	"rk/internal/operator"
	"rk/internal/validate"
)

// record.go — the per-run durable files under
// <state home>/operator/runs/<slug>/ (dir 0700, files 0600): the run record,
// the rendered brief and the wrapper's output log. The record is the only
// state a fresh daemon needs: written before the window exists (durable before
// acknowledged), updated atomically by the wrapper and by transcription.

const (
	runsSubdir = "runs"
	dirMode    = 0o700
	fileMode   = 0o600

	recordSuffix = ".json"
	briefSuffix  = ".brief.md"
	logSuffix    = ".log"

	// RunRetention is how many run records per server survive pruning.
	RunRetention = 50

	runIDTimeLayout = "20060102T150405"
	runIDSuffixLen  = 4
	runIDAlphabet   = "abcdefghijklmnopqrstuvwxyz0123456789"

	// RunWindowPrefix names a run window `run-<short-id>`.
	RunWindowPrefix = "run-"
)

// ValidRunID reports whether id is a well-formed run id.
func ValidRunID(id string) bool { return validate.ValidRunID(id) }

// NewRunID generates `YYYYMMDDTHHMMSS-xxxx` for now (UTC).
func NewRunID(now time.Time) (string, error) {
	var buf [runIDSuffixLen]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generating run id: %w", err)
	}
	suffix := make([]byte, runIDSuffixLen)
	for i, b := range buf {
		suffix[i] = runIDAlphabet[int(b)%len(runIDAlphabet)]
	}
	return now.UTC().Format(runIDTimeLayout) + "-" + string(suffix), nil
}

// ShortID is the random suffix of a run id, the `<short-id>` of its window name.
func ShortID(id string) string {
	_, short, _ := strings.Cut(id, "-")
	return short
}

// Record is one run's durable record. Timestamps are RFC3339 UTC with zero
// values omitted; ExitCode is a pointer because 0 is a real exit status. Lost
// carries the reason a run never produced an exit status (the launch failed,
// or its window vanished) — transcribed as `run-lost: <reason>`.
type Record struct {
	ID         string   `json:"id"`
	Server     string   `json:"server"`
	Entry      string   `json:"entry"`
	FiredAt    string   `json:"fired_at,omitempty"`
	Changed    []string `json:"changed,omitempty"`
	Window     string   `json:"window,omitempty"`
	StartedAt  string   `json:"started_at,omitempty"`
	EndedAt    string   `json:"ended_at,omitempty"`
	ExitCode   *int     `json:"exit_code,omitempty"`
	Outcome    string   `json:"outcome,omitempty"`
	Lost       string   `json:"lost,omitempty"`
	Transcript string   `json:"transcript,omitempty"`
	Logged     bool     `json:"logged,omitempty"`
}

// Ended reports whether the run has recorded an end.
func (r Record) Ended() bool { return r.EndedAt != "" }

// Duration is the run's length: ended − started, falling back to ended −
// fired when the wrapper never recorded a start. Zero when either end is
// missing or unparseable.
func (r Record) Duration() time.Duration {
	end, err := time.Parse(time.RFC3339, r.EndedAt)
	if err != nil {
		return 0
	}
	start, err := time.Parse(time.RFC3339, r.StartedAt)
	if err != nil {
		if start, err = time.Parse(time.RFC3339, r.FiredAt); err != nil {
			return 0
		}
	}
	if d := end.Sub(start); d > 0 {
		return d
	}
	return 0
}

// FormatTime renders a record timestamp.
func FormatTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// statePathFn resolves rk's operator state file for a server with ONE tmux
// socket query, failing when the socket path is unknown: operator.StatePath
// would fall back to the `default` slug, and run files, notes and seeding must
// not follow a transient query failure onto another server's files. A seam so
// tests run without tmux.
var statePathFn = func(ctx context.Context, server string) (string, error) {
	sock := operator.ServerSocketPath(ctx, server)
	if sock == "" {
		return "", fmt.Errorf("tmux socket path for server %q unavailable", server)
	}
	return operator.StatePath(sock)
}

// Dir is one server's runs directory: <state home>/operator/runs/<slug>, the
// slug being the operator state file's. The server name and slug are validated
// before any path is built, so neither can traverse.
func Dir(ctx context.Context, server string) (string, error) {
	if msg := validate.ValidateServerName(server); msg != "" {
		return "", errors.New(msg)
	}
	statePath, err := statePathFn(ctx, server)
	if err != nil {
		return "", err
	}
	slug := strings.TrimSuffix(filepath.Base(statePath), ".yaml")
	if !cron.ValidSlug(slug) {
		return "", fmt.Errorf("operator state slug %q is not a valid path component", slug)
	}
	return filepath.Join(filepath.Dir(statePath), runsSubdir, slug), nil
}

// FilePath joins a run's file name inside dir. id must be a valid run id.
func FilePath(dir, id, suffix string) (string, error) {
	if !ValidRunID(id) {
		return "", fmt.Errorf("invalid run id %q", id)
	}
	return filepath.Join(dir, id+suffix), nil
}

// RecordPath, BriefPath and LogPath are FilePath for the three run files.
func RecordPath(dir, id string) (string, error) { return FilePath(dir, id, recordSuffix) }
func BriefPath(dir, id string) (string, error)  { return FilePath(dir, id, briefSuffix) }
func LogPath(dir, id string) (string, error)    { return FilePath(dir, id, logSuffix) }

// EnsureDir creates the runs directory (0700).
func EnsureDir(dir string) error { return os.MkdirAll(dir, dirMode) }

// ReadRecord parses one record file.
func ReadRecord(path string) (Record, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Record{}, err
	}
	var r Record
	if err := json.Unmarshal(data, &r); err != nil {
		return Record{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	return r, nil
}

// WriteRecord writes a record atomically (whole file, 0600).
func WriteRecord(path string, r Record) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return fsatomic.WriteFile(path, append(data, '\n'), fileMode)
}

// UpdateRecord is the read-modify-write the wrapper and transcription use:
// each writer changes only its own fields, and the daemon and wrapper never
// write the same phase of a run, so whole-file atomic writes suffice.
func UpdateRecord(path string, mutate func(*Record)) error {
	r, err := ReadRecord(path)
	if err != nil {
		return err
	}
	mutate(&r)
	return WriteRecord(path, r)
}

// writeFile writes a plain run file (brief) atomically.
func writeFile(path string, data []byte) error {
	return fsatomic.WriteFile(path, data, fileMode)
}

// listRunIDs returns the run ids that have a record file in dir, ascending
// (the id sorts chronologically). An absent dir is no runs.
func listRunIDs(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, recordSuffix) {
			continue
		}
		if id := strings.TrimSuffix(name, recordSuffix); ValidRunID(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// Prune deletes the record, brief and log of every run past the newest
// RunRetention — except a record still awaiting transcription, which is
// history the log has not received yet.
func Prune(dir string) error {
	ids, err := listRunIDs(dir)
	if err != nil || len(ids) <= RunRetention {
		return err
	}
	var firstErr error
	for _, id := range ids[:len(ids)-RunRetention] {
		recPath, _ := RecordPath(dir, id)
		if rec, rerr := ReadRecord(recPath); rerr == nil && !rec.Logged {
			continue
		}
		for _, suffix := range []string{recordSuffix, briefSuffix, logSuffix} {
			p, _ := FilePath(dir, id, suffix)
			if rmErr := os.Remove(p); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) && firstErr == nil {
				firstErr = rmErr
			}
		}
	}
	return firstErr
}

// nowTime is the time source for record timestamps; a var so tests pin it.
var nowTime = time.Now
