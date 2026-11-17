package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"rk/internal/cron"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk cron add <prompt> — record one cron entry in the resolved server's
// intent file. Exactly one schedule flag is required: --every <dur>,
// --idle-every <dur> (sugar for a flat backoff ladder, min = max), bare
// --backoff (a ladder keyed on the target pane's idle epoch, min/max
// refinable), or --cron "<expr>" (a 5-field expression in the daemon's local
// time, validated at add time; --catch-up once fires once late after a gap).
// Inside a tmux pane the creator is auto-captured ($TMUX_PANE + now, plus the
// pane's agent-session ref when one is stamped) and the target defaults down
// the ladder: the caller window's role when it carries any @rk_win_role, else
// the caller pane's agent session, else the caller's own pane; explicit
// --role/--session/--pane (mutually exclusive) override. Outside tmux an
// explicit target flag is required — a typed command must not guess a target.
// The write goes through cron.Add only (atomic read-modify-write, id
// generation, per-entry validation — a corrupt file refuses to mutate).

// cronAddNameMaxRunes caps the derived --name default (a prompt prefix).
const cronAddNameMaxRunes = 40

var (
	cronAddEvery        time.Duration
	cronAddIdleEvery    time.Duration
	cronAddBackoff      bool
	cronAddCronExpr     string
	cronAddCatchUp      string
	cronAddMin          time.Duration
	cronAddMax          time.Duration
	cronAddName         string
	cronAddDeliver      string
	cronAddIfAbsent     string
	cronAddRespawn      []string
	cronAddPinned       bool
	cronAddRole         string
	cronAddPane         string
	cronAddSession      string
	cronAddJSON         bool
	cronAddWakeOn       string
	cronAddWakeScope    string
	cronAddWakeDebounce time.Duration
)

// cronAddReceipt is the --json success document: exactly the four fields the
// human line prints, as the same strings (schedule/target via the summary
// helpers).
type cronAddReceipt struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Schedule string `json:"schedule"`
	Target   string `json:"target"`
}

var cronAddCmd = &cobra.Command{
	Use:   `add <prompt> --every <dur> | --idle-every <dur> | --backoff | --cron "<expr>"`,
	Short: "Add a cron entry to the server's intent file",
	Long: "Add a cron entry delivering <prompt> on a schedule. The prompt is text for an " +
		"agent, not a command: at fire time rk types it into the target agent's chat through the " +
		"injection engine and presses Enter, exactly as if a person had typed it; " +
		"it is never run as a command — to run a command, ask the agent to run it. " +
		"Exactly one schedule flag is required: --every <dur> (a positive Go " +
		"duration like 1h or 90s), --idle-every <dur> (fire every <dur> of agent " +
		"quiet — a flat backoff ladder, min = max; unlike --every, the count " +
		"restarts on genuine activity and the clock's own deliveries never " +
		"restart it), --backoff (a backoff ladder keyed on the target " +
		"pane's idle epoch — resets on genuine activity, continues otherwise; " +
		"60s→30m by default, refine with --min/--max), or --cron \"<expr>\" (a " +
		"5-field expression in the daemon's local time, validated at add time; " +
		"--catch-up once fires once late after a gap). Run inside a tmux " +
		"pane, the creator is auto-captured from $TMUX_PANE and the target defaults " +
		"to your window's role when it carries any @rk_win_role, else your " +
		"pane's agent session, else your own pane; --role <role>, --session <ref>, " +
		"or --pane %N override (mutually exclusive). Outside tmux, --role, " +
		"--session, or --pane is required. --name defaults to a prompt prefix; " +
		"--deliver (immediate | when-idle | skip-if-busy) and --if-absent are " +
		"validated at add time and enforced at fire time. " +
		"--wake-on <event> adds the reactive channel: the entry also fires " +
		"when an agent in scope goes waiting/idle or vanishes, in addition to " +
		"the schedule; --wake-scope sets the fingerprint scope (server) and " +
		"--wake-debounce holds the fire after the entry's own newest delivery " +
		"(default 60s), so a burst coalesces into one fire. " +
		"With --if-absent respawn, repeat --respawn <arg> to give " +
		"the command that brings the target back (one argv element per " +
		"occurrence; the exact text {server} in any element is replaced with the " +
		"entry's stamped tmux server name at fire time) — required for role and " +
		"pane targets, optional for session targets (which default to resuming " +
		"the closed session).",
	Example: `  rk cron add "check PRs" --every 1h
  rk cron add "wake up" --idle-every 3m
  rk cron add "tick" --backoff --min 2m --max 30m
  rk cron add "nightly" --cron "0 3 * * *" --role operator
  rk cron add "morning digest" --cron "0 9 * * *" --deliver skip-if-busy
  rk cron add "anything waiting on me? one line" --backoff --min 3m --max 24m --wake-on agent-state-change --deliver skip-if-busy --session 4fe2abc-1c3b-4f7e-9a2d-8b5c4e1f0a37 --if-absent respawn
  rk cron add "follow up" --every 2h --session 4fe2abc-1c3b-4f7e-9a2d-8b5c4e1f0a37`,
	Args: usageArgs(cobra.ExactArgs(1)),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCronAdd(cmd, args[0])
	},
}

