import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerServiceWorker,
  enablePushSubscription,
  getPushState,
  sendTestNotification,
} from "./push";

// Mock the API client so the subscribe flow does not hit the network.
const getVapidPublicKey = vi.fn();
const subscribePush = vi.fn();
vi.mock("@/api/client", () => ({
  getVapidPublicKey: (...args: unknown[]) => getVapidPublicKey(...args),
  subscribePush: (...args: unknown[]) => subscribePush(...args),
}));

// A base64url-encoded VAPID key (dummy but atob-decodable).
const FAKE_KEY = "BHViMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg";

function setNotificationPermission(perm: NotificationPermission) {
  // jsdom lacks Notification; install a minimal stub.
  const stub = {
    permission: perm,
    requestPermission: vi.fn().mockResolvedValue(perm),
  };
  Object.defineProperty(globalThis, "Notification", {
    value: stub,
    writable: true,
    configurable: true,
  });
  return stub;
}

function setSecureContext(secure: boolean) {
  Object.defineProperty(globalThis, "isSecureContext", {
    value: secure,
    writable: true,
    configurable: true,
  });
}

function installServiceWorker(opts: {
  existingSub?: unknown;
  subscribeResult?: unknown;
} = {}) {
  // isPushSupported() gates on a secure context; install one for the happy path.
  setSecureContext(true);
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(opts.existingSub ?? null),
    subscribe: vi.fn().mockResolvedValue(
      opts.subscribeResult ?? { toJSON: () => ({ endpoint: "https://e", keys: {} }) },
    ),
  };
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const registration = { pushManager, showNotification };
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
    writable: true,
    configurable: true,
  });
  // PushManager presence is part of isPushSupported's feature check.
  Object.defineProperty(globalThis, "PushManager", {
    value: function PushManager() {},
    writable: true,
    configurable: true,
  });
  return { registration, pushManager, showNotification };
}

function removeServiceWorker() {
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  setSecureContext(false);
}

describe("registerServiceWorker", () => {
  beforeEach(() => {
    getVapidPublicKey.mockReset();
    subscribePush.mockReset();
  });
  afterEach(() => {
    removeServiceWorker();
  });

  it("is a no-op (returns null) when serviceWorker is unsupported", async () => {
    removeServiceWorker();
    expect(await registerServiceWorker()).toBeNull();
  });

  it("registers /sw.js when supported", async () => {
    const { registration } = installServiceWorker();
    const reg = await registerServiceWorker();
    expect(reg).toBe(registration);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
  });
});

describe("enablePushSubscription", () => {
  beforeEach(() => {
    getVapidPublicKey.mockReset();
    subscribePush.mockReset();
    getVapidPublicKey.mockResolvedValue(FAKE_KEY);
    subscribePush.mockResolvedValue(undefined);
  });
  afterEach(() => {
    removeServiceWorker();
  });

  it("returns 'unsupported' and sends nothing when push is unsupported", async () => {
    removeServiceWorker();
    // Notification also absent.
    Object.defineProperty(globalThis, "Notification", { value: undefined, writable: true, configurable: true });
    expect(await enablePushSubscription()).toBe("unsupported");
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it("aborts to 'denied' when permission is denied, sending nothing", async () => {
    installServiceWorker();
    setNotificationPermission("denied");
    expect(await enablePushSubscription()).toBe("denied");
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it("returns 'unsupported' in an insecure context even when the APIs exist", async () => {
    installServiceWorker();
    setNotificationPermission("granted");
    setSecureContext(false); // APIs present, but not a secure context.
    expect(await enablePushSubscription()).toBe("unsupported");
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it("subscribes and POSTs the subscription when permission is granted", async () => {
    const { pushManager } = installServiceWorker();
    setNotificationPermission("granted");

    const result = await enablePushSubscription();

    expect(result).toBe("subscribed");
    // Registers a worker before awaiting readiness (awaiting `ready` first
    // would hang forever when no worker has been registered yet).
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    expect(getVapidPublicKey).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(subscribePush).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing subscription without re-subscribing", async () => {
    const existing = { toJSON: () => ({ endpoint: "https://e", keys: {} }) };
    const { pushManager } = installServiceWorker({ existingSub: existing });
    setNotificationPermission("granted");

    const result = await enablePushSubscription();

    expect(result).toBe("subscribed");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(getVapidPublicKey).not.toHaveBeenCalled();
    expect(subscribePush).toHaveBeenCalledTimes(1);
  });
});

describe("getPushState", () => {
  afterEach(() => {
    removeServiceWorker();
  });

  it("reports 'unsupported' without serviceWorker", async () => {
    removeServiceWorker();
    Object.defineProperty(globalThis, "Notification", { value: undefined, writable: true, configurable: true });
    expect(await getPushState()).toBe("unsupported");
  });

  it("reports 'denied' when permission is denied", async () => {
    installServiceWorker();
    setNotificationPermission("denied");
    expect(await getPushState()).toBe("denied");
  });

  it("reports 'subscribed' when a subscription exists", async () => {
    installServiceWorker({ existingSub: { toJSON: () => ({}) } });
    setNotificationPermission("granted");
    expect(await getPushState()).toBe("subscribed");
  });
});

describe("sendTestNotification", () => {
  afterEach(() => {
    removeServiceWorker();
  });

  it("returns false (no-op) when push is unsupported", async () => {
    removeServiceWorker();
    Object.defineProperty(globalThis, "Notification", { value: undefined, writable: true, configurable: true });
    expect(await sendTestNotification()).toBe(false);
  });

  it("returns false without calling showNotification when permission is not granted", async () => {
    const { showNotification } = installServiceWorker();
    setNotificationPermission("default");
    expect(await sendTestNotification()).toBe(false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("calls registration.showNotification and returns true when granted", async () => {
    const { showNotification } = installServiceWorker();
    setNotificationPermission("granted");
    expect(await sendTestNotification()).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith(
      "HexoKit",
      expect.objectContaining({ body: expect.any(String) }),
    );
  });
});
