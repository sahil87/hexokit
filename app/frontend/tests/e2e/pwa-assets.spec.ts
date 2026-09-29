import { test, expect } from "@playwright/test";

// PWA identity assets (`/manifest.json`, `/generated-icons/*`) served
// dynamically by the Go backend through the Vite dev proxy. All assertions
// are tint-agnostic: the box running the e2e suite may or may not have an
// instance accent in its real ~/.config/hexokit/config.yaml, so the tests pin
// the serving pipeline (proxy → Go handler → valid asset), never the tint
// state (the tint itself is golden-pixel tested in Go: api/pwa_test.go,
// internal/icontint).
//
// Shared setup: none beyond the standard externally-managed e2e dev server
// (Vite proxying to the Go backend) — the tests use Playwright's `request`
// fixture against baseURL; no page or tmux state.
test.describe("PWA assets", () => {
  /**
   * Proves: /manifest.json reaches the Go dynamic handler (not Vite's
   * public-dir static copy) and still parses as the HexoKit manifest. The
   * discriminator is the application/manifest+json content-type — only the
   * Go handler sets it; Vite would serve the static file as
   * application/json.
   *
   * Steps:
   * 1. request.get("/manifest.json").
   * 2. Assert status 200 and content-type contains
   *    application/manifest+json.
   * 3. Parse the JSON; assert `name` is `HexoKit` and there are exactly 3
   *    icons.
   * 4. Assert each icon `src` matches /generated-icons/icon-*.png with an
   *    optional ?c=<descriptor> cache-buster (present only when the box has
   *    an accent configured — tint-agnostic).
   */
  test("manifest is served by the Go handler through the dev proxy", async ({
    request,
  }) => {
    const res = await request.get("/manifest.json");
    expect(res.status()).toBe(200);
    // The Go handler answers application/manifest+json; Vite's public-dir
    // static serving would answer application/json — so this content-type is
    // the proof the request traversed the proxy to the dynamic handler.
    expect(res.headers()["content-type"]).toContain(
      "application/manifest+json",
    );
    const manifest = await res.json();
    expect(manifest.name).toBe("HexoKit");
    expect(manifest.icons).toHaveLength(3);
    for (const icon of manifest.icons) {
      // Tint-agnostic: with an accent set the srcs carry ?c=<descriptor>.
      expect(icon.src).toMatch(/^\/generated-icons\/icon-.*\.png(\?c=.*)?$/);
    }
  });

  /**
   * Proves: the proxied /generated-icons/icon-192.png route returns a real
   * PNG (magic-byte check) with the right content-type, tinted or not.
   *
   * Steps:
   * 1. request.get("/generated-icons/icon-192.png").
   * 2. Assert status 200 and content-type contains image/png.
   * 3. Assert the first 8 body bytes are the PNG signature
   *    89 50 4E 47 0D 0A 1A 0A.
   */
  test("dock icon PNG is served intact", async ({ request }) => {
    const res = await request.get("/generated-icons/icon-192.png");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    const body = await res.body();
    // PNG magic bytes — the asset decodes as a real PNG regardless of tint.
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  /**
   * Proves: the proxied /generated-icons/favicon.svg route is answered by the
   * Go favicon handler — it returns SVG content and the Cache-Control:
   * no-cache header that handler sets (the favicon tint resolves from
   * settings per request, so tabs must revalidate to pick up accent changes).
   *
   * Steps:
   * 1. request.get("/generated-icons/favicon.svg").
   * 2. Assert status 200 and content-type contains image/svg+xml.
   * 3. Assert `cache-control` contains `no-cache`.
   * 4. Assert the body contains `<svg`.
   */
  test("favicon SVG is served with revalidation caching", async ({
    request,
  }) => {
    const res = await request.get("/generated-icons/favicon.svg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/svg+xml");
    // no-cache is set by the Go favicon handler (the tint resolves from
    // settings per request, so tabs must revalidate) — further proof the
    // dynamic handler answered.
    expect(res.headers()["cache-control"]).toContain("no-cache");
    expect(await res.text()).toContain("<svg");
  });
});
