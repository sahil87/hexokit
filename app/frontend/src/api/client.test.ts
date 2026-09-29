import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../tests/msw/server";
import { resetMockSessions } from "../../tests/msw/handlers";
import {
  getHealth,
  getOpenApps,
  openInApp,
  getSessions,
  setSessionOrder,
  createSession,
  renameSession,
  killSession,
  createWindow,
  killWindow,
  renameWindow,
  sendToWindow,
  sendOperatorRequest,
  sendServerOperatorRequest,
  startOperator,
  ApiError,
  fetchWindowHistory,
  fetchCodeWorkspace,
  fetchCodeBridge,
  fetchGuiStatus,
  launchGuiApp,
  resizeGui,
  restartGui,
  getDirectories,
  uploadFile,
  killServer,
  setServerProtected,
  getThemePreference,
  setThemePreference,
  getServerColor,
  setServerColor,
  getAllServerColors,
  getAllServerFlairs,
  setServerFlair,
  getInstanceColor,
  getSSHHost,
  setSSHHost,
  getInstanceName,
  setInstanceName,
  getSettingsEntries,
  postSettings,
  setWindowColor,
  setWindowRole,
  setWindowFlair,
  setSessionFlair,
  addWebTab,
  removeWebTab,
  selectWebTab,
  borrowLayout,
  returnLayout,
  triggerUpdate,
  triggerForceUpdate,
  triggerRestart,
  refreshStatus,
  checkForUpdates,
  getRecoveryOffers,
  restoreRecoveryServer,
  dismissRecoveryServer,
  DAEMON_SERVER,
  isInfraServer,
  compareServers,
  compareServersRanked,
  muteCron,
  editCron,
} from "./client";
import type { ServerInfo } from "./client";

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mswServer.resetHandlers();
  resetMockSessions();
});
afterAll(() => mswServer.close());

