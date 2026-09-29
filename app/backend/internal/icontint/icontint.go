// Package icontint colorizes the grayscale HexoKit logo assets with the
// per-instance accent color ("host color"), so the PWA Dock/Cmd-Tab icon and
// the tab favicon visually distinguish HexoKit instances. Go stdlib only
// (image, image/png, image/color) — the logo being grayscale makes the tint a
// pure luminance→accent ramp; sharp stays build-time-only.
package icontint

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"

	"rk/internal/validate"
)

// familyHexByValue maps every canonical color value that resolves to an owned
// hue family/shade to its default-dark hex: the LEGACY numeric descriptors and
// the family NAMES (both the normal-shade vocabulary — the frontend write seam
// stores normal picks as legacy, but names are valid stored values too), plus
// the "-dark"/"-light" shade variants (which have no legacy form and are
// stored as names verbatim — see themes.ts HUE_FAMILIES / SHADE_DARK_SUFFIX /
// SHADE_LIGHT_SUFFIX). A Dock icon is theme-independent, so the hexes are
// frozen from the default-dark palette rather than derived per active theme:
// each value is colorValueToHex(value, DEFAULT_DARK_THEME.palette) from
// app/frontend/src/themes.ts — the OKLCH owned-family rendering at the
// default-dark theme's mean L/C (L≈0.7059, C≈0.1470 over ansi[1..6]) in the
// family's own hue (dark shade at mean-L − 0.14, light shade at mean-L +
// 0.14 — the symmetric mirror), brought into the sRGB gamut by chroma
// reduction.
//
// Descriptors that validate but map to no owned family (e.g. "7", "2+5")
// deliberately resolve to nothing — mirroring the frontend's resolveFamily,
// which renders no accent for values outside the 10 owned families.
var familyHexByValue = map[string]string{
	"1": "#ee7871", "red": "#ee7871", "red-dark": "#bd4c48", "red-light": "#feb8b2", // hue 25
	"1+3": "#e58439", "orange": "#e58439", "orange-dark": "#b15c0e", "orange-light": "#febc8f", // hue 55
	"3": "#c19b22", "amber": "#c19b22", "amber-dark": "#907204", "amber-light": "#f2c74a", // hue 90
	"1+2": "#95ad33", "olive": "#95ad33", "olive-dark": "#6d8019", "olive-light": "#c0da64", // hue 120
	"2": "#51b96d", "green": "#51b96d", "green-dark": "#198d44", "green-light": "#80e798", // hue 150
	"6": "#00b9aa", "teal": "#00b9aa", "teal-dark": "#0f887e", "teal-light": "#16ebd9", // hue 185
	"4": "#4fa5f8", "blue": "#4fa5f8", "blue-dark": "#1d79c8", "blue-light": "#a7d1fd", // hue 250
	"1+4": "#a08ef5", "purple": "#a08ef5", "purple-dark": "#7763c5", "purple-light": "#cbc4ff", // hue 290
	"5": "#d37ccb", "magenta": "#d37ccb", "magenta-dark": "#a5519f", "magenta-light": "#feabf6", // hue 330
	"3+4": "#95a2b0", "slate": "#95a2b0", "slate-dark": "#6b7885", "slate-light": "#c1cedd", // hue 250, near-neutral chroma
}

// Resolve maps an instance-accent color-value descriptor to its owned-family
// default-dark hex. The descriptor is normalized via
// validate.NormalizeColorValue first (so "04" and " 1 + 3 " resolve like "4"
// and "1+3", and family names trim to their verbatim form). Returns the
// family/shade hex, the canonical descriptor (stable cache/URL key), and
// ok=false when the value is malformed or owned by no family.
func Resolve(descriptor string) (hex string, canonical string, ok bool) {
	normalized, valid := validate.NormalizeColorValue(descriptor)
	if !valid {
		return "", "", false
	}
	h, owned := familyHexByValue[normalized]
	if !owned {
		return "", "", false
	}
	return h, normalized, true
}

