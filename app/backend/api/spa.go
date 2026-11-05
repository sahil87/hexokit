package api

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"rk/build"

	"github.com/go-chi/chi/v5"
)

// spaDir is the directory containing the built SPA assets (used in dev/filesystem mode).
var spaDir = "app/frontend/dist"

// useEmbeddedSPA controls whether mountSPA serves from the embedded FS or the filesystem.
// Defaults to the result of hasEmbeddedAssets(); overridden by tests to force filesystem mode.
var useEmbeddedSPA = hasEmbeddedAssets()

// embeddedSPASub returns the embedded frontend sub-FS. Overridden by tests to
// serve a synthetic fs.FS (e.g. fstest.MapFS) through the embedded-mode
// handler — the test-build embed.FS contains only .gitkeep.
var embeddedSPASub = func() (fs.FS, error) { return fs.Sub(build.Frontend, "frontend") }

// Cache policies for SPA responses. Vite content-hashes every filename under
// /assets/ (a rebuild changes the URL), so those files are safe to cache
// forever; everything else (index.html, the SPA fallback, root-level files)
// must revalidate on every load so new deploys reach clients immediately.
const (
	// spaAssetsPrefix is the URL prefix of Vite's content-hashed build output.
	spaAssetsPrefix = "/assets/"

	spaAssetsCacheControl = "public, max-age=31536000, immutable"
	spaHTMLCacheControl   = "no-cache"
)

// wellKnownPrefix is the RFC 8615 discovery namespace. Files the SPA ships
// under it are served like any other file, but a miss MUST 404 rather than
// fall back to index.html: discovery clients (MCP's OAuth protected-resource
// probe) read any 200 as the metadata document they asked for.
const wellKnownPrefix = "/.well-known/"

// setSPACacheControl applies the two-tier cache policy based on the path of
// the file actually being served: hashed assets cache forever, everything
// else revalidates. Call it at the serve point, not on the raw request — the
// SPA fallback serves index.html and must always get the no-cache policy,
// even when the request URL looks like a (stale, missing) hashed asset.
func setSPACacheControl(w http.ResponseWriter, urlPath string) {
	if strings.HasPrefix(urlPath, spaAssetsPrefix) {
		w.Header().Set("Cache-Control", spaAssetsCacheControl)
	} else {
		w.Header().Set("Cache-Control", spaHTMLCacheControl)
	}
}

// hasEmbeddedAssets reports whether the embedded frontend FS contains real build output
// (i.e., more than just the .gitkeep placeholder).
func hasEmbeddedAssets() bool {
	entries, err := fs.ReadDir(build.Frontend, "frontend")
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Name() != ".gitkeep" {
			return true
		}
	}
	return false
}

func (s *Server) mountSPA(r chi.Router) {
	if useEmbeddedSPA {
		s.mountEmbeddedSPA(r)
	} else {
		s.mountFilesystemSPA(r)
	}
}