describe("API client", () => {
  it("getHealth fetches GET /api/health with hostname", async () => {
    const health = await getHealth();
    expect(health.status).toBe("ok");
    expect(health.hostname).toBe("test-host");
  });

  it("getHealth surfaces the optional sshHost field when present", async () => {
    mswServer.use(
      http.get("/api/health", () =>
        HttpResponse.json({ status: "ok", hostname: "test-host", sshHost: "devbox" }),
      ),
    );
    const health = await getHealth();
    expect(health.sshHost).toBe("devbox");
  });

  it("getOpenApps returns the registry array", async () => {
    mswServer.use(
      http.get("/api/open-apps", () =>
        HttpResponse.json([{ id: "vscode", label: "VS Code", kind: "editor" }]),
      ),
    );
    const apps = await getOpenApps();
    expect(apps).toEqual([{ id: "vscode", label: "VS Code", kind: "editor" }]);
  });

  it("getOpenApps is fail-silent: non-200 resolves to []", async () => {
    mswServer.use(
      http.get("/api/open-apps", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    await expect(getOpenApps()).resolves.toEqual([]);
  });

  it("getOpenApps is fail-silent: non-array body resolves to []", async () => {
    mswServer.use(
      http.get("/api/open-apps", () => HttpResponse.json({ nope: true })),
    );
    await expect(getOpenApps()).resolves.toEqual([]);
  });

  it("openInApp POSTs path+app to /api/open with the server query", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    mswServer.use(
      http.post("/api/open", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const res = await openInApp("runkit", "/Users/x/code/proj", "vscode");
    expect(res.ok).toBe(true);
    expect(capturedUrl).toContain("?server=runkit");
    expect(capturedBody).toEqual({ path: "/Users/x/code/proj", app: "vscode" });
  });

  it("openInApp throws the server's error message on failure", async () => {
    mswServer.use(
      http.post("/api/open", () =>
        HttpResponse.json({ error: "unknown app" }, { status: 400 }),
      ),
    );
    await expect(openInApp("runkit", "/x", "nope")).rejects.toThrow("unknown app");
  });

  it("getSessions fetches GET /api/sessions with server query", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get("/api/sessions", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );
    await getSessions("server-B");
    expect(capturedUrl).toContain("?server=server-B");
  });

  it("createSession sends POST /api/sessions with name and cwd", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.post("/api/sessions", async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );
    const result = await createSession("runkit", "my-project", "~/code/my-project");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain("?server=runkit");
  });

  it("createSession sends POST /api/sessions with name only", async () => {
    const result = await createSession("runkit", "bare");
    expect(result.ok).toBe(true);
  });

  it("createSession sends the captured server in the query string", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.post("/api/sessions", async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );
    await createSession("server-B", "foo");
    expect(capturedUrl).toMatch(/\/api\/sessions\?server=server-B$/);
  });

  it("renameSession sends POST /api/sessions/:session/rename with server query", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/sessions/:session/rename", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await renameSession("server-B", "foo", "bar");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toMatch(/\/api\/sessions\/foo\/rename\?server=server-B$/);
    expect(capturedBody.name).toBe("bar");
  });

  it("killSession sends POST /api/sessions/:session/kill with server query", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.post("/api/sessions/:session/kill", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await killSession("server-B", "foo");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toMatch(/\/api\/sessions\/foo\/kill\?server=server-B$/);
  });

  it("createWindow posts the route, query, and provided optional fields", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/sessions/:session/windows", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );

    const result = await createWindow("server-B", "foo", "editor", "/home/user/project");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toMatch(/\/api\/sessions\/foo\/windows\?server=server-B$/);
    expect(capturedBody).toEqual({ name: "editor", cwd: "/home/user/project" });
  });

  it.each([
    { label: "cwd", name: "editor", cwd: undefined, omitted: "cwd", kept: ["name", "editor"] },
    { label: "name", name: undefined, cwd: "/home/user/project", omitted: "name", kept: ["cwd", "/home/user/project"] },
  ] as const)("createWindow omits an absent $label", async ({ name, cwd, omitted, kept }) => {
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/sessions/:session/windows", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );

    await createWindow("runkit", "run-kit", name, cwd);
    expect(capturedBody[omitted]).toBeUndefined();
    expect(capturedBody[kept[0]]).toBe(kept[1]);
  });

  it("killWindow sends POST /api/windows/:windowId/kill with server query", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.post("/api/windows/:windowId/kill", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await killWindow("server-B", "@3");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toMatch(/\/api\/windows\/%403\/kill\?server=server-B$/);
  });

  it("renameWindow sends POST /api/windows/:windowId/rename with server query", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/windows/:windowId/rename", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await renameWindow("runkit", "@0", "renamed");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toMatch(/\/api\/windows\/%400\/rename\?server=runkit$/);
    expect(capturedBody.name).toBe("renamed");
  });

  it("sendToWindow POSTs /api/windows/:windowId/send with intent and server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: { text?: string; mode?: string } = {};
    mswServer.use(
      http.post("/api/windows/:windowId/send", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        const body: unknown = await request.json();
        if (typeof body === "object" && body !== null) capturedBody = body;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await sendToWindow("runkit", "@0", "one\ntwo", "submit");
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/windows\/%400\/send\?server=runkit$/);
    expect(capturedBody).toEqual({ text: "one\ntwo", mode: "submit" });
  });

  it("sendToWindow serializes target:\"agent\" only when set (the selection broadcast)", async () => {
    const capturedBodies: unknown[] = [];
    mswServer.use(
      http.post("/api/windows/:windowId/send", async ({ request }) => {
        capturedBodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    await sendToWindow("runkit", "@0", "hello", "submit", "agent");
    await sendToWindow("runkit", "@0", "hello", "submit");
    expect(capturedBodies).toEqual([
      { text: "hello", mode: "submit", target: "agent" },
      { text: "hello", mode: "submit" },
    ]);
  });

  it("sendToWindow carries raw and enter modes without changing their text", async () => {
    const capturedBodies: unknown[] = [];
    mswServer.use(
      http.post("/api/windows/:windowId/send", async ({ request }) => {
        capturedBodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    await sendToWindow("runkit", "@0", "one\ntwo", "raw");
    await sendToWindow("runkit", "@0", "", "enter");
    expect(capturedBodies).toEqual([
      { text: "one\ntwo", mode: "raw" },
      { text: "", mode: "enter" },
    ]);
  });

  it("sendToWindow throws ApiError with the server message, status, and code", async () => {
    const probeError = "agent input not ready — message pasted but not echoed; Enter withheld.";
    mswServer.use(
      http.post("/api/windows/:windowId/send", () =>
        HttpResponse.json({ error: probeError, code: "probe_failure" }, { status: 409 }),
      ),
    );
    try {
      await sendToWindow("runkit", "@0", "a\nb", "submit");
      expect.fail("sendToWindow should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.message).toBe(probeError);
      expect(err.status).toBe(409);
      expect(err.code).toBe("probe_failure");
    }
  });

  it("ApiError tolerates a response without a code", async () => {
    mswServer.use(
      http.post("/api/windows/:windowId/send", () =>
        HttpResponse.json({ error: "plain failure" }, { status: 500 }),
      ),
    );
    try {
      await sendToWindow("runkit", "@0", "hello", "submit");
      expect.fail("sendToWindow should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.message).toBe("plain failure");
      expect(err.status).toBe(500);
      expect(err.code).toBeUndefined();
    }
  });

  it("getDirectories sends GET /api/directories?prefix=...", async () => {
    const dirs = await getDirectories("~/code/");
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toContain("project-a");
  });

  it("uploadFile sends POST /api/sessions/:session/upload with server query", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.post("/api/sessions/:session/upload", ({ request, params }) => {
        capturedUrl = request.url;
        const sess = params.session as string;
        return HttpResponse.json({ ok: true, path: `/tmp/uploads/${sess}/file.txt` });
      }),
    );
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    const result = await uploadFile("runkit", "run-kit", file, "0");
    expect(result.ok).toBe(true);
    expect(result.path).toContain("run-kit");
    expect(capturedUrl).toContain("?server=runkit");
  });

  it("killServer does NOT carry a server query string", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    mswServer.use(
      http.post("/api/servers/kill", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    await killServer("runkit");
    expect(capturedUrl).toMatch(/\/api\/servers\/kill$/);
    expect(capturedBody.name).toBe("runkit");
    expect(capturedBody.force).toBe(false);
  });

  it("killServer carries force for a protected-target force kill", async () => {
    let capturedBody: Record<string, unknown> = {};
    mswServer.use(
      http.post("/api/servers/kill", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    await killServer("rk-daemon", true);
    expect(capturedBody.name).toBe("rk-daemon");
    expect(capturedBody.force).toBe(true);
  });

  it("setServerProtected posts name + protected to the protect endpoint", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    mswServer.use(
      http.post("/api/servers/protect", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    await setServerProtected("vault", true);
    expect(capturedUrl).toMatch(/\/api\/servers\/protect$/);
    expect(capturedBody).toEqual({ name: "vault", protected: true });

    await setServerProtected("vault", false);
    expect(capturedBody).toEqual({ name: "vault", protected: false });
  });

  it("encodes server names with special characters", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.post("/api/sessions/:session/rename", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );
    await renameSession("server with spaces", "foo", "bar");
    expect(capturedUrl).toContain("?server=server%20with%20spaces");
  });
});

describe("operator request outcomes", () => {
  it("distinguishes immediate window delivery from a queued response", async () => {
    let queued = false;
    mswServer.use(
      http.post("/api/windows/:windowId/operator-request", () =>
        queued
          ? HttpResponse.json({ queued: true }, { status: 202 })
          : HttpResponse.json({ ok: true }),
      ),
    );
    await expect(sendOperatorRequest("default", "@1", "fix-tab-name")).resolves.toEqual({
      outcome: "delivered",
    });
    queued = true;
    await expect(sendOperatorRequest("default", "@1", "fix-tab-name")).resolves.toEqual({
      outcome: "queued",
    });
  });

  it("carries the optional text only when non-empty", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/windows/:windowId/operator-request", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(sendOperatorRequest("default", "@1", "user-message", "hello operator")).resolves.toEqual({
      outcome: "delivered",
    });
    await expect(sendOperatorRequest("default", "@1", "fix-tab-name")).resolves.toEqual({
      outcome: "delivered",
    });
    expect(bodies).toEqual([
      { template: "user-message", text: "hello operator" },
      { template: "fix-tab-name" },
    ]);
  });

  it("distinguishes server delivery from queueing and preserves the optional session body", async () => {
    const bodies: unknown[] = [];
    let queued = false;
    mswServer.use(
      http.post("/api/operator-request", async ({ request }) => {
        bodies.push(await request.json());
        return queued
          ? HttpResponse.json({ queued: true }, { status: 202 })
          : HttpResponse.json({ ok: true });
      }),
    );
    await expect(sendServerOperatorRequest("default", "brief-me", "")).resolves.toEqual({
      outcome: "delivered",
    });
    queued = true;
    await expect(
      sendServerOperatorRequest("default", "update-annotations", "", "work"),
    ).resolves.toEqual({ outcome: "queued" });
    expect(bodies).toEqual([
      { template: "brief-me", text: "" },
      { template: "update-annotations", text: "", session: "work" },
    ]);
  });

  it("keeps structured operator errors on the throwing path", async () => {
    mswServer.use(
      http.post("/api/operator-request", () =>
        HttpResponse.json({ error: "operator queue is full" }, { status: 409 }),
      ),
    );
    await expect(sendServerOperatorRequest("default", "brief-me", "")).rejects.toThrow(
      "operator queue is full",
    );
  });
});

describe("startOperator", () => {
  it("posts an empty body to /api/operator/start and resolves the 202 receipt", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/operator/start", async ({ request }) => {
        bodies.push(await request.json());
        expect(request.url).toContain("server=default");
        return HttpResponse.json({ windowId: "@7", server: "default" }, { status: 202 });
      }),
    );
    await expect(startOperator("default")).resolves.toEqual({ windowId: "@7", server: "default" });
    expect(bodies).toEqual([{}]);
  });

  it("posts the viewed window in the body when given", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/operator/start", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ windowId: "@7", server: "default" }, { status: 202 });
      }),
    );
    await expect(startOperator("default", "@1")).resolves.toEqual({ windowId: "@7", server: "default" });
    expect(bodies).toEqual([{ window: "@1" }]);
  });

  it("surfaces a 409 operator_exists as an ApiError carrying code and windowId", async () => {
    mswServer.use(
      http.post("/api/operator/start", () =>
        HttpResponse.json(
          { error: "operator already present", code: "operator_exists", windowId: "@3" },
          { status: 409 },
        ),
      ),
    );
    const err = await startOperator("default").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) throw new Error("expected ApiError");
    expect(err.status).toBe(409);
    expect(err.code).toBe("operator_exists");
    expect(err.windowId).toBe("@3");
  });

  it("rejects a 502 with the server's message", async () => {
    mswServer.use(
      http.post("/api/operator/start", () =>
        HttpResponse.json({ error: "run-kit operator: fab not found on PATH" }, { status: 502 }),
      ),
    );
    await expect(startOperator("default")).rejects.toThrow(
      "run-kit operator: fab not found on PATH",
    );
  });
});