func init() {
	f := cronAddCmd.Flags()
	f.DurationVar(&cronAddEvery, "every", 0, "Fire on a fixed interval (Go duration, e.g. 1h, 90s)")
	f.DurationVar(&cronAddIdleEvery, "idle-every", 0, "Fire every <dur> of agent quiet: <dur> after the target pane last went idle for a reason other than the clock, then every <dur> while it stays idle (a flat backoff ladder, min = max)")
	f.BoolVar(&cronAddBackoff, "backoff", false, "Fire on a backoff ladder keyed on the target pane's idle epoch — resets on genuine activity, continues otherwise (60s→30m by default; refine with --min/--max)")
	f.StringVar(&cronAddCronExpr, "cron", "", "Fire on a 5-field cron expression (daemon local time, validated at add time)")
	f.StringVar(&cronAddCatchUp, "catch-up", "", "With --cron: fire once late after a gap (only: once)")
	f.DurationVar(&cronAddMin, "min", time.Minute, "Backoff ladder minimum gap (with --backoff)")
	f.DurationVar(&cronAddMax, "max", 30*time.Minute, "Backoff ladder maximum gap (with --backoff)")
	f.StringVar(&cronAddName, "name", "", "Display name (default: a prompt prefix)")
	f.StringVar(&cronAddDeliver, "deliver", cron.DeliverImmediate, "Delivery policy: immediate|when-idle|skip-if-busy")
	f.StringVar(&cronAddIfAbsent, "if-absent", cron.IfAbsentSkip, "Absent-target policy: skip|notify|respawn")
	f.StringArrayVar(&cronAddRespawn, "respawn", nil, "With --if-absent respawn: one argv element of the respawn command per occurrence (repeatable; {server} resolves to the entry's server at fire time)")
	f.BoolVar(&cronAddPinned, "pinned", false, "Pin the entry (exempt from orphan expiry)")
	f.StringVar(&cronAddRole, "role", "", "Target a server role (the @rk_win_role value, e.g. operator)")
	f.StringVar(&cronAddPane, "pane", "", "Target a pane id (%N)")
	f.StringVar(&cronAddSession, "session", "", "Target an agent session ref (e.g. 4fe2abc-…)")
	f.BoolVar(&cronAddJSON, "json", false, "Emit the machine-readable envelope (exactly one JSON document on stdout)")
	f.StringVar(&cronAddWakeOn, "wake-on", "", "Also fire on an actionable agent-state edge (only: agent-state-change)")
	f.StringVar(&cronAddWakeScope, "wake-scope", cron.WakeScopeServer, "Fingerprint scope for --wake-on (only: server)")
	f.DurationVar(&cronAddWakeDebounce, "wake-debounce", cronWakeDebounceDefault, "Hold a --wake-on fire this long after the entry's own newest delivery")
}

