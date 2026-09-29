import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  SIDEBAR_SECTIONS,
  useSidebarSectionVisible,
  type SidebarSection,
} from "./use-sidebar-sections";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderSection(section: SidebarSection) {
  return renderHook(() => useSidebarSectionVisible(section));
}

describe("SIDEBAR_SECTIONS", () => {
  it("lists exactly Boards · Server · Pane · Host in order (no Sessions)", () => {
    expect(SIDEBAR_SECTIONS.map((e) => e.section)).toEqual(["boards", "server", "pane", "host"]);
    expect(SIDEBAR_SECTIONS.map((e) => e.label)).toEqual(["Boards", "Servers", "Pane", "Host"]);
  });

  it("uses hexokit-sidebar-section-{section} keys with boards/server on, pane/host off by default", () => {
    for (const entry of SIDEBAR_SECTIONS) {
      expect(entry.key).toBe(`hexokit-sidebar-section-${entry.section}`);
    }
    expect(SIDEBAR_SECTIONS.map((e) => e.defaultValue)).toEqual([true, true, false, false]);
  });
});

describe("useSidebarSectionVisible", () => {
  it("returns the section defaults when nothing is stored and does not write on read", () => {
    expect(renderSection("boards").result.current[0]).toBe(true);
    expect(renderSection("server").result.current[0]).toBe(true);
    expect(renderSection("pane").result.current[0]).toBe(false);
    expect(renderSection("host").result.current[0]).toBe(false);
    expect(localStorage.getItem("hexokit-sidebar-section-pane")).toBeNull();
  });

  it("reads a persisted value", () => {
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    expect(renderSection("pane").result.current[0]).toBe(true);
  });

  it("setter persists the value and updates the hook", () => {
    const { result } = renderSection("host");
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("hexokit-sidebar-section-host")).toBe("true");
  });

  it("notifies sibling subscribers of the same section in the same tab", () => {
    // Two independent hook instances on the same key — the boolean hook's
    // in-module pub/sub must fan a write from one out to the other (no
    // `storage` event fires within a single tab).
    const a = renderSection("pane");
    const b = renderSection("pane");

    act(() => a.result.current[1](true));

    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
  });

  it("keeps different sections independent", () => {
    const pane = renderSection("pane");
    const host = renderSection("host");

    act(() => pane.result.current[1](true));

    expect(pane.result.current[0]).toBe(true);
    expect(host.result.current[0]).toBe(false);
  });

  it("round-trips: a fresh hook instance reads the persisted value", () => {
    const first = renderSection("pane");
    act(() => first.result.current[1](true));
    first.unmount();

    expect(renderSection("pane").result.current[0]).toBe(true);
  });
});