describe("web tab verb wrappers", () => {
  it("addWebTab POSTs {target} to /api/windows/:windowId/web with server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: { target?: string } = {};
    mswServer.use(
      http.post("/api/windows/:windowId/web", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        capturedBody = (await request.json()) as { target?: string };
        return HttpResponse.json(
          { index: 3, existed: false, url: "/proxy/3003/" },
          { status: 201 },
        );
      }),
    );
    const result = await addWebTab("s", "@5", "/proxy/3003/");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/windows\/%405\/web\?server=s$/);
    expect(capturedBody).toEqual({ target: "/proxy/3003/" });
    expect(result).toEqual({ index: 3, existed: false, url: "/proxy/3003/" });
  });

  it("removeWebTab POSTs /api/windows/:windowId/web/:n/remove with server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    mswServer.use(
      http.post("/api/windows/:windowId/web/:n/remove", ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await removeWebTab("s", "@5", 2);
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/windows\/%405\/web\/2\/remove\?server=s$/);
  });

  it("selectWebTab POSTs /api/windows/:windowId/web/:n/select with server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    mswServer.use(
      http.post("/api/windows/:windowId/web/:n/select", ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await selectWebTab("s", "@5", 3);
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/windows\/%405\/web\/3\/select\?server=s$/);
  });

  it("a 409 rejects with the server's error text verbatim (family cap)", async () => {
    mswServer.use(
      http.post("/api/windows/:windowId/web", () =>
        HttpResponse.json({ error: "web tabs full (16)" }, { status: 409 }),
      ),
    );
    await expect(addWebTab("s", "@5", "/proxy/3009/")).rejects.toThrow(
      "web tabs full (16)",
    );
  });
});

describe("layout borrow/return verbs", () => {
  it("borrowLayout POSTs {to, leaf, tree} to /api/layout/borrow with server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/layout/borrow", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await borrowLayout("s", {
      to: "@9",
      leaf: "@3/tty",
      tree: "h(tty,@3/tty)",
    });
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/layout\/borrow\?server=s$/);
    expect(capturedBody).toEqual({ to: "@9", leaf: "@3/tty", tree: "h(tty,@3/tty)" });
  });

  it("returnLayout POSTs {from, leaf} to /api/layout/return with server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/layout/return", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await returnLayout("s", { from: "@7", leaf: "@3/tty" });
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/layout\/return\?server=s$/);
    expect(capturedBody).toEqual({ from: "@7", leaf: "@3/tty" });
  });

  it("a 409 rejects as an ApiError carrying the status and the server's message", async () => {
    mswServer.use(
      http.post("/api/layout/return", () =>
        HttpResponse.json({ error: "leaf not held by window" }, { status: 409 }),
      ),
    );
    try {
      await returnLayout("s", { from: "@7", leaf: "@3/tty" });
      expect.fail("returnLayout should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.message).toBe("leaf not held by window");
      expect(err.status).toBe(409);
    }
  });
});

describe("recovery offers client", () => {
  const offer = {
    server: "kit",
    takenAt: "2026-08-20T06:00:00Z",
    sessionCount: 2,
    windowCount: 3,
    sessions: [
      {
        name: "dev",
        color: "4",
        windows: [
          { index: 0, name: "shell", paneCount: 1, commands: ["zsh"], resumable: false },
          { index: 1, name: "agent", paneCount: 2, commands: ["zsh", "claude -c"], resumable: true },
        ],
      },
    ],
  };

  it("getRecoveryOffers fetches GET /api/recovery and returns the offers list", async () => {
    mswServer.use(
      http.get("/api/recovery", () => HttpResponse.json({ offers: [offer] })),
    );
    const offers = await getRecoveryOffers();
    expect(offers).toEqual([offer]);
  });

  it("getRecoveryOffers resolves [] when the offers key is absent", async () => {
    mswServer.use(http.get("/api/recovery", () => HttpResponse.json({})));
    await expect(getRecoveryOffers()).resolves.toEqual([]);
  });


  it("restoreRecoveryServer POSTs {server} in the body with no query string", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/recovery/restore", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ sessionsCreated: 2 });
      }),
    );
    const report = await restoreRecoveryServer("kit");
    expect(capturedUrl).toMatch(/\/api\/recovery\/restore$/);
    expect(capturedBody).toEqual({ server: "kit" });
    expect(report).toEqual({ sessionsCreated: 2 });
  });


  it("dismissRecoveryServer POSTs {server} in the body and returns ok", async () => {
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.post("/api/recovery/dismiss", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, string>;
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(dismissRecoveryServer("kit")).resolves.toEqual({ ok: true });
    expect(capturedBody).toEqual({ server: "kit" });
  });

});