// Seams so runCronAdd is testable without a live tmux server: the clock, the
// caller's pane, the caller-window role read, and the caller-pane session read.
var (
	cronNowFn      = time.Now
	cronTmuxPaneFn = func() string { return os.Getenv("TMUX_PANE") }
	// cronWindowRoleFn resolves the pane's window and reads its role option.
	// Any failure degrades the add down the capture ladder — the caller IS
	// the pane, so that fallback never guesses.
	cronWindowRoleFn = func(ctx context.Context, paneID, server string) (string, error) {
		windowID, err := tmux.WindowIDForPane(ctx, paneID, server)
		if err != nil {
			return "", err
		}
		return tmux.GetWindowOption(ctx, windowID, server, tmux.RoleOption)
	}
	// cronPaneSessionFn reads the pane's agent-session option and returns the
	// parsed ref half ("" when unset or unparseable — tolerance, not error).
	// A read failure degrades session capture the same way the role read
	// degrades role capture: a note, then the next rung.
	cronPaneSessionFn = func(ctx context.Context, paneID, server string) (string, error) {
		raw, err := tmux.GetPaneOption(ctx, paneID, server, tmux.AgentSessionOption)
		if err != nil {
			return "", err
		}
		_, ref := tmux.ParseAgentSessionRef(raw)
		return ref, nil
	}
)

// cronAddTimeout bounds the auto-capture option reads (the only subprocesses
// the verb spawns; the write itself is local disk).
const cronAddTimeout = 5 * time.Second

func runCronAdd(cmd *cobra.Command, payload string) error {
	schedule, err := cronAddSchedule(cmd)
	if err != nil {
		return err
	}
	if err := cronAddValidateEnum("--deliver", cronAddDeliver, cron.DeliverImmediate, cron.DeliverWhenIdle, cron.DeliverSkipIfBusy); err != nil {
		return err
	}
	if err := cronAddValidateEnum("--if-absent", cronAddIfAbsent, cron.IfAbsentSkip, cron.IfAbsentNotify, cron.IfAbsentRespawn); err != nil {
		return err
	}
	if len(cronAddRespawn) > 0 && cronAddIfAbsent != cron.IfAbsentRespawn {
		return usageError(fmt.Errorf("--respawn only applies with --if-absent respawn"))
	}
	wakeOn, err := cronWakeOnFromFlags(cmd, cronAddWakeOn, cronAddWakeScope, cronAddWakeDebounce, false)
	if err != nil {
		return err
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, cronAddTimeout)
	defer cancel()

	slug, err := cronSlug()
	if err != nil {
		return err
	}
	sink := newSink(cmd)
	target, createdBy, err := cronAddTarget(ctx, slug, sink)
	if err != nil {
		return err
	}

	name := cronAddName
	if name == "" {
		name = truncateRunes(payload, cronAddNameMaxRunes)
	}

	// The add-time respawn rule (cron.ValidateRespawnIntent, also enforced
	// inside cron.Add for the API path) is classified as usage here: the
	// caller can fix the flags.
	if err := cron.ValidateRespawnIntent(cron.Entry{Target: target, IfAbsent: cronAddIfAbsent, Respawn: cronAddRespawn}); err != nil {
		return usageError(fmt.Errorf("%w — pass repeatable --respawn <arg>", err))
	}

	dir, err := cronDir()
	if err != nil {
		return err
	}
	// An empty --respawn set is the unset case — the entry file omits the key.
	respawn := cronAddRespawn
	if len(respawn) == 0 {
		respawn = nil
	}
	entry, err := cron.Add(dir, slug, cron.Entry{
		Name:      name,
		Schedule:  schedule,
		Target:    target,
		Payload:   payload,
		Deliver:   cronAddDeliver,
		IfAbsent:  cronAddIfAbsent,
		Respawn:   respawn,
		Pinned:    cronAddPinned,
		WakeOn:    wakeOn,
		CreatedBy: createdBy,
	})
	if err != nil {
		return err
	}
	if cronAddJSON {
		sink.JSONResult(cronAddReceipt{
			ID:       entry.ID,
			Name:     entry.Name,
			Schedule: cronScheduleSummary(entry.Schedule),
			Target:   cronTargetSummary(entry.Target),
		})
		return nil
	}
	sink.Dataf("%s %s [%s -> %s]\n", entry.ID, entry.Name, cronScheduleSummary(entry.Schedule), cronTargetSummary(entry.Target))
	return nil
}

