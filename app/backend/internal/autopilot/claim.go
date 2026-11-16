package autopilot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"reflect"
	"time"

	"rk/internal/operator"
)

const scopeClaim = "claim"
const spawnClaimTTL = 15 * time.Minute

func claimOf(it operator.TrackedItem) map[string]interface{} {
	claim, _ := it.Scope[scopeClaim].(map[string]interface{})
	return claim
}

func claimToken(it operator.TrackedItem) string { return operator.ScopeString(claimOf(it), "token") }

const (
	claimSpawnKind = "spawn"
	claimRespawn   = "respawn"
	claimFixSpawn  = "ci-spawn"
	claimFixSend   = "ci-send"
	claimRebase    = "rebase"
	claimStacked   = "stacked-rebase"
)

func (e *engine) claimSpawn(id string, ready *operator.State) (operator.TrackedItem, bool, error) {
	return e.claimWork(id, ready, claimSpawnKind, "", nil)
}

// All launches and recovery operations share one snapshot CAS. The lock covers
// only ledger facts; pane and PR probes run before claiming that snapshot.
func (e *engine) claimWork(id string, ready *operator.State, kind, target string, fields map[string]interface{}) (operator.TrackedItem, bool, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return operator.TrackedItem{}, false, err
	}
	var claimed operator.TrackedItem
	ok := false
	err := e.mutate(func(st *operator.State) error {
		if !reflect.DeepEqual(st.Tracked, ready.Tracked) || !reflect.DeepEqual(st.BranchMap, ready.BranchMap) {
			return operator.ErrNoWrite
		}
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return operator.ErrNoWrite
		}
		cur := &st.Tracked[i]
		if cur.Paused || operator.ItemDone(*cur) || skipped(*cur) || scopeBool(*cur, scopeHalted) || cur.Scope[scopeClaim] != nil {
			return operator.ErrNoWrite
		}
		switch kind {
		case claimSpawnKind:
			if !isQueueItem(st, *cur) || operator.ScopeString(cur.Scope, "pane") != "" {
				return operator.ErrNoWrite
			}
		case claimRespawn:
			if !isQueueItem(st, *cur) || operator.ScopeString(cur.Scope, "pane") == "" || scopeBool(*cur, scopeRespawned) {
				return operator.ErrNoWrite
			}
			cur.Scope[scopeRespawned] = true
		case claimFixSend, claimFixSpawn:
			if !isPRItem(*cur) || operator.ScopeString(cur.Scope, scopeRecovery) == recoveryCIFix {
				return operator.ErrNoWrite
			}
			if target != "" && operator.IndexOf(st.Tracked, target) >= 0 {
				return fmt.Errorf("recovery item %s already exists", target)
			}
		case claimRebase:
			if !isPRItem(*cur) || operator.ScopeString(cur.Scope, scopeRecovery) == recoveryRebase {
				return operator.ErrNoWrite
			}
		case claimStacked:
			if !isPRItem(*cur) || scopeBool(*cur, scopePrepared) {
				return operator.ErrNoWrite
			}
		default:
			return fmt.Errorf("unknown claim kind %q", kind)
		}
		for k, v := range fields {
			cur.Scope[k] = v
		}
		cur.Scope[scopeClaim] = map[string]interface{}{"at": e.env.now().UTC().Format(time.RFC3339), "token": hex.EncodeToString(token[:]), "kind": kind, "target": target, "previous_pane": operator.ScopeString(cur.Scope, "pane")}
		claimed, ok = *cur, true
		return nil
	})
	return claimed, ok && err == nil, err
}

// rollbackClaim is only for operations known not to have opened a pane or
// delivered a request. A failed rollback keeps the claim pending, so another
// pass cannot count an undelivered CI request as a spent fix round.
func (e *engine) rollbackClaim(it operator.TrackedItem) error {
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, it.ID)
		if i < 0 || claimToken(st.Tracked[i]) != claimToken(it) || operator.ScopeString(claimOf(st.Tracked[i]), "pane") != "" {
			return operator.ErrNoWrite
		}
		cur := &st.Tracked[i]
		switch operator.ScopeString(claimOf(*cur), "kind") {
		case claimRespawn:
			delete(cur.Scope, scopeRespawned)
		case claimFixSend, claimFixSpawn:
			delete(cur.Scope, scopeRecovery)
			delete(cur.Scope, scopeFixHead)
			delete(cur.Scope, scopeRecoverAt)
		}
		delete(cur.Scope, scopeClaim)
		return nil
	})
}

func (e *engine) rollbackUnopened(it operator.TrackedItem, opened *bool) {
	if !*opened && !e.env.DryRun {
		if err := e.rollbackClaim(it); err != nil {
			e.escalate(it.ID, "claim rollback failed: "+err.Error())
		}
	}
}

func (e *engine) finishWorkClaim(it operator.TrackedItem) {
	if err := e.releaseClaim(it); err != nil {
		e.escalate(it.ID, "operation claim release failed: "+err.Error())
	}
}

