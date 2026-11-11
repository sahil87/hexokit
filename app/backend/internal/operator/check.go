package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Check implements the operator's deterministic gate: probe every due item,
// diff against the stored baselines, write the new baselines, and report what
// changed — no model involved. It runs in two phases so the state-file lock is
// never held across a subprocess:
//
//  1. observe, lock-free: load the file, take one pane snapshot of the server
//     (only when a pane item needs it) and run the due shell probes. Nothing is
//     written.
//  2. apply, under one Mutate: re-read the file (external writes win), apply
//     the observations to the items still present, derive conditions and edge
//     verdicts, and write once.
//
// Standing conditions are edge-triggered through TrackedItem.Reported: a
// condition is a change the first time its key appears in an item's set and an
// open condition while it stays there.
func Check(ctx context.Context, server string, opts CheckOptions) (CheckResult, error) {
	path, err := StatePathForServer(ctx, server)
	if err != nil {
		return CheckResult{}, err
	}
	loaded, err := Load(path)
	if err != nil {
		return CheckResult{}, err
	}
	obs, err := observe(ctx, server, loaded, opts)
	if err != nil {
		return CheckResult{}, err
	}
	var res CheckResult
	err = Mutate(path, func(st *State) error {
		res = applyCheck(st, obs)
		return nil
	})
	if err != nil {
		return CheckResult{}, err
	}
	return res, nil
}

// CheckOptions tunes one Check call.
type CheckOptions struct {
	// Budget bounds the wall clock spent starting shell probes; zero means
	// defaultCheckBudget.
	Budget time.Duration
}

const defaultCheckBudget = 60 * time.Second

// Delta kinds.
const (
	DeltaChanged        = "changed"
	DeltaDone           = "done"
	DeltaPaneDeath      = "pane_death"
	DeltaPaneMismatch   = "pane_mismatch"
	DeltaAgentExited    = "agent_exited"
	DeltaStageAdvance   = "stage_advance"
	DeltaReviewFail     = "review_fail"
	DeltaAgentState     = "agent_state"
	DeltaPaused         = "paused"
	DeltaStale          = "stale"
	DeltaDue            = "due"
	DeltaUnknownDep     = "unknown_dep"
	NoticeProbeError    = "probe_error"
	NoticeSkipped       = "skipped"
	NoticeGHUnavailable = "gh_unavailable"
)

// Notice texts for the two skip causes.
const (
	skipBudgetText = "skipped (check budget)"
	skipGHText     = "gh unavailable"
)

// FieldChange is one differing declared field of a `changed` delta; either
// side may be null.
type FieldChange struct {
	From interface{} `json:"from"`
	To   interface{} `json:"to"`
}

// CheckDelta is one reported condition or event, keyed by item id. Which
// fields are meaningful depends on Kind; MarshalJSON emits exactly that set in
// a pinned order (including the load-bearing nulls: done's then, pane_mismatch's
// found, agent_exited's command).
type CheckDelta struct {
	Kind        string
	ID          string
	Pane        string
	Fields      map[string]FieldChange
	Then        *string
	Age         string
	Instruction string
	Error       string
	Failures    int
	Paused      bool
	Found       *string
	Command     *string
	From        *string
	To          *string
	Duration    *string
	Dep         string
}

// CheckNotice is a non-gating observation: it never sets Changed.
type CheckNotice struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Error    string `json:"error"`
	Failures int    `json:"failures"`
}

// CheckResult is what one Check found. Changes is the gate: conditions new
// since the last check plus event deltas. Open lists standing conditions the
// last check already reported.
type CheckResult struct {
	CheckedAt string        `json:"checked_at"`
	Changed   bool          `json:"changed"`
	Changes   []CheckDelta  `json:"changes"`
	Open      []CheckDelta  `json:"open"`
	Notices   []CheckNotice `json:"notices"`
}

type jsonField struct {
	key string
	val interface{}
}

