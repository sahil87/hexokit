import { describe, it, expect, beforeEach } from "vitest";
import {
  WEB_ZOOM_DEFAULT,
  WEB_ZOOM_LEVELS,
  readWebZoom,
  stepWebZoom,
  webZoomKeyFor,
  writeWebZoom,
} from "./web-zoom";

beforeEach(() => {
  localStorage.clear();
});

describe("stepWebZoom (R3)", () => {
  it("steps up and down the ladder from 100%", () => {
    expect(stepWebZoom(1, "in")).toBe(1.1);
    expect(stepWebZoom(1.1, "in")).toBe(1.25);
    expect(stepWebZoom(1, "out")).toBe(0.9);
    expect(stepWebZoom(0.9, "out")).toBe(0.8);
  });

  it("clamps at the ladder ends", () => {
    expect(stepWebZoom(3, "in")).toBe(3);
    expect(stepWebZoom(0.5, "out")).toBe(0.5);
  });

  it("snaps an off-ladder value to the nearest level, then steps", () => {
    expect(stepWebZoom(1.05, "in")).toBe(1.1);
    expect(stepWebZoom(1.05, "out")).toBe(0.9);
    expect(stepWebZoom(1.2, "in")).toBe(1.5);
  });

  it("covers the full ladder in both directions", () => {
    let level: number = WEB_ZOOM_DEFAULT;
    for (let i = 0; i < WEB_ZOOM_LEVELS.length; i++) level = stepWebZoom(level, "in");
    expect(level).toBe(WEB_ZOOM_LEVELS[WEB_ZOOM_LEVELS.length - 1]);
    for (let i = 0; i < WEB_ZOOM_LEVELS.length; i++) level = stepWebZoom(level, "out");
    expect(level).toBe(WEB_ZOOM_LEVELS[0]);
  });
});

describe("webZoomKeyFor (R3)", () => {
  it("external → the URL's origin", () => {
    expect(webZoomKeyFor("https://example.com/docs/page")).toBe("https://example.com");
    expect(webZoomKeyFor("http://shll.ai:8443/x?y=1")).toBe("http://shll.ai:8443");
  });

  it("proxy/loopback → proxy:{port}", () => {
    expect(webZoomKeyFor("/proxy/3000/board")).toBe("proxy:3000");
    expect(webZoomKeyFor("http://localhost:8080/docs")).toBe("proxy:8080");
    expect(webZoomKeyFor("http://127.0.0.1:5173")).toBe("proxy:5173");
  });

  it("present/relative → the single viewer-origin bucket", () => {
    expect(webZoomKeyFor("/present/@320/report.html?server=a&v=1")).toBe("self");
    expect(webZoomKeyFor("/board/runKit")).toBe("self");
  });

  it("degrades to self on unparseable input — never throws", () => {
    expect(webZoomKeyFor("")).toBe("self");
    expect(webZoomKeyFor("not a url")).toBe("self");
  });
});

describe("readWebZoom / writeWebZoom (R3)", () => {
  it("reads back a written level per bucket", () => {
    writeWebZoom("proxy:3000", 1.25);
    writeWebZoom("https://example.com", 0.75);
    expect(readWebZoom("proxy:3000")).toBe(1.25);
    expect(readWebZoom("https://example.com")).toBe(0.75);
    expect(readWebZoom("self")).toBe(1);
  });

  it("a level of 1 removes the entry — the map stays sparse", () => {
    writeWebZoom("proxy:3000", 1.25);
    writeWebZoom("proxy:3000", WEB_ZOOM_DEFAULT);
    expect(readWebZoom("proxy:3000")).toBe(1);
    expect(localStorage.getItem("hexokit-web-zoom")).toBe("{}");
  });

  it("an off-ladder stored float reads back AS-IS, clamped to bounds — never snapped (260824-iafo R2)", () => {
    localStorage.setItem("hexokit-web-zoom", JSON.stringify({ self: 1.04, "proxy:1": 1.37 }));
    expect(readWebZoom("self")).toBe(1.04);
    expect(readWebZoom("proxy:1")).toBe(1.37);
    // Out-of-bounds stored values clamp to the continuous range.
    localStorage.setItem("hexokit-web-zoom", JSON.stringify({ self: 5, "proxy:1": 0.1 }));
    expect(readWebZoom("self")).toBe(3);
    expect(readWebZoom("proxy:1")).toBe(0.5);
  });

  it("writeWebZoom rounds to 2 decimals; a round-to-1 value removes the entry (260824-iafo R2)", () => {
    writeWebZoom("self", 1.82211);
    expect(JSON.parse(localStorage.getItem("hexokit-web-zoom")!)).toEqual({ self: 1.82 });
    // Float noise around 1 must not survive as a stored entry.
    writeWebZoom("self", 0.9999);
    expect(localStorage.getItem("hexokit-web-zoom")).toBe("{}");
  });

  it("corrupt or missing storage reads as default — never throws", () => {
    localStorage.setItem("hexokit-web-zoom", "{not json");
    expect(readWebZoom("self")).toBe(1);
    localStorage.setItem("hexokit-web-zoom", JSON.stringify(["self", 1.5]));
    expect(readWebZoom("self")).toBe(1);
    localStorage.setItem("hexokit-web-zoom", JSON.stringify({ self: "big" }));
    expect(readWebZoom("self")).toBe(1);
  });
});
