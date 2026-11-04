import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBrowserTitle } from "./use-browser-title";

describe("useBrowserTitle", () => {
  beforeEach(() => {
    document.title = "HexoKit";
  });

  it("sets dashboard title with hostname", () => {
    renderHook(() => useBrowserTitle(undefined, undefined, "arbaaz-dev-01"));
    expect(document.title).toBe("HexoKit \u2014 arbaaz-dev-01");
  });

  it("sets dashboard title without hostname", () => {
    renderHook(() => useBrowserTitle(undefined, undefined, ""));
    expect(document.title).toBe("HexoKit");
  });

  it("sets terminal title with hostname", () => {
    renderHook(() => useBrowserTitle("myproject", "0", "arbaaz-dev-01"));
    expect(document.title).toBe("myproject/0 \u2014 arbaaz-dev-01");
  });

  it("sets terminal title without hostname", () => {
    renderHook(() => useBrowserTitle("myproject", "0", ""));
    expect(document.title).toBe("myproject/0");
  });

  it("updates title on navigation from dashboard to terminal", () => {
    const { rerender } = renderHook(
      ({ session, window, hostname }) => useBrowserTitle(session, window, hostname),
      { initialProps: { session: undefined as string | undefined, window: undefined as string | undefined, hostname: "arbaaz-dev-01" } },
    );
    expect(document.title).toBe("HexoKit \u2014 arbaaz-dev-01");

    rerender({ session: "agent-work", window: "2", hostname: "arbaaz-dev-01" });
    expect(document.title).toBe("agent-work/2 \u2014 arbaaz-dev-01");
  });
});
