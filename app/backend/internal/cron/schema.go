package cron

import (
	"crypto/rand"
	"fmt"
	"time"

	robfigcron "github.com/robfig/cron/v3"
	"gopkg.in/yaml.v3"

	"rk/internal/tmux"
)

// schema.go — the cron entry schema (docs/specs/cron.md § Cron State). Entry
// files are INTENT: runtime facts (last_fired, next_fire, backoff rung,
// orphaned-since) are NEVER fields here — they derive from the delivery log,
// the pane agent-state option, and the wake cursor.

// Schedule kinds.
const (
	ScheduleEvery   = "every"
	ScheduleBackoff = "backoff"
	ScheduleCron    = "cron"
)

// Target kinds.
const (
	TargetRole    = "role"
	TargetSession = "session"
	TargetPane    = "pane"
)

// RoleOperator is the operator's @rk_win_role value. Role targets accept any
// role value — the constant exists for call sites that name the operator role
// literally (the operator-window lookup in push_url.go).
const RoleOperator = "operator"

// RunOperatorLoop is the one legal Entry.Run value: the entry fires the
// operator loop (a Go function behind Deps.LoopRunner) instead of typing a
// payload into a target agent.
const RunOperatorLoop = "operator-loop"

// Wake events.
const (
	WakeAgentStateChange = "agent-state-change"
	WakeScopeServer      = "server"
)

// Delivery policies (Entry.Deliver), enforced by the deliverer at fire time:
// immediate (or "") sends now; when-idle holds a busy-pane fire, bounded by
// DefaultHoldWindow; skip-if-busy drops a busy-pane fire with a logged
// skipped-busy outcome that advances the anchor. The empty default is
// immediate.
const (
	DeliverImmediate  = "immediate"
	DeliverWhenIdle   = "when-idle"
	DeliverSkipIfBusy = "skip-if-busy"
)

// Absence policies (Entry.IfAbsent), applied by the tick when the target does
// not resolve.
const (
	IfAbsentSkip    = "skip"
	IfAbsentNotify  = "notify"
	IfAbsentRespawn = "respawn"
)

// Catch-up policies (Schedule.CatchUp): how a cron-kind entry treats
// occurrences that fell due while no tick ran. The empty default skips them
// (one `missed` log line per gap); "once" fires the latest stale occurrence
// late, exactly once per gap.
const CatchUpOnce = "once"

// Duration is a time.Duration that YAML-marshals as a Go duration string
// ("60s", "30m") per the spec's schema.
type Duration struct {
	time.Duration
}

// UnmarshalYAML parses a time.ParseDuration string; anything else is a
// per-entry validation failure (the tolerant load skips the entry).
func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	var s string
	if err := value.Decode(&s); err != nil {
		return fmt.Errorf("duration must be a string like \"60s\" or \"30m\"")
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("bad duration %q: %w", s, err)
	}
	d.Duration = v
	return nil
}

// MarshalYAML emits the time.Duration string form.
func (d Duration) MarshalYAML() (any, error) {
	return d.String(), nil
}

// Schedule is the entry's timing predicate. every carries Interval; backoff
// carries Min + Max (the ladder is keyed on the target pane's idle epoch);
// cron carries a 5-field Expr, with CatchUp ("once") opting into one late fire
// per missed gap.
type Schedule struct {
	Kind     string   `yaml:"kind"`
	Interval Duration `yaml:"interval,omitempty"`
	Min      Duration `yaml:"min,omitempty"`
	Max      Duration `yaml:"max,omitempty"`
	Expr     string   `yaml:"expr,omitempty"`
	CatchUp  string   `yaml:"catch_up,omitempty"`
}

// WakeOn is the edge trigger OR'd with the schedule: fire when the named
// transition occurred, debounced so a burst coalesces into at most one fire.
type WakeOn struct {
	Event    string   `yaml:"event"`
	Scope    string   `yaml:"scope,omitempty"`
	Debounce Duration `yaml:"debounce,omitempty"`
}

// Target names whom the payload is delivered to, resolved at fire time.
type Target struct {
	Kind    string `yaml:"kind"`
	Role    string `yaml:"role,omitempty"`
	Session string `yaml:"session,omitempty"`
	Pane    string `yaml:"pane,omitempty"`
}

// CreatedBy records provenance; At is the pre-delivery anchor for `every`.
type CreatedBy struct {
	Session string `yaml:"session,omitempty"`
	Pane    string `yaml:"pane,omitempty"`
	At      int64  `yaml:"at"`
}

// Entry is one cron intent record.
type Entry struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name,omitempty"`
	// Run marks a target-less entry that fires a Go function (RunOperatorLoop)
	// instead of delivering a payload. With Run set, Target, Payload, Deliver,
	// IfAbsent and Respawn are all unused and validation rejects them.
	Run      string   `yaml:"run,omitempty"`
	Schedule Schedule `yaml:"schedule"`
	WakeOn   *WakeOn  `yaml:"wake_on,omitempty"`
	Target   Target   `yaml:"target,omitempty"`
	Payload  string   `yaml:"payload,omitempty"`
	Deliver  string   `yaml:"deliver,omitempty"`
	IfAbsent string   `yaml:"if_absent,omitempty"`
	// Respawn is the caller-supplied argv for if_absent: respawn (the {server}
	// placeholder resolves at fire time); used by role/session targets only.
	Respawn []string `yaml:"respawn,omitempty"`
	Pinned  bool     `yaml:"pinned,omitempty"`
	Muted   bool     `yaml:"muted,omitempty"`
	// MutedUntil is a bounded mute lease (unix seconds): the entry is muted
	// until then, after which it resumes on its own — expiry writes nothing.
	MutedUntil int64     `yaml:"muted_until,omitempty"`
	CreatedBy  CreatedBy `yaml:"created_by,omitempty"`
}