// cronScheduleExactlyOne is the four-way schedule-flag exclusion shared by
// `add` (which requires exactly one) and `edit` (which rejects more than one;
// zero means "keep the stored schedule").
const cronScheduleExactlyOne = "exactly one schedule flag is required: --every, --idle-every, --backoff, or --cron"

// cronScheduleFlags carries the raw schedule-flag values of one verb (`add`
// and `edit` bind their own flag vars); the Changed bits are read off the
// command by cronScheduleFromFlags.
type cronScheduleFlags struct {
	every     time.Duration
	idleEvery time.Duration
	min       time.Duration
	max       time.Duration
	cronExpr  string
	catchUp   string
}

// cronAddSchedule is the add-side wrapper over the shared parser: exactly one
// schedule flag is required.
func cronAddSchedule(cmd *cobra.Command) (cron.Schedule, error) {
	schedule, set, err := cronScheduleFromFlags(cmd, cronScheduleFlags{
		every:     cronAddEvery,
		idleEvery: cronAddIdleEvery,
		min:       cronAddMin,
		max:       cronAddMax,
		cronExpr:  cronAddCronExpr,
		catchUp:   cronAddCatchUp,
	})
	if err != nil {
		return cron.Schedule{}, err
	}
	if !set {
		return cron.Schedule{}, usageError(fmt.Errorf("%s", cronScheduleExactlyOne))
	}
	return schedule, nil
}

// cronScheduleFromFlags validates the schedule flag set and builds the
// schedule, returning set=false when no schedule flag was given (edit's
// "keep the schedule" case). At most one of --every/--idle-every/--backoff/
// --cron may be set; --min/--max and --catch-up are legal only alongside
// --backoff and --cron respectively. --idle-every d is sugar for a flat
// backoff ladder {backoff, d, d}. The 5-field count is a friendlier
// usage-error pre-check; validate() (ParseStandard) stays the authority on
// what parses.
func cronScheduleFromFlags(cmd *cobra.Command, f cronScheduleFlags) (cron.Schedule, bool, error) {
	set := 0
	for _, name := range []string{"every", "idle-every", "backoff", "cron"} {
		if cmd.Flags().Changed(name) {
			set++
		}
	}
	if set > 1 {
		return cron.Schedule{}, false, usageError(fmt.Errorf("%s", cronScheduleExactlyOne))
	}
	if cmd.Flags().Changed("min") || cmd.Flags().Changed("max") {
		if !cmd.Flags().Changed("backoff") {
			return cron.Schedule{}, false, usageError(fmt.Errorf("--min/--max only apply with --backoff"))
		}
	}
	if cmd.Flags().Changed("catch-up") {
		if !cmd.Flags().Changed("cron") {
			return cron.Schedule{}, false, usageError(fmt.Errorf("--catch-up only applies with --cron"))
		}
		if f.catchUp != cron.CatchUpOnce {
			return cron.Schedule{}, false, usageError(fmt.Errorf("invalid --catch-up value %q: want %q", f.catchUp, cron.CatchUpOnce))
		}
	}
	switch {
	case cmd.Flags().Changed("every"):
		if f.every <= 0 {
			return cron.Schedule{}, false, usageError(fmt.Errorf("--every must be a positive duration, got %s", f.every))
		}
		return cron.Schedule{Kind: cron.ScheduleEvery, Interval: cron.Duration{Duration: f.every}}, true, nil
	case cmd.Flags().Changed("idle-every"):
		if f.idleEvery <= 0 {
			return cron.Schedule{}, false, usageError(fmt.Errorf("--idle-every must be a positive duration, got %s", f.idleEvery))
		}
		return cron.Schedule{
			Kind: cron.ScheduleBackoff,
			Min:  cron.Duration{Duration: f.idleEvery},
			Max:  cron.Duration{Duration: f.idleEvery},
		}, true, nil
	case cmd.Flags().Changed("backoff"):
		return cron.Schedule{
			Kind: cron.ScheduleBackoff,
			Min:  cron.Duration{Duration: f.min},
			Max:  cron.Duration{Duration: f.max},
		}, true, nil
	case cmd.Flags().Changed("cron"):
		if len(strings.Fields(f.cronExpr)) != 5 {
			return cron.Schedule{}, false, usageError(fmt.Errorf("--cron must be a 5-field cron expression, got %q", f.cronExpr))
		}
		return cron.Schedule{Kind: cron.ScheduleCron, Expr: f.cronExpr, CatchUp: f.catchUp}, true, nil
	}
	return cron.Schedule{}, false, nil
}

