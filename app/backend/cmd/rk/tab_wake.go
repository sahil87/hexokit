package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// tabWakeTimeout bounds the wake POST. Deliberately shorter than
// notifyTimeout: the wake rides every tab mutation's hot path — a down daemon
// connection-refuses instantly, so the timeout only bounds a hung one. A var
// (the safetyInterval override idiom) so tests can prove the hung-daemon
// bound without a real 2s wait.
var tabWakeTimeout = 2 * time.Second

// tabWakeFn is the wake seam the mutating tab verbs call after a successful
// write — a package var (the presentNotifyFn idiom) so tests can record calls
// without a network.
var tabWakeFn = wakeTabHub

// wakeTabHub POSTs {"name": server} to the covering daemon's
// /api/servers/wake so the SSE derive tick repaints the mutation immediately
// (direct tmux option writes emit no control-mode event; without the wake the
// UI waits for the safety poll). The origin comes from resolveOrigin (explicit
// RK_HOST/RK_PORT env → the covering tmux server's @rk_srv_origin → the
// portpolicy default). Fail-silent by design: any error (unreachable
// daemon, non-2xx, timeout) is swallowed with no output — the tab family
// works with rk serve down, and the wake must never change that.
func wakeTabHub(parent context.Context, server string) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, tabWakeTimeout)
	defer cancel()

	url := resolveOrigin(ctx) + "/api/servers/wake"

	payload, err := json.Marshal(map[string]string{"name": server})
	if err != nil {
		return
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return // server unreachable / timeout — fail silent
	}
	defer resp.Body.Close()
	// Non-2xx is also swallowed: the wake is best-effort.
}
