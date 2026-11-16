package operator

import (
	"fmt"
	"slices"
	"sort"
)

// Scope keys the autopilot engine writes. Defined here once: internal/autopilot
// uses these constants, and the ownership table below refuses them on every
// hand write, so a key added to the engine is protected as soon as it is
// registered (a drift test in internal/autopilot fails until it is).
const (
	ScopeQueue     = "queue"
	ScopeMergeMode = "merge_mode"
	ScopeMergeSeq  = "merge_seq"
	ScopeItem      = "item"
	ScopeURL       = "url"
	ScopeSpawning  = "spawning"
	ScopeRespawned = "respawned"
	ScopeSkipped   = "skipped"
	ScopeArmed     = "armed"
	ScopeHalted    = "halted"
	ScopeDirect    = "direct"
	ScopeStallSeen = "stall_seen"
	ScopeDeferred  = "deferred"
	ScopeEscalated = "escalated"
)

// Identity and free-form keys.
const (
	ScopeTask = "task"
	ScopeBare = "bare"
	// ScopeMemo is the free-form map owned by AI and people. No code decides
	// anything from it.
	ScopeMemo = "memo"
)

// scopeClass says who may write a scope key after creation.
type scopeClass int

const (
	// classEngine keys are written only by the autopilot engine.
	classEngine scopeClass = iota + 1
	// classCheck keys are recorded by rk itself (operator check, pane lookups).
	classCheck
	// classIdentity keys are set by the creator and immutable once non-empty.
	classIdentity
	// classBinding keys belong to autopilot on a queue item and to whoever
	// tracks the item otherwise.
	classBinding
	// classFree keys belong to people, chat and runs.
	classFree
)

type scopeKey struct {
	class scopeClass
	owner string
}

const (
	ownerAutopilot = "autopilot"
	ownerCheck     = "rk operator check"
	ownerPeople    = "people, chat and runs"
)

// scopeKeys is the only list of scope keys rk knows. A key absent from it is
// refused on track add/update (unless forced): deny by default.
var scopeKeys = map[string]scopeKey{
	ScopeQueue:     {classEngine, ownerAutopilot},
	ScopeMergeMode: {classEngine, ownerAutopilot},
	ScopeMergeSeq:  {classEngine, ownerAutopilot},
	ScopeItem:      {classEngine, ownerAutopilot},
	ScopeURL:       {classEngine, ownerAutopilot},
	ScopeSpawning:  {classEngine, ownerAutopilot},
	ScopeRespawned: {classEngine, ownerAutopilot},
	ScopeSkipped:   {classEngine, ownerAutopilot},
	ScopeArmed:     {classEngine, ownerAutopilot},
	ScopeHalted:    {classEngine, ownerAutopilot},
	ScopeDirect:    {classEngine, ownerAutopilot},
	ScopeStallSeen: {classEngine, ownerAutopilot},
	ScopeDeferred:  {classEngine, ownerAutopilot},
	ScopeEscalated: {classEngine, ownerAutopilot},

	"pane_pid": {classCheck, ownerCheck},
	"stage":    {classCheck, ownerCheck},
	"agent":    {classCheck, ownerCheck},

	"repo":    {classIdentity, "the creator"},
	"change":  {classIdentity, "the creator"},
	"pr":      {classIdentity, "the creator"},
	ScopeTask: {classIdentity, "the creator"},
	ScopeBare: {classIdentity, "the creator"},

	"pane":    {classBinding, ownerAutopilot},
	"session": {classBinding, ownerAutopilot},
	"branch":  {classBinding, ownerAutopilot},

	ScopeMemo:    {classFree, ownerPeople},
	"stop_stage": {classFree, ownerPeople},
	"spawned_by": {classFree, ownerPeople},
	// recovery and fix_head are written by the brief's PR-recovery text until
	// the engine takes recovery over.
	"recovery": {classFree, ownerPeople},
	"fix_head": {classFree, ownerPeople},
	// query describes a linear/slack watcher's search for its run.
	"query": {classFree, ownerPeople},
}

// ScopeKeyKnown reports whether key is registered in the ownership table.
func ScopeKeyKnown(key string) bool {
	_, ok := scopeKeys[key]
	return ok
}

