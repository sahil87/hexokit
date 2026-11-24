package riff

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// WtVersionTimeout bounds the `wt --version` probe.
const WtVersionTimeout = 5 * time.Second

// wtMinVersion is the oldest wt riff drives: the first release whose
// `create --json` prints the receipt riff decodes and whose --fetch pins the
// base it records.
var wtMinVersion = [3]int{0, 1, 8}

const wtMinVersionText = "v0.1.8"

var wtVersionRe = regexp.MustCompile(`^wt version v(\d+)\.(\d+)\.(\d+)$`)

// wtVersionGate caches a passing probe for the process. A failing probe is
// never cached, so a `wt update` takes effect on the next spawn without a
// daemon restart.
var wtVersionGate struct {
	mu sync.Mutex
	ok bool
}

// ensureWtVersion refuses a spawn when wt is older than wtMinVersion or its
// version cannot be read. There is no fallback to the pre-receipt `Path:`
// parsing: one code path, with the fix in the message.
func ensureWtVersion(parent context.Context) error {
	wtVersionGate.mu.Lock()
	defer wtVersionGate.mu.Unlock()
	if wtVersionGate.ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(parent, WtVersionTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "wt", "--version").Output()
	if err != nil {
		return &ExitCodeError{Code: ExitPrecondition, Msg: fmt.Sprintf("run-kit riff: could not read the wt version (%v) — rk needs wt >= %s (run: wt update)", err, wtMinVersionText)}
	}
	raw := strings.TrimSpace(string(out))
	version, ok := parseWtVersion(raw)
	if !ok {
		return &ExitCodeError{Code: ExitPrecondition, Msg: fmt.Sprintf("run-kit riff: cannot parse the wt version %q — rk needs wt >= %s (run: wt update)", raw, wtMinVersionText)}
	}
	if wtVersionLess(version, wtMinVersion) {
		return &ExitCodeError{Code: ExitPrecondition, Msg: fmt.Sprintf("run-kit riff: wt v%d.%d.%d is too old — rk needs wt >= %s (run: wt update)", version[0], version[1], version[2], wtMinVersionText)}
	}
	wtVersionGate.ok = true
	return nil
}

// parseWtVersion reads `wt version vX.Y.Z`. Pure.
func parseWtVersion(out string) ([3]int, bool) {
	m := wtVersionRe.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return [3]int{}, false
	}
	var v [3]int
	for i := range v {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return [3]int{}, false
		}
		v[i] = n
	}
	return v, true
}

// wtVersionLess reports a < b component-wise. Pure.
func wtVersionLess(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}