// EffectivelyMuted is the single muted rule: the indefinite flag, or a lease
// that has not yet lapsed at now. An expired lease reads as unmuted with no
// write — the stale muted_until is scrubbed by the next mutation that marshals
// the file.
func (e Entry) EffectivelyMuted(now time.Time) bool {
	return e.Muted || (e.MutedUntil > 0 && now.Unix() < e.MutedUntil)
}

// IsLoop reports whether the entry is the target-less operator-loop kind.
func (e Entry) IsLoop() bool { return e.Run == RunOperatorLoop }

// validate is the per-entry gate the tolerant load applies: a failing entry is
// skipped with a diagnostic, never failing the file.
func (e Entry) validate() error {
	if e.ID == "" {
		return fmt.Errorf("missing id")
	}
	if err := e.validateSchedule(); err != nil {
		return err
	}
	if e.Run != "" {
		return e.validateLoop()
	}
	return e.validateDelivery()
}

// validateLoop gates a run-kind entry: a closed run value and none of the
// delivery-only fields.
func (e Entry) validateLoop() error {
	if !e.IsLoop() {
		return fmt.Errorf("unknown run value %q (only %q)", e.Run, RunOperatorLoop)
	}
	switch {
	case e.Payload != "":
		return fmt.Errorf("run %q entry must not carry a payload", e.Run)
	case e.Target != (Target{}):
		return fmt.Errorf("run %q entry must not carry a target", e.Run)
	case e.Deliver != "":
		return fmt.Errorf("run %q entry must not carry deliver", e.Run)
	case e.IfAbsent != "":
		return fmt.Errorf("run %q entry must not carry if_absent", e.Run)
	case e.Respawn != nil:
		return fmt.Errorf("run %q entry must not carry respawn", e.Run)
	}
	return nil
}

// validateSchedule gates the schedule shape shared by every entry kind.
func (e Entry) validateSchedule() error {
	switch e.Schedule.Kind {
	case ScheduleEvery:
		if e.Schedule.Interval.Duration <= 0 {
			return fmt.Errorf("every schedule needs a positive interval")
		}
	case ScheduleBackoff:
		if e.Schedule.Min.Duration <= 0 {
			return fmt.Errorf("backoff schedule needs a positive min")
		}
		if e.Schedule.Max.Duration < e.Schedule.Min.Duration {
			return fmt.Errorf("backoff max must be ≥ min")
		}
	case ScheduleCron:
		if _, err := robfigcron.ParseStandard(e.Schedule.Expr); err != nil {
			return fmt.Errorf("cron expression %q does not parse: %w", e.Schedule.Expr, err)
		}
	case "":
		return fmt.Errorf("missing schedule kind")
	default:
		return fmt.Errorf("unknown schedule kind %q", e.Schedule.Kind)
	}
	// catch_up is cron-kind-only: interval/idle-anchored schedules have no
	// occurrences to catch up on.
	if e.Schedule.CatchUp != "" {
		if e.Schedule.Kind != ScheduleCron {
			return fmt.Errorf("catch_up only applies to kind cron, got kind %q", e.Schedule.Kind)
		}
		if e.Schedule.CatchUp != CatchUpOnce {
			return fmt.Errorf("unknown catch_up value %q (only %q)", e.Schedule.CatchUp, CatchUpOnce)
		}
	}
	return nil
}

// validateDelivery gates the delivery fields of a typed-payload entry.
func (e Entry) validateDelivery() error {
	switch e.Deliver {
	case "", DeliverImmediate, DeliverWhenIdle, DeliverSkipIfBusy:
	default:
		return fmt.Errorf("unknown deliver value %q", e.Deliver)
	}
	switch e.Target.Kind {
	case TargetRole:
		if e.Target.Role == "" {
			return fmt.Errorf("role target needs a role")
		}
	case TargetSession:
		if e.Target.Session == "" {
			return fmt.Errorf("session target needs a session id")
		}
	case TargetPane:
		if !tmux.ValidPaneID(e.Target.Pane) {
			return fmt.Errorf("pane target needs a %%N pane id, got %q", e.Target.Pane)
		}
	default:
		return fmt.Errorf("unknown target kind %q", e.Target.Kind)
	}
	// A present-but-empty respawn argv can never exec; argv[0] is the command.
	if e.Respawn != nil {
		if len(e.Respawn) == 0 {
			return fmt.Errorf("respawn needs at least one element")
		}
		if e.Respawn[0] == "" {
			return fmt.Errorf("respawn argv[0] must not be empty")
		}
	}
	return nil
}

// idAlphabet for the rk-generated 4-char entry ids ("a3f9", "k7q2").
const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// newID generates a random 4-char entry id not present in taken.
func newID(taken map[string]bool) (string, error) {
	var buf [4]byte
	for attempt := 0; attempt < 64; attempt++ {
		if _, err := rand.Read(buf[:]); err != nil {
			return "", fmt.Errorf("generating entry id: %w", err)
		}
		id := make([]byte, 4)
		for i, b := range buf {
			id[i] = idAlphabet[int(b)%len(idAlphabet)]
		}
		if !taken[string(id)] {
			return string(id), nil
		}
	}
	return "", fmt.Errorf("generating entry id: id space exhausted")
}
