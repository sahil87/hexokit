package ghhooks

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	// MaxBodyBytes caps a delivery body. GitHub itself caps payloads at 25 MiB
	// but the four subscribed kinds are a few KiB; the cap keeps a stray local
	// POST from filling memory.
	MaxBodyBytes = 5 << 20
	// dispatchTimeout bounds one mapping run (server discovery, ledger reads,
	// git origin lookups).
	dispatchTimeout = 20 * time.Second
)

// Receiver is the loopback webhook handler. It answers every delivery 2xx at
// once and maps it afterwards, so the forwarder never retries on slow disk or
// git; mapping failures are logged, never returned.
type Receiver struct {
	Source Source
	// Wake writes the server's trigger marker (the door); reason is already
	// within the marker's limit.
	Wake func(server, reason string) error
	// Logger receives event name + nwo#n lines only, never payload content.
	Logger *slog.Logger

	pending sync.WaitGroup
}

// Wait blocks until every accepted delivery has finished mapping. Tests use it
// to observe the markers; the server does not need it.
func (r *Receiver) Wait() { r.pending.Wait() }

func (r *Receiver) log() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

// ServeHTTP serves POST /hooks/github and nothing else.
func (r *Receiver) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != HookPath {
		http.NotFound(w, req)
		return
	}
	if req.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, MaxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "unreadable body", http.StatusBadRequest)
		return
	}
	name := req.Header.Get(EventHeader)
	w.WriteHeader(http.StatusAccepted)

	ev, ok, err := Extract(name, body)
	if err != nil {
		r.log().Warn("gh hooks: undecodable delivery ignored", "event", name, "err", err)
		return
	}
	if !ok {
		return
	}
	r.pending.Add(1)
	go func() {
		defer r.pending.Done()
		r.dispatch(ev)
	}()
}

// dispatch maps one event onto the live servers and writes one marker per
// matching server.
func (r *Receiver) dispatch(ev Event) {
	ctx, cancel := context.WithTimeout(context.Background(), dispatchTimeout)
	defer cancel()
	hits := Match(ctx, r.Source, ev, func(server string, err error) {
		r.log().Warn("gh hooks: mapping skipped a server", "server", server, "err", err)
	})
	for _, hit := range hits {
		if err := r.Wake(hit.Server, Reason(ev, hit)); err != nil {
			r.log().Warn("gh hooks: wake marker not written", "server", hit.Server, "err", err)
			continue
		}
		r.log().Info("gh hooks: operator woken", "server", hit.Server, "event", ev.Name, "pr", ev.NWO+"#"+refText(hit))
	}
}

func refText(h Hit) string {
	if h.PR == 0 {
		return h.Branch
	}
	return strconv.Itoa(h.PR)
}
