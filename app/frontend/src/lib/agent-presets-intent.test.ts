import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onPresetsIntent, requestPresetsIntent, resetPresetsIntent, takePresetsIntent } from "./agent-presets-intent";

beforeEach(() => {
  vi.useFakeTimers();
  resetPresetsIntent();
});
afterEach(() => vi.useRealTimers());

describe("presets intent", () => {
  it("is taken once", () => {
    requestPresetsIntent({ action: "new" });
    expect(takePresetsIntent()).toEqual({ action: "new" });
    expect(takePresetsIntent()).toBeNull();
  });

  it("notifies a live subscriber and stops after unsubscribe", () => {
    const listener = vi.fn();
    const off = onPresetsIntent(listener);
    requestPresetsIntent({ action: "focus" });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    requestPresetsIntent({ action: "focus" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops an intent nobody took in time, so it cannot fire at a later open", () => {
    requestPresetsIntent({ action: "delete", name: "x" });
    vi.advanceTimersByTime(11_000);
    expect(takePresetsIntent()).toBeNull();
  });
});