// MarshalJSON emits the kind's field set in a pinned key order.
func (d CheckDelta) MarshalJSON() ([]byte, error) {
	fields := []jsonField{{"kind", d.Kind}, {"id", d.ID}}
	add := func(k string, v interface{}) { fields = append(fields, jsonField{k, v}) }
	switch d.Kind {
	case DeltaChanged:
		add("fields", d.Fields)
	case DeltaDone:
		add("then", d.Then)
	case DeltaStale:
		add("age", d.Age)
	case DeltaDue:
		add("age", d.Age)
		add("instruction", d.Instruction)
	case DeltaPaused:
		add("error", d.Error)
		add("failures", d.Failures)
		add("paused", d.Paused)
	case DeltaPaneDeath:
		add("pane", d.Pane)
	case DeltaPaneMismatch:
		add("pane", d.Pane)
		add("found", d.Found)
	case DeltaAgentExited:
		add("pane", d.Pane)
		add("command", d.Command)
	case DeltaStageAdvance, DeltaReviewFail:
		add("pane", d.Pane)
		add("from", d.From)
		add("to", d.To)
	case DeltaAgentState:
		add("pane", d.Pane)
		add("from", d.From)
		add("to", d.To)
		add("duration", d.Duration)
	case DeltaUnknownDep:
		add("dep", d.Dep)
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, f := range fields {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, _ := json.Marshal(f.key)
		v, err := json.Marshal(f.val)
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// Test seams; the defaults do the real work.
var (
	paneSnapshotFn = defaultPaneSnapshot
	agentAliveFn   = defaultAgentAlive
	probeRunnerFn  = defaultProbeRunner
	ghAvailableFn  = defaultGHAvailable
	gitBranchFn    = defaultGitBranch
)

// observation is everything phase 1 learned; phase 2 applies it to whichever
// items are still present.
type observation struct {
	// now anchors the phase-1 due rule.
	now time.Time
	// panes is the server's pane snapshot by pane id; nil when no pane item
	// needed one.
	panes map[string]paneRow
	// exited marks snapshot panes whose foreground is a bare shell with no
	// live agent anywhere under it.
	exited map[string]bool
	// branches is the current git branch by pane cwd, resolved only for
	// panes whose change still lacks a branch_map entry.
	branches map[string]string
	probes   map[string]probeOutcome
	skips    map[string]CheckNotice
}

func observe(ctx context.Context, server string, st *State, opts CheckOptions) (observation, error) {
	obs := observation{
		now:    clock().UTC(),
		probes: map[string]probeOutcome{},
		skips:  map[string]CheckNotice{},
	}
	if anyPaneItems(st.Tracked) {
		panes, err := paneSnapshotFn(ctx, server)
		if err != nil {
			return obs, err
		}
		obs.panes = panes
		obs.exited = resolveExited(ctx, st.Tracked, panes)
		obs.branches = resolveBranches(ctx, st, panes)
	}
	budget := opts.Budget
	if budget <= 0 {
		budget = defaultCheckBudget
	}
	runDueProbes(ctx, st.Tracked, &obs, budget)
	return obs, nil
}

// applyCheck is phase 2: it runs inside Mutate against the re-read state.
func applyCheck(st *State, obs observation) CheckResult {
	now := clock().UTC()
	nowStr := now.Format(time.RFC3339)
	res := CheckResult{
		CheckedAt: nowStr,
		Changes:   []CheckDelta{},
		Open:      []CheckDelta{},
		Notices:   []CheckNotice{},
	}
	for i := range st.Tracked {
		it := &st.Tracked[i]
		if n, ok := obs.skips[it.ID]; ok {
			res.Notices = append(res.Notices, n)
		}
		events, notice := applyProbeOutcome(it, obs)
		if notice != nil {
			res.Notices = append(res.Notices, *notice)
		}
		pane := diffPane(it, st, obs, now)
		events = append(events, pane.events...)
		conds := itemConditions(st.Tracked, *it, pane.conds, now)

		res.Changes = append(res.Changes, events...)
		reported := map[string]bool{}
		for _, k := range it.Reported {
			reported[k] = true
		}
		keys := make([]string, 0, len(conds))
		for _, c := range conds {
			keys = append(keys, c.key)
			if reported[c.key] {
				res.Open = append(res.Open, c.openDelta())
			} else {
				res.Changes = append(res.Changes, c.delta)
			}
		}
		sort.Strings(keys)
		it.Reported = nil
		if len(keys) > 0 {
			it.Reported = keys
		}
	}
	st.LastCheckAt = nowStr
	res.Changed = len(res.Changes) > 0
	return res
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func equalStrPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func pausedErrorText(failures int) string {
	return fmt.Sprintf("paused after %d consecutive probe failures", failures)
}
