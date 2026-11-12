package operatorloop

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/riff"
	"rk/internal/selfpath"
	"rk/internal/shellq"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// runner.go — the production cron.Deps.LoopRunner: what a `run: operator-loop`
// fire does.

// launcherTier is the fab agent tier the run resolves its launcher from.
const launcherTier = "operator"

// wrapperVerb is the hidden `rk operator run-exec` argv that runs inside the
// window.
var wrapperVerb = []string{"operator", "run-exec"}

// Test seams (package-level, like internal/operator).
var (
	checkFn           = operator.Check
	loadStateFn       = operator.Load
	launchWindowFn    = tmux.LaunchOperatorRunWindow
	operatorRootFn    = tmux.GetOperatorRoot
	resolveLauncherFn = riff.ResolveHeadlessAgent
	selfPathFn        = selfpath.LauncherOrStable
	homeDirFn         = os.UserHomeDir
	newRunIDFn        = func() (string, error) { return NewRunID(nowTime()) }
)

// Run handles one due loop fire for fire.Server, in order: a live run window
// means busy (no check — the run in flight owns the current changes); the
// free deterministic check decides whether anything changed; only a change
// persists a run record and brief, then opens the run window. A launch
// returns a Held outcome: the single log line for the fire is written later,
// at transcription.
func Run(ctx context.Context, fire cron.Fire) cron.Outcome {
	server := fire.Server
	if msg := validate.ValidateServerName(server); msg != "" {
		return outcome(cron.OutcomeCheckFailed(msg))
	}

	wins, err := listRunWindowsFn(ctx, server)
	if err != nil {
		return outcome(cron.OutcomeCheckFailed("listing run windows: " + firstLine(err.Error())))
	}
	if len(wins) > 0 {
		id := wins[0].RunID
		if id == "" {
			id = "unknown"
		}
		return outcome(cron.OutcomeSkippedBusy(id))
	}

	res, err := checkFn(ctx, server, operator.CheckOptions{})
	if err != nil {
		return outcome(cron.OutcomeCheckFailed(firstLine(err.Error())))
	}
	if !res.Changed {
		return outcome(cron.OutcomeNoChange)
	}

	recorded, err := launch(ctx, fire, res)
	switch {
	case err == nil:
	case recorded:
		// The record is marked ended/lost; the line is written at
		// transcription like any other run's.
		slog.Warn("operator loop: launching run failed", "server", server, "err", err)
	default:
		// Nothing durable exists to transcribe, so the fire logs its loss now.
		slog.Warn("operator loop: preparing run failed", "server", server, "err", err)
		return outcome(cron.OutcomeRunLost("launch: " + firstLine(err.Error())))
	}
	return cron.Outcome{Status: "launched", Held: true}
}

// outcome wraps a fully rendered loop outcome string as a cron.Outcome.
func outcome(s string) cron.Outcome { return cron.Outcome{Status: s} }

// firstLine keeps a log outcome to one line.
func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	return s
}

// launch persists the run record and brief (durable before the window
// exists), resolves the launcher and opens the run window. recorded reports
// whether the record exists on disk: a failure after that point marks it ended
// with a lost reason, so the fire still yields one `run-lost: launch: …` line.
// Every failure leaves a note on each changed item — the check already
// consumed their edges, so the note is what keeps the failure visible.
func launch(ctx context.Context, fire cron.Fire, res operator.CheckResult) (recorded bool, err error) {
	server := fire.Server
	changed := changedItems(res.Changes)
	statePath, err := statePathFn(ctx, server)
	if err != nil {
		return false, err
	}
	failed := func(err error) (bool, error) {
		NoteFailure(statePath, changedIDs(changed), "run failed: launch: "+firstLine(err.Error()))
		return recorded, err
	}

	dir, rec, err := persistRun(ctx, fire, statePath, changed)
	if err != nil {
		return failed(err)
	}
	recorded = true

	if err := openRunWindow(ctx, server, dir, rec); err != nil {
		recPath, _ := RecordPath(dir, rec.ID)
		markLost(recPath, rec, "launch: "+firstLine(err.Error()))
		return failed(err)
	}
	return true, nil
}

