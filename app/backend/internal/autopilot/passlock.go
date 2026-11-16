package autopilot

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const passLockSuffix = ".autopilot.lock"

// passLockPath sits beside the operator state file as <slug>.autopilot.lock,
// so one server has one pass lock.
func passLockPath(statePath string) string {
	return strings.TrimSuffix(statePath, filepath.Ext(statePath)) + passLockSuffix
}

// acquirePassLock takes the server's exclusive, non-blocking pass lock. A held
// lock is busy, not an error. The OS drops the flock when the process dies, so
// a crash never leaves it held. The state file's own sidecar lock is separate
// and unchanged.
func acquirePassLock(statePath string) (release func(), busy bool, err error) {
	path := passLockPath(statePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, fmt.Errorf("cannot create %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, fmt.Errorf("cannot open pass lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("cannot lock %s: %w", path, err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, false, nil
}

// passLocked runs fn under the pass lock and returns a busy result without
// running it when another pass holds the lock. A dry run takes no lock: it
// changes nothing.
func passLocked(env Env, fn func() (*StepResult, error)) (*StepResult, error) {
	if env.DryRun {
		return fn()
	}
	release, busy, err := acquirePassLock(env.StatePath)
	if err != nil {
		res := newResult(false)
		return res, err
	}
	if busy {
		res := newResult(false)
		res.Busy = true
		return res, nil
	}
	defer release()
	return fn()
}
