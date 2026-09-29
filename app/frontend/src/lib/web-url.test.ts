import { describe, it, expect } from "vitest";
import {
  classifyAddress,
  displayForm,
  isAllowedUrl,
  normalizeAddressInput,
  proxyPortOf,
  routeAddressSubmit,
  toNativeSrc,
  toProxySrc,
  toWebAddTarget,
  webTabTitle,
} from "./web-url";

describe("classifyAddress (260819-v6y4 R3)", () => {
  it("classifies the intake's examples", () => {
    expect(classifyAddress("/present/@320/tmux-version-floor.html?server=runKit&v=1")).toBe("present");
    expect(classifyAddress("/present/runKit/3f9a2c8e1b77/report.html?v=1")).toBe("present");
    expect(classifyAddress("/proxy/3000/board/runKit")).toBe("proxy");
    expect(classifyAddress("http://localhost:8080/docs")).toBe("proxy");
    expect(classifyAddress("http://127.0.0.1:5173")).toBe("proxy");
    expect(classifyAddress("http://[::1]:5173/x")).toBe("proxy");
    expect(classifyAddress("https://shll.ai/rk/skill")).toBe("external");
    expect(classifyAddress("/board/runKit")).toBe("relative");
  });

  it("degrades unrecognized input to relative without throwing", () => {
    expect(classifyAddress("javascript:alert(1)")).toBe("relative");
    expect(classifyAddress("not a url")).toBe("relative");
    expect(classifyAddress("")).toBe("relative");
  });

  it("treats portless http loopback URLs as proxied port 80 (the rk present rule)", () => {
    expect(classifyAddress("http://localhost/")).toBe("proxy");
    expect(classifyAddress("http://localhost:80/x")).toBe("proxy");
    expect(classifyAddress("http://127.0.0.1/x")).toBe("proxy");
    expect(classifyAddress("http://[::1]/x")).toBe("proxy");
  });

  it("keeps portless https loopback URLs external", () => {
    expect(classifyAddress("https://localhost/")).toBe("external");
  });
});

