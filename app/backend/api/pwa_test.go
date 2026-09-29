package api

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/settings"
)

// realPublicDir is the frontend public source dir relative to this package's
// test cwd (app/backend/api) — the real committed stock assets, so the tint
// tests golden-pixel against exactly what production serves.
const realPublicDir = "../../frontend/public"

// pointSPAAtRealPublic forces filesystem mode with spaDir at the real
// frontend public dir, restoring the originals after the test.
func pointSPAAtRealPublic(t *testing.T) {
	t.Helper()
	origDir, origEmbed := spaDir, useEmbeddedSPA
	spaDir = realPublicDir
	useEmbeddedSPA = false
	t.Cleanup(func() { spaDir = origDir; useEmbeddedSPA = origEmbed })
}

// setInstanceColor persists an instance accent into the (isolated) settings.
func setInstanceColor(t *testing.T, descriptor string) {
	t.Helper()
	if err := settings.SetInstanceColor(&descriptor); err != nil {
		t.Fatalf("SetInstanceColor(%q): %v", descriptor, err)
	}
}

func getAsset(t *testing.T, router http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func readStock(t *testing.T, relPath string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(realPublicDir, relPath))
	if err != nil {
		t.Fatalf("read stock asset %s: %v", relPath, err)
	}
	return b
}

// --- GET /manifest.json ---