describe("API request deduplication", () => {
  it("deduplicates concurrent GET requests to the same endpoint", async () => {
    let callCount = 0;
    mswServer.use(
      http.get("/api/health", () => {
        callCount++;
        return HttpResponse.json({ status: "ok", hostname: "test-host" });
      }),
    );

    const [a, b] = await Promise.all([getHealth(), getHealth()]);
    expect(callCount).toBe(1);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
  });

  it("does not deduplicate POST requests", async () => {
    let callCount = 0;
    mswServer.use(
      http.post("/api/sessions", async ({ request }) => {
        callCount++;
        await request.json();
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );

    await Promise.all([
      createSession("runkit", "proj-a"),
      createSession("runkit", "proj-b"),
    ]);
    expect(callCount).toBe(2);
  });

  it("cleans up after resolve so sequential calls make fresh requests", async () => {
    let callCount = 0;
    mswServer.use(
      http.get("/api/health", () => {
        callCount++;
        return HttpResponse.json({ status: "ok", hostname: "test-host" });
      }),
    );

    await getHealth();
    expect(callCount).toBe(1);

    await getHealth();
    expect(callCount).toBe(2);
  });

  it("cleans up after reject so subsequent calls make fresh requests", async () => {
    let callCount = 0;
    mswServer.use(
      http.get("/api/health", () => {
        callCount++;
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );

    await expect(getHealth()).rejects.toThrow();
    expect(callCount).toBe(1);

    await expect(getHealth()).rejects.toThrow();
    expect(callCount).toBe(2);
  });

  it("concurrent GET calls to different URLs are not deduplicated", async () => {
    let healthCount = 0;
    let sessionsCount = 0;
    mswServer.use(
      http.get("/api/health", () => {
        healthCount++;
        return HttpResponse.json({ status: "ok", hostname: "test-host" });
      }),
      http.get("/api/sessions", () => {
        sessionsCount++;
        return HttpResponse.json([]);
      }),
    );

    await Promise.all([getHealth(), getSessions("runkit")]);
    expect(healthCount).toBe(1);
    expect(sessionsCount).toBe(1);
  });

  it("concurrent callers both receive the same rejection on failure", async () => {
    mswServer.use(
      http.get("/api/health", () => {
        return HttpResponse.json({ error: "server down" }, { status: 500 });
      }),
    );

    const results = await Promise.allSettled([getHealth(), getHealth()]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });

  it("setSessionOrder sends POST /api/sessions/order with JSON body and server query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: { order?: string[] } = {};
    let capturedContentType = "";
    mswServer.use(
      http.post("/api/sessions/order", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        capturedContentType = request.headers.get("content-type") ?? "";
        capturedBody = (await request.json()) as { order?: string[] };
        return HttpResponse.json({ ok: true });
      }),
    );
    await setSessionOrder("default", ["main", "dev"]);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("?server=default");
    expect(capturedContentType).toContain("application/json");
    expect(capturedBody.order).toEqual(["main", "dev"]);
  });

});

// --- Verb migration + unified /options contract (this change) ---

describe("POST verb migration + /options contract", () => {
  it("setWindowColor POSTs /options with @rk_win_color as a single-index string", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: { options?: Record<string, string | null> } = {};
    mswServer.use(
      http.post("/api/windows/:windowId/options", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        capturedBody = (await request.json()) as typeof capturedBody;
        return HttpResponse.json({ ok: true });
      }),
    );
    await setWindowColor("default", "@2", "5");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/windows\/%402\/options\?server=default$/);
    expect(capturedBody.options).toEqual({ "@rk_win_color": "5" });
  });

  it("setWindowColor POSTs /options with @rk_win_color as a blend string", async () => {
    let capturedBody: { options?: Record<string, string | null> } = {};
    mswServer.use(
      http.post("/api/windows/:windowId/options", async ({ request }) => {
        capturedBody = (await request.json()) as typeof capturedBody;
        return HttpResponse.json({ ok: true });
      }),
    );
    await setWindowColor("default", "@2", "1+3");
    expect(capturedBody.options).toEqual({ "@rk_win_color": "1+3" });
  });

  it("setWindowColor sends @rk_win_color: null to clear", async () => {
    let capturedBody: { options?: Record<string, string | null> } = {};
    mswServer.use(
      http.post("/api/windows/:windowId/options", async ({ request }) => {
        capturedBody = (await request.json()) as typeof capturedBody;
        return HttpResponse.json({ ok: true });
      }),
    );
    await setWindowColor("default", "@2", null);
    expect(capturedBody.options).toEqual({ "@rk_win_color": null });
  });

  it("setWindowRole POSTs /options with @rk_win_role; null and empty string both clear", async () => {
    const bodies: Array<{ options?: Record<string, string | null> }> = [];
    mswServer.use(
      http.post("/api/windows/:windowId/options", async ({ request }) => {
        bodies.push((await request.json()) as { options?: Record<string, string | null> });
        return HttpResponse.json({ ok: true });
      }),
    );
    await setWindowRole("default", "@2", "operator");
    await setWindowRole("default", "@2", null);
    await setWindowRole("default", "@2", "");
    expect(bodies[0].options).toEqual({ "@rk_win_role": "operator" });
    expect(bodies[1].options).toEqual({ "@rk_win_role": "" });
    expect(bodies[2].options).toEqual({ "@rk_win_role": "" });
  });

  it("setWindowFlair POSTs /options with @rk_win_flair; null and empty string both clear", async () => {
    const bodies: Array<{ options?: Record<string, string | null> }> = [];
    mswServer.use(
      http.post("/api/windows/:windowId/options", async ({ request }) => {
        bodies.push((await request.json()) as { options?: Record<string, string | null> });
        return HttpResponse.json({ ok: true });
      }),
    );
    await setWindowFlair("s", "@1", "nyan");
    await setWindowFlair("s", "@1", null);
    await setWindowFlair("s", "@1", "");
    expect(bodies[0].options).toEqual({ "@rk_win_flair": "nyan" });
    expect(bodies[1].options).toEqual({ "@rk_win_flair": "" });
    expect(bodies[2].options).toEqual({ "@rk_win_flair": "" });
  });

  it("setSessionFlair POSTs /api/sessions/{session}/flair with {flair}; null clears", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const bodies: Array<{ flair?: string | null }> = [];
    mswServer.use(
      http.post("/api/sessions/:session/flair", async ({ request }) => {
        capturedUrl = request.url;
        capturedMethod = request.method;
        bodies.push((await request.json()) as { flair?: string | null });
        return HttpResponse.json({ ok: true });
      }),
    );
    await setSessionFlair("default", "alpha", "naruto");
    await setSessionFlair("default", "alpha", null);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toMatch(/\/api\/sessions\/alpha\/flair\?server=default$/);
    expect(bodies).toEqual([{ flair: "naruto" }, { flair: null }]);
  });

  it("setThemePreference issues POST (not PUT) with the changed keys as a patch", async () => {
    let capturedMethod = "";
    let capturedBody: Record<string, unknown> = {};
    mswServer.use(
      http.post("/api/settings", async ({ request }) => {
        capturedMethod = request.method;
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await setThemePreference({ theme: "dark" });
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toEqual({ theme: "dark" });
  });

  it("setServerColor posts a one-entry server_colors patch (null clears)", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/settings", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await setServerColor("default", "7");
    await setServerColor("default", "1+3");
    await setServerColor("default", null);
    expect(bodies).toEqual([
      { server_colors: { default: "7" } },
      { server_colors: { default: "1+3" } },
      { server_colors: { default: null } },
    ]);
  });

  it("getAllServerFlairs reads the server_flairs entry from GET /api/settings", async () => {
    mswServer.use(
      http.get("/api/settings", () =>
        HttpResponse.json({
          settings: [settingsEntry("server_flairs", "map", { default: "nyan", dev: "cube" })],
        }),
      ),
    );
    await expect(getAllServerFlairs()).resolves.toEqual({ default: "nyan", dev: "cube" });
  });

  it("setServerFlair posts a one-entry server_flairs patch; null clears", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/settings", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await setServerFlair("default", "cube");
    await setServerFlair("default", null);
    expect(bodies).toEqual([
      { server_flairs: { default: "cube" } },
      { server_flairs: { default: null } },
    ]);
  });

  it("setServerFlair rejects on a non-2xx (e.g. 400 unknown token)", async () => {
    mswServer.use(
      http.post("/api/settings", () =>
        HttpResponse.json({ error: "Flair must be one of: ..." }, { status: 400 }),
      ),
    );
    await expect(setServerFlair("default", "sparkle")).rejects.toThrow();
  });
});