// EngineScopeKeys lists the keys only the engine writes, sorted.
func EngineScopeKeys() []string {
	var keys []string
	for k, info := range scopeKeys {
		if info.class == classEngine {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// EngineMayWrite reports whether the engine can legitimately write key: an
// engine key, or an identity/binding/recorded key it stamps at queue, spawn
// and PR-chain time. A key it writes that fails this check is unregistered.
func EngineMayWrite(key string) bool {
	info, ok := scopeKeys[key]
	if !ok {
		return false
	}
	return info.class != classFree || key == "stop_stage"
}

// IsQueueItem reports whether it is autopilot queue work: a pane item that
// carries scope.queue, or (legacy) a non-null scope.merge_mode, or that has a
// depends_on edge with another pane item. An isolated pane with neither is
// ordinary tracking and is never spawned.
func IsQueueItem(st *State, it TrackedItem) bool {
	if it.Kind != KindPane {
		return false
	}
	if it.Scope[ScopeQueue] != nil || it.Scope[ScopeMergeMode] != nil {
		return true
	}
	for _, other := range st.Tracked {
		if other.ID != it.ID && other.Kind == KindPane && (slices.Contains(it.DependsOn, other.ID) || slices.Contains(other.DependsOn, it.ID)) {
			return true
		}
	}
	return false
}

func refuseUnknown(k string) error {
	return invalidf("scope.%s is not a key rk defines; keep your own facts in scope.memo (--scope '{\"memo\":{%q:...}}'), or pass --force to write it anyway", k, k)
}

// checkScopeUpdate refuses the keys of a scope update that the caller does
// not own, naming the key and its owner. Only the allow-listed keys pass; keys
// are checked in sorted order so the message is stable.
func checkScopeUpdate(st *State, it TrackedItem, scope map[string]interface{}) error {
	queue := IsQueueItem(st, it)
	for _, k := range sortedKeys(scope) {
		info, ok := scopeKeys[k]
		switch {
		case !ok:
			return refuseUnknown(k)
		case k == ScopeMergeMode:
			return invalidf("scope.%s is set once by track add --mode or autopilot queue, then owned by autopilot (use --force to repair)", k)
		case info.class == classEngine || info.class == classCheck:
			return invalidf("scope.%s is owned by %s (use --force to repair)", k, info.owner)
		case info.class == classIdentity:
			if queue && (k == ScopeTask || k == ScopeBare) {
				return invalidf("scope.%s is identity stamped when the item was queued and is immutable (use --force to repair)", k)
			}
			if cur := it.Scope[k]; !emptyScopeValue(cur) && fmt.Sprint(cur) != fmt.Sprint(scope[k]) {
				return invalidf("scope.%s is identity, owned by %s and immutable once set (use --force to repair)", k, info.owner)
			}
		case info.class == classBinding && queue:
			return invalidf("scope.%s on a queue item is owned by %s (use --force to repair)", k, info.owner)
		}
	}
	return nil
}

// checkScopeAdd refuses the creation-time scope keys a creator may not
// choose: engine- and check-owned keys, and anything unregistered. Identity,
// binding and free keys are the creator's to set. merge_mode comes only from
// --mode.
func checkScopeAdd(scope map[string]interface{}) error {
	for _, k := range sortedKeys(scope) {
		info, ok := scopeKeys[k]
		switch {
		case !ok:
			return refuseUnknown(k)
		case k == ScopeMergeMode:
			return invalidf("scope.%s is set through --mode (use --force to write it anyway)", k)
		case info.class == classEngine || info.class == classCheck:
			return invalidf("scope.%s is owned by %s (use --force to write it anyway)", k, info.owner)
		}
	}
	return nil
}

// validateMemo requires scope.memo to be an object (or null to clear it).
func validateMemo(scope map[string]interface{}) error {
	v, ok := scope[ScopeMemo]
	if !ok || v == nil {
		return nil
	}
	if _, isMap := v.(map[string]interface{}); !isMap {
		return invalidf("scope.memo must be a JSON object")
	}
	return nil
}

// mergeScope applies a scope update onto the current scope. Keys replace,
// except scope.memo, which merges per key: a null member deletes it and null
// clears the map.
func mergeScope(cur, upd map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(cur)+len(upd))
	for k, v := range cur {
		out[k] = v
	}
	for k, v := range upd {
		if k != ScopeMemo {
			out[k] = v
			continue
		}
		in, isMap := v.(map[string]interface{})
		if !isMap {
			delete(out, ScopeMemo)
			continue
		}
		memo := map[string]interface{}{}
		if old, ok := out[ScopeMemo].(map[string]interface{}); ok {
			for mk, mv := range old {
				memo[mk] = mv
			}
		}
		for mk, mv := range in {
			if mv == nil {
				delete(memo, mk)
				continue
			}
			memo[mk] = mv
		}
		if len(memo) == 0 {
			delete(out, ScopeMemo)
			continue
		}
		out[ScopeMemo] = memo
	}
	return out
}

func emptyScopeValue(v interface{}) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// sequencePRItem reports whether it is an unfinished github-pr item of an
// autopilot merge sequence (scope.merge_seq set). Armed is read from GitHub,
// not stored, so any such item may have auto-merge enabled, and track rm must
// not drop it: nothing would be left to disarm it.
func sequencePRItem(it TrackedItem) bool {
	return it.Kind == KindGitHubPR && !itemDone(it) && scopeString(it.Scope, ScopeMergeSeq) != ""
}
