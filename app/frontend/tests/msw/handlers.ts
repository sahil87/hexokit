import { http, HttpResponse } from "msw";
import type { ProjectSession } from "@/types";

/** Default mock data — two sessions with windows. */
export const mockSessions: ProjectSession[] = [
  {
    name: "run-kit",
    windows: [
      {
        index: 0,
        windowId: "@0",
        name: "main",
        worktreePath: "~/code/run-kit",
        activity: "active",
        isActiveWindow: true,
        fabChange: "260312-ux92-vite-react-frontend",
        fabStage: "apply",
        activityTimestamp: Math.floor(Date.now() / 1000) - 2,
      },
      {
        index: 1,
        windowId: "@1",
        name: "scratch",
        worktreePath: "~/code/run-kit",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: Math.floor(Date.now() / 1000) - 120,
      },
    ],
  },
  {
    name: "ao-server",
    windows: [
      {
        index: 0,
        windowId: "@2",
        name: "dev",
        worktreePath: "~/code/ao-server",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: Math.floor(Date.now() / 1000) - 300,
      },
    ],
  },
];

let sessions = structuredClone(mockSessions);

export function resetMockSessions() {
  sessions = structuredClone(mockSessions);
}

export const handlers = [
  // GET /api/health
  http.get("/api/health", () => {
    return HttpResponse.json({ status: "ok", hostname: "test-host" });
  }),

  // GET /api/open-apps — default: no wt registry (fail-silent empty)
  http.get("/api/open-apps", () => {
    return HttpResponse.json([]);
  }),

  // GET /api/sessions
  http.get("/api/sessions", () => {
    return HttpResponse.json(sessions);
  }),

  // POST /api/sessions — create session
  http.post("/api/sessions", async ({ request }) => {
    const body = (await request.json()) as { name: string; cwd?: string };
    const newSession: ProjectSession = {
      name: body.name,
      windows: [
        {
          index: 0,
          windowId: `@${Date.now()}`,
          name: "main",
          worktreePath: body.cwd ?? "~",
          activity: "idle",
          isActiveWindow: true,
          activityTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    };
    sessions.push(newSession);
    return HttpResponse.json({ ok: true }, { status: 201 });
  }),

  // POST /api/sessions/:session/kill
  http.post("/api/sessions/:session/kill", ({ params }) => {
    const sessionName = params.session as string;
    sessions = sessions.filter((s) => s.name !== sessionName);
    return HttpResponse.json({ ok: true });
  }),

  // POST /api/sessions/:session/windows — create window
  http.post("/api/sessions/:session/windows", async ({ params, request }) => {
    const sessionName = params.session as string;
    const body = (await request.json()) as { name: string; cwd?: string };
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    const maxIndex = session.windows.reduce((m, w) => Math.max(m, w.index), -1);
    session.windows.push({
      index: maxIndex + 1,
      windowId: `@${Date.now()}`,
      name: body.name,
      worktreePath: body.cwd ?? session.windows[0]?.worktreePath ?? "~",
      activity: "idle",
      isActiveWindow: false,
      activityTimestamp: Math.floor(Date.now() / 1000),
    });
    return HttpResponse.json({ ok: true }, { status: 201 });
  }),

  // POST /api/sessions/:session/windows/:index/kill
  http.post("/api/sessions/:session/windows/:index/kill", ({ params }) => {
    const sessionName = params.session as string;
    const idx = Number(params.index);
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    session.windows = session.windows.filter((w) => w.index !== idx);
    return HttpResponse.json({ ok: true });
  }),

  // POST /api/sessions/:session/windows/:index/rename
  http.post("/api/sessions/:session/windows/:index/rename", async ({ params, request }) => {
    const sessionName = params.session as string;
    const idx = Number(params.index);
    const body = (await request.json()) as { name: string };
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    const win = session.windows.find((w) => w.index === idx);
    if (!win) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    win.name = body.name;
    return HttpResponse.json({ ok: true });
  }),

  // POST /api/sessions/:session/windows/:index/keys
  http.post("/api/sessions/:session/windows/:index/keys", async ({ params, request }) => {
    const sessionName = params.session as string;
    const idx = Number(params.index);
    const body = (await request.json()) as { keys: string };
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    return HttpResponse.json({ ok: true });
  }),

  // GET /api/directories
  http.get("/api/directories", ({ request }) => {
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") ?? "";
    // Mock: return a few directories based on prefix
    const dirs = prefix
      ? [`${prefix}project-a/`, `${prefix}project-b/`]
      : [];
    return HttpResponse.json({ directories: dirs });
  }),

  // GET /api/worktrees
  http.get("/api/worktrees", () => HttpResponse.json({ repo: "", worktrees: [] })),

  // POST /api/sessions/:session/upload
  http.post("/api/sessions/:session/upload", async ({ params }) => {
    const sessionName = params.session as string;
    return HttpResponse.json({ ok: true, path: `/tmp/uploads/${sessionName}/file.txt` });
  }),
];