describe("maintenance actions (force update + restart)", () => {
  it("triggerForceUpdate POSTs /api/update with {force:true}", async () => {
    let capturedMethod = "";
    let capturedBody: { force?: boolean } = {};
    mswServer.use(
      http.post("/api/update", async ({ request }) => {
        capturedMethod = request.method;
        capturedBody = (await request.json()) as typeof capturedBody;
        return HttpResponse.json({ status: "updating" }, { status: 202 });
      }),
    );
    await triggerForceUpdate();
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toEqual({ force: true });
  });

  it("triggerForceUpdate rejects on a non-2xx (e.g. 409 not-brew)", async () => {
    mswServer.use(
      http.post("/api/update", () =>
        HttpResponse.json({ error: "not brew" }, { status: 409 }),
      ),
    );
    await expect(triggerForceUpdate()).rejects.toThrow();
  });

  it("triggerRestart POSTs /api/restart with an empty body", async () => {
    let capturedMethod = "";
    let capturedBody: Record<string, unknown> = {};
    mswServer.use(
      http.post("/api/restart", async ({ request }) => {
        capturedMethod = request.method;
        capturedBody = (await request.json()) as typeof capturedBody;
        return HttpResponse.json({ status: "restarting" }, { status: 202 });
      }),
    );
    await triggerRestart();
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toEqual({});
  });

  it("triggerRestart rejects on a non-2xx (e.g. 409 on a dev build)", async () => {
    mswServer.use(
      http.post("/api/restart", () =>
        HttpResponse.json({ error: "dev" }, { status: 409 }),
      ),
    );
    await expect(triggerRestart()).rejects.toThrow();
  });
});

describe("update trigger watch-target parse", () => {
  const WATCH = { server: "rk-daemon", session: "rk-jobs", window: "update", window_id: "@5" };

  it("triggerUpdate resolves the status + watch target from a 202", async () => {
    mswServer.use(
      http.post("/api/update", () =>
        HttpResponse.json({ status: "updating", watch: WATCH }, { status: 202 }),
      ),
    );
    const result = await triggerUpdate();
    expect(result).toEqual({ status: "updating", watch: WATCH });
  });

  it("a 200 already-running is a RESOLVED result carrying the existing window", async () => {
    mswServer.use(
      http.post("/api/update", () =>
        HttpResponse.json({ status: "already-running", watch: WATCH }, { status: 200 }),
      ),
    );
    const result = await triggerUpdate();
    expect(result.status).toBe("already-running");
    expect(result.watch).toEqual(WATCH);
  });

  it("an old-daemon body ({status} only) resolves with watch undefined", async () => {
    mswServer.use(
      http.post("/api/update", () => HttpResponse.json({ status: "updating" }, { status: 202 })),
    );
    const result = await triggerUpdate();
    expect(result).toEqual({ status: "updating", watch: undefined });
  });

  it("a malformed watch key resolves with watch undefined", async () => {
    mswServer.use(
      http.post("/api/update", () =>
        HttpResponse.json({ status: "updating", watch: { server: "rk-daemon" } }, { status: 202 }),
      ),
    );
    const result = await triggerUpdate();
    expect(result.status).toBe("updating");
    expect(result.watch).toBeUndefined();
  });

  it("triggerRestart parses the same shape", async () => {
    const restartWatch = { ...WATCH, window: "restart", window_id: "@9" };
    mswServer.use(
      http.post("/api/restart", () =>
        HttpResponse.json({ status: "restarting", watch: restartWatch }, { status: 202 }),
      ),
    );
    const result = await triggerRestart();
    expect(result).toEqual({ status: "restarting", watch: restartWatch });
  });

  it("triggerForceUpdate parses the same shape", async () => {
    mswServer.use(
      http.post("/api/update", () =>
        HttpResponse.json({ status: "updating", watch: WATCH }, { status: 202 }),
      ),
    );
    const result = await triggerForceUpdate();
    expect(result).toEqual({ status: "updating", watch: WATCH });
  });
});

describe("checkForUpdates source wiring", () => {
  function withCheckResponse(body: Record<string, unknown>) {
    let capturedBody: Record<string, unknown> = {};
    mswServer.use(
      http.post("/api/updates/check", async ({ request }) => {
        capturedBody = (await request.json()) as typeof capturedBody;
        return HttpResponse.json(body);
      }),
    );
    return () => capturedBody;
  }

  const githubRow = {
    tool: "run-kit",
    current: "3.8.0",
    latest: "3.9.1",
    updateAvailable: true,
    notable: false,
  };

  it("default check POSTs an empty body and parses the echoed source", async () => {
    const body = withCheckResponse({ tools: [], key: "", source: "released" });
    const result = await checkForUpdates();
    expect(body()).toEqual({});
    expect(result).toEqual({ tools: [], key: "", source: "released" });
  });

  it('checkForUpdates("github") POSTs {"source":"github"} and parses the echoed source', async () => {
    const body = withCheckResponse({ tools: [githubRow], key: "", source: "github" });
    const result = await checkForUpdates("github");
    expect(body()).toEqual({ source: "github" });
    expect(result.source).toBe("github");
    expect(result.tools).toEqual([githubRow]);
  });

  it("defaults source to an empty string when an old daemon omits it", async () => {
    withCheckResponse({ tools: [], key: "" });
    const result = await checkForUpdates();
    expect(result.source).toBe("");
  });
});

