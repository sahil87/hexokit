import type { Page } from "@playwright/test";

// Browser-level `/api/fab-config` stub shared by the Agents-tab e2e spec and
// demo. Stubbing at `page.route` guarantees no run can ever write the
// developer's real `~/.fab-kit/config.yaml`; the daemon's fab wrapper has its
// own Go tests. The stub is stateful: a POST applies set/unset (null) to an
// in-memory system tier, and every GET/POST response serves the resulting
// document, so set → re-render → reset round-trips through the real SPA.
//
// With `presets: true` the stub also behaves like a fab that lists agent
// presets: the document carries `agent_presets` (fab 2.31.1's three built-ins),
// `agent.preset` is writable, and the chosen preset's leaves are applied BELOW
// explicit system/env values — they keep the choosing layer as their origin and
// carry `originDetail: "preset <name>"` plus `preset`, never an override.
// Without it the stub models a fab that cannot list presets, which is what the
// pre-preset specs and demos run against.
//
// In presets mode the stub also keeps a table of user-defined presets
// (`userPresets` seeds it) and answers the editor's routes: `agent_presets.*`
// leaf writes on `POST /api/fab-config` (an unset of a preset's last leaf
// removes it, like fab), `presets/{duplicate,rename,delete}`,
// `leftovers/{move,clear}` and `GET presets/resolve`. Every multi-write
// request is recorded on the returned array's `ops`.

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

export type StubPreset = {
  description?: string;
  session?: string;
  workers?: string;
  profiles?: Record<string, Record<string, string>>;
};

type StubField = { value: Scalar; origin: string; originDetail?: string; systemValue?: Scalar; preset?: string };