// cronAddValidateEnum gates a flag value against the schema's closed set at
// parse time, so a bad value is a usage error (exit 2) before any write;
// Entry.validate() enforces the same sets on the store/API path.
func cronAddValidateEnum(flag, value string, valid ...string) error {
	for _, v := range valid {
		if value == v {
			return nil
		}
	}
	return usageError(fmt.Errorf("invalid %s value %q: want one of %v", flag, value, valid))
}

// The edit-only clear spellings for --wake-on; add validates against the
// event enum only (there is nothing to clear on a fresh entry).
const (
	cronWakeClearNone = "none"
	cronWakeClearOff  = "off"
	// cronWakeDebounceDefault is the --wake-debounce default shared by add and
	// edit; the two verbs bind separate flag vars and must agree.
	cronWakeDebounceDefault = 60 * time.Second
)

// cronWakeOnFromFlags validates the wake flag set and builds the wake_on
// block, returning w=nil when --wake-on was not given (the entry file omits
// the key). --wake-scope/--wake-debounce refine the block and are a usage
// error without --wake-on (the --min/--max rule), detected via Changed so an
// explicit default-value knob still errors. When allowClear (edit), the
// none/off spellings also return nil — the caller nils the stored block
// under Changed("wake-on") — and combining them with a knob is a usage error. Shared by add and
// edit, which bind their own flag vars.
func cronWakeOnFromFlags(cmd *cobra.Command, on, scope string, debounce time.Duration, allowClear bool) (*cron.WakeOn, error) {
	flags := cmd.Flags()
	if !flags.Changed("wake-on") {
		if flags.Changed("wake-scope") || flags.Changed("wake-debounce") {
			return nil, usageError(fmt.Errorf("--wake-scope/--wake-debounce only apply with --wake-on"))
		}
		return nil, nil
	}
	if allowClear && (on == cronWakeClearNone || on == cronWakeClearOff) {
		if flags.Changed("wake-scope") || flags.Changed("wake-debounce") {
			return nil, usageError(fmt.Errorf("--wake-scope/--wake-debounce do not apply with --wake-on none"))
		}
		return nil, nil
	}
	if err := cronAddValidateEnum("--wake-on", on, cron.WakeAgentStateChange); err != nil {
		return nil, err
	}
	if err := cronAddValidateEnum("--wake-scope", scope, cron.WakeScopeServer); err != nil {
		return nil, err
	}
	if debounce < 0 {
		return nil, usageError(fmt.Errorf("--wake-debounce must not be negative, got %s", debounce))
	}
	return &cron.WakeOn{
		Event:    on,
		Scope:    scope,
		Debounce: cron.Duration{Duration: debounce},
	}, nil
}

