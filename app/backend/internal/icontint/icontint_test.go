package icontint

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

// blueHex is the owned blue family's default-dark hex (descriptor "4"),
// rgb(79, 165, 248).
const blueHex = "#4fa5f8"

func TestResolve_ownedDescriptors(t *testing.T) {
	cases := []struct {
		in            string
		wantHex       string
		wantCanonical string
	}{
		{"4", "#4fa5f8", "4"},
		{"04", "#4fa5f8", "4"},        // normalized leading zero
		{"1+3", "#e58439", "1+3"},     // owned blend (orange)
		{" 1 + 3 ", "#e58439", "1+3"}, // whitespace tolerated, normalized
		{"1", "#ee7871", "1"},         // red
		{"3+4", "#95a2b0", "3+4"},     // slate (near-neutral)
		// Family-name vocabulary: a name resolves to the same hex as its
		// legacy descriptor; "-dark"/"-light" variants (no legacy form) get
		// their own frozen hexes (mean-L ∓ 0.14, same hue/chroma,
		// gamut-reduced).
		{"blue", "#4fa5f8", "blue"},
		{"blue-dark", "#1d79c8", "blue-dark"},
		{"blue-light", "#a7d1fd", "blue-light"},
		{" slate-dark ", "#6b7885", "slate-dark"}, // trimmed to verbatim form
		{" slate-light ", "#c1cedd", "slate-light"},
		{"orange", "#e58439", "orange"},
		{"orange-light", "#febc8f", "orange-light"},
		{"4+5", "#7d9afb", "4+5"},
		{"violet-dark", "#556ecc", "violet-dark"},
	}
	for _, tc := range cases {
		hex, canonical, ok := Resolve(tc.in)
		if !ok {
			t.Errorf("Resolve(%q) ok = false, want true", tc.in)
			continue
		}
		if hex != tc.wantHex || canonical != tc.wantCanonical {
			t.Errorf("Resolve(%q) = (%q, %q), want (%q, %q)", tc.in, hex, canonical, tc.wantHex, tc.wantCanonical)
		}
	}
}

func TestResolve_unownedAndMalformed(t *testing.T) {
	// "7" and "2+5" validate per ValidateColorValue but map to no owned
	// family — they must resolve to nothing (the frontend renders no accent
	// for them, so the icon stays stock).
	for _, in := range []string{"7", "0", "15", "2+5", "zzz", "", "1+2+3", "-1", "16", "+", "1+", "Blue", "bluish", "bluish-light", "blue-lite"} {
		if _, _, ok := Resolve(in); ok {
			t.Errorf("Resolve(%q) ok = true, want false", in)
		}
	}
}

func TestResolve_coversAllFamiliesAndShades(t *testing.T) {
	legacy := []string{"1", "1+3", "3", "1+2", "2", "6", "4", "4+5", "1+4", "5", "3+4"}
	names := []string{"red", "orange", "amber", "olive", "green", "teal", "blue", "violet", "purple", "magenta", "slate"}
	// 11 legacy + 11 names + 11 dark variants + 11 light variants.
	if want := len(legacy) + 3*len(names); len(familyHexByValue) != want {
		t.Fatalf("familyHexByValue has %d entries, want %d", len(familyHexByValue), want)
	}
	for _, d := range legacy {
		if _, _, ok := Resolve(d); !ok {
			t.Errorf("Resolve(%q) ok = false, want true (owned family)", d)
		}
	}
	for i, n := range names {
		hexName, _, okName := Resolve(n)
		hexLegacy, _, okLegacy := Resolve(legacy[i])
		if !okName || !okLegacy || hexName != hexLegacy {
			t.Errorf("Resolve(%q) = (%q, %v), want same hex as legacy %q (%q, %v)", n, hexName, okName, legacy[i], hexLegacy, okLegacy)
		}
		hexDark, _, okDark := Resolve(n + "-dark")
		if !okDark {
			t.Errorf("Resolve(%q) ok = false, want true (dark shade)", n+"-dark")
		} else if hexDark == hexName {
			t.Errorf("Resolve(%q) = %q, want a hex distinct from the normal shade", n+"-dark", hexDark)
		}
		hexLight, _, okLight := Resolve(n + "-light")
		if !okLight {
			t.Errorf("Resolve(%q) ok = false, want true (light shade)", n+"-light")
		} else if hexLight == hexName || hexLight == hexDark {
			t.Errorf("Resolve(%q) = %q, want a hex distinct from the normal and dark shades", n+"-light", hexLight)
		}
	}
}

// encodePNG builds a PNG from the given NRGBA pixels laid out in one row.
func encodePNG(t *testing.T, pixels []color.NRGBA) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, len(pixels), 1))
	for x, px := range pixels {
		img.SetNRGBA(x, 0, px)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return buf.Bytes()
}