describe("refreshStatus tri-state body", () => {
  function withStatusBody(body: { status: string }) {
    mswServer.use(
      http.post("/api/status/refresh", () => HttpResponse.json(body, { status: 202 })),
    );
  }

  it("returns {status:started} for a started 202 body", async () => {
    withStatusBody({ status: "started" });
    expect(await refreshStatus()).toEqual({ status: "started" });
  });

  it("returns {status:coalesced} for a coalesced 202 body", async () => {
    withStatusBody({ status: "coalesced" });
    expect(await refreshStatus()).toEqual({ status: "coalesced" });
  });

  it("returns {status:throttled} for a throttled 202 body", async () => {
    withStatusBody({ status: "throttled" });
    expect(await refreshStatus()).toEqual({ status: "throttled" });
  });

  it("defaults a legacy {status:refreshing} body to started (spin-until-event)", async () => {
    withStatusBody({ status: "refreshing" });
    expect(await refreshStatus()).toEqual({ status: "started" });
  });

  it("defaults an empty/unparseable body to started", async () => {
    mswServer.use(
      http.post("/api/status/refresh", () => new HttpResponse(null, { status: 202 })),
    );
    expect(await refreshStatus()).toEqual({ status: "started" });
  });

  it("rejects on a non-2xx", async () => {
    mswServer.use(
      http.post("/api/status/refresh", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    await expect(refreshStatus()).rejects.toThrow();
  });
});

describe("infra-server identification", () => {
  const si = (name: string): ServerInfo => ({ name, sessionCount: 0 });

  it("DAEMON_SERVER is the daemon socket name", () => {
    expect(DAEMON_SERVER).toBe("rk-daemon");
  });

  it("isInfraServer matches the exact daemon socket", () => {
    expect(isInfraServer("rk-daemon")).toBe(true);
  });

  it("isInfraServer matches any rk-test- prefixed name", () => {
    expect(isInfraServer("rk-test-e2e")).toBe(true);
    expect(isInfraServer("rk-test-e2e-web-123-456")).toBe(true);
    expect(isInfraServer("rk-test-")).toBe(true);
  });

  it("isInfraServer rejects near-misses", () => {
    expect(isInfraServer("rk-daemon2")).toBe(false);
    expect(isInfraServer("my-rk-daemon")).toBe(false);
    expect(isInfraServer("rktest")).toBe(false);
    expect(isInfraServer("rk-tes")).toBe(false);
    expect(isInfraServer("default")).toBe(false);
    expect(isInfraServer("work")).toBe(false);
  });

  it("compareServers sorts regular servers before infra servers", () => {
    const sorted = [si("rk-daemon"), si("work"), si("default")]
      .sort(compareServers)
      .map((s) => s.name);
    expect(sorted).toEqual(["default", "work", "rk-daemon"]);
  });

  it("compareServers sorts alphabetically within the infra class (byte order)", () => {
    const sorted = [si("rk-test-b"), si("rk-daemon"), si("rk-test-a")]
      .sort(compareServers)
      .map((s) => s.name);
    // "rk-daemon" < "rk-test-a" < "rk-test-b" in byte order.
    expect(sorted).toEqual(["rk-daemon", "rk-test-a", "rk-test-b"]);
  });

  it("compareServers keeps an all-regular list byte-alphabetical (unchanged from backend order)", () => {
    const sorted = [si("charlie"), si("alpha"), si("bravo")]
      .sort(compareServers)
      .map((s) => s.name);
    expect(sorted).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("compareServers interleaves regular and infra correctly from an already-alphabetical input", () => {
    // Mirrors the backend's alphabetical /api/servers response.
    const sorted = [
      si("alpha"),
      si("rk-daemon"),
      si("rk-test-e2e"),
      si("zeta"),
    ]
      .sort(compareServers)
      .map((s) => s.name);
    expect(sorted).toEqual(["alpha", "zeta", "rk-daemon", "rk-test-e2e"]);
  });
});

describe("rank-aware server ordering (compareServersRanked)", () => {
  const sr = (name: string, rank?: number | null): ServerInfo => ({
    name,
    sessionCount: 0,
    rank: rank ?? null,
  });

  it("sorts regular servers by rank ascending", () => {
    const sorted = [sr("b", 1), sr("a", 0), sr("c", 2)]
      .sort(compareServersRanked)
      .map((s) => s.name);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("sorts unranked regular servers after ranked ones (byte-alphabetical among themselves)", () => {
    const sorted = [sr("zebra"), sr("alpha"), sr("mid", 0)]
      .sort(compareServersRanked)
      .map((s) => s.name);
    // "mid" (rank 0) leads; the two unranked follow in byte order.
    expect(sorted).toEqual(["mid", "alpha", "zebra"]);
  });

  it("mixes ranked and unranked correctly", () => {
    // b:1, a:null, a2:0, rk-daemon:null(infra) → a2, b, a, rk-daemon
    const sorted = [sr("b", 1), sr("a"), sr("a2", 0), sr("rk-daemon")]
      .sort(compareServersRanked)
      .map((s) => s.name);
    expect(sorted).toEqual(["a2", "b", "a", "rk-daemon"]);
  });

  it("keeps infra servers pinned last and ignores their rank", () => {
    // Even if an infra server somehow carries a low rank, it stays in the
    // infra class (last), and intra-infra order is byte-alphabetical.
    const sorted = [sr("rk-test-b", 0), sr("work", 5), sr("rk-daemon", 1)]
      .sort(compareServersRanked)
      .map((s) => s.name);
    expect(sorted).toEqual(["work", "rk-daemon", "rk-test-b"]);
  });

  it("keeps an all-regular-unranked list byte-alphabetical (unchanged from compareServers)", () => {
    const input = [sr("charlie"), sr("alpha"), sr("bravo")];
    const ranked = [...input].sort(compareServersRanked).map((s) => s.name);
    const plain = [...input].sort(compareServers).map((s) => s.name);
    expect(ranked).toEqual(["alpha", "bravo", "charlie"]);
    expect(ranked).toEqual(plain);
  });

  it("sinks ephemeral servers among unranked regulars (byte order within each group)", () => {
    const input = [
      { name: "alpha", sessionCount: 0, rank: null, ephemeral: true },
      sr("beta"),
      { name: "zeta", sessionCount: 0, rank: null, ephemeral: true },
      sr("rk-daemon"),
    ];
    const sorted = input.sort(compareServersRanked).map((s) => s.name);
    expect(sorted).toEqual(["beta", "alpha", "zeta", "rk-daemon"]);
  });

  it("rank wins over the ephemeral key", () => {
    const input = [
      sr("plain", 1),
      { name: "scratch", sessionCount: 0, rank: 0, ephemeral: true },
    ];
    const sorted = input.sort(compareServersRanked).map((s) => s.name);
    expect(sorted).toEqual(["scratch", "plain"]);
  });

  it("ignores ephemeral on infra servers (intra-infra order stays byte-alphabetical)", () => {
    const input = [
      { name: "rk-test-b", sessionCount: 0, rank: null, ephemeral: true },
      sr("work"),
      sr("rk-daemon"),
    ];
    const sorted = input.sort(compareServersRanked).map((s) => s.name);
    expect(sorted).toEqual(["work", "rk-daemon", "rk-test-b"]);
  });
});

// settingsEntry builds one GET /api/settings payload row for the msw stubs —
// only the fields the client reads (key, value) need to be meaningful.
function settingsEntry(key: string, kind: string, value: unknown) {
  return { key, kind, default: "", description: "", category: "", ui: true, live: true, value };
}

describe("settings client (registry-driven GET/POST /api/settings)", () => {
  it("getHealth surfaces the optional instanceName field when present", async () => {
    mswServer.use(
      http.get("/api/health", () =>
        HttpResponse.json({ status: "ok", hostname: "test-host", instanceName: "my-box" }),
      ),
    );
    const health = await getHealth();
    expect(health.instanceName).toBe("my-box");
    expect(health.hostname).toBe("test-host");
  });

  it.each([
    { key: "ssh_host", value: "devbox", get: getSSHHost },
    { key: "instance_name", value: "my-box", get: getInstanceName },
  ] as const)("get $key resolves stored and unset values", async ({ key, value, get }) => {
    mswServer.use(
      http.get("/api/settings", () =>
        HttpResponse.json({ settings: [settingsEntry(key, "string", value)] }),
      ),
    );
    await expect(get()).resolves.toBe(value);

    mswServer.use(
      http.get("/api/settings", () =>
        HttpResponse.json({ settings: [settingsEntry(key, "string", null)] }),
      ),
    );
    await expect(get()).resolves.toBeNull();
  });

  it.each([
    {
      key: "ssh_host",
      value: "devbox",
      invalid: "dev box",
      error: "SSH host cannot contain whitespace or control characters",
      set: setSSHHost,
    },
    {
      key: "instance_name",
      value: "my-box",
      invalid: "bad",
      error: "Instance name cannot contain control characters",
      set: setInstanceName,
    },
  ] as const)("set $key patches, clears, and surfaces validation errors", async ({ key, value, invalid, error, set }) => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/settings", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await set(value);
    await set(null);
    expect(bodies).toEqual([{ [key]: value }, { [key]: null }]);

    mswServer.use(
      http.post("/api/settings", () => HttpResponse.json({ error }, { status: 400 })),
    );
    await expect(set(invalid)).rejects.toThrow(error);
  });

  it("concurrent getters collapse into one deduplicated GET /api/settings", async () => {
    let getCount = 0;
    mswServer.use(
      http.get("/api/settings", () => {
        getCount++;
        return HttpResponse.json({
          settings: [
            settingsEntry("theme", "enum", "system"),
            settingsEntry("theme_dark", "string", "default-dark"),
            settingsEntry("theme_light", "string", "default-light"),
            settingsEntry("instance_color", "color", "4"),
            settingsEntry("ssh_host", "string", "devbox"),
            settingsEntry("instance_name", "string", "my-box"),
            settingsEntry("server_colors", "map", { dev: "7" }),
            settingsEntry("server_flairs", "map", { dev: "nyan" }),
          ],
        });
      }),
    );
    const [theme, sshHost, name, color, colors, flairs, serverColor] = await Promise.all([
      getThemePreference(),
      getSSHHost(),
      getInstanceName(),
      getInstanceColor(),
      getAllServerColors(),
      getAllServerFlairs(),
      getServerColor("dev"),
    ]);
    expect(getCount).toBe(1);
    expect(theme).toEqual({ theme: "system", themeDark: "default-dark", themeLight: "default-light" });
    expect(sshHost).toBe("devbox");
    expect(name).toBe("my-box");
    expect(color).toBe("4");
    expect(colors).toEqual({ dev: "7" });
    expect(flairs).toEqual({ dev: "nyan" });
    expect(serverColor).toBe("7");
  });

  it("getServerColor resolves null for a server with no entry", async () => {
    mswServer.use(
      http.get("/api/settings", () =>
        HttpResponse.json({ settings: [settingsEntry("server_colors", "map", { dev: "7" })] }),
      ),
    );
    await expect(getServerColor("prod")).resolves.toBeNull();
  });

  it("getSettingsEntries returns the raw registry rows, enum options included", async () => {
    mswServer.use(
      http.get("/api/settings", () =>
        HttpResponse.json({
          settings: [
            {
              key: "log_level",
              kind: "enum",
              default: "info",
              description: "Daemon log verbosity",
              category: "advanced",
              ui: true,
              live: false,
              options: ["info", "debug"],
              value: "debug",
            },
            settingsEntry("ssh_host", "string", null),
          ],
        }),
      ),
    );
    const entries = await getSettingsEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      key: "log_level",
      kind: "enum",
      live: false,
      options: ["info", "debug"],
      value: "debug",
    });
    // Non-enum rows carry no options key at all (omitempty on the wire).
    expect(entries[1]).not.toHaveProperty("options");
  });

  it("postSettings POSTs a partial-merge patch; a 400 rejects with the server message", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/settings", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await postSettings({ auto_name: true, ssh_host: null });
    expect(bodies).toEqual([{ auto_name: true, ssh_host: null }]);

    mswServer.use(
      http.post("/api/settings", () =>
        HttpResponse.json({ error: "unknown settings key: nope" }, { status: 400 }),
      ),
    );
    await expect(postSettings({ nope: 1 })).rejects.toThrow("unknown settings key: nope");
  });
});

describe("fetchWindowHistory (terminal export)", () => {
  it("GETs /api/windows/{id}/history with the server query and returns the text body", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get("/api/windows/:windowId/history", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse("line one\nline two\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }),
    );
    const body = await fetchWindowHistory("rk", "@5");
    expect(capturedUrl).toContain("/api/windows/%405/history");
    expect(capturedUrl).toContain("server=rk");
    expect(body).toBe("line one\nline two\n");
  });

});

describe("fetchCodeWorkspace (tab-keyed workspace derivation)", () => {
  it("GETs /api/windows/{id}/code-workspace with the server query and resolves ok with path/root", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get("/api/windows/:windowId/code-workspace", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          path: "/home/u/.local/state/hexokit/code/default/@7-3fa1c9.code-workspace",
          root: "/home/u/code/x",
        });
      }),
    );
    const result = await fetchCodeWorkspace("default", "@7");
    expect(capturedUrl).toContain("/api/windows/%407/code-workspace");
    expect(capturedUrl).toContain("server=default");
    expect(result).toEqual({
      status: "ok",
      path: "/home/u/.local/state/hexokit/code/default/@7-3fa1c9.code-workspace",
      root: "/home/u/code/x",
    });
  });

  it("a 409 resolves to { status: \"no-root\" } — a typed status, not a throw", async () => {
    mswServer.use(
      http.get("/api/windows/:windowId/code-workspace", () =>
        HttpResponse.json({ error: "window has no code root" }, { status: 409 }),
      ),
    );
    await expect(fetchCodeWorkspace("default", "@7")).resolves.toEqual({ status: "no-root" });
  });

  it("other non-ok responses throw as usual", async () => {
    mswServer.use(
      http.get("/api/windows/:windowId/code-workspace", () =>
        HttpResponse.json({ error: "ensure failed" }, { status: 500 }),
      ),
    );
    try {
      await fetchCodeWorkspace("default", "@7");
      expect.fail("fetchCodeWorkspace should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.status).toBe(500);
      expect(err.message).toBe("ensure failed");
    }
  });
});

