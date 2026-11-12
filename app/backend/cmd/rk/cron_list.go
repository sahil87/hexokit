package main

import (
	"fmt"
	"text/tabwriter"
	"time"

	"rk/internal/cron"

	"github.com/spf13/cobra"
)

// rk cron list — the disk-derived listing: entry file + delivery log only,
// ZERO tmux commands (a tmux probe against a dead socket would resurrect the
// server, so next-fire/rung/live-orphan derivations stay out of the CLI and
// belong to the API wave; the log-derived orphan streak is disk-only and is
// surfaced here). An absent or empty entry file is an empty listing with
// exit 0; load diagnostics (corrupt entries) print to stderr without failing
// the listing — the tolerant-load posture.

var cronListJSONFlag bool

var cronListCmd = &cobra.Command{
	Use:   "list [--json]",
	Short: "List the server's cron entries (disk-derived; no tmux probes)",
	Long: "List one row per cron entry in the resolved server's intent file: id, " +
		"name, schedule, target, deliver policy, flags (muted/pinned), and " +
		"last-fired (the newest delivery-log line, `-` when none). Derived from " +
		"the entry file and delivery log only — no tmux commands are issued, so " +
		"listing never resurrects a dead server. Corrupt entries are skipped with " +
		"a stderr diagnostic; an absent or empty file yields an empty listing " +
		"with exit 0. --json emits the same records as a JSON array inside the " +
		"standard {\"ok\":true,\"result\":…} envelope, with the " +
		"schedule as a structured object (kind plus its parameters) beside the " +
		"intent fields wake_on, if_absent and respawn; schedule_summary carries " +
		"the table's rendering.",
	Example: `  rk cron list
  rk cron list -L work --json`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, _ []string) error {
		return runCronList(cmd)
	},
}

func init() {
	cronListCmd.Flags().BoolVar(&cronListJSONFlag, "json", false, "Output as JSON")
}

// cronListRecord is one list row / --json element. The JSON shape is a fixed
// key set — unset values serialize as zero values, never as missing keys
// (wake_on is null, respawn is [], if_absent is "") — with one exception:
// muted_until is omitempty, emitted only while the lease is live (an expired
// lease is indistinguishable from no lease). Inside schedule and wake_on the
// optional parameters ARE omitempty, mirroring the entry file's own keys.
// Keys are snake_case like the on-disk YAML; the HTTP API's camelCase
// projection is a separate type by design.
type cronListRecord struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Schedule cronListSchedule `json:"schedule"`
	// ScheduleSummary is the table's rendering of Schedule, kept for one
	// release so consumers that read the pre-structured string keep working.
	ScheduleSummary string          `json:"schedule_summary"`
	WakeOn          *cronListWakeOn `json:"wake_on"`
	Target          string          `json:"target"`
	// Run mirrors the on-disk `run` key of a target-less loop entry; omitted
	// for every typed-payload entry so their fixed key set is unchanged.
	Run        string   `json:"run,omitempty"`
	Deliver    string   `json:"deliver"`
	IfAbsent   string   `json:"if_absent"`
	Respawn    []string `json:"respawn"`
	Pinned     bool     `json:"pinned"`
	Muted      bool     `json:"muted"`
	MutedUntil int64    `json:"muted_until,omitempty"`
	LastFired  int64    `json:"last_fired"`
	// OrphanedSince/ExpiresAt are the log-derived orphan streak (unix
	// seconds; role targets always zero, ExpiresAt zero for pinned). The CLI
	// gathers no live facts, so a target that re-resolved without a logged
	// delivery still reports its streak — the API carries the live snapshot.
	OrphanedSince int64 `json:"orphaned_since"`
	ExpiresAt     int64 `json:"expires_at"`
}

// cronListSchedule is the --json projection of cron.Schedule: kind is always
// present, the parameters only when the entry sets them (each kind uses a
// different subset — every: interval; backoff: min/max; cron: expr/catch_up).
type cronListSchedule struct {
	Kind     string `json:"kind"`
	Interval string `json:"interval,omitempty"`
	Min      string `json:"min,omitempty"`
	Max      string `json:"max,omitempty"`
	Expr     string `json:"expr,omitempty"`
	CatchUp  string `json:"catch_up,omitempty"`
}

// cronListWakeOn is the --json projection of cron.WakeOn.
type cronListWakeOn struct {
	Event    string `json:"event"`
	Scope    string `json:"scope,omitempty"`
	Debounce string `json:"debounce,omitempty"`
}