// Colorize ramp ("A — colorized logo"): each pixel's luminance picks a point
// on a black→accent ramp. Pixels at/below backgroundLumaCeil (the icon's
// #0f1117 background, luma ≈ 17) are left untouched so the background stays
// dark; brighter pixels render as the accent scaled by luma/peakLuma, so the
// logo's brightest gray #b4b4b4 (luma 180) maps to the accent hex itself and
// darker grays to proportionally darker accent.
const (
	backgroundLumaCeil = 24
	peakLuma           = 180
)

// rgb is an 8-bit sRGB triple (the accent color, parsed once per tint).
type rgb struct{ r, g, b uint8 }

// parseHex parses a "#rrggbb" hex color.
func parseHex(hex string) (rgb, error) {
	var c rgb
	if len(hex) != 7 || hex[0] != '#' {
		return c, fmt.Errorf("icontint: malformed hex color %q", hex)
	}
	if _, err := fmt.Sscanf(hex[1:], "%02x%02x%02x", &c.r, &c.g, &c.b); err != nil {
		return c, fmt.Errorf("icontint: malformed hex color %q", hex)
	}
	return c, nil
}

// luma returns the BT.601 luminance of an 8-bit sRGB triple, rounded.
func luma(r, g, b uint8) int {
	return (299*int(r) + 587*int(g) + 114*int(b) + 500) / 1000
}

// rampChannel scales one accent channel by y/peakLuma with round-to-nearest
// integer math (deterministic — no float rounding at .5 boundaries), clamped
// to 255 for the few anti-aliased pixels brighter than the peak gray.
func rampChannel(accent uint8, y int) uint8 {
	v := (int(accent)*y + peakLuma/2) / peakLuma
	if v > 255 {
		v = 255
	}
	return uint8(v)
}

// tintPixel applies the colorize ramp to one pixel: background-dark pixels
// pass through untouched; brighter pixels become the accent scaled by their
// luminance.
func tintPixel(r, g, b uint8, accent rgb) (uint8, uint8, uint8) {
	y := luma(r, g, b)
	if y <= backgroundLumaCeil {
		return r, g, b
	}
	return rampChannel(accent.r, y), rampChannel(accent.g, y), rampChannel(accent.b, y)
}

// TintPNG decodes a stock logo PNG, applies the colorize ramp per pixel
// (alpha preserved), and re-encodes it. Pure function of (stock, hex) — safe
// to memoize.
func TintPNG(stock []byte, hex string) ([]byte, error) {
	accent, err := parseHex(hex)
	if err != nil {
		return nil, err
	}
	src, err := png.Decode(bytes.NewReader(stock))
	if err != nil {
		return nil, fmt.Errorf("icontint: decode stock png: %w", err)
	}
	bounds := src.Bounds()
	dst := image.NewNRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			px := color.NRGBAModel.Convert(src.At(x, y)).(color.NRGBA)
			px.R, px.G, px.B = tintPixel(px.R, px.G, px.B, accent)
			dst.SetNRGBA(x, y, px)
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, fmt.Errorf("icontint: encode tinted png: %w", err)
	}
	return out.Bytes(), nil
}

// logoGrayFills are the five grayscale fill values of the canonical logo SVG
// (app/frontend/public/icon.svg / generated-icons/favicon.svg), lowercase as
// written in the file.
var logoGrayFills = []string{"#b4b4b4", "#2a2a2a", "#888888", "#737373", "#545454"}

// TintSVG replaces the logo SVG's five grayscale fills with the colorize-ramp
// hexes the PNG treatment produces for the same luminance values, so browser
// tabs match the Dock. Pure string substitution on the SVG text; pure function
// of (stock, hex) — safe to memoize.
func TintSVG(stock []byte, hex string) ([]byte, error) {
	accent, err := parseHex(hex)
	if err != nil {
		return nil, err
	}
	text := string(stock)
	for _, gray := range logoGrayFills {
		g, err := parseHex(gray)
		if err != nil { // unreachable: logoGrayFills are literals
			return nil, err
		}
		r, gg, b := tintPixel(g.r, g.g, g.b, accent)
		text = strings.ReplaceAll(text, gray, fmt.Sprintf("#%02x%02x%02x", r, gg, b))
	}
	return []byte(text), nil
}
