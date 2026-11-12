package operatorloop

import (
	"log/slog"

	"rk/internal/operator"
)

// noteBy is the `by` of every note this package writes: a scheduled run.
const noteBy = "run"

// NoteFailure appends a `--by run` note with text to each listed item of the
// operator state file at statePath. An item removed since the check is skipped,
// and a failure on one item never stops the rest — the notes are best-effort
// breadcrumbs for a failure the check had already consumed.
func NoteFailure(statePath string, ids []string, text string) {
	for _, id := range ids {
		if err := operator.AddNote(statePath, id, noteBy, text); err != nil {
			slog.Debug("operator loop: failure note skipped", "item", id, "err", err)
		}
	}
}
