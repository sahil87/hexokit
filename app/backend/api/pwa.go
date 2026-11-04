package api

// PWA identity assets — dynamic serving of /manifest.json and the
// /generated-icons/* assets so the per-instance accent color
// (~/.config/hexokit/config.yaml instance_color, see api/settings.go) tints the
// installed PWA's Dock/Cmd-Tab icon and the tab favicon. Routes are
// registered in router.go BEFORE the SPA catch-all; with no owned accent
// every route serves the stock bytes byte-identically, so zero-config
// behavior is unchanged.
//
// The accent is read from settings PER REQUEST (Constitution §II — state
// derived at request time). Tinted outputs are memoized in memory on the
// Server (a pure function of the fixed stock bytes + descriptor — not
// persistent state; bounded at 10 owned families × 4 assets).

import (
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"rk/internal/icontint"
	"rk/internal/settings"
)

// spaPublicFallbackDirs are filesystem locations for the stock frontend
// assets tried AFTER spaDir (the built dist) in filesystem mode, so `just
// dev` — where dist may not exist — still serves these routes: the frontend
// public source dir relative to the repo root, and relative to app/backend
// (the air dev cwd, per scripts/dev.sh).
var spaPublicFallbackDirs = []string{"app/frontend/public", "../frontend/public"}

// readSPAAsset reads a stock frontend asset (path relative to the frontend
// root, e.g. "manifest.json", "generated-icons/icon-192.png") through the
// same seam mountSPA branches on: the embedded FS in production, the local
// filesystem (dist, then the public source dir) in dev.
func readSPAAsset(relPath string) ([]byte, error) {
	if useEmbeddedSPA {
		sub, err := embeddedSPASub()
		if err != nil {
			return nil, err
		}
		return fs.ReadFile(sub, relPath)
	}
	for _, dir := range append([]string{spaDir}, spaPublicFallbackDirs...) {
		if b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(relPath))); err == nil {
			return b, nil
		}
	}
	return nil, os.ErrNotExist
}

// manifestIconSrcs are the icon src literals in the stock manifest.json that
// gain the ?c= cache-buster when an owned accent is set. The changed URLs are
// also what makes Chrome detect a manifest change and refresh the installed
// icon (on its lazy re-check cycle — an accepted limitation).
var manifestIconSrcs = []string{
	"/generated-icons/icon-192.png",
	"/generated-icons/icon-512.png",
	"/generated-icons/icon-512-maskable.png",
}

// instanceAccent resolves the configured instance accent to its owned-family
// hex + canonical descriptor. ok=false when no accent is set OR the stored
// value maps to no owned family (mirroring the frontend's resolveFamily —
// such values render no accent anywhere, so the icons stay stock).
func instanceAccent() (hex string, canonical string, ok bool) {
	c := settings.GetInstanceColor()
	if c == nil {
		return "", "", false
	}
	return icontint.Resolve(*c)
}

// handleManifest serves GET /manifest.json. Unset/unowned accent → the stock
// manifest bytes verbatim; owned accent → the same JSON with each icon src
// carrying ?c=<descriptor> (query-escaped: the blend "+" becomes %2B — Go
// writes and parses both sides, so the encoding round-trips exactly).
// String substitution, not a JSON round-trip, keeps everything except the
// three srcs byte-identical.
func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request) {
	stock, err := readSPAAsset("manifest.json")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	if _, canonical, ok := instanceAccent(); ok {
		esc := url.QueryEscape(canonical)
		text := string(stock)
		for _, src := range manifestIconSrcs {
			text = strings.ReplaceAll(text, `"`+src+`"`, `"`+src+"?c="+esc+`"`)
		}
		w.Write([]byte(text))
		return
	}
	w.Write(stock)
}

// tintableIcons is the closed set of PNG names the tinted-icon route serves.
// Names come from the fixed route registrations, never user input; the map is
// belt-and-suspenders (constitution §I).
var tintableIcons = map[string]bool{
	"icon-192.png":          true,
	"icon-512.png":          true,
	"icon-512-maskable.png": true,
}

// handleGeneratedIcon serves GET /generated-icons/{icon-*.png}. Without ?c=
// — or with a malformed/unowned descriptor (treated as absent, never a 400:
// browsers and OS surfaces fetch these, and a broken query must not break the
// install) — the stock bytes are served. With an owned ?c=<descriptor> the
// stock PNG is colorized (icontint.TintPNG) and memoized.
func (s *Server) handleGeneratedIcon(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/generated-icons/")
	if !tintableIcons[name] {
		http.NotFound(w, r)
		return
	}
	stock, err := readSPAAsset("generated-icons/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")

	c := r.URL.Query().Get("c")
	if c == "" {
		w.Write(stock)
		return
	}
	hex, canonical, ok := icontint.Resolve(c)
	if !ok {
		w.Write(stock)
		return
	}
	tinted, err := s.tintCached(name, canonical, func() ([]byte, error) {
		return icontint.TintPNG(stock, hex)
	})
	if err != nil {
		s.logger.Error("failed to tint icon", "icon", name, "descriptor", canonical, "error", err)
		w.Write(stock)
		return
	}
	w.Write(tinted)
}

// handleFavicon serves GET /generated-icons/favicon.svg. index.html's
// rel=icon href is static (no ?c=), so the tint resolves from the current
// settings per request; Cache-Control: no-cache makes the browser revalidate
// so an accent change reaches open tabs on their next load.
func (s *Server) handleFavicon(w http.ResponseWriter, r *http.Request) {
	stock, err := readSPAAsset("generated-icons/favicon.svg")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-cache")

	hex, canonical, ok := instanceAccent()
	if !ok {
		w.Write(stock)
		return
	}
	tinted, err := s.tintCached("favicon.svg", canonical, func() ([]byte, error) {
		return icontint.TintSVG(stock, hex)
	})
	if err != nil {
		s.logger.Error("failed to tint favicon", "descriptor", canonical, "error", err)
		w.Write(stock)
		return
	}
	w.Write(tinted)
}

// tintCached memoizes a tinted asset under "asset|descriptor". The stock
// bytes are fixed for the process lifetime (embedded in prod; in dev a
// regenerated asset is picked up on restart), so the entry is a pure function
// of its key.
func (s *Server) tintCached(asset, descriptor string, tint func() ([]byte, error)) ([]byte, error) {
	key := asset + "|" + descriptor
	s.tintCacheMu.Lock()
	cached, hit := s.tintCache[key]
	s.tintCacheMu.Unlock()
	if hit {
		return cached, nil
	}
	tinted, err := tint()
	if err != nil {
		return nil, err
	}
	s.tintCacheMu.Lock()
	if s.tintCache == nil {
		s.tintCache = make(map[string][]byte)
	}
	s.tintCache[key] = tinted
	s.tintCacheMu.Unlock()
	return tinted, nil
}
