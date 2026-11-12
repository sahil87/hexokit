package main

import (
	"errors"
	"testing"

	"rk/internal/cron"
)

func TestWireOperatorLoopFillsSeams(t *testing.T) {
	var deps cron.Deps
	wireOperatorLoop(&deps, func() (string, error) { return "/opt/rk", nil })
	if deps.LoopRunner == nil || deps.LoopTranscribe == nil || deps.LoopLogged == nil || deps.LoopSeed == nil {
		t.Fatalf("seams not wired: %+v", deps)
	}
}

func TestWireOperatorLoopLeavesSeamsNilWhenBinaryUnresolvable(t *testing.T) {
	var deps cron.Deps
	wireOperatorLoop(&deps, func() (string, error) { return "", errors.New("no executable") })
	if deps.LoopRunner != nil || deps.LoopTranscribe != nil || deps.LoopLogged != nil || deps.LoopSeed != nil {
		t.Fatalf("seams must stay nil: %+v", deps)
	}
}