// launchClaimed is the only pane launch site. Both the immediate attach and
// later reconciliation use the same durable owner and finalization procedure.
func (e *engine) launchClaimed(ctx context.Context, it operator.TrackedItem, req SpawnRequest, action string, opened *bool) {
	req.Opened = func(res SpawnResult) error { *opened = true; return e.recordClaimPane(it, res, req.Session) }
	res, err := e.env.Spawn.Spawn(ctx, req)
	if err != nil {
		e.escalate(it.ID, "spawn failed: "+err.Error())
		return
	}
	if !*opened {
		*opened = true
		if err := e.recordClaimPane(it, res, req.Session); err != nil {
			e.escalate(it.ID, "orphan pane "+res.PaneID+": claim pane not written: "+err.Error())
			return
		}
	}
	if err := e.attach(ctx, it, req.Repo, res, req.Session); err != nil {
		e.escalate(it.ID, "spawned but attaching the pane failed: "+err.Error())
		return
	}
	e.act(action, it.ID, fmt.Sprintf("%s in %s", res.PaneID, req.Session))
}

func (e *engine) releaseClaim(it operator.TrackedItem) error {
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, it.ID)
		if i < 0 || claimToken(st.Tracked[i]) != claimToken(it) || operator.ScopeString(claimOf(st.Tracked[i]), "pane") != operator.ScopeString(claimOf(it), "pane") {
			return operator.ErrNoWrite
		}
		delete(st.Tracked[i].Scope, scopeClaim)
		return nil
	})
}

func (e *engine) recordClaimPane(it operator.TrackedItem, res SpawnResult, session string) error {
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, it.ID)
		if i < 0 || claimToken(st.Tracked[i]) != claimToken(it) {
			return fmt.Errorf("spawn claim was changed externally")
		}
		claim := claimOf(st.Tracked[i])
		claim["pane"], claim["window"], claim["session"] = res.PaneID, res.WindowID, session
		claim["branch"], claim["worktree"] = res.Branch, res.WorktreePath
		return nil
	})
}

// A live recorded pane is adopted even before the lease expires. An unrecorded
// claim is held until expiry so an overlapping pass cannot duplicate a spawn.
func (e *engine) reconcileClaim(ctx context.Context, it operator.TrackedItem) {
	if e.env.DryRun {
		return
	}
	claim := claimOf(it)
	if raw := claim["branch"]; raw != nil && raw != "" {
		if _, ok := e.checkedBranch(it.ID, operator.ScopeString(claim, "branch"), "claimed"); !ok {
			return
		}
	}
	if kind := operator.ScopeString(claim, "kind"); kind == claimRebase || kind == claimStacked {
		if _, ok := e.checkedBranch(it.ID, operator.ScopeString(it.Scope, "branch"), "claimed worktree"); !ok {
			return
		}
	}
	pane := operator.ScopeString(claim, "pane")
	panes, err := e.env.Panes.Snapshot(ctx)
	if err != nil {
		e.escalate(it.ID, "cannot reconcile spawn claim: "+err.Error())
		return
	}
	if _, alive := panes[pane]; pane != "" && alive {
		res := SpawnResult{PaneID: pane, WindowID: operator.ScopeString(claim, "window"), Branch: operator.ScopeString(claim, "branch"), WorktreePath: operator.ScopeString(claim, "worktree")}
		if res.Branch == "" {
			branch, err := e.git(ctx, res.WorktreePath, "rev-parse", "--abbrev-ref", "HEAD")
			if err != nil || safeBranch(branch) == "" {
				e.escalate(it.ID, "cannot adopt recorded pane: worktree branch unavailable")
				return
			}
			res.Branch = branch
		}
		if err := e.attach(ctx, it, operator.ScopeString(it.Scope, "repo"), res, operator.ScopeString(claim, "session")); err != nil {
			e.escalate(it.ID, "cannot adopt recorded pane: "+err.Error())
			return
		}
		action := ActSpawned
		switch operator.ScopeString(claim, "kind") {
		case claimRespawn:
			action = ActRespawned
		case claimFixSpawn:
			action = ActRecoverySpawn
		}
		e.act(action, it.ID, "adopted recorded pane "+pane)
		return
	}
	at, err := time.Parse(time.RFC3339, operator.ScopeString(claim, "at"))
	if pane == "" && err == nil && e.env.now().Sub(at) < spawnClaimTTL {
		return
	}
	kind := operator.ScopeString(claim, "kind")
	if (kind == claimRebase || kind == claimStacked) && operator.ScopeString(claim, "worktree") != "" {
		if err := e.env.Spawn.RemoveWorktree(ctx, operator.ScopeString(it.Scope, "repo"), operator.ScopeString(claim, "worktree")); err != nil {
			e.escalate(it.ID, "claimed worktree cleanup failed: "+err.Error())
			return
		}
	}
	release := e.releaseClaim
	if kind == claimFixSend {
		release = e.rollbackClaim
	}
	if err := release(it); err != nil {
		e.escalate(it.ID, "spawn claim could not be released: "+err.Error())
		return
	}
	e.escalate(it.ID, "released spawn claim without a live recorded pane; inspect any abandoned worktree before retrying")
}
