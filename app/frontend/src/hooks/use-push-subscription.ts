import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaletteAction } from "@/components/command-palette";
import { useToast } from "@/components/toast";
import {
  enablePushSubscription,
  getPushState,
  sendTestNotification,
  type PushState,
} from "@/lib/push";
import { isShell } from "@/lib/shell";
import {
  isShellNotificationsEnabled,
  setShellNotificationsEnabled,
} from "@/lib/shell-notifications";

const TEST_NOTIFICATION_BODY = "Test notification — if you can see this, delivery works.";

/**
 * Push opt-in + test, surfaced both as command-palette actions (Cmd+K, per
 * Constitution §V Keyboard-First / §IV Minimal Surface Area) and as the
 * settings dialog's Notifications row (260724-6j1v). Both surfaces are backed
 * by the same `enable` / `sendTest` handlers and `state` here, so they never
 * drift.
 */
export function usePushSubscription(): {
  state: PushState;
  enable: () => Promise<void>;
  sendTest: () => Promise<void>;
  actions: PaletteAction[];
} {
  const [state, setState] = useState<PushState>("default");
  const { addToast } = useToast();
  const shell = isShell();

  // Resolve the initial state once on mount (without prompting the user). The
  // underlying getPushState() is timeout-guarded, so this never hangs.
  useEffect(() => {
    if (shell) {
      setState(isShellNotificationsEnabled() ? "subscribed" : "default");
      return;
    }
    let cancelled = false;
    getPushState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [shell]);

  const enable = useCallback(async () => {
    if (shell) {
      setShellNotificationsEnabled(true);
      // The pref write swallows storage errors; read it back so a blocked
      // localStorage never leaves the UI claiming notifications are on.
      if (!isShellNotificationsEnabled()) {
        addToast("Could not save the notification preference — storage is blocked", "error");
        return;
      }
      setState("subscribed");
      addToast("Notifications enabled", "info");
      return;
    }
    const next = await enablePushSubscription();
    setState(next);
    switch (next) {
      case "subscribed":
        addToast("Push notifications enabled", "info");
        break;
      case "denied":
        addToast("Notifications blocked — enable them in your browser settings", "error");
        break;
      case "unsupported":
        addToast("Push needs a secure context (HTTPS or localhost)", "error");
        break;
      default:
        // "default": user dismissed the prompt or the flow aborted — stay quiet.
        break;
    }
  }, [addToast, shell]);

  const sendTest = useCallback(async () => {
    if (shell) {
      if (!isShellNotificationsEnabled()) {
        addToast("Enable notifications first", "error");
        return;
      }
      try {
        new Notification("HexoKit", { body: TEST_NOTIFICATION_BODY });
        addToast("Test notification sent — check your desktop", "info");
      } catch {
        addToast("Enable notifications first", "error");
      }
      return;
    }
    const shown = await sendTestNotification();
    if (shown) {
      addToast("Test notification sent — check your desktop", "info");
    } else if (Notification?.permission === "denied") {
      addToast("Notifications blocked — enable them in your browser settings", "error");
    } else {
      addToast("Enable notifications first", "error");
    }
  }, [addToast, shell]);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];
    if (state === "subscribed") {
      // Already on — a no-op marker + a test action.
      list.push({
        id: "push-enabled",
        label: "Notifications: Enabled ✓",
        onSelect: () => {},
      });
      list.push({
        id: "push-test",
        label: "Notifications: Send test notification",
        onSelect: () => {
          void sendTest();
        },
      });
    } else {
      list.push({
        id: "push-enable",
        label: shell ? "Notifications: Enable notifications" : "Notifications: Enable push",
        onSelect: () => {
          void enable();
        },
      });
    }
    return list;
  }, [state, enable, sendTest, shell]);

  return { state, enable, sendTest, actions };
}
