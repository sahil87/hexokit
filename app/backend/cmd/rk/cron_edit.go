package main

import (
	"fmt"
	"time"

	"rk/internal/cron"

	"github.com/spf13/cobra"
)

// rk cron edit <id> — change one entry's schedule or policies in place,
// keeping its id and delivery-log history (the rm + add dance mints a new id
// and orphans the old entry's history). Each flag given REPLACES that field;
// omitted fields keep their values; at least one flag is required. The
// schedule flags are add's mutually-exclusive set via the shared
// cronScheduleFromFlags parser — zero schedule flags keeps the stored
// schedule, and --backoff --min/--max replaces the whole ladder (60s/30m
// defaults for the knob not given). Target and creator are immutable:
// --role/--session/--pane are deliberately not defined here (a retarget is a
// different entry — rm + add). The write goes through cron.Edit (the tick
// flock, the validated merge, and the `rescheduled` log line when the
// schedule or deliver policy changed — the anchor reset point). An unknown id
// exits non-zero with `no entry <id>` (the rm/mute/pin shape); flock
// contention surfaces cron.ErrEditContention's message, exit 1.

var (
	cronEditEvery        time.Duration
	cronEditIdleEvery    time.Duration
	cronEditBackoff      bool
	cronEditCronExpr     string
	cronEditCatchUp      string
	cronEditMin          time.Duration
	cronEditMax          time.Duration
	cronEditName         string
	cronEditDeliver      string
	cronEditIfAbsent     string
	cronEditRespawn      []string
	cronEditWakeOn       string
	cronEditWakeScope    string
	cronEditWakeDebounce time.Duration
)

var cronEditCmd = &cobra.Command{
	Use:   `edit <id> [--every <dur> | --idle-every <dur> | --backoff [--min <dur>] [--max <dur>] | --cron "<expr>" [--catch-up once]] [--deliver <policy>] [--name <n>] [--if-absent <policy>] [--respawn <arg>…] [--wake-on <event>|none [--wake-scope <s>] [--wake-debounce <dur>]]`,
	Short: "Edit a cron entry's schedule or policies in place",
	Long: "Edit the cron entry with the given id in the resolved server's " +
		"intent file, keeping its id and delivery-log history. Each flag given " +
		"REPLACES that field; omitted fields keep their values; at least one " +
		"flag is required. The schedule flags are add's mutually-exclusive set " +
		"(--every, --idle-every, --backoff, --cron): pass none to keep the " +
		"stored schedule; --backoff --min/--max replaces the whole ladder " +
		"(60s/30m defaults for the knob not given). A change to the schedule " +
		"or the deliver policy logs a `rescheduled` line — the anchor reset: " +
		"every/cron then count from the edit and a backoff streak restarts " +
		"from the target's idle epoch. Target and creator are immutable: " +
		"to retarget, add a new entry — a target change is a different entry. " +
		"Mute/pin have their own verbs. --respawn replaces the whole argv; " +
		"--if-absent set to a non-respawn value clears it. --wake-on <event> " +
		"replaces the whole wake_on block (server/60s defaults for the knob " +
		"not given); --wake-on none (or off) clears it, and either form logs " +
		"no rescheduled line — wake_on carries no schedule anchor. Exits non-zero " +
		"with `no entry <id>` when the id is unknown.",
	Example: `  rk cron edit a3f9 --idle-every 3m
  rk cron edit a3f9 --deliver skip-if-busy
  rk cron edit a3f9 --backoff --min 2m --max 10m
  rk cron edit a3f9 --wake-on agent-state-change --wake-debounce 2m
  rk cron edit a3f9 --wake-on none
  rk cron edit a3f9 --name "morning digest"`,
	Args: usageArgs(cobra.ExactArgs(1)),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCronEdit(cmd, args[0])
	},
}

func init() {
	f := cronEditCmd.Flags()
	f.DurationVar(&cronEditEvery, "every", 0, "Replace the schedule with a fixed interval (Go duration, e.g. 1h, 90s)")
	f.DurationVar(&cronEditIdleEvery, "idle-every", 0, "Replace the schedule with a flat backoff ladder, min = max (fire every <dur> of agent quiet)")
	f.BoolVar(&cronEditBackoff, "backoff", false, "Replace the schedule with a backoff ladder (60s→30m by default; refine with --min/--max)")
	f.DurationVar(&cronEditMin, "min", time.Minute, "Backoff ladder minimum gap (with --backoff)")
	f.DurationVar(&cronEditMax, "max", 30*time.Minute, "Backoff ladder maximum gap (with --backoff)")
	f.StringVar(&cronEditCronExpr, "cron", "", "Replace the schedule with a 5-field cron expression (daemon local time)")
	f.StringVar(&cronEditCatchUp, "catch-up", "", "With --cron: fire once late after a gap (only: once)")
	f.StringVar(&cronEditDeliver, "deliver", "", "Replace the delivery policy: immediate|when-idle|skip-if-busy")
	f.StringVar(&cronEditName, "name", "", "Replace the display name")
	f.StringVar(&cronEditIfAbsent, "if-absent", "", "Replace the absent-target policy: skip|notify|respawn (a non-respawn value clears the respawn argv)")
	f.StringArrayVar(&cronEditRespawn, "respawn", nil, "Replace the whole respawn argv (repeatable; requires --if-absent respawn)")
	f.StringVar(&cronEditWakeOn, "wake-on", "", "Replace the whole wake_on block (only: agent-state-change); none|off clears it")
	f.StringVar(&cronEditWakeScope, "wake-scope", cron.WakeScopeServer, "Fingerprint scope for --wake-on (only: server)")
	f.DurationVar(&cronEditWakeDebounce, "wake-debounce", cronWakeDebounceDefault, "Hold a --wake-on fire this long after the entry's own newest delivery")
}

