// Package ghhooks carries GitHub PR events into the operator's trigger door:
// the loopback receiver `rk operator hooks serve`, the supervised
// `gh webhook forward` child, the admin probe that decides whether a repo can
// have a hook at all, and the cleanup of the hooks the forwarder creates.
//
// The whole feature is opportunistic. A hook only saves the minutes between a
// PR event and the operator loop's next scheduled check, so every failure
// here degrades to "the clock picks it up" and none is ever fatal to the
// daemon or the operator.
package ghhooks