// cronListDur renders a duration as time.Duration.String() — the encoding
// GET /api/cron uses — or "" when unset so omitempty drops the key.
func cronListDur(d cron.Duration) string {
	if d.Duration <= 0 {
		return ""
	}
	return d.String()
}

func newCronListSchedule(s cron.Schedule) cronListSchedule {
	return cronListSchedule{
		Kind:     s.Kind,
		Interval: cronListDur(s.Interval),
		Min:      cronListDur(s.Min),
		Max:      cronListDur(s.Max),
		Expr:     s.Expr,
		CatchUp:  s.CatchUp,
	}
}

func newCronListWakeOn(w *cron.WakeOn) *cronListWakeOn {
	if w == nil {
		return nil
	}
	return &cronListWakeOn{
		Event:    w.Event,
		Scope:    w.Scope,
		Debounce: cronListDur(w.Debounce),
	}
}

func runCronList(cmd *cobra.Command) error {
	slug, err := cronSlug()
	if err != nil {
		return err
	}
	dir, err := cronDir()
	if err != nil {
		return err
	}
	sink := newSink(cmd)

	entriesPath, err := cron.EntriesPath(dir, slug)
	if err != nil {
		return err
	}
	entries, diags := cron.LoadEntries(entriesPath)
	for _, d := range diags {
		sink.Notef("%s: %s\n", d.Reason, d.Detail)
	}

	logPath, err := cron.LogPath(dir, slug)
	if err != nil {
		return err
	}
	log := cron.ReadLog(logPath)

	records := make([]cronListRecord, 0, len(entries))
	now := cronNowFn()
	for _, e := range entries {
		rec := cronListRecord{
			ID:              e.ID,
			Name:            e.Name,
			Schedule:        newCronListSchedule(e.Schedule),
			ScheduleSummary: cronScheduleSummary(e.Schedule),
			WakeOn:          newCronListWakeOn(e.WakeOn),
			Target:          cronEntryTargetSummary(e),
			Run:             e.Run,
			Deliver:         e.Deliver,
			IfAbsent:        e.IfAbsent,
			Respawn:         e.Respawn,
			Pinned:          e.Pinned,
			Muted:           e.EffectivelyMuted(now),
		}
		if rec.Respawn == nil {
			rec.Respawn = []string{}
		}
		if e.MutedUntil > 0 && now.Unix() < e.MutedUntil {
			rec.MutedUntil = e.MutedUntil
		}
		if last, ok := cron.LastDelivery(log, e.ID); ok {
			rec.LastFired = last.TS
		}
		if !e.IsLoop() && e.Target.Kind != cron.TargetRole {
			rec.OrphanedSince = cron.OrphanedSince(log, e)
			rec.ExpiresAt = cron.OrphanExpiresAt(rec.OrphanedSince, e.Pinned)
		}
		records = append(records, rec)
	}

	if cronListJSONFlag {
		return sink.Envelope(records, nil)
	}

	w := tabwriter.NewWriter(sink.data, 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tSCHEDULE\tTARGET\tDELIVER\tFLAGS\tLAST-FIRED")
	for _, r := range records {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			r.ID, r.Name, r.ScheduleSummary, r.Target, r.Deliver, cronListFlags(r, now), cronListLastFired(r.LastFired))
	}
	return w.Flush()
}

// cronListFlags renders the FLAGS column ("muted(4m)" for a live lease,
// "muted" for the indefinite flag, "pinned", comma-joined; "-" when none). The
// record's Muted is the effective state, so a live lease with no flag still
// renders muted(<remaining>).
func cronListFlags(r cronListRecord, now time.Time) string {
	flags := ""
	if r.MutedUntil > 0 && now.Unix() < r.MutedUntil {
		flags = "muted(" + cronDurationShort(time.Duration(r.MutedUntil-now.Unix())*time.Second) + ")"
	} else if r.Muted {
		flags = "muted"
	}
	if r.Pinned {
		if flags != "" {
			flags += ","
		}
		flags += "pinned"
	}
	if flags == "" {
		return "-"
	}
	return flags
}

// cronListLastFired renders the LAST-FIRED column ("-" when never fired).
func cronListLastFired(ts int64) string {
	if ts == 0 {
		return "-"
	}
	return time.Unix(ts, 0).Format(time.RFC3339)
}