describe("fetchCodeBridge (first-boot rescue status)", () => {
  it("GETs /api/windows/{id}/code-bridge with the server query and resolves ok with installed/startedAt/emptyBootAt", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get("/api/windows/:windowId/code-bridge", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          installed: true,
          startedAt: "2026-09-10T02:45:39.941Z",
          emptyBootAt: "2026-09-10T02:45:40.000Z",
        });
      }),
    );
    const result = await fetchCodeBridge("default", "@7");
    expect(capturedUrl).toContain("/api/windows/%407/code-bridge");
    expect(capturedUrl).toContain("server=default");
    expect(result).toEqual({
      status: "ok",
      installed: true,
      startedAt: "2026-09-10T02:45:39.941Z",
      emptyBootAt: "2026-09-10T02:45:40.000Z",
    });
  });

  it("an older backend without emptyBootAt resolves it as the empty string", async () => {
    mswServer.use(
      http.get("/api/windows/:windowId/code-bridge", () =>
        HttpResponse.json({ installed: true, startedAt: "2026-09-10T02:45:39.941Z" }),
      ),
    );
    await expect(fetchCodeBridge("default", "@7")).resolves.toEqual({
      status: "ok",
      installed: true,
      startedAt: "2026-09-10T02:45:39.941Z",
      emptyBootAt: "",
    });
  });

  it("a non-2xx (an old backend's 404) resolves to unavailable and never throws", async () => {
    mswServer.use(
      http.get("/api/windows/:windowId/code-bridge", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    await expect(fetchCodeBridge("default", "@7")).resolves.toEqual({ status: "unavailable" });
  });

  it("a network error resolves to unavailable and never throws", async () => {
    mswServer.use(
      http.get("/api/windows/:windowId/code-bridge", () => HttpResponse.error()),
    );
    await expect(fetchCodeBridge("default", "@7")).resolves.toEqual({ status: "unavailable" });
  });
});