func runCronEdit(cmd *cobra.Command, id string) error {
	flags := cmd.Flags()
	schedule, scheduleSet, err := cronScheduleFromFlags(cmd, cronScheduleFlags{
		every:     cronEditEvery,
		idleEvery: cronEditIdleEvery,
		min:       cronEditMin,
		max:       cronEditMax,
		cronExpr:  cronEditCronExpr,
		catchUp:   cronEditCatchUp,
	})
	if err != nil {
		return err
	}
	if flags.Changed("deliver") {
		if err := cronAddValidateEnum("--deliver", cronEditDeliver, cron.DeliverImmediate, cron.DeliverWhenIdle, cron.DeliverSkipIfBusy); err != nil {
			return err
		}
	}
	if flags.Changed("if-absent") {
		if err := cronAddValidateEnum("--if-absent", cronEditIfAbsent, cron.IfAbsentSkip, cron.IfAbsentNotify, cron.IfAbsentRespawn); err != nil {
			return err
		}
	}
	wakeOn, err := cronWakeOnFromFlags(cmd, cronEditWakeOn, cronEditWakeScope, cronEditWakeDebounce, true)
	if err != nil {
		return err
	}
	edited := scheduleSet || flags.Changed("deliver") || flags.Changed("name") ||
		flags.Changed("if-absent") || flags.Changed("respawn") || flags.Changed("wake-on")
	if !edited {
		return usageError(fmt.Errorf("nothing to edit — pass a schedule flag, --deliver, --name, --if-absent, --respawn, or --wake-on"))
	}

	apply := func(e *cron.Entry) {
		if scheduleSet {
			e.Schedule = schedule
		}
		if flags.Changed("name") {
			e.Name = cronEditName
		}
		if flags.Changed("deliver") {
			e.Deliver = cronEditDeliver
		}
		if flags.Changed("if-absent") {
			e.IfAbsent = cronEditIfAbsent
			// An argv without the respawn policy is dead weight (and would
			// trip the merged-entry respawn rule).
			if cronEditIfAbsent != cron.IfAbsentRespawn {
				e.Respawn = nil
			}
		}
		if flags.Changed("respawn") {
			e.Respawn = cronEditRespawn
		}
		if flags.Changed("wake-on") {
			e.WakeOn = wakeOn // nil on the none|off clear form
		}
	}

	slug, dir, err := cronMutTarget()
	if err != nil {
		return err
	}

	// The merged-entry usage rules (the add-time respawn pair, the respawn
	// intent) are classified as usage here — the caller can fix the flags —
	// so they are checked against a pre-load before cron.Edit's own
	// validate/ValidateRespawnIntent gate runs under the flock. An entry the
	// tolerant load cannot see (absent/corrupt file, unknown id) skips the
	// pre-check; cron.Edit then reports the refusing-to-mutate / no-entry
	// outcome itself.
	if stored, ok := cronEditStoredEntry(dir, slug, id); ok {
		merged := stored
		apply(&merged)
		if flags.Changed("respawn") && len(merged.Respawn) > 0 && merged.IfAbsent != cron.IfAbsentRespawn {
			return usageError(fmt.Errorf("--respawn only applies with --if-absent respawn"))
		}
		if err := cron.ValidateRespawnIntent(merged); err != nil {
			return usageError(fmt.Errorf("%w — pass repeatable --respawn <arg>", err))
		}
	}

	entry, found, err := cron.Edit(dir, slug, id, cronNowFn(), apply)
	if err != nil {
		// ErrEditContention ("cron tick in progress — retry") and store
		// errors are operational (exit 1); the caller-fixable merge rules
		// were pre-checked above, mirroring add's classification.
		return err
	}
	if !found {
		return fmt.Errorf("no entry %s", id)
	}
	newSink(cmd).Dataf("edited %s %s [%s -> %s]\n", entry.ID, entry.Name,
		cronScheduleSummary(entry.Schedule), cronEntryTargetSummary(entry))
	return nil
}

// cronEditStoredEntry reads the stored entry for the merged-view usage
// pre-checks. The tolerant load doubles as the not-found signal: ok=false
// means "let cron.Edit decide" (unknown id, absent file, corrupt file).
func cronEditStoredEntry(dir, slug, id string) (cron.Entry, bool) {
	path, err := cron.EntriesPath(dir, slug)
	if err != nil {
		return cron.Entry{}, false
	}
	entries, _ := cron.LoadEntries(path)
	for _, e := range entries {
		if e.ID == id {
			return e, true
		}
	}
	return cron.Entry{}, false
}
