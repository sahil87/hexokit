package operatorloop

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/shellq"
	"rk/internal/tmux"
)

// TestFailedRunIsRetriedOnTheNextFire runs the loop's real check → launch →
// wrapper path on an isolated tmux server: a launcher that fails leaves the
// failure note on the item, and once the launcher works the next fire offers
// the item again with a `failed` reason; the retry's note closes it, so the
// fire after that finds nothing. Run is called directly so the cron ladder's
// wall-clock spacing is out of the picture.
func TestFailedRunIsRetriedOnTheNextFire(t *testing.T) {
	server := isolatedTmux(t)
	ctx := context.Background()

	statePath, err := statePathFn(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	if err := operator.Add(ctx, statePath, operator.AddSpec{ID: "n1", Kind: operator.KindTask}); err != nil {
		t.Fatal(err)
	}
	if err := operator.AddNote(statePath, "n1", operator.ByUser, "look at this"); err != nil {
		t.Fatal(err)
	}

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	prevSelf, prevResolve := selfPathFn, resolveLauncherFn
	t.Cleanup(func() { selfPathFn, resolveLauncherFn = prevSelf, prevResolve })
	selfPathFn = func() (string, error) { return self, nil }
	launcher := "cat >/dev/null; echo 'Not logged in' >&2; exit 1"
	resolveLauncherFn = func(context.Context, string, string, string) string { return launcher }

	fire := cron.Fire{Server: server, Entry: cron.Entry{ID: "lp01", Run: cron.RunOperatorLoop}, Reason: cron.FireSchedule}
	dir, err := Dir(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	// fireAndWait fires once, waits for the launched run to end, and returns
	// its record.
	fireAndWait := func() Record {
		t.Helper()
		if out := Run(ctx, fire); out.Status != "launched" {
			t.Fatalf("fire = %+v, want a launched run", out)
		}
		wins, err := tmux.ListOperatorRunWindows(ctx, server)
		if err != nil || len(wins) != 1 {
			t.Fatalf("run windows = %+v, err %v", wins, err)
		}
		recPath, _ := RecordPath(dir, wins[0].RunID)
		waitFor(t, "the run window to close", 30*time.Second, func() bool {
			w, err := tmux.ListOperatorRunWindows(ctx, server)
			return err == nil && len(w) == 0
		})
		var rec Record
		waitFor(t, "the run record to end", 10*time.Second, func() bool {
			rec, err = ReadRecord(recPath)
			return err == nil && rec.Ended()
		})
		return rec
	}
	notes := func() []operator.Note {
		t.Helper()
		st, err := operator.Load(statePath)
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range st.Tracked {
			if it.ID == "n1" {
				return it.Notes
			}
		}
		t.Fatal("n1 not tracked")
		return nil
	}

	first := fireAndWait()
	if first.ExitCode == nil || *first.ExitCode == 0 {
		t.Fatalf("first run = %+v, want a failed exit", first)
	}
	ns := notes()
	if last := ns[len(ns)-1]; last.By != operator.ByRun || !strings.HasPrefix(last.Text, operator.FailureNotePrefix) {
		t.Fatalf("notes after the failed run = %+v, want a trailing failure note", ns)
	}
	failureAt := ns[len(ns)-1].At

	launcher = "cat >/dev/null; " +
		shellq.QuoteArgv([]string{self, "note", statePath, "n1", "retried after failure: nothing to do"}) +
		"; echo 'outcome: retried'"
	retry := fireAndWait()
	var reasons []string
	for _, c := range retry.Changes {
		if c.ID == "n1" {
			reasons = c.Reasons
		}
	}
	if want := "failed " + failureAt; !slices.Contains(reasons, want) {
		t.Fatalf("retry changes = %+v, want n1 with reason %q", retry.Changes, want)
	}
	if retry.ExitCode == nil || *retry.ExitCode != 0 {
		t.Fatalf("retry run = %+v, want a clean exit", retry)
	}

	if out := Run(ctx, fire); out.Status != cron.OutcomeNoChange {
		t.Fatalf("fire after the retry's note = %+v, want %q", out, cron.OutcomeNoChange)
	}
}