/** The built-in presets `fab agent presets --json` lists, in fab's order. */
const AGENT_PRESETS = [
  { name: "claude", description: "All roles on Claude (today's defaults)", source: "built-in", session: "claude", workers: "claude" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in", profiles: { review: { cli: "codex" } } },
  { name: "codex-workers", description: "Pipeline workers on Codex; session on Claude", source: "built-in", workers: "codex" },
];

/** A preset's leaves by the stub's config keys (a role's `cli` is its `tool`). */
function presetLeaves(preset: StubPreset): Record<string, string> {
  const leaves: Record<string, string> = {};
  if (preset.session) leaves["agent.session"] = preset.session;
  if (preset.workers) leaves["agent.workers"] = preset.workers;
  for (const [role, profile] of Object.entries(preset.profiles ?? {})) {
    for (const [leaf, value] of Object.entries(profile)) {
      leaves[`agent.profiles.${role}.${leaf === "cli" ? "tool" : leaf}`] = value;
    }
  }
  return leaves;
}

/** Installs the stub (call before `page.goto`); returns the POST bodies seen.
 *  `system` seeds extra system-tier values; `env` keys win over system as
 *  origin `env` from `FAB_TEST_ENV`, carrying the shadowed `systemValue`. */
export async function stubFabConfig(
  page: Page,
  opts: {
    installed?: boolean;
    systemPath?: string;
    system?: Record<string, Scalar>;
    env?: Record<string, Scalar>;
    presets?: boolean;
    /** Presets already defined in the system file (presets mode only). */
    userPresets?: Record<string, StubPreset>;
  } = {},
): Promise<StubPosts> {
  const systemPath = opts.systemPath ?? "/home/e2e/.fab-kit/config.yaml";
  // `ops` is non-enumerable so a spec can still `toEqual` the bare patch list.
  const posts = Object.defineProperty([] as Array<Record<string, unknown>>, "ops", {
    value: [] as StubOp[],
    enumerable: false,
  }) as StubPosts;
  // A fab that lists presets starts with nothing set explicitly: an explicit
  // session CLI would be a leftover setting.
  const seeded: Array<[string, Scalar]> = opts.presets ? [] : [["agent.session", "claude"]];
  const system = new Map<string, Scalar>([...seeded, ...Object.entries(opts.system ?? {})]);
  const userPresets = new Map<string, StubPreset>(
    Object.entries(opts.userPresets ?? {}).map(([name, p]) => [name, structuredClone(p)]),
  );
  const listed = () => [
    ...AGENT_PRESETS,
    ...[...userPresets].map(([name, p]) => ({ name, source: "system", ...p })),
  ];
  const env = opts.env ?? {};
  const envDetail = "FAB_TEST_ENV";

  const document = () => {
    // The chosen preset and the layer that chose it (env outranks system).
    const chooser = opts.presets ? ("agent.preset" in env ? "env" : system.has("agent.preset") ? "system" : null) : null;
    const chosenName = chooser === "env" ? String(env["agent.preset"]) : chooser === "system" ? String(system.get("agent.preset")) : "";
    const chosen = listed().find((p) => p.name === chosenName);
    const supplied = chosen ? presetLeaves(chosen) : {};
    const presetOrigin = { origin: chooser ?? "default", originDetail: `preset ${chosenName}`, preset: chosenName };

    const fields: Record<string, StubField> = Object.fromEntries(
      Object.entries(DEFAULTS).map(([key, def]): [string, StubField] => {
        const sys = system.get(key);
        if (key in env) {
          return [key, { value: env[key], origin: "env", originDetail: envDetail, ...(sys !== undefined ? { systemValue: sys } : {}) }];
        }
        if (sys !== undefined) return [key, { value: sys, origin: "system", originDetail: systemPath }];
        if (key in supplied) return [key, { value: supplied[key], ...presetOrigin }];
        return [key, { value: def, origin: "default" }];
      }),
    );
    if (chooser) {
      fields["agent.preset"] = chooser === "env"
        ? { value: chosenName, origin: "env", originDetail: "FAB_AGENT_PRESET", ...(system.has("agent.preset") ? { systemValue: system.get("agent.preset") } : {}) }
        : { value: chosenName, origin: "system", originDetail: systemPath };
    }
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
        if (sys !== undefined) {
          return { override: String(sys), effective: String(sys), source: key, origin: "system", originDetail: systemPath, inherited };
        }
        if (key in supplied) {
          return { override: null, effective: supplied[key], source: key, ...presetOrigin, inherited };
        }
        return { override: null, effective: inherited, source, origin: "default", inherited };
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
      ...(opts.presets ? { agent_presets: listed() } : {}),
    };
  };

  const unsetLoose = () => {
    for (const key of [...system.keys()]) {
      if (key === "agent.session" || key === "agent.workers" || key.startsWith("agent.profiles.")) system.delete(key);
    }
  };

  /** Applies one `agent_presets.<name>[.<field>]` write; a preset left with no
   *  field is removed, as fab does. */
  const applyPresetKey = (key: string, value: Scalar | null) => {
    const [, name, ...rest] = key.split(".");
    const field = rest.join(".");
    if (field === "") {
      if (value === null) userPresets.delete(name);
      return;
    }
    const preset = userPresets.get(name) ?? {};
    const [head, role, leaf] = field.split(".");
    if (head === "profiles") {
      const profiles = { ...(preset.profiles ?? {}) };
      const roleLeaves = { ...(profiles[role] ?? {}) };
      if (value === null) delete roleLeaves[leaf];
      else roleLeaves[leaf] = String(value);
      if (Object.keys(roleLeaves).length > 0) profiles[role] = roleLeaves;
      else delete profiles[role];
      preset.profiles = Object.keys(profiles).length > 0 ? profiles : undefined;
    } else if (head === "description" || head === "session" || head === "workers") {
      preset[head] = value === null ? undefined : String(value);
    }
    const empty = !preset.description && !preset.session && !preset.workers && !preset.profiles;
    if (empty) userPresets.delete(name);
    else userPresets.set(name, JSON.parse(JSON.stringify(preset)));
  };

  const fieldsOf = (name: string): StubPreset => {
    const p = listed().find((x) => x.name === name) as StubPreset | undefined;
    return structuredClone({ description: p?.description, session: p?.session, workers: p?.workers, profiles: p?.profiles });
  };

  /** What `fab agent <role> --preset <name>` resolves: the preset's leaf, else
   *  the explicit system value, else the depth knob. */
  const resolve = (name: string) => {
    const preset = fieldsOf(name);
    return Object.fromEntries(
      ROLES.map(([role, depth]) => {
        const leaves = preset.profiles?.[role] ?? {};
        const knob = preset[depth] ?? String(system.get(`agent.${depth}`) ?? "claude");
        const loose = (leaf: string) => (system.has(`agent.profiles.${role}.${leaf}`) ? String(system.get(`agent.profiles.${role}.${leaf}`)) : "");
        return [role, { cli: leaves.cli ?? (loose("tool") || knob), model: leaves.model ?? loose("model"), effort: leaves.effort ?? loose("effort") }];
      }),
    );
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
        if (key.startsWith("agent_presets.")) applyPresetKey(key, value);
        else if (value === null) system.delete(key);
        else system.set(key, value);
      }
    }
    await route.fulfill({ json: document() });
  });

  await page.route("**/api/fab-config/**", async (route) => {
    const url = new URL(route.request().url());
    const op = url.pathname.replace(/^.*\/api\/fab-config\//, "");
    if (op === "presets/resolve") {
      await route.fulfill({ json: { roles: resolve(url.searchParams.get("name") ?? "") } });
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as Record<string, string>;
    posts.ops.push({ path: op, body });
    if (op === "presets/duplicate") {
      const copy = fieldsOf(body.from);
      if (body.description) copy.description = body.description;
      userPresets.set(body.to, JSON.parse(JSON.stringify(copy)));
    } else if (op === "presets/rename") {
      const moved = userPresets.get(body.from);
      if (moved) userPresets.set(body.to, moved);
      userPresets.delete(body.from);
      if (system.get("agent.preset") === body.from) system.set("agent.preset", body.to);
    } else if (op === "presets/delete") {
      userPresets.delete(body.name);
      if (system.get("agent.preset") === body.name) system.delete("agent.preset");
    } else if (op === "leftovers/move") {
      const base = fieldsOf(String(system.get("agent.preset") ?? ""));
      const moved: StubPreset = { ...base, description: body.description, profiles: { ...(base.profiles ?? {}) } };
      for (const [key, value] of system) {
        if (key === "agent.session" || key === "agent.workers") moved[key === "agent.session" ? "session" : "workers"] = String(value);
        const m = /^agent\.profiles\.([^.]+)\.(tool|cli|provider|model|effort)$/.exec(key);
        if (m && moved.profiles) {
          const leaf = m[2] === "model" || m[2] === "effort" ? m[2] : "cli";
          moved.profiles[m[1]] = { ...(moved.profiles[m[1]] ?? {}), [leaf]: String(value) };
        }
      }
      userPresets.set(body.name, JSON.parse(JSON.stringify(moved)));
      unsetLoose();
      system.set("agent.preset", body.name);
    } else if (op === "leftovers/clear") {
      unsetLoose();
    }
    await route.fulfill({ json: document() });
  });
  return posts;
}

/** One multi-write request the stub saw: the path under `/api/fab-config/`. */
export type StubOp = { path: string; body: Record<string, string> };
/** The `POST /api/fab-config` bodies, with the multi-write requests on `ops`. */
export type StubPosts = Array<Record<string, unknown>> & { ops: StubOp[] };
