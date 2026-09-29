import { describe, it, expect, beforeEach } from "vitest";
import { readWebCapture, writeWebCapture } from "./web-capture";

describe("web capture latch", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to released", () => {
    expect(readWebCapture()).toBe(false);
  });

  it("round-trips on and off, removing the key when released", () => {
    writeWebCapture(true);
    expect(readWebCapture()).toBe(true);
    expect(localStorage.getItem("rk-web-capture")).toBe("1");
    writeWebCapture(false);
    expect(readWebCapture()).toBe(false);
    expect(localStorage.getItem("rk-web-capture")).toBeNull();
  });

  it("is independent of the gui capture latch", () => {
    localStorage.setItem("rk-gui-capture", "1");
    expect(readWebCapture()).toBe(false);
  });
});
