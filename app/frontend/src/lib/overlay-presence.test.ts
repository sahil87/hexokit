import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetForTests, acquire, count, isModalOpen, isOccludingOpen, subscribe } from "./overlay-presence";

describe("overlay-presence", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("starts empty", () => {
    expect(count()).toBe(0);
    expect(count("modal")).toBe(0);
    expect(count("transient")).toBe(0);
    expect(isModalOpen()).toBe(false);
  });

  it("acquire increments its kind and release decrements it", () => {
    const release = acquire("modal");
    expect(count("modal")).toBe(1);
    expect(count()).toBe(1);
    expect(isModalOpen()).toBe(true);
    release();
    expect(count("modal")).toBe(0);
    expect(isModalOpen()).toBe(false);
  });

  it("nested modals stay open until the last release", () => {
    const a = acquire("modal");
    const b = acquire("modal");
    expect(count("modal")).toBe(2);
    a();
    expect(isModalOpen()).toBe(true);
    b();
    expect(isModalOpen()).toBe(false);
  });

  it("release is idempotent and the count never goes negative", () => {
    const release = acquire("modal");
    release();
    release();
    expect(count("modal")).toBe(0);
    expect(count()).toBe(0);
  });

  it("a held transient does not feed the modal signal", () => {
    const release = acquire("transient");
    expect(isModalOpen()).toBe(false);
    expect(count("transient")).toBe(1);
    expect(count()).toBe(1);
    release();
    expect(count()).toBe(0);
  });

  it("isOccludingOpen reads modal + transient: either kind opens it, the last release closes it", () => {
    expect(isOccludingOpen()).toBe(false);
    const menu = acquire("transient");
    expect(isOccludingOpen()).toBe(true);
    const dialog = acquire("modal");
    menu();
    expect(isOccludingOpen()).toBe(true);
    dialog();
    expect(isOccludingOpen()).toBe(false);
  });

  it("count() sums both kinds", () => {
    acquire("modal");
    acquire("transient");
    acquire("transient");
    expect(count()).toBe(3);
    expect(count("modal")).toBe(1);
    expect(count("transient")).toBe(2);
  });

  it("subscribers fire on acquire and on effective release, then stop after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const release = acquire("modal");
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    // A no-op second release notifies nobody.
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    acquire("modal");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("subscribers observe the new count synchronously", () => {
    const seen: boolean[] = [];
    subscribe(() => seen.push(isModalOpen()));
    const release = acquire("modal");
    release();
    expect(seen).toEqual([true, false]);
  });

  it("unsubscribing inside a notification neither throws nor skips other listeners", () => {
    const second = vi.fn();
    const unsubscribeFirst = subscribe(() => unsubscribeFirst());
    subscribe(second);
    expect(() => acquire("modal")).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
