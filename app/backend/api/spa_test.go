package api

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func setupSPADir(t *testing.T) (string, func()) {
	t.Helper()
	dir := t.TempDir()

	// Save originals and restore after test
	orig := spaDir
	origEmbed := useEmbeddedSPA
	spaDir = dir
	useEmbeddedSPA = false

	// Create index.html
	indexPath := filepath.Join(dir, "index.html")
	if err := os.WriteFile(indexPath, []byte("<html>SPA</html>"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Create a static asset
	assetsDir := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assetsDir, "main.js"), []byte("console.log('app')"), 0o644); err != nil {
		t.Fatal(err)
	}

	return dir, func() {
		spaDir = orig
		useEmbeddedSPA = origEmbed
	}
}

func TestSPAStaticAsset(t *testing.T) {
	_, cleanup := setupSPADir(t)
	defer cleanup()

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/assets/main.js", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	body := rec.Body.String()
	if body != "console.log('app')" {
		t.Errorf("body = %q, want %q", body, "console.log('app')")
	}
}

func TestSPAFallback(t *testing.T) {
	_, cleanup := setupSPADir(t)
	defer cleanup()

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/p/run-kit/0", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	body := rec.Body.String()
	if body != "<html>SPA</html>" {
		t.Errorf("body = %q, want SPA index.html content", body)
	}
}

func TestSPAPathTraversal(t *testing.T) {
	_, cleanup := setupSPADir(t)
	defer cleanup()

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// Should not serve /etc/passwd — path traversal must be blocked with 404
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// setupEmbeddedSPA forces embedded mode backed by a synthetic fs.FS and
// restores the real seams after the test.
func setupEmbeddedSPA(t *testing.T) {
	t.Helper()
	origEmbed := useEmbeddedSPA
	origSub := embeddedSPASub

	useEmbeddedSPA = true
	mapFS := fstest.MapFS{
		"index.html":               {Data: []byte("<html>SPA</html>")},
		"assets/app-abc123.js":     {Data: []byte("console.log('app')")},
		"favicon-precomposed.png":  {Data: []byte("png-bytes")},
		".well-known/security.txt": {Data: []byte("Contact: mailto:security@example.com")},
	}
	embeddedSPASub = func() (fs.FS, error) { return mapFS, nil }

	t.Cleanup(func() {
		useEmbeddedSPA = origEmbed
		embeddedSPASub = origSub
	})
}

func TestSPACacheControlFilesystem(t *testing.T) {
	_, cleanup := setupSPADir(t)
	defer cleanup()

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	cases := []struct {
		path string
		want string
	}{
		{"/assets/main.js", "public, max-age=31536000, immutable"},
		{"/", "no-cache"},
		{"/p/run-kit/0", "no-cache"}, // SPA fallback
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want %d", tc.path, rec.Code, http.StatusOK)
		}
		if got := rec.Header().Get("Cache-Control"); got != tc.want {
			t.Errorf("%s: Cache-Control = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestSPAFilesystemLastModified304(t *testing.T) {
	_, cleanup := setupSPADir(t)
	defer cleanup()

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	lastMod := rec.Header().Get("Last-Modified")
	if lastMod == "" {
		t.Fatal("Last-Modified header missing — filesystem mode should keep mtime validators")
	}

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("If-Modified-Since", lastMod)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotModified)
	}
}

func TestSPACacheControlEmbedded(t *testing.T) {
	setupEmbeddedSPA(t)

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// Hashed asset: immutable, no ETag needed.
	req := httptest.NewRequest(http.MethodGet, "/assets/app-abc123.js", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("asset status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("asset Cache-Control = %q, want immutable policy", got)
	}

	// Index: no-cache + a content-derived ETag.
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("index status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("index Cache-Control = %q, want %q", got, "no-cache")
	}
	indexETag := rec.Header().Get("ETag")
	if indexETag == "" {
		t.Fatal("index ETag missing — embedded mode must set a content-derived validator")
	}

	// SPA fallback route: serves index.html with the same policy and ETag.
	req = httptest.NewRequest(http.MethodGet, "/p/run-kit/0", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fallback status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("fallback Cache-Control = %q, want %q", got, "no-cache")
	}
	if got := rec.Header().Get("ETag"); got != indexETag {
		t.Errorf("fallback ETag = %q, want index ETag %q (memoized, stable)", got, indexETag)
	}

	// Non-asset root-level file: no-cache + its own ETag.
	req = httptest.NewRequest(http.MethodGet, "/favicon-precomposed.png", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("root file status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("root file Cache-Control = %q, want %q", got, "no-cache")
	}
	if got := rec.Header().Get("ETag"); got == "" || got == indexETag {
		t.Errorf("root file ETag = %q, want non-empty and distinct from index ETag %q", got, indexETag)
	}

	// Stale hashed-asset URL falls through to the index fallback — it must
	// get the no-cache policy, never the immutable one.
	req = httptest.NewRequest(http.MethodGet, "/assets/gone-xyz.js", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("stale asset status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("stale-asset fallback Cache-Control = %q, want %q", got, "no-cache")
	}
	if body := rec.Body.String(); body != "<html>SPA</html>" {
		t.Errorf("stale-asset fallback body = %q, want index.html content", body)
	}
}

func TestSPAEmbeddedIfNoneMatch304(t *testing.T) {
	setupEmbeddedSPA(t)

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag missing on first response")
	}

	// Matching If-None-Match revalidates to 304 with an empty body.
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("If-None-Match", etag)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotModified)
	}
	if body := rec.Body.String(); body != "" {
		t.Errorf("304 body = %q, want empty", body)
	}

	// The 304 also works on SPA fallback routes (same index.html validator).
	req = httptest.NewRequest(http.MethodGet, "/p/run-kit/0", nil)
	req.Header.Set("If-None-Match", etag)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Errorf("fallback status = %d, want %d", rec.Code, http.StatusNotModified)
	}

	// A non-matching validator serves the full body again.
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("If-None-Match", `"different"`)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("non-matching status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("ETag"); got != etag {
		t.Errorf("ETag = %q, want stable %q", got, etag)
	}
}