describe("gui client (host-global /api/gui/*)", () => {
  const STATUS = {
    id: "host",
    enabled: true,
    backend: "Xtigervnc",
    reachable: false,
    display: ":10",
    width: 1920,
    height: 1080,
    viewers: 0,
    wm: "",
    geometry: "1920x1080",
    socket: "/run/host.sock",
    session: "rk-gui",
    reason: "no VNC backend: sudo apt install tigervnc-standalone-server openbox",
    apps: [{ name: "chromium", count: 3 }],
    uptime_seconds: 15120,
  };

  it("fetchGuiStatus GETs /api/gui/host and resolves the status document", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get("/api/gui/:id", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(STATUS);
      }),
    );
    const result = await fetchGuiStatus();
    expect(capturedUrl).toContain("/api/gui/host");
    expect(result).toEqual(STATUS);
  });

  it("fetchGuiStatus throws on a non-ok response", async () => {
    mswServer.use(
      http.get("/api/gui/:id", () =>
        HttpResponse.json({ error: "invalid gui id" }, { status: 400 }),
      ),
    );
    await expect(fetchGuiStatus("nope")).rejects.toBeInstanceOf(ApiError);
  });

  it("restartGui POSTs and resolves { ok: true } on 200", async () => {
    let method = "";
    mswServer.use(
      http.post("/api/gui/:id/restart", ({ request }) => {
        method = request.method;
        return HttpResponse.json({ status: "ok" });
      }),
    );
    await expect(restartGui()).resolves.toEqual({ ok: true });
    expect(method).toBe("POST");
  });

  it("restartGui maps a 409 (gui disabled) to { ok: false, disabled: true }, never a throw", async () => {
    mswServer.use(
      http.post("/api/gui/:id/restart", () =>
        HttpResponse.json({ error: "gui disabled" }, { status: 409 }),
      ),
    );
    await expect(restartGui()).resolves.toEqual({ ok: false, disabled: true });
  });

  it("restartGui throws on other non-ok responses", async () => {
    mswServer.use(
      http.post("/api/gui/:id/restart", () =>
        HttpResponse.json({ error: "kill failed" }, { status: 500 }),
      ),
    );
    try {
      await restartGui();
      expect.fail("restartGui should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.status).toBe(500);
      expect(err.message).toBe("kill failed");
    }
  });

  it("launchGuiApp POSTs the app body and resolves the parsed ok:false ladder-miss body (a 200 by design)", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const hint = "no browser on the GUI host — sudo apt install chromium-browser";
    mswServer.use(
      http.post("/api/gui/:id/launch", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ ok: false, app: "browser", hint });
      }),
    );
    await expect(launchGuiApp("browser")).resolves.toEqual({ ok: false, app: "browser", hint });
    expect(capturedUrl).toContain("/api/gui/host/launch");
    expect(capturedBody).toEqual({ app: "browser" });
  });

  it("launchGuiApp resolves the parsed ok:true body on 200", async () => {
    mswServer.use(
      http.post("/api/gui/:id/launch", () =>
        HttpResponse.json({ ok: true, app: "terminal", argv0: "xterm", pid: 4321 }),
      ),
    );
    await expect(launchGuiApp("terminal")).resolves.toEqual({
      ok: true,
      app: "terminal",
      argv0: "xterm",
      pid: 4321,
    });
  });

  it("launchGuiApp throws on a 409 (gui disabled) via throwOnError", async () => {
    mswServer.use(
      http.post("/api/gui/:id/launch", () =>
        HttpResponse.json({ error: "gui disabled" }, { status: 409 }),
      ),
    );
    try {
      await launchGuiApp("terminal");
      expect.fail("launchGuiApp should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.status).toBe(409);
      expect(err.message).toBe("gui disabled");
    }
  });

  it("resizeGui POSTs the geometry body to /api/gui/host/resize and resolves the parsed body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    mswServer.use(
      http.post("/api/gui/:id/resize", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true, geometry: "1600x900", was: "1920x1080" });
      }),
    );
    await expect(resizeGui("1600x900")).resolves.toEqual({
      ok: true,
      geometry: "1600x900",
      was: "1920x1080",
    });
    expect(capturedUrl).toContain("/api/gui/host/resize");
    expect(capturedBody).toEqual({ geometry: "1600x900" });
  });

  it("resizeGui throws on a non-ok response via throwOnError (the server message)", async () => {
    mswServer.use(
      http.post("/api/gui/:id/resize", () =>
        HttpResponse.json(
          { error: "geometry 100x100 out of range (320–7680 per side)" },
          { status: 400 },
        ),
      ),
    );
    try {
      await resizeGui("100x100");
      expect.fail("resizeGui should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (!(err instanceof ApiError)) return;
      expect(err.status).toBe(400);
      expect(err.message).toBe("geometry 100x100 out of range (320–7680 per side)");
    }
  });

  it("muteCron POSTs {id, muted} to /api/cron/mute with the server query", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    mswServer.use(
      http.post("/api/cron/mute", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(muteCron("runkit", "c_1", true)).resolves.toEqual({ ok: true });
    expect(capturedUrl).toContain("/api/cron/mute?server=runkit");
    expect(capturedBody).toEqual({ id: "c_1", muted: true });
  });

  it("muteCron omits `for` unless a duration is given", async () => {
    const bodies: unknown[] = [];
    mswServer.use(
      http.post("/api/cron/mute", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    await muteCron("runkit", "c_1", true);
    await muteCron("runkit", "c_1", false);
    expect(bodies).toEqual([
      { id: "c_1", muted: true },
      { id: "c_1", muted: false },
    ]);
  });

  it("muteCron includes `for` when a duration is given", async () => {
    let capturedBody: unknown = null;
    mswServer.use(
      http.post("/api/cron/mute", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    await muteCron("runkit", "c_1", true, "2h");
    expect(capturedBody).toEqual({ id: "c_1", muted: true, for: "2h" });
  });

  it("editCron POSTs the body to /api/cron/edit with the server query and resolves the entry", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const entry = {
      id: "c_1",
      name: "renamed",
      schedule: { kind: "every", interval: "30m" },
      target: { kind: "role", role: "operator" },
      payload: "ping",
      lastFired: 0,
    };
    mswServer.use(
      http.post("/api/cron/edit", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json(entry);
      }),
    );
    await expect(
      editCron("runkit", { id: "c_1", name: "renamed" }),
    ).resolves.toEqual(entry);
    expect(capturedUrl).toContain("/api/cron/edit?server=runkit");
    expect(capturedBody).toEqual({ id: "c_1", name: "renamed" });
  });

  it("editCron surfaces the server's 400 error text", async () => {
    mswServer.use(
      http.post("/api/cron/edit", () =>
        HttpResponse.json({ error: "unknown schedule kind" }, { status: 400 }),
      ),
    );
    await expect(
      editCron("runkit", { id: "c_1", schedule: { kind: "nope" } }),
    ).rejects.toThrow("unknown schedule kind");
  });
});
