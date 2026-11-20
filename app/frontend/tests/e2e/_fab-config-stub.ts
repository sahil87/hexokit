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

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Per-tool model suggestions as `fab agent models` reports them: labels,
 *  per-model efforts and a default. kimi lists enough models to exceed the
 *  SPA's searchable-list threshold. */
const KIMI_MODELS = [
  { id: "openrouter/moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro", efforts: ["low", "high", "max"], default: true },
  ...Array.from({ length: 40 }, (_, i) => ({ id: `kimi-alias-${i + 1}` })),
];
const MODEL_SUGGESTIONS = {
  claude: [
    { id: "claude-opus-5-5", efforts: EFFORTS },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: EFFORTS, default: true },
  ],
  codex: [{ id: "gpt-6.1-sol", efforts: [...EFFORTS, "ultra"], default: true }],
  agy: [],
  kimi: KIMI_MODELS,
};
/** Per-tool reserved "use the tool's own default" values, labelled with each
 *  tool's default model as `fab agent models` labels them. */
const TOOL_DEFAULTS = {
  agy: { id: "tool-default", label: "tool default" },
  claude: { id: "tool-default", label: "tool default (claude-sonnet-5-5)", efforts: EFFORTS },
  codex: { id: "tool-default", label: "tool default (gpt-6.1-sol)", efforts: [...EFFORTS, "ultra"] },
  kimi: { id: "tool-default", label: "tool default (openrouter/moonshotai/kimi-k3.1-pro)", efforts: ["low", "high", "max"] },
};

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
      const tool = cell("tool", String(fields[tierKey].value), tierKey);
      // `provider` mirrors `tool` so `just demo --before` can replay this
      // stub against a base SPA that predates the neutral field names.
      return { role, depth, tool, provider: tool, model: cell("model", "", ""), effort: cell("effort", "", "") };
    });
    const tools = ["agy", "claude", "codex", "kimi"];
    return {
      installed: true,
      systemPath,
      tools,
      providers: tools,
      fields,
      roles,
      modelSuggestions: MODEL_SUGGESTIONS,
      toolDefaults: TOOL_DEFAULTS,
      effortSuggestions: EFFORTS,
      effortCapable: { agy: false, claude: true, codex: true, kimi: false },
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
