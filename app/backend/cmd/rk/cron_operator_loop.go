package main

import (
	"log/slog"

	"rk/internal/cron"
	"rk/internal/operatorloop"
)

// wireOperatorLoop fills the cron ticker's operator-loop seams (the
// `run: operator-loop` entry kind: runner, transcription, seeding).
// Best-effort like every other daemon wiring: when the rk binary cannot be
// resolved a run window could never start its wrapper, so the seams stay nil —
// loop fires then log `no-deliverer` and the daemon serves unchanged — with one
// Warn.
func wireOperatorLoop(deps *cron.Deps, resolveSelf func() (string, error)) {
	if _, err := resolveSelf(); err != nil {
		slog.Warn("operator loop disabled: rk binary path unresolvable", "err", err)
		return
	}
	deps.LoopRunner = operatorloop.Run
	deps.LoopTranscribe = operatorloop.Transcribe
	deps.LoopLogged = operatorloop.MarkLogged
	deps.LoopSeed = operatorloop.StateFileExists
}
