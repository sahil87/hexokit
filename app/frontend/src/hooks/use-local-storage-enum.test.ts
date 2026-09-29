import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useLocalStorageEnum } from "./use-local-storage-enum";
import { useSessionsScope, SESSIONS_SCOPE_KEY } from "./use-sessions-scope";

const KEY = "test-enum-key";
const VALUES = ["all", "current"] as const;
type Value = (typeof VALUES)[number];

function renderEnum(defaultValue: Value = "all") {
  return renderHook(() => useLocalStorageEnum<Value>(KEY, defaultValue, VALUES));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useLocalStorageEnum", () => {
  it("returns the default when no value is stored and does not write on read", () => {
    const { result } = renderEnum();
    expect(result.current[0]).toBe("all");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("reads a persisted allowed value", () => {
    localStorage.setItem(KEY, "current");
    const { result } = renderEnum();
    expect(result.current[0]).toBe("current");
  });

  it("treats an unrecognized stored value as the default", () => {
    localStorage.setItem(KEY, "bogus");
    const { result } = renderEnum();
    expect(result.current[0]).toBe("all");
  });

  it("setter persists the value and updates the hook", () => {
    const { result } = renderEnum();
    act(() => result.current[1]("current"));
    expect(result.current[0]).toBe("current");
    expect(localStorage.getItem(KEY)).toBe("current");
  });

  it("notifies sibling subscribers of the same key in the same tab", () => {
    // Two independent hook instances on the same key — the in-module pub/sub
    // must fan a write from one out to the other (no `storage` event fires
    // within a single tab).
    const a = renderEnum();
    const b = renderEnum();

    act(() => a.result.current[1]("current"));

    expect(a.result.current[0]).toBe("current");
    expect(b.result.current[0]).toBe("current");
  });

  it("round-trips: a fresh hook instance reads the persisted value", () => {
    const first = renderEnum();
    act(() => first.result.current[1]("current"));
    first.unmount();

    const second = renderEnum();
    expect(second.result.current[0]).toBe("current");
  });
});

describe("useSessionsScope", () => {
  it("defaults to 'all' and persists under hexokit-panel-sessions-scope", () => {
    const { result } = renderHook(() => useSessionsScope());
    expect(result.current[0]).toBe("all");

    act(() => result.current[1]("current"));
    expect(localStorage.getItem(SESSIONS_SCOPE_KEY)).toBe("current");
  });

  it("treats an unrecognized stored scope as 'all'", () => {
    localStorage.setItem(SESSIONS_SCOPE_KEY, "everything");
    const { result } = renderHook(() => useSessionsScope());
    expect(result.current[0]).toBe("all");
  });
});
