import type { Page } from "@playwright/test";

// Browser-level `/api/fab-config` stub shared by the Agents-tab e2e spec and
// demo. Stubbing at `page.route` guarantees no run can ever write the
// developer's real `~/.fab-kit/config.yaml`; the daemon's fab wrapper has its
// own Go tests. The stub is stateful: a POST applies set/unset (null) to an
// in-memory system tier, and every GET/POST response serves the resulting
// document, so set → re-render → reset round-trips through the real SPA.

type Scalar = string | number | boolean;

const DEFAULTS: Record<string, Scalar> = {
  "agent.session": "claude",
  "agent.workers": "claude",
  "dispatch.mode": "native",
  "dispatch.column_width": 45,
  "dispatch.min_cols": 50,
  "dispatch.min_rows": 20,
  "dispatch.reap_done": true,
};

const ROLES: Array<[string, "session" | "workers"]> = [
  ["default", "session"],
  ["operator", "session"],
  ["doing", "workers"],
  ["fast", "workers"],
  ["hydrate", "workers"],
  ["review", "workers"],
];

/** Installs the stub (call before `page.goto`); returns the POST bodies seen.
 *  `system` seeds extra system-tier values; `env` keys win over system as
 *  origin `env` from `FAB_TEST_ENV`, carrying the shadowed `systemValue`. */
export async function stubFabConfig(
  page: Page,
  opts: { installed?: boolean; systemPath?: string; system?: Record<string, Scalar>; env?: Record<string, Scalar> } = {},
): Promise<Array<Record<string, unknown>>> {
  const systemPath = opts.systemPath ?? "/home/e2e/.fab-kit/config.yaml";
  const posts: Array<Record<string, unknown>> = [];
  const system = new Map<string, Scalar>([["agent.session", "claude"], ...Object.entries(opts.system ?? {})]);
  const env = opts.env ?? {};
  const envDetail = "FAB_TEST_ENV";

  const document = () => {
    const fields = Object.fromEntries(
      Object.entries(DEFAULTS).map(([key, def]) => {
        const sys = system.get(key);
        if (key in env) {
          return [key, { value: env[key], origin: "env", originDetail: envDetail, ...(sys !== undefined ? { systemValue: sys } : {}) }];
        }
        return [key, sys !== undefined ? { value: sys, origin: "system", originDetail: systemPath } : { value: def, origin: "default" }];
      }),
    );
    const roles = ROLES.map(([role, depth]) => {
      const tierKey = `agent.${depth}`;
      const cell = (leaf: string, inherited: string, source: string) => {
        const key = `agent.profiles.${role}.${leaf}`;
        const sys = system.get(key);
        if (key in env) {
          return {
            override: null,
            effective: String(env[key]),
            source: key,
            origin: "env",
            originDetail: envDetail,
            inherited,
            ...(sys !== undefined ? { systemValue: String(sys) } : {}),
          };
        }
        return sys !== undefined
          ? { override: String(sys), effective: String(sys), source: key, origin: "system", originDetail: systemPath, inherited }
          : { override: null, effective: inherited, source, origin: "default", inherited };
      };
      return {
        role,
        depth,
        provider: cell("provider", String(fields[tierKey].value), tierKey),
        model: cell("model", "", ""),
        effort: cell("effort", "", ""),
      };
    });
    return {
      installed: true,
      systemPath,
      providers: ["agy", "claude", "codex", "kimi"],
      fields,
      roles,
      modelSuggestions: { claude: ["claude-opus-5-5", "claude-sonnet-5-5"], codex: ["gpt-5.6-sol"], agy: [], kimi: [] },
      effortSuggestions: ["low", "medium", "high", "xhigh", "max"],
    };
  };

  await page.route("**/api/fab-config", async (route) => {
    const request = route.request();
    if (opts.installed === false) {
      await route.fulfill({ json: { installed: false } });
      return;
    }
    if (request.method() === "POST") {
      const patch = request.postDataJSON() as Record<string, Scalar | null>;
      posts.push(patch);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) system.delete(key);
        else system.set(key, value);
      }
    }
    await route.fulfill({ json: document() });
  });
  return posts;
}