func TestManifest_unsetAccentByteIdentical(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getAsset(t, router, "/manifest.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/manifest+json" {
		t.Errorf("Content-Type = %q, want application/manifest+json", ct)
	}
	if !bytes.Equal(rec.Body.Bytes(), readStock(t, "manifest.json")) {
		t.Error("unset-accent manifest body is not byte-identical to the stock file")
	}
}

func TestManifest_ownedAccentAddsCacheBuster(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	setInstanceColor(t, "1+3") // owned blend (orange) — the "+" must escape as %2B
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getAsset(t, router, "/manifest.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	body := rec.Body.String()
	for _, src := range []string{
		`"/generated-icons/icon-192.png?c=1%2B3"`,
		`"/generated-icons/icon-512.png?c=1%2B3"`,
		`"/generated-icons/icon-512-maskable.png?c=1%2B3"`,
	} {
		if !strings.Contains(body, src) {
			t.Errorf("manifest missing cache-busted src %s", src)
		}
	}
	// Still valid JSON with the stock identity fields.
	var m struct {
		Name  string `json:"name"`
		Icons []struct {
			Src string `json:"src"`
		} `json:"icons"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("tinted manifest is not valid JSON: %v", err)
	}
	if m.Name != "HexoKit" || len(m.Icons) != 3 {
		t.Errorf("manifest identity = (%q, %d icons), want (HexoKit, 3)", m.Name, len(m.Icons))
	}
}

func TestManifest_unownedAccentServesStock(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	setInstanceColor(t, "7") // valid per ValidateColorValue, owned by no family
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getAsset(t, router, "/manifest.json")
	if !bytes.Equal(rec.Body.Bytes(), readStock(t, "manifest.json")) {
		t.Error("unowned-accent manifest body is not byte-identical to the stock file")
	}
}

func TestManifest_missingAsset404s(t *testing.T) {
	isolateSettings(t)
	origDir, origEmbed := spaDir, useEmbeddedSPA
	spaDir = t.TempDir() // empty — and the public fallbacks don't resolve from this cwd
	useEmbeddedSPA = false
	t.Cleanup(func() { spaDir = origDir; useEmbeddedSPA = origEmbed })
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	if rec := getAsset(t, router, "/manifest.json"); rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// --- GET /generated-icons/icon-*.png ---

func decodePNG(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	return img
}

// findPixel scans img for the first pixel with the given NRGBA value.
func findPixel(t *testing.T, img image.Image, want color.NRGBA) (int, int) {
	t.Helper()
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA) == want {
				return x, y
			}
		}
	}
	t.Fatalf("no pixel %+v found in stock icon", want)
	return 0, 0
}

func TestGeneratedIcon_noQueryServesStock(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	// Even with an owned accent set, the bare URL serves stock — only the
	// ?c= cache-buster (written into the manifest) selects the tint.
	setInstanceColor(t, "4")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	for _, name := range []string{"icon-192.png", "icon-512.png", "icon-512-maskable.png"} {
		rec := getAsset(t, router, "/generated-icons/"+name)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want %d", name, rec.Code, http.StatusOK)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("%s: Content-Type = %q, want image/png", name, ct)
		}
		if !bytes.Equal(rec.Body.Bytes(), readStock(t, "generated-icons/"+name)) {
			t.Errorf("%s: no-query body is not byte-identical to the stock file", name)
		}
	}
}

func TestGeneratedIcon_tintGoldenPixels(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	stock := decodePNG(t, readStock(t, "generated-icons/icon-192.png"))
	// Locate a peak-gray logo pixel in the stock asset; the corner is the
	// #0f1117 padding background.
	px, py := findPixel(t, stock, color.NRGBA{R: 180, G: 180, B: 180, A: 255})

	rec := getAsset(t, router, "/generated-icons/icon-192.png?c=4") // blue
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	tinted := decodePNG(t, rec.Body.Bytes())

	if got := color.NRGBAModel.Convert(tinted.At(px, py)).(color.NRGBA); got != (color.NRGBA{R: 79, G: 165, B: 248, A: 255}) {
		t.Errorf("peak-gray pixel (%d,%d) = %+v, want the blue family hex rgb(79,165,248)", px, py, got)
	}
	if got := color.NRGBAModel.Convert(tinted.At(0, 0)).(color.NRGBA); got != (color.NRGBA{R: 15, G: 17, B: 23, A: 255}) {
		t.Errorf("background corner = %+v, want #0f1117 unchanged", got)
	}
}

func TestGeneratedIcon_blendDescriptorEscaped(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// %2B is exactly what handleManifest writes into the icon srcs.
	rec := getAsset(t, router, "/generated-icons/icon-192.png?c=1%2B3")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if bytes.Equal(rec.Body.Bytes(), readStock(t, "generated-icons/icon-192.png")) {
		t.Error("owned blend descriptor served stock bytes, want tinted")
	}
	if _, err := png.Decode(bytes.NewReader(rec.Body.Bytes())); err != nil {
		t.Errorf("tinted body is not a valid PNG: %v", err)
	}
}

func TestGeneratedIcon_invalidDescriptorsServeStock(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	stock := readStock(t, "generated-icons/icon-192.png")
	for _, q := range []string{"?c=zzz", "?c=7", "?c=2%2B5", "?c=", "?c=1%2B2%2B3"} {
		rec := getAsset(t, router, "/generated-icons/icon-192.png"+q)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want %d (treat-as-absent, never an error)", q, rec.Code, http.StatusOK)
		}
		if !bytes.Equal(rec.Body.Bytes(), stock) {
			t.Errorf("%s: body is not the stock bytes", q)
		}
	}
}

func TestGeneratedIcon_repeatRequestsIdentical(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	first := getAsset(t, router, "/generated-icons/icon-192.png?c=4")
	second := getAsset(t, router, "/generated-icons/icon-192.png?c=4") // cache hit
	if !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Error("repeat tinted request returned different bytes (cache should memoize)")
	}
}

// --- GET /generated-icons/favicon.svg ---

func TestFavicon_unsetAccentServesStock(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getAsset(t, router, "/generated-icons/favicon.svg")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("Content-Type = %q, want image/svg+xml", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", cc)
	}
	if !bytes.Equal(rec.Body.Bytes(), readStock(t, "generated-icons/favicon.svg")) {
		t.Error("unset-accent favicon body is not byte-identical to the stock file")
	}
}

func TestFavicon_ownedAccentTints(t *testing.T) {
	isolateSettings(t)
	pointSPAAtRealPublic(t)
	setInstanceColor(t, "4") // blue
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getAsset(t, router, "/generated-icons/favicon.svg")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "#4fa5f8") {
		t.Error("tinted favicon missing the blue family hex #4fa5f8 for the peak gray")
	}
	for _, gray := range []string{"#b4b4b4", "#2a2a2a", "#888888", "#737373", "#545454"} {
		if strings.Contains(body, gray) {
			t.Errorf("tinted favicon still contains grayscale fill %s", gray)
		}
	}
}
