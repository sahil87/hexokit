package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"reflect"
	"slices"
	"sort"
	"strings"
	"time"

	"rk/internal/ghprobe"
)

// checkEveryDefault is the cadence applied to an item whose check_every is
// missing or unparsable.
var checkEveryDefault, _ = time.ParseDuration(checkEveryDefaultText)

// probeOutcome is one phase-1 probe result, applied in phase 2 only while the
// item's argv and checked_at still equal the values observed here.
type probeOutcome struct {
	argv      []string
	checkedAt *string
	at        string
	stdout    string
	err       error
}

func (o probeOutcome) matches(it TrackedItem) bool {
	return slices.Equal(o.argv, it.Probe.Argv) && equalStrPtr(o.checkedAt, it.CheckedAt)
}

// shellDue applies the cadence rule: a null or unparsable checked_at is always
// due; otherwise due when now - checked_at >= check_every.
func shellDue(it TrackedItem, now time.Time) bool {
	if it.CheckedAt == nil || *it.CheckedAt == "" {
		return true
	}
	ce, ok := checkEveryDuration(it)
	if !ok {
		ce = checkEveryDefault
	}
	t, err := time.Parse(time.RFC3339, *it.CheckedAt)
	if err != nil {
		return true
	}
	return !now.Before(t.Add(ce))
}

// runDueProbes runs every due shell probe sequentially, recording each outcome
// in obs. Probes not started before the budget deadline, and github-pr probes
// while gh is unavailable, record a skip notice and leave the item untouched.
func runDueProbes(ctx context.Context, items []TrackedItem, obs *observation, budget time.Duration) {
	deadline := time.Now().Add(budget)
	for _, it := range items {
		if it.Probe.Mode != probeShell || it.Paused || itemDone(it) || !shellDue(it, obs.now) {
			continue
		}
		if time.Now().After(deadline) {
			obs.skips[it.ID] = CheckNotice{ID: it.ID, Kind: NoticeSkipped, Error: skipBudgetText, Failures: it.Failures}
			continue
		}
		if it.Kind == KindGitHubPR && !ghAvailableFn(ctx) {
			obs.skips[it.ID] = CheckNotice{ID: it.ID, Kind: NoticeGHUnavailable, Error: skipGHText, Failures: it.Failures}
			continue
		}
		stdout, err := probeRunnerFn(ctx, it.Probe.Argv)
		obs.probes[it.ID] = probeOutcome{
			argv:      slices.Clone(it.Probe.Argv),
			checkedAt: it.CheckedAt,
			at:        nowRFC3339(),
			stdout:    stdout,
			err:       err,
		}
	}
}

func defaultGHAvailable(ctx context.Context) bool {
	return ghprobe.Available(ctx, probeTimeout)
}

// defaultProbeRunner runs argv with the caller's environment, bounded by
// probeTimeout. The returned error is one line: "exit <n>: <first stderr
// line>", "timeout after 10s", or the lookup error.
func defaultProbeRunner(ctx context.Context, argv []string) (string, error) {
	if len(argv) == 0 {
		return "", errors.New("empty probe argv")
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return "", err
	}
	cctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, argv[0], argv[1:]...).Output()
	if err == nil {
		return string(out), nil
	}
	if errors.Is(cctx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("timeout after %s", probeTimeout)
	}
	msg := err.Error()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		msg = fmt.Sprintf("exit %d", ee.ExitCode())
		if first, _, _ := strings.Cut(strings.TrimSpace(string(ee.Stderr)), "\n"); first != "" {
			msg += ": " + first
		}
	}
	return "", errors.New(msg)
}

// applyProbeOutcome applies the item's phase-1 probe outcome to the re-read
// item, if one exists and is still current, and returns the resulting event
// delta or failure notice. A failure counts toward the pause cap; a success
// resets it, stores the declared fields as last, and reports field changes.
func applyProbeOutcome(it *TrackedItem, obs observation) ([]CheckDelta, *CheckNotice) {
	out, ok := obs.probes[it.ID]
	if !ok || !out.matches(*it) || it.Paused || itemDone(*it) {
		return nil, nil
	}
	it.CheckedAt = &out.at
	obj, failure := parseProbeOutput(out)
	if failure != "" {
		it.Failures++
		if it.Failures >= failurePauseCap {
			it.Paused = true
		}
		return nil, &CheckNotice{ID: it.ID, Kind: NoticeProbeError, Error: failure, Failures: it.Failures}
	}
	it.Failures = 0
	newLast := obj
	if len(it.Probe.Fields) > 0 {
		newLast = extractProbeFields(obj, it.Probe.Fields)
	}
	normalizeJSONNumbers(newLast)
	if reflect.DeepEqual(newLast, it.Last) {
		it.Unchanged++
		return nil, nil
	}
	delta := CheckDelta{Kind: DeltaChanged, ID: it.ID, Fields: fieldChanges(it.Last, newLast, it.Probe.Fields)}
	it.Unchanged = 0
	it.Last = newLast
	it.UpdatedAt = out.at
	return []CheckDelta{delta}, nil
}

// parseProbeOutput returns the probe's JSON object, or a one-line failure.
func parseProbeOutput(out probeOutcome) (map[string]interface{}, string) {
	if out.err != nil {
		return nil, out.err.Error()
	}
	var obj map[string]interface{}
	if err := json.Unmarshal([]byte(out.stdout), &obj); err != nil || obj == nil {
		return nil, "stdout is not a JSON object"
	}
	return obj, ""
}

// fieldChanges computes a changed delta's per-field from/to entries over the
// declared fields (top-level or dotted); an absent side reports null. With no
// declared fields every key of either side is compared.
func fieldChanges(oldLast, newLast map[string]interface{}, fields []string) map[string]FieldChange {
	if len(fields) == 0 {
		for k := range newLast {
			fields = append(fields, k)
		}
		for k := range oldLast {
			if _, ok := newLast[k]; !ok {
				fields = append(fields, k)
			}
		}
		sort.Strings(fields)
	}
	changes := map[string]FieldChange{}
	for _, f := range fields {
		segs := strings.Split(f, ".")
		from, to := getPathValue(oldLast, segs), getPathValue(newLast, segs)
		if !reflect.DeepEqual(from, to) {
			changes[f] = FieldChange{From: from, To: to}
		}
	}
	return changes
}
