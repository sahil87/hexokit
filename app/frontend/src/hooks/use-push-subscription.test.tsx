import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/toast";
import { setShellNotificationsEnabled } from "@/lib/shell-notifications";
import { usePushSubscription } from "./use-push-subscription";

const getPushState = vi.fn();
const enablePushSubscription = vi.fn();
const sendTestNotification = vi.fn();
vi.mock("@/lib/push", () => ({
  getPushState: (...args: unknown[]) => getPushState(...args),
  enablePushSubscription: (...args: unknown[]) => enablePushSubscription(...args),
  sendTestNotification: (...args: unknown[]) => sendTestNotification(...args),
}));

class NotificationStub {
  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    notifications.push(this);
  }
}

const notifications: NotificationStub[] = [];

function Wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

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

describe("usePushSubscription", () => {
  beforeEach(() => {
    localStorage.clear();
    notifications.length = 0;
    setShell(false);
    getPushState.mockReset().mockResolvedValue("default");
    enablePushSubscription.mockReset().mockResolvedValue("subscribed");
    sendTestNotification.mockReset().mockResolvedValue(true);
    vi.stubGlobal("Notification", NotificationStub);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    setShell(false);
  });

  it("derives shell state from the pref and enables without PushManager", async () => {
    setShell(true);
    const { result } = renderHook(() => usePushSubscription(), { wrapper: Wrapper });

    expect(result.current.state).toBe("default");
    expect(result.current.actions[0]?.label).toBe("Notifications: Enable notifications");
    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.state).toBe("subscribed");
    expect(localStorage.getItem("hexokit-shell-notifications")).toBe("on");
    expect(enablePushSubscription).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Notifications enabled");
  });

  it("sends the shell test directly through Notification", async () => {
    setShell(true);
    setShellNotificationsEnabled(true);
    const { result } = renderHook(() => usePushSubscription(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state).toBe("subscribed"));

    await act(async () => {
      await result.current.sendTest();
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("HexoKit");
    expect(notifications[0].options?.body).toContain("delivery works");
    expect(sendTestNotification).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Test notification sent — check your desktop",
    );
  });

  it("requires shell opt-in before a test notification", async () => {
    setShell(true);
    const { result } = renderHook(() => usePushSubscription(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.sendTest();
    });
    expect(notifications).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Enable notifications first");
  });

  it("keeps the browser Web Push flow unchanged", async () => {
    getPushState.mockResolvedValue("subscribed");
    const { result } = renderHook(() => usePushSubscription(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state).toBe("subscribed"));

    await act(async () => {
      await result.current.sendTest();
    });
    expect(getPushState).toHaveBeenCalledTimes(1);
    expect(sendTestNotification).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(0);
  });
});
