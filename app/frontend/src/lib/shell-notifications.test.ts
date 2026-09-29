import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNotification,
  isShellNotificationsEnabled,
  sameOriginPath,
  setShellNotificationsEnabled,
  showShellNotification,
} from "./shell-notifications";

class NotificationStub {
  onclick: ((event: Event) => void) | null = null;

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    notifications.push(this);
  }
}

const notifications: NotificationStub[] = [];

function setShell(on: boolean) {
  if (on) {
    Object.defineProperty(window, "runkitShell", {
      value: { version: "test", platform: "linux" },
      configurable: true,
      writable: true,
    });
  } else {
    delete window.runkitShell;
  }
}

describe("shell notifications", () => {
  beforeEach(() => {
    localStorage.clear();
    notifications.length = 0;
    setShell(false);
    vi.stubGlobal("Notification", NotificationStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    setShell(false);
  });

  it("accepts only same-origin absolute paths", () => {
    expect(sameOriginPath("/default/1?view=web")).toBe("/default/1?view=web");
    expect(sameOriginPath("//evil.example/path")).toBeNull();
    expect(sameOriginPath("https://evil.example/path")).toBeNull();
    expect(sameOriginPath(42)).toBeNull();
  });

  it("stores the opt-in as on or absent", () => {
    expect(isShellNotificationsEnabled()).toBe(false);
    setShellNotificationsEnabled(true);
    expect(isShellNotificationsEnabled()).toBe(true);
    setShellNotificationsEnabled(false);
    expect(isShellNotificationsEnabled()).toBe(false);
  });

  it("claims an id once and fails open when claim storage throws", () => {
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    expect(claimNotification("event-1", store)).toBe(true);
    expect(claimNotification("event-1", store)).toBe(false);

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(claimNotification("event-2", blocked)).toBe(true);
  });

  it("prunes expired and excess claim keys opportunistically", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000);
    for (let index = 0; index < 40; index++) {
      localStorage.setItem(`hexokit-notify-claim-old-${index}`, String(index));
    }
    expect(claimNotification("fresh", localStorage)).toBe(true);
    const claimKeys = Object.keys(localStorage).filter((key) =>
      key.startsWith("hexokit-notify-claim-"),
    );
    expect(claimKeys).toEqual(["hexokit-notify-claim-fresh"]);
  });

  it("prunes claim keys even when unrelated storage entries precede them", () => {
    const now = 2_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (let index = 0; index < 150; index++) {
      localStorage.setItem(`unrelated-${index}`, "value");
    }
    for (let index = 0; index < 40; index++) {
      localStorage.setItem(`hexokit-notify-claim-existing-${index}`, String(now - index));
    }

    expect(claimNotification("fresh", localStorage)).toBe(true);
    const claimKeys = Object.keys(localStorage).filter((key) =>
      key.startsWith("hexokit-notify-claim-"),
    );
    expect(claimKeys).toHaveLength(32);
    expect(claimKeys).toContain("hexokit-notify-claim-fresh");
  });

  it("is inert outside the shell and while the pref is off", () => {
    setShellNotificationsEnabled(true);
    expect(showShellNotification({ title: "ignored" }, vi.fn())).toBe(false);
    setShell(true);
    setShellNotificationsEnabled(false);
    expect(showShellNotification({ title: "ignored" }, vi.fn())).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  it("shows once per id and rejects a hostile click target", () => {
    setShell(true);
    setShellNotificationsEnabled(true);
    const navigate = vi.fn();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});

    expect(
      showShellNotification(
        { id: "same", title: "Agent", body: "waiting", url: "//evil.example" },
        navigate,
      ),
    ).toBe(true);
    expect(showShellNotification({ id: "same", title: "Agent" }, navigate)).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Agent");
    expect(notifications[0].options).toEqual({
      body: "waiting",
      icon: "/generated-icons/icon-192.png",
    });

    notifications[0].onclick?.(new Event("click"));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows without a claim when claim storage is blocked", () => {
    setShell(true);
    setShellNotificationsEnabled(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      if (key === "hexokit-shell-notifications") return "on";
      if (key.startsWith("hexokit-notify-claim-")) throw new Error("blocked");
      return null;
    });

    expect(showShellNotification({ id: "unclaimable", body: "waiting" }, vi.fn())).toBe(true);
    expect(notifications).toHaveLength(1);
  });

  it("tolerates malformed payloads and navigates safe paths on click", () => {
    setShell(true);
    setShellNotificationsEnabled(true);
    const navigate = vi.fn();
    vi.spyOn(window, "focus").mockImplementation(() => {});

    expect(showShellNotification(null, navigate)).toBe(true);
    expect(notifications[0].title).toBe("HexoKit");
    expect(notifications[0].options?.body).toBe("");

    expect(showShellNotification({ id: 9, url: "/default/3" }, navigate)).toBe(true);
    notifications[1].onclick?.(new Event("click"));
    expect(navigate).toHaveBeenCalledWith("/default/3");
  });

  it("treats throwing payload access as missing fields", () => {
    setShell(true);
    setShellNotificationsEnabled(true);
    const payload = {
      get title(): string {
        throw new Error("hostile accessor");
      },
      body: "waiting",
    };

    expect(showShellNotification(payload, vi.fn())).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("HexoKit");
    expect(notifications[0].options?.body).toBe("waiting");

    const proxy = new Proxy(
      {},
      {
        has: () => {
          throw new Error("hostile trap");
        },
      },
    );
    expect(showShellNotification(proxy, vi.fn())).toBe(true);
    expect(notifications).toHaveLength(2);
    expect(notifications[1].title).toBe("HexoKit");
  });
});