// mountEmbeddedSPA serves the SPA from the embedded filesystem (production mode).
func (s *Server) mountEmbeddedSPA(r chi.Router) {
	// Sub into the "frontend" subdirectory of the embed.FS.
	sub, err := embeddedSPASub()
	if err != nil {
		s.logger.Error("failed to open embedded frontend", "err", err)
		return
	}
	fsys := http.FS(sub)

	// etagFor memoizes a content-derived ETag per embedded path. Embedded
	// files carry a zero modtime (so net/http emits no Last-Modified),
	// making a hash of the served bytes the only honest validator — and the
	// embedded FS is immutable for the process lifetime, so computing it
	// once per path is safe (same rationale as pwa.go's tintCached).
	var (
		etagMu sync.Mutex
		etags  = map[string]string{}
	)
	etagFor := func(path string) (string, bool) {
		etagMu.Lock()
		defer etagMu.Unlock()
		if tag, ok := etags[path]; ok {
			return tag, true
		}
		data, err := fs.ReadFile(sub, path)
		if err != nil {
			return "", false
		}
		sum := sha256.Sum256(data)
		tag := `"` + hex.EncodeToString(sum[:8]) + `"`
		etags[path] = tag
		return tag, true
	}

	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		urlPath := strings.TrimPrefix(req.URL.Path, "/")

		// Skip API and WebSocket routes defensively (registered before the SPA
		// catch-all — this guard is belt-and-suspenders).
		if strings.HasPrefix(req.URL.Path, "/api/") || strings.HasPrefix(req.URL.Path, "/ws/") {
			http.NotFound(w, req)
			return
		}

		// Try to serve the file directly from embedded FS.
		// Only serve regular files — reject directories to prevent directory listings.
		if urlPath != "" {
			if f, err := sub.Open(urlPath); err == nil {
				stat, statErr := f.Stat()
				f.Close()
				if statErr == nil && !stat.IsDir() {
					setSPACacheControl(w, req.URL.Path)
					// Non-asset files (index.html, favicons, manifests) get a
					// content-derived ETag; setting the header before serving
					// lets net/http answer If-None-Match with 304 itself.
					if !strings.HasPrefix(req.URL.Path, spaAssetsPrefix) {
						if tag, ok := etagFor(urlPath); ok {
							w.Header().Set("ETag", tag)
						}
					}
					http.FileServer(fsys).ServeHTTP(w, req)
					return
				}
			}
		}

		if strings.HasPrefix(req.URL.Path, wellKnownPrefix) {
			http.NotFound(w, req)
			return
		}

		// SPA fallback: serve index.html for client-side routing. Always the
		// no-cache policy + index.html's ETag, whatever the request URL was.
		w.Header().Set("Cache-Control", spaHTMLCacheControl)
		if tag, ok := etagFor("index.html"); ok {
			w.Header().Set("ETag", tag)
		}
		req.URL.Path = "/"
		http.FileServer(fsys).ServeHTTP(w, req)
	})
}

// mountFilesystemSPA serves the SPA from the local filesystem (dev mode).
// It applies the same two-tier Cache-Control policy as embedded mode but
// keeps http.ServeFile's mtime-based Last-Modified/304 handling as the
// validator — behavior parity, not implementation symmetry.
func (s *Server) mountFilesystemSPA(r chi.Router) {
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		// Clean the URL path and strip the leading slash so filepath.Join
		// resolves relative to spaDir instead of discarding it.
		urlPath := strings.TrimPrefix(req.URL.Path, "/")

		// Skip API and WebSocket routes (should never reach here due to route
		// ordering, but guard defensively)
		if strings.HasPrefix(req.URL.Path, "/api/") || strings.HasPrefix(req.URL.Path, "/ws/") {
			http.NotFound(w, req)
			return
		}

		// Try to serve the static file directly
		filePath := filepath.Join(spaDir, filepath.Clean(urlPath))

		// Ensure the resolved path stays within spaDir to prevent path traversal
		absFilePath, _ := filepath.Abs(filePath)
		absSpaDir, _ := filepath.Abs(spaDir)
		if !strings.HasPrefix(absFilePath, absSpaDir+string(filepath.Separator)) && absFilePath != absSpaDir {
			http.NotFound(w, req)
			return
		}
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			setSPACacheControl(w, req.URL.Path)
			http.ServeFile(w, req, filePath)
			return
		}

		if strings.HasPrefix(req.URL.Path, wellKnownPrefix) {
			http.NotFound(w, req)
			return
		}

		// SPA fallback: serve index.html for client-side routing
		indexPath := filepath.Join(spaDir, "index.html")
		if _, err := os.Stat(indexPath); err != nil {
			// SPA not built yet — return 404
			http.NotFound(w, req)
			return
		}

		w.Header().Set("Cache-Control", spaHTMLCacheControl)
		http.ServeFile(w, req, indexPath)
	})
}