func decodeNRGBA(t *testing.T, data []byte) *image.NRGBA {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode tinted png: %v", err)
	}
	out := image.NewNRGBA(img.Bounds())
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			out.SetNRGBA(x, y, color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA))
		}
	}
	return out
}

func TestTintPNG_goldenPixels(t *testing.T) {
	// Fixture: background pixel, peak gray, mid gray, dark gray with partial
	// alpha (alpha must survive the tint).
	stock := encodePNG(t, []color.NRGBA{
		{R: 15, G: 17, B: 23, A: 255},    // #0f1117 background (luma 17)
		{R: 180, G: 180, B: 180, A: 255}, // #b4b4b4 — the logo's brightest gray
		{R: 136, G: 136, B: 136, A: 255}, // #888888 mid gray
		{R: 84, G: 84, B: 84, A: 128},    // #545454 with partial alpha
	})

	tinted, err := TintPNG(stock, blueHex)
	if err != nil {
		t.Fatalf("TintPNG: %v", err)
	}
	img := decodeNRGBA(t, tinted)

	cases := []struct {
		x    int
		want color.NRGBA
		desc string
	}{
		// Background (luma 17 ≤ ceiling 24): untouched.
		{0, color.NRGBA{R: 15, G: 17, B: 23, A: 255}, "background unchanged"},
		// Peak gray (luma 180): exactly the accent.
		{1, color.NRGBA{R: 79, G: 165, B: 248, A: 255}, "#b4b4b4 → accent"},
		// Mid gray (luma 136): accent × 136/180 with integer rounding —
		// (79·136+90)/180=60, (165·136+90)/180=125, (248·136+90)/180=187.
		{2, color.NRGBA{R: 60, G: 125, B: 187, A: 255}, "#888888 → scaled accent"},
		// Dark gray (luma 84): (79·84+90)/180=37, (165·84+90)/180=77,
		// (248·84+90)/180=116; alpha 128 preserved.
		{3, color.NRGBA{R: 37, G: 77, B: 116, A: 128}, "#545454 → scaled accent, alpha preserved"},
	}
	for _, tc := range cases {
		if got := img.NRGBAAt(tc.x, 0); got != tc.want {
			t.Errorf("%s: pixel %d = %+v, want %+v", tc.desc, tc.x, got, tc.want)
		}
	}
}

func TestTintPNG_isPureAndDeterministic(t *testing.T) {
	stock := encodePNG(t, []color.NRGBA{{R: 180, G: 180, B: 180, A: 255}})
	a, err := TintPNG(stock, blueHex)
	if err != nil {
		t.Fatalf("TintPNG: %v", err)
	}
	b, err := TintPNG(stock, blueHex)
	if err != nil {
		t.Fatalf("TintPNG: %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Error("TintPNG is not deterministic for identical inputs")
	}
}

func TestTintPNG_errors(t *testing.T) {
	if _, err := TintPNG([]byte("not a png"), blueHex); err == nil {
		t.Error("TintPNG(garbage) err = nil, want error")
	}
	stock := encodePNG(t, []color.NRGBA{{R: 180, G: 180, B: 180, A: 255}})
	for _, hex := range []string{"", "4fa5f8", "#4fa5", "#zzzzzz"} {
		if _, err := TintPNG(stock, hex); err == nil {
			t.Errorf("TintPNG(hex=%q) err = nil, want error", hex)
		}
	}
}

func TestTintSVG_replacesAllGrayFills(t *testing.T) {
	svg := []byte(`<svg><polygon fill="#b4b4b4"/><polygon fill="#2a2a2a"/>` +
		`<polygon fill="#888888"/><polygon fill="#737373"/><polygon fill="#545454"/></svg>`)

	tinted, err := TintSVG(svg, blueHex)
	if err != nil {
		t.Fatalf("TintSVG: %v", err)
	}
	out := string(tinted)

	for _, gray := range []string{"#b4b4b4", "#2a2a2a", "#888888", "#737373", "#545454"} {
		if strings.Contains(out, gray) {
			t.Errorf("tinted SVG still contains grayscale fill %s", gray)
		}
	}
	// The brightest fill (#b4b4b4, luma 180) maps to the accent hex itself;
	// spot-check one scaled fill (#545454, luma 84 → #254d74).
	if !strings.Contains(out, blueHex) {
		t.Errorf("tinted SVG missing the accent hex %s for the peak gray", blueHex)
	}
	if !strings.Contains(out, "#254d74") {
		t.Error("tinted SVG missing the scaled ramp hex #254d74 for #545454")
	}
}

func TestTintSVG_badHex(t *testing.T) {
	if _, err := TintSVG([]byte("<svg/>"), "nope"); err == nil {
		t.Error("TintSVG(bad hex) err = nil, want error")
	}
}
