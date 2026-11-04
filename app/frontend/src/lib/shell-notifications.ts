import { isShell } from "@/lib/shell";

const SHELL_NOTIFICATIONS_KEY = "hexokit-shell-notifications";
const CLAIM_PREFIX = "hexokit-notify-claim-";
const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLAIM_KEEP_LIMIT = 32;
const NOTIFICATION_ICON = "/generated-icons/icon-192.png";

type ClaimStore = Pick<Storage, "getItem" | "setItem">;
type PrunableClaimStore = ClaimStore & Pick<Storage, "length" | "key" | "removeItem">;

function canPrune(store: ClaimStore): store is PrunableClaimStore {
  return (
    "length" in store &&
    typeof store.length === "number" &&
    "key" in store &&
    typeof store.key === "function" &&
    "removeItem" in store &&
    typeof store.removeItem === "function"
  );
}

function pruneClaims(store: ClaimStore, now: number): void {
  if (!canPrune(store)) return;
  try {
    const fresh: Array<{ key: string; claimedAt: number }> = [];
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith(CLAIM_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const claimedAt = Number(store.getItem(key));
      if (!Number.isFinite(claimedAt) || now - claimedAt > CLAIM_MAX_AGE_MS) {
        store.removeItem(key);
        continue;
      }
      fresh.push({ key, claimedAt });
    }
    fresh.sort((left, right) => left.claimedAt - right.claimedAt);
    for (const entry of fresh.slice(0, Math.max(0, fresh.length - CLAIM_KEEP_LIMIT + 1))) {
      store.removeItem(entry.key);
    }
  } catch {
    // Storage cleanup is best-effort; claiming still proceeds below.
  }
}

export function sameOriginPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  if (typeof window === "undefined") return null;
  try {
    const resolved = new URL(value, window.location.origin);
    return resolved.origin === window.location.origin ? value : null;
  } catch {
    return null;
  }
}

export function isShellNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SHELL_NOTIFICATIONS_KEY) === "on";
  } catch {
    return false;
  }
}

export function setShellNotificationsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) {
      window.localStorage.setItem(SHELL_NOTIFICATIONS_KEY, "on");
    } else {
      window.localStorage.removeItem(SHELL_NOTIFICATIONS_KEY);
    }
  } catch {
    // A blocked preference store leaves notifications disabled.
  }
}

export function claimNotification(id: string, store: ClaimStore): boolean {
  const normalized = id.trim();
  if (!normalized) return true;
  const key = `${CLAIM_PREFIX}${normalized}`;
  const now = Date.now();
  pruneClaims(store, now);
  try {
    if (store.getItem(key) !== null) return false;
    store.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

function stringField(value: object, key: string): string | null {
  try {
    if (!(key in value)) return null;
    const field = Reflect.get(value, key);
    return typeof field === "string" ? field : null;
  } catch {
    return null;
  }
}

export function showShellNotification(
  payload: unknown,
  navigate: (path: string) => void,
): boolean {
  if (!isShell() || !isShellNotificationsEnabled() || typeof Notification !== "function") {
    return false;
  }

  const source = typeof payload === "object" && payload !== null ? payload : {};
  const rawID = stringField(source, "id");
  const id = rawID?.trim() ? rawID.trim() : null;
  const rawTitle = stringField(source, "title");
  const title = rawTitle?.trim() || "HexoKit";
  const body = stringField(source, "body") ?? "";
  const url = stringField(source, "url");

  if (id) {
    try {
      if (!claimNotification(id, window.localStorage)) return false;
    } catch {
      // A blocked claim store degrades to an unclaimed notification.
    }
  }

  try {
    const notification = new Notification(title, { body, icon: NOTIFICATION_ICON });
    notification.onclick = () => {
      try {
        window.focus();
        const path = sameOriginPath(url);
        if (path) navigate(path);
      } catch {
        // Notification clicks must never throw into the host renderer.
      }
    };
    return true;
  } catch {
    return false;
  }
}