// cronAddTarget resolves the entry's target and creator provenance. Explicit
// flags win; else inside a pane the target defaults down the ladder — the
// caller window's role when it carries any @rk_win_role, else the caller
// pane's agent session, else the caller's pane; outside tmux an explicit flag
// is required (a typed command must not guess). created_by.at is always "now"
// — it anchors `every` schedules pre-first-delivery, so a zero value would
// anchor at the Unix epoch and fire at once.
// created_by.session is the caller pane's parsed agent-session ref whenever
// one is stamped, regardless of the target kind chosen.
func cronAddTarget(ctx context.Context, slug string, sink outputSink) (cron.Target, cron.CreatedBy, error) {
	var set []string
	for _, f := range []struct {
		name, value string
	}{
		{"--role", cronAddRole},
		{"--pane", cronAddPane},
		{"--session", cronAddSession},
	} {
		if f.value != "" {
			set = append(set, f.name)
		}
	}
	if len(set) > 1 {
		return cron.Target{}, cron.CreatedBy{}, usageError(fmt.Errorf("%s are mutually exclusive", strings.Join(set, " and ")))
	}
	// A role value is a tmux option discriminator other verbs read back — the
	// same name-shape rule session refs already pass through.
	if cronAddRole != "" && strings.IndexFunc(cronAddRole, unicode.IsSpace) >= 0 {
		return cron.Target{}, cron.CreatedBy{}, usageError(fmt.Errorf("invalid --role value %q: want a non-empty, whitespace-free role (the @rk_win_role value)", cronAddRole))
	}
	if cronAddPane != "" && !tmux.ValidPaneID(cronAddPane) {
		return cron.Target{}, cron.CreatedBy{}, usageError(fmt.Errorf("invalid --pane value %q: want a %%N pane id", cronAddPane))
	}
	if cronAddSession != "" && !tmux.ValidAgentSessionRef(cronAddSession) {
		return cron.Target{}, cron.CreatedBy{}, usageError(fmt.Errorf("invalid --session value %q: want a session ref (non-empty, no whitespace)", cronAddSession))
	}

	createdBy := cron.CreatedBy{At: cronNowFn().Unix()}
	callerPane := cronTmuxPaneFn()
	callerRef := ""
	if callerPane != "" {
		if !tmux.ValidPaneID(callerPane) {
			return cron.Target{}, cron.CreatedBy{}, fmt.Errorf("malformed $TMUX_PANE %q (want a %%N pane id)", callerPane)
		}
		createdBy.Pane = callerPane
		ref, err := cronPaneSessionFn(ctx, callerPane, slug)
		if err != nil {
			sink.Notef("pane agent session unreadable (%v) — session capture skipped\n", err)
		} else if ref != "" {
			callerRef = ref
			createdBy.Session = ref
		}
	}

	switch {
	case cronAddRole != "":
		return cron.Target{Kind: cron.TargetRole, Role: cronAddRole}, createdBy, nil
	case cronAddPane != "":
		return cron.Target{Kind: cron.TargetPane, Pane: cronAddPane}, createdBy, nil
	case cronAddSession != "":
		return cron.Target{Kind: cron.TargetSession, Session: cronAddSession}, createdBy, nil
	case callerPane == "":
		return cron.Target{}, cron.CreatedBy{}, usageError(fmt.Errorf("not inside a tmux pane ($TMUX_PANE is unset) — pass --role, --pane, or --session to name a target"))
	}

	role, err := cronWindowRoleFn(ctx, callerPane, slug)
	if err == nil && role != "" {
		return cron.Target{Kind: cron.TargetRole, Role: role}, createdBy, nil
	}
	if err != nil {
		sink.Notef("window role unreadable (%v) — target capture degrades down the ladder\n", err)
	}
	if callerRef != "" {
		return cron.Target{Kind: cron.TargetSession, Session: callerRef}, createdBy, nil
	}
	return cron.Target{Kind: cron.TargetPane, Pane: callerPane}, createdBy, nil
}

// truncateRunes returns s cut to at most n runes.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