func TestSPANotBuilt(t *testing.T) {
	// Point spaDir to a nonexistent directory and force filesystem mode
	orig := spaDir
	origEmbed := useEmbeddedSPA
	spaDir = "/tmp/nonexistent-spa-dir-12345"
	useEmbeddedSPA = false
	defer func() { spaDir = orig; useEmbeddedSPA = origEmbed }()

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// wellKnownDiscoveryPaths are RFC 8615 URIs that discovery clients probe and
// that the SPA ships no file for. The OAuth pair is what MCP tunnel clients
// fetch against the daemon's origin before trusting /mcp.
var wellKnownDiscoveryPaths = []string{
	"/.well-known/oauth-protected-resource",
	"/.well-known/oauth-protected-resource/mcp",
	"/.well-known/oauth-authorization-server",
	"/.well-known/openid-configuration",
}

func assertWellKnownNotFound(t *testing.T, router http.Handler) {
	t.Helper()
	for _, path := range wellKnownDiscoveryPaths {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want %d", path, rec.Code, http.StatusNotFound)
		}
		if strings.Contains(rec.Body.String(), "<html>SPA</html>") {
			t.Errorf("GET %s: served the SPA index.html, want no fallback", path)
		}
	}
}

func assertWellKnownFileServed(t *testing.T, router http.Handler) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/.well-known/security.txt", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if body := rec.Body.String(); body != "Contact: mailto:security@example.com" {
		t.Errorf("body = %q, want the shipped security.txt", body)
	}
}

func TestSPAWellKnownNoFallbackFilesystem(t *testing.T) {
	_, cleanup := setupSPADir(t)
	defer cleanup()

	assertWellKnownNotFound(t, newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{}))
}

func TestSPAWellKnownNoFallbackEmbedded(t *testing.T) {
	setupEmbeddedSPA(t)

	assertWellKnownNotFound(t, newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{}))
}

func TestSPAWellKnownShippedFileFilesystem(t *testing.T) {
	dir, cleanup := setupSPADir(t)
	defer cleanup()

	wellKnownDir := filepath.Join(dir, ".well-known")
	if err := os.MkdirAll(wellKnownDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wellKnownDir, "security.txt"), []byte("Contact: mailto:security@example.com"), 0o644); err != nil {
		t.Fatal(err)
	}

	assertWellKnownFileServed(t, newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{}))
}

func TestSPAWellKnownShippedFileEmbedded(t *testing.T) {
	setupEmbeddedSPA(t)

	assertWellKnownFileServed(t, newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{}))
}