// persistRun renders the brief from the loaded ledger and writes the run
// record and brief atomically, before any window exists.
func persistRun(ctx context.Context, fire cron.Fire, statePath string, changed []operator.ChangedItem) (dir string, rec Record, err error) {
	state, err := loadStateFn(statePath)
	if err != nil {
		return "", Record{}, err
	}
	now := nowTime()
	brief := operator.RenderBrief(operator.BriefInput{State: state, Server: fire.Server, Now: now, Changed: changed})

	id, err := newRunIDFn()
	if err != nil {
		return "", Record{}, err
	}
	if dir, err = Dir(ctx, fire.Server); err != nil {
		return "", Record{}, err
	}
	if err := EnsureDir(dir); err != nil {
		return "", Record{}, err
	}
	rec = Record{
		ID: id, Server: fire.Server, Entry: fire.Entry.ID,
		FiredAt: FormatTime(now), Changed: changedIDs(changed), Window: RunWindowPrefix + ShortID(id),
	}
	briefPath, err := BriefPath(dir, id)
	if err != nil {
		return "", Record{}, err
	}
	recPath, err := RecordPath(dir, id)
	if err != nil {
		return "", Record{}, err
	}
	if err := writeFile(briefPath, []byte(brief)); err != nil {
		return "", Record{}, err
	}
	if err := WriteRecord(recPath, rec); err != nil {
		return "", Record{}, err
	}
	return dir, rec, nil
}

// openRunWindow resolves the headless launcher and opens the run window
// running the hidden wrapper verb, which feeds the brief to the launcher.
func openRunWindow(ctx context.Context, server, dir string, rec Record) error {
	self, err := selfPathFn()
	if err != nil {
		return fmt.Errorf("resolving rk binary: %w", err)
	}
	cwd := runWindowDir(ctx, server)
	launcher := resolveLauncherFn(ctx, cwd, launcherTier)
	argv := append(append([]string{self}, wrapperVerb...),
		"--server", server, "--run", rec.ID, "--", "sh", "-c", launcher)
	if _, err := launchWindowFn(ctx, server, rec.Window, cwd, shellq.QuoteArgv(argv), rec.ID); err != nil {
		return err
	}
	return nil
}

// runWindowDir is the run window's working directory: the server's recorded
// operator root while it still validates as a directory, else the home
// directory (the `rk operator -L` rule). A home lookup failure leaves it empty
// and tmux picks its default.
func runWindowDir(ctx context.Context, server string) string {
	if root, err := operatorRootFn(ctx, server); err == nil && root != "" && filepath.IsAbs(root) {
		if st, serr := os.Stat(root); serr == nil && st.IsDir() {
			return root
		}
	}
	home, err := homeDirFn()
	if err != nil {
		return ""
	}
	return home
}

// changedItems maps a check's new changes to the brief's ChangedItem list: one
// per id in first-seen order, reasons accumulated in emission order.
func changedItems(changes []operator.CheckDelta) []operator.ChangedItem {
	var out []operator.ChangedItem
	index := map[string]int{}
	for _, d := range changes {
		i, ok := index[d.ID]
		if !ok {
			i = len(out)
			index[d.ID] = i
			out = append(out, operator.ChangedItem{ID: d.ID})
		}
		out[i].Reasons = append(out[i].Reasons, reasonFor(d))
	}
	return out
}

func changedIDs(items []operator.ChangedItem) []string {
	ids := make([]string, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	return ids
}

// reasonFor renders a delta as `<kind>[ <detail>]`, the detail only where the
// delta carries a short one (a stage move, an agent-state move, the changed
// field names, an age, the paused error, the missing dependency).
func reasonFor(d operator.CheckDelta) string {
	detail := ""
	switch d.Kind {
	case operator.DeltaStageAdvance, operator.DeltaReviewFail, operator.DeltaAgentState:
		detail = nullable(d.From) + "→" + nullable(d.To)
	case operator.DeltaChanged:
		names := make([]string, 0, len(d.Fields))
		for name := range d.Fields {
			names = append(names, name)
		}
		sort.Strings(names)
		detail = strings.Join(names, ",")
	case operator.DeltaStale, operator.DeltaDue:
		detail = d.Age
	case operator.DeltaPaused:
		detail = d.Error
	case operator.DeltaUnknownDep:
		detail = d.Dep
	}
	if detail == "" {
		return d.Kind
	}
	return d.Kind + " " + detail
}

func nullable(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}
