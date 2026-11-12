// Package operatorloop is the daemon's operator loop: the cron entry kind
// `run: operator-loop` fires Run, which probes the tracked ledger for free
// (operator.Check) and only on a real change launches a one-shot headless run
// in its own tmux window with the rendered brief on stdin. Each run leaves a
// durable record under <state home>/operator/runs/<slug>/; the cron tick
// transcribes finished records into the delivery log, so a fresh daemon
// rebuilds every outcome from files and tmux alone (Constitution II) and a run
// never depends on the daemon that started it (Constitution VI).
//
// The package imports cron, operator, tmux and riff; cron holds only the
// nil-safe seams (cron.Deps.Loop*) this package fills in cmd/rk/serve.go.
package operatorloop