describe("displayForm (260819-v6y4 R3)", () => {
  it("present: the file basename with plumbing params hidden (both forms)", () => {
    expect(displayForm("/present/@320/tmux-version-floor.html?server=runKit&v=1755600000")).toBe(
      "tmux-version-floor.html",
    );
    expect(displayForm("/present/@320/dir/index.html?server=a")).toBe("index.html");
    // NEW content-keyed form: server + hash segments are plumbing too.
    expect(displayForm("/present/runKit/3f9a2c8e1b77/report.html?v=1")).toBe("report.html");
    expect(displayForm("/present/runKit/3f9a2c8e1b77/dir/index.html?v=1")).toBe("index.html");
    // A NEW-form directory present (empty path tail) shows the index.html it
    // serves — the raw hash segment never displays.
    expect(displayForm("/present/runKit/3f9a2c8e1b77/?v=1")).toBe("index.html");
    // Legacy directory present behaves the same (windowId-only remainder).
    expect(displayForm("/present/@5/?server=a")).toBe("/present/@5/?server=a");
  });

  it("present: a page's own query params survive plumbing removal", () => {
    expect(displayForm("/present/@320/report.html?server=runKit&v=1&tab=perf")).toBe(
      "report.html?tab=perf",
    );
    expect(displayForm("/present/@320/doc.html?server=a&v=1#section")).toBe("doc.html#section");
  });

  it("present: the viewer shell's raw param is plumbing too (both forms)", () => {
    expect(displayForm("/present/runKit/3f9a2c8e1b77/notes.md?raw=1&v=2")).toBe("notes.md");
    expect(displayForm("/present/@320/notes.md?server=runKit&raw=1")).toBe("notes.md");
  });

  it("proxy: localhost:{port}{path} — the /proxy/ plumbing never shows", () => {
    expect(displayForm("/proxy/3000/board/runKit")).toBe("localhost:3000/board/runKit");
    expect(displayForm("/proxy/3000/")).toBe("localhost:3000/");
    expect(displayForm("/proxy/3000")).toBe("localhost:3000/");
    expect(displayForm("http://localhost:8080/docs?x=1")).toBe("localhost:8080/docs?x=1");
    expect(displayForm("http://127.0.0.1:8080/docs")).toBe("localhost:8080/docs");
    expect(displayForm("http://localhost/x?y=1")).toBe("localhost:80/x?y=1");
    // A literal loopback URL (the native engine's direct/proxy load target)
    // renders the same localhost form as the /proxy/ plumbing.
    expect(displayForm("http://localhost:6000/x")).toBe("localhost:6000/x");
  });

  it("external: host + path, scheme omitted", () => {
    expect(displayForm("https://shll.ai/rk/skill")).toBe("shll.ai/rk/skill");
    expect(displayForm("https://github.com/sahil87/run-kit")).toBe("github.com/sahil87/run-kit");
  });

  it("relative: the raw path", () => {
    expect(displayForm("/board/runKit")).toBe("/board/runKit");
  });

  it("never throws on unparseable input — degrades to the raw string", () => {
    expect(displayForm("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(displayForm("not a url")).toBe("not a url");
    expect(displayForm("")).toBe("");
    expect(displayForm("/present/")).toBe("/present/");
  });
});

describe("webTabTitle", () => {
  it("derives the strip label per address kind", () => {
    expect(webTabTitle("/present/@3/1/report.html?v=17&server=x")).toBe("report.html");
    expect(webTabTitle("/proxy/3000/docs/api?q=1")).toBe("localhost:3000/docs/api");
    expect(webTabTitle("http://localhost:5173/?x=1")).toBe("localhost:5173/");
    expect(webTabTitle("http://localhost/x?y=1")).toBe("localhost:80/x");
    expect(webTabTitle("https://docs.example.com/a/b#c")).toBe("docs.example.com");
    expect(webTabTitle("/foo")).toBe("/foo");
    expect(webTabTitle("")).toBe("");
  });

  it("treats whitespace-only input as empty and never throws", () => {
    expect(webTabTitle("   ")).toBe("");
    expect(webTabTitle("not a url")).toBe("not a url");
  });

  it("derives the NEW-form label with server+hash plumbing hidden", () => {
    expect(webTabTitle("/present/runKit/3f9a2c8e1b77/report.html?v=1")).toBe("report.html");
    expect(webTabTitle("/present/s/a1b2c3d4e5/dir/index.html?v=2")).toBe("index.html");
    // Directory present (empty path tail): the hash stays out of the label —
    // the served index.html is the name.
    expect(webTabTitle("/present/runKit/3f9a2c8e1b77/?v=1")).toBe("index.html");
  });
});

describe("proxyPortOf", () => {
  it("reads the port from either proxy form", () => {
    expect(proxyPortOf("/proxy/8080/")).toBe(8080);
    expect(proxyPortOf("http://localhost:8080/x")).toBe(8080);
  });

  it("returns null for non-proxy addresses", () => {
    expect(proxyPortOf("/present/@320/f.html")).toBeNull();
    expect(proxyPortOf("https://shll.ai/")).toBeNull();
    expect(proxyPortOf("https://localhost/")).toBeNull();
  });

  it("resolves portless and :80 http loopback URLs to port 80", () => {
    expect(proxyPortOf("http://localhost/")).toBe(80);
    expect(proxyPortOf("http://localhost:80/x")).toBe(80);
  });
});

describe("normalizeAddressInput (260819-v6y4 R4)", () => {
  it("maps bare loopback host:port to the proxy path", () => {
    expect(normalizeAddressInput("localhost:5173")).toBe("/proxy/5173/");
    expect(normalizeAddressInput("127.0.0.1:3000")).toBe("/proxy/3000/");
    expect(normalizeAddressInput("localhost:3000/board/runKit")).toBe("/proxy/3000/board/runKit");
    expect(normalizeAddressInput("localhost:3000/board?x=1")).toBe("/proxy/3000/board?x=1");
  });

  it("prefixes a bare domain with https://", () => {
    expect(normalizeAddressInput("example.com")).toBe("https://example.com");
    expect(normalizeAddressInput("shll.ai/rk/skill")).toBe("https://shll.ai/rk/skill");
    expect(normalizeAddressInput("example.com:8080/x")).toBe("https://example.com:8080/x");
  });

  it("passes already-valid values through unchanged", () => {
    expect(normalizeAddressInput("https://example.com/x")).toBe("https://example.com/x");
    expect(normalizeAddressInput("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeAddressInput("/proxy/3000/")).toBe("/proxy/3000/");
    expect(normalizeAddressInput("/present/@320/f.html?server=a&v=1")).toBe(
      "/present/@320/f.html?server=a&v=1",
    );
  });

  it("passes invalid values through for isAllowedUrl to reject", () => {
    expect(normalizeAddressInput("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(normalizeAddressInput("localhost")).toBe("localhost");
    expect(normalizeAddressInput("  https://example.com  ")).toBe("https://example.com");
  });
});

describe("isAllowedUrl (frontend mirror of R1)", () => {
  it("accepts absolute http(s) with a host and root-relative paths", () => {
    expect(isAllowedUrl("https://example.com")).toBe(true);
    expect(isAllowedUrl("http://localhost:3000/x")).toBe(true);
    expect(isAllowedUrl("/proxy/3000/")).toBe(true);
    expect(isAllowedUrl("/")).toBe(true);
  });

  it("rejects every other form", () => {
    expect(isAllowedUrl("")).toBe(false);
    expect(isAllowedUrl("   ")).toBe(false);
    expect(isAllowedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedUrl("data:text/html,<p>x</p>")).toBe(false);
    expect(isAllowedUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedUrl("//evil.com/x")).toBe(false);
    expect(isAllowedUrl("ftp://example.com")).toBe(false);
    expect(isAllowedUrl("example.com")).toBe(false);
    expect(isAllowedUrl("https://")).toBe(false);
  });
});

describe("routeAddressSubmit (submit ladder)", () => {
  it("lane 1: absolute http(s) URLs and root-relative paths write, untouched", () => {
    expect(routeAddressSubmit("https://example.com/x")).toEqual({
      kind: "write",
      url: "https://example.com/x",
    });
    expect(routeAddressSubmit("http://localhost:3000/x")).toEqual({
      kind: "write",
      url: "http://localhost:3000/x",
    });
    expect(routeAddressSubmit("/present/runKit/3f9a2c8e1b77/report.html")).toEqual({
      kind: "write",
      url: "/present/runKit/3f9a2c8e1b77/report.html",
    });
    expect(routeAddressSubmit("/proxy/3000/")).toEqual({ kind: "write", url: "/proxy/3000/" });
  });

  it("lane 2: bare loopback host:port keeps today's /proxy rewrite", () => {
    expect(routeAddressSubmit("localhost:5173")).toEqual({ kind: "write", url: "/proxy/5173/" });
    expect(routeAddressSubmit("127.0.0.1:3000")).toEqual({ kind: "write", url: "/proxy/3000/" });
    expect(routeAddressSubmit("localhost:3000/board?x=1")).toEqual({
      kind: "write",
      url: "/proxy/3000/board?x=1",
    });
  });

  it("lane 2: bare :NNNN becomes a backend port target", () => {
    expect(routeAddressSubmit(":3000")).toEqual({ kind: "add", target: ":3000" });
    expect(routeAddressSubmit(":80")).toEqual({ kind: "add", target: ":80" });
  });

  it("lane 3: slash-bearing and ./-leading input is a backend path target, no fallback", () => {
    expect(routeAddressSubmit("docs/wiki/foo.html")).toEqual({
      kind: "add",
      target: "docs/wiki/foo.html",
    });
    expect(routeAddressSubmit("./report.html")).toEqual({ kind: "add", target: "./report.html" });
    expect(routeAddressSubmit("./x")).toEqual({ kind: "add", target: "./x" });
    // Slash-bearing input is ALWAYS a path — a bare domain with a path needs
    // its scheme typed (intake assumption 3).
    expect(routeAddressSubmit("example.com/path")).toEqual({
      kind: "add",
      target: "example.com/path",
    });
  });

  it("lane 4: a dotted single segment stat-decides with an https fallback", () => {
    expect(routeAddressSubmit("README.md")).toEqual({
      kind: "add",
      target: "README.md",
      fallback: "https://README.md",
    });
    expect(routeAddressSubmit("example.com")).toEqual({
      kind: "add",
      target: "example.com",
      fallback: "https://example.com",
    });
    expect(routeAddressSubmit("example.com:8080")).toEqual({
      kind: "add",
      target: "example.com:8080",
      fallback: "https://example.com:8080",
    });
  });

  it("lane 5: bare words, non-http(s) schemes, and degenerate input reject", () => {
    expect(routeAddressSubmit("")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("   ")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("foo")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("localhost")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("ftp://example.com/x")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("mailto:a@b.com")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("javascript:alert(1)")).toEqual({ kind: "reject" });
    // Slash-bearing scheme forms WITHOUT `//` must not reach the path lane.
    expect(routeAddressSubmit("file:/etc/passwd")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("mailto:user/docs")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("javascript:foo/bar")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("ftp:folder/file")).toEqual({ kind: "reject" });
    // Digit-leading scheme payloads are still schemes, not domain:port — only
    // the dotted-host `host.tld:port` shape is exempt from the scheme reject.
    expect(routeAddressSubmit("file:1/etc/passwd")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("mailto:123/docs")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("ftp:21/folder")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("javascript:1/x")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("//evil.com/x")).toEqual({ kind: "reject" });
    expect(routeAddressSubmit("https://")).toEqual({ kind: "reject" });
  });

  it("regression: every today-passing input keeps its exact write value", () => {
    // Scheme-bearing, root-relative, and loopback rows mirror the
    // normalizeAddressInput/isAllowedUrl suites above; the bare-domain form
    // reaches the same https:// value through the lane-4 fallback.
    expect(routeAddressSubmit("  https://example.com  ")).toEqual({
      kind: "write",
      url: "https://example.com",
    });
    const domain = routeAddressSubmit("shll.ai/rk/skill");
    expect(domain.kind).toBe("add"); // slash-bearing: now a path target by design
    const single = routeAddressSubmit("shll.ai");
    expect(single).toEqual({ kind: "add", target: "shll.ai", fallback: "https://shll.ai" });
  });
});

describe("toProxySrc", () => {
  it("maps absolute loopback URLs onto /proxy/{port}", () => {
    expect(toProxySrc("http://localhost:8080/docs")).toBe("/proxy/8080/docs");
    expect(toProxySrc("http://127.0.0.1:8080/docs?a=1")).toBe("/proxy/8080/docs?a=1");
    expect(toProxySrc("http://localhost:8080")).toBe("/proxy/8080/");
  });

  it("maps portless http loopback URLs onto /proxy/80", () => {
    expect(toProxySrc("http://localhost/")).toBe("/proxy/80/");
    expect(toProxySrc("http://localhost")).toBe("/proxy/80/");
    expect(toProxySrc("http://127.0.0.1/x?a=1")).toBe("/proxy/80/x?a=1");
    expect(toProxySrc("http://localhost:80/x")).toBe("/proxy/80/x");
  });

  it("passes everything else through unchanged", () => {
    expect(toProxySrc("/proxy/8080/docs")).toBe("/proxy/8080/docs");
    expect(toProxySrc("https://shll.ai/")).toBe("https://shll.ai/");
    expect(toProxySrc("https://localhost/")).toBe("https://localhost/");
  });
});

describe("toWebAddTarget", () => {
  it("re-expresses a relative /proxy/{port} address as the absolute loopback URL", () => {
    expect(toWebAddTarget("/proxy/3003/")).toBe("http://localhost:3003/");
    expect(toWebAddTarget("/proxy/3003/docs")).toBe("http://localhost:3003/docs");
    expect(toWebAddTarget("/proxy/3003/docs?x=1")).toBe("http://localhost:3003/docs?x=1");
    expect(toWebAddTarget("/proxy/3003")).toBe("http://localhost:3003/");
  });

  it("passes every non-proxy-path address through unchanged (both present forms)", () => {
    expect(toWebAddTarget("http://localhost:3003/docs")).toBe("http://localhost:3003/docs");
    expect(toWebAddTarget("https://shll.ai/")).toBe("https://shll.ai/");
    expect(toWebAddTarget("/present/@3/1/report.html?v=1")).toBe("/present/@3/1/report.html?v=1");
    expect(toWebAddTarget("/present/runKit/3f9a2c8e1b77/report.html?v=1")).toBe(
      "/present/runKit/3f9a2c8e1b77/report.html?v=1",
    );
    expect(toWebAddTarget("/foo")).toBe("/foo");
  });
});

describe("toNativeSrc", () => {
  // The address-kind matrix runs against all three modes: proxy path, proxy
  // root, absolute loopback, external, present, and plain relative.
  it("direct/proxy: a stored /proxy/{port} slot maps to the literal loopback URL", () => {
    for (const mode of ["direct", "proxy"] as const) {
      expect(toNativeSrc("/proxy/6000/assets/x.js", mode)).toBe(
        "http://localhost:6000/assets/x.js",
      );
      expect(toNativeSrc("/proxy/6000/docs?x=1", mode)).toBe("http://localhost:6000/docs?x=1");
      // The root form gains its trailing slash.
      expect(toNativeSrc("/proxy/6000", mode)).toBe("http://localhost:6000/");
      expect(toNativeSrc("/proxy/6000/", mode)).toBe("http://localhost:6000/");
    }
  });

  it("direct/proxy: every other address kind passes through unchanged", () => {
    for (const mode of ["direct", "proxy"] as const) {
      expect(toNativeSrc("http://localhost:6000/x", mode)).toBe("http://localhost:6000/x");
      expect(toNativeSrc("http://127.0.0.1:6000/x?a=1", mode)).toBe("http://127.0.0.1:6000/x?a=1");
      expect(toNativeSrc("https://shll.ai/rk/skill", mode)).toBe("https://shll.ai/rk/skill");
      expect(toNativeSrc("/present/@320/report.html?server=a&v=1", mode)).toBe(
        "/present/@320/report.html?server=a&v=1",
      );
      expect(toNativeSrc("/present/runKit/3f9a2c8e1b77/report.html?v=1", mode)).toBe(
        "/present/runKit/3f9a2c8e1b77/report.html?v=1",
      );
      expect(toNativeSrc("/board/runKit", mode)).toBe("/board/runKit");
    }
  });

  it("legacy: exactly toProxySrc for every address kind", () => {
    const cases = [
      "/proxy/6000/assets/x.js",
      "/proxy/6000",
      "http://localhost:6000/x",
      "https://shll.ai/rk/skill",
      "/present/runKit/3f9a2c8e1b77/report.html?v=1",
      "/board/runKit",
    ];
    for (const url of cases) {
      expect(toNativeSrc(url, "legacy")).toBe(toProxySrc(url));
    }
    // The loopback absolute case is the one where legacy differs from the
    // other modes: it rides the same-origin proxy path.
    expect(toNativeSrc("http://localhost:6000/x", "legacy")).toBe("/proxy/6000/x");
  });
});
