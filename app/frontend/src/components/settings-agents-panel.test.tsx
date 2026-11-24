import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import type { FabAgentPreset, FabConfigDocument, FabField, FabModelSuggestion, FabRole, FabRoleCell } from "@/api/client";
import { SettingsAgentsPanel } from "./settings-agents-panel";

// The panel talks to the daemon only through these two functions; mocking them
// keeps every test off the network and off the real ~/.fab-kit/config.yaml.
vi.mock("@/api/client", () => ({
  getFabConfig: vi.fn(),
  postFabConfig: vi.fn(),
}));
import { getFabConfig, postFabConfig } from "@/api/client";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
import { copyToClipboard } from "@/lib/clipboard";

const SYSTEM_PATH = "/home/u/.fab-kit/config.yaml";

type Doc = Extract<FabConfigDocument, { installed: true }>;

const inherited = (effective: string, source: string): FabRoleCell => ({
  override: null,
  effective,
  source,
  origin: "default",
  inherited: effective,
});

const overridden = (value: string, key: string, inheritedValue = ""): FabRoleCell => ({
  override: value,
  effective: value,
  source: key,
  origin: "system",
  originDetail: SYSTEM_PATH,
  inherited: inheritedValue,
});

function role(name: string, depth: FabRole["depth"], tool: string, tier: string): FabRole {
  return {
    role: name,
    depth,
    tool: inherited(tool, tier),
    model: inherited("", ""),
    effort: inherited("", ""),
  };
}

const field = (value: FabField["value"], origin: FabField["origin"], extra: Partial<FabField> = {}): FabField => ({
  value,
  origin,
  ...(origin === "system" ? { originDetail: SYSTEM_PATH } : {}),
  ...extra,
});

const suggest = (...ids: string[]): FabModelSuggestion[] => ids.map((id) => ({ id }));

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    installed: true,
    systemPath: SYSTEM_PATH,
    tools: ["agy", "claude", "codex", "kimi"],
    fields: {
      "agent.session": field("claude", "system"),
      "agent.workers": field("claude", "default"),
      "dispatch.mode": field("pane", "default"),
      "dispatch.column_width": field(45, "default"),
      "dispatch.min_cols": field(50, "default"),
      "dispatch.min_rows": field(20, "default"),
      "dispatch.reap_done": field(true, "default"),
    },
    roles: [
      role("default", "session", "claude", "agent.session"),
      role("operator", "session", "claude", "agent.session"),
      role("doing", "workers", "claude", "agent.workers"),
      role("fast", "workers", "claude", "agent.workers"),
      role("hydrate", "workers", "claude", "agent.workers"),
      role("review", "workers", "claude", "agent.workers"),
    ],
    modelSuggestions: {
      claude: suggest("claude-opus-5-5", "claude-sonnet-5-5"),
      codex: suggest("gpt-5.6-sol"),
      agy: [],
      kimi: [],
    },
    effortSuggestions: ["low", "medium", "high", "xhigh", "max"],
    effortCapable: { agy: false, claude: true, codex: true, kimi: false },
    ...overrides,
  };
}

function withRole(doc: Doc, name: string, patch: Partial<FabRole>): Doc {
  return { ...doc, roles: doc.roles.map((r) => (r.role === name ? { ...r, ...patch } : r)) };
}

function withField(doc: Doc, key: string, f: FabField): Doc {
  return { ...doc, fields: { ...doc.fields, [key]: f } };
}

async function renderPanel(doc: FabConfigDocument) {
  vi.mocked(getFabConfig).mockResolvedValue(doc);
  render(<SettingsAgentsPanel />);
  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
}

const row = (key: string) => screen.getByTestId(`fab-row-${key}`);

const optionTexts = (el: HTMLElement) =>
  el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => o.textContent) : [];

/** Picks the model list's `Custom…` entry by its label, not its sentinel value. */
function pickCustom(roleName: string) {
  const select = screen.getByLabelText(`${roleName} model`);
  const custom = within(select).getByRole("option", { name: "Custom…" });
  fireEvent.change(select, { target: { value: custom.getAttribute("value") } });
}

beforeEach(() => {
  vi.mocked(getFabConfig).mockReset();
  vi.mocked(postFabConfig).mockReset();
  vi.mocked(copyToClipboard).mockClear();
});

afterEach(cleanup);

describe("SettingsAgentsPanel", () => {
  it("renders CLI chips with the effective one latched", async () => {
    await renderPanel(makeDoc());
    const group = within(row("agent.session")).getByRole("group", { name: "Session CLI" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["agy", "claude", "codex", "kimi"]);
    expect(within(group).getByRole("button", { name: "claude" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "false");
  });

  it("labels the tool controls CLI, never provider", async () => {
    await renderPanel(makeDoc());
    expect(screen.getByRole("region", { name: "Agent CLIs" })).toBeInTheDocument();
    expect(within(row("agent.workers")).getByRole("group", { name: "Worker CLI" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "CLI" })).toBeInTheDocument();
    expect(screen.getByLabelText("doing CLI")).toBeInTheDocument();
    // The footer names the `providers:` config key in <code>; prose and labels never say it.
    expect(screen.queryByText(/provider/i, { ignore: "code, script, style" })).toBeNull();
    expect(screen.queryByLabelText(/provider/i)).toBeNull();
  });

  it("shows provenance chip, modified dot and reset only for system overrides", async () => {
    await renderPanel(makeDoc());
    const session = row("agent.session");
    expect(within(session).getByTestId("provenance-chip")).toHaveTextContent("system");
    expect(within(session).getByTestId("modified-dot")).toHaveAttribute("aria-hidden", "false");
    expect(within(session).getByRole("button", { name: "Reset agent.session" })).toBeInTheDocument();

    const workers = row("agent.workers");
    expect(within(workers).getByTestId("provenance-chip")).toHaveTextContent("default");
    expect(within(workers).getByTestId("modified-dot")).toHaveAttribute("aria-hidden", "true");
    expect(within(workers).queryByRole("button", { name: "Reset agent.workers" })).not.toBeInTheDocument();
  });

  it("picking a chip POSTs just that key and re-renders from the returned document", async () => {
    const next = withField(makeDoc(), "agent.workers", field("codex", "system"));
    vi.mocked(postFabConfig).mockResolvedValue(next);
    await renderPanel(makeDoc());

    fireEvent.click(within(row("agent.workers")).getByRole("button", { name: "codex" }));

    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.workers": "codex" }));
    await waitFor(() =>
      expect(within(row("agent.workers")).getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(within(row("agent.workers")).getByRole("button", { name: "Reset agent.workers" })).toBeInTheDocument();
  });

  it("reset POSTs null for the key", async () => {
    vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    fireEvent.click(within(row("agent.session")).getByRole("button", { name: "Reset agent.session" }));
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.session": null }));
  });

  it("a failed write shows fab's message on that row and keeps the previous value", async () => {
    vi.mocked(postFabConfig).mockRejectedValue(new Error("fab: refusing to set dispatch.mode"));
    await renderPanel(makeDoc());
    fireEvent.click(within(row("dispatch.mode")).getByRole("button", { name: "headless" }));
    expect(await within(row("dispatch.mode")).findByRole("alert")).toHaveTextContent("refusing to set dispatch.mode");
    expect(within(row("dispatch.mode")).getByRole("button", { name: "pane" })).toHaveAttribute("aria-pressed", "true");
    expect(within(row("agent.session")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a failed multi-key write re-reads fab so partially applied keys show", async () => {
    const doc = withField(
      withField(makeDoc(), "dispatch.min_cols", field(80, "system")),
      "dispatch.min_rows",
      field(30, "system"),
    );
    vi.mocked(postFabConfig).mockRejectedValue(new Error("fab config unset dispatch.min_rows --system failed"));
    await renderPanel(doc);
    // min_cols was unset before min_rows failed; the re-read reflects that.
    vi.mocked(getFabConfig).mockResolvedValue(withField(doc, "dispatch.min_cols", field(50, "default")));

    expect(screen.getByLabelText("Split floor columns")).toHaveValue("80");

    fireEvent.click(screen.getByRole("button", { name: "Reset split floor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("min_rows");
    await waitFor(() => expect(screen.getByLabelText("Split floor columns")).toHaveValue("50"));
    expect(getFabConfig).toHaveBeenCalledTimes(2);
  });

  it("warns on an env-shadowed key, naming the variable and the shadowed system value", async () => {
    const doc = withField(
      makeDoc(),
      "agent.workers",
      field("kimi", "env", { originDetail: "FAB_AGENT_WORKERS", systemValue: "codex" }),
    );
    await renderPanel(doc);
    const warning = within(row("agent.workers")).getByTestId("env-shadow-warning");
    expect(warning).toHaveTextContent("$FAB_AGENT_WORKERS");
    expect(warning).toHaveTextContent("system value (codex) is shadowed");
    // A shadowed system value still counts as modified → reset stays reachable.
    expect(within(row("agent.workers")).getByRole("button", { name: "Reset agent.workers" })).toBeInTheDocument();
    expect(within(row("agent.session")).queryByTestId("env-shadow-warning")).not.toBeInTheDocument();
  });

  it("renders a project-origin chip read-only without errors", async () => {
    await renderPanel(withField(makeDoc(), "dispatch.mode", field("native", "project")));
    expect(within(row("dispatch.mode")).getByTestId("provenance-chip")).toHaveTextContent("project");
  });

  describe("dispatch rows", () => {
    it("column width commits on Enter as a number and Escape reverts", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      const input = screen.getByLabelText("Worker column width percent");
      expect(input).toHaveValue("45");

      fireEvent.change(input, { target: { value: "60" } });
      expect(postFabConfig).not.toHaveBeenCalled(); // no per-keystroke commit
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "dispatch.column_width": 60 }));

      fireEvent.change(input, { target: { value: "70" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveValue("45");
      expect(postFabConfig).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-numeric draft inline without calling the API", async () => {
      await renderPanel(makeDoc());
      const input = screen.getByLabelText("Split floor columns");
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.blur(input);
      expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole number");
      expect(postFabConfig).not.toHaveBeenCalled();
    });

    it("min cols and rows commit independently on one row", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      fireEvent.change(screen.getByLabelText("Split floor rows"), { target: { value: "30" } });
      fireEvent.blur(screen.getByLabelText("Split floor rows"));
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "dispatch.min_rows": 30 }));
    });

    it("the reap toggle commits the flipped boolean", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      fireEvent.click(screen.getByRole("switch", { name: "Reap finished panes" }));
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "dispatch.reap_done": false }));
    });

    it("the split floor shows each leaf's own provenance", async () => {
      await renderPanel(withField(makeDoc(), "dispatch.min_rows", field(30, "system")));
      const chips = within(screen.getByTestId("fab-row-dispatch.split-floor")).getAllByTestId("provenance-chip");
      expect(chips.map((c) => c.textContent)).toEqual(["default", "system"]);
    });

    it("the split-floor reset unsets both leaves in one POST", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withField(makeDoc(), "dispatch.min_rows", field(30, "system"));
      await renderPanel(doc);
      fireEvent.click(screen.getByRole("button", { name: "Reset split floor" }));
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({ "dispatch.min_cols": null, "dispatch.min_rows": null }),
      );
    });
  });

  describe("per-role table", () => {
    it("lists the six roles in order with their tier", async () => {
      await renderPanel(makeDoc());
      const rows = screen.getAllByTestId(/^role-row-/);
      expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual([
        "default", "operator", "doing", "fast", "hydrate", "review",
      ]);
      expect(within(rows[0]).getAllByRole("cell")[1]).toHaveTextContent("session");
      expect(within(rows[5]).getAllByRole("cell")[1]).toHaveTextContent("workers");
    });

    it("shows inherited cells dimmed with a ↳ prefix and 'tool default' when unknown", async () => {
      const doc = withRole(makeDoc(), "doing", { tool: inherited("kimi", "agent.workers") });
      await renderPanel(doc);
      const tool = screen.getByLabelText("doing CLI") as HTMLSelectElement;
      expect(tool.value).toBe("");
      expect(tool.options[0].textContent).toBe("↳ kimi");
      expect(tool.className).toContain("text-text-secondary");
      const model = screen.getByLabelText("doing model") as HTMLSelectElement;
      expect(model.value).toBe("");
      expect(model.options[0].textContent).toBe("↳ inherit (tool default)");
      expect(model.className).toContain("text-text-secondary");
    });

    it("labels inherit on an overridden leaf with the value clearing it restores", async () => {
      const doc = withRole(makeDoc(), "review", {
        tool: overridden("codex", "agent.profiles.review.provider", "claude"),
        model: overridden("gpt-5.6-sol", "agent.profiles.review.model", "claude-opus-5-5"),
      });
      await renderPanel(doc);
      const tool = screen.getByLabelText("review CLI") as HTMLSelectElement;
      expect(tool.value).toBe("codex");
      expect(tool.options[0].textContent).toBe("↳ claude");
      const model = screen.getByLabelText("review model") as HTMLSelectElement;
      expect(model.value).toBe("gpt-5.6-sol");
      expect(model.options[0].textContent).toBe("↳ inherit (claude-opus-5-5)");
    });

    it("choosing inherit on an overridden leaf POSTs null for that key", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", { tool: overridden("codex", "agent.profiles.review.provider") });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": null,
          "agent.profiles.review.model": null,
          "agent.profiles.review.effort": null,
        }),
      );
    });

    it("a CLI pick POSTs that role's neutral tool key, unsetting model and effort in the same request", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      fireEvent.change(screen.getByLabelText("operator CLI"), { target: { value: "codex" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.operator.tool": "codex",
          "agent.profiles.operator.model": null,
          "agent.profiles.operator.effort": null,
        }),
      );
      expect(postFabConfig).toHaveBeenCalledTimes(1);
    });

    it("the model list offers inherit, every suggestion and Custom…, whatever model is saved", async () => {
      const doc = withRole(makeDoc(), "doing", { model: overridden("claude-sonnet-5-5", "agent.profiles.doing.model") });
      await renderPanel(doc);
      const model = screen.getByLabelText("doing model") as HTMLSelectElement;
      expect(model.value).toBe("claude-sonnet-5-5");
      expect(optionTexts(model)).toEqual([
        "↳ inherit (tool default)",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "Custom…",
      ]);
    });

    it("lists a pin the tool doesn't suggest as not offered, after the suggestions", async () => {
      const doc = withRole(makeDoc(), "review", {
        tool: inherited("codex", "agent.workers"),
        model: overridden("claude-opus-5-5", "agent.profiles.review.model", "gpt-5.6-sol"),
      });
      await renderPanel(doc);
      const model = screen.getByLabelText("review model") as HTMLSelectElement;
      expect(model.value).toBe("claude-opus-5-5");
      expect(optionTexts(model)).toEqual([
        "↳ inherit (gpt-5.6-sol)",
        "gpt-5.6-sol",
        "claude-opus-5-5 (not offered)",
        "Custom…",
      ]);
    });

    it("with no suggestions the pin is listed plainly and gets no stale note", async () => {
      const doc = withRole(makeDoc(), "review", {
        tool: inherited("kimi", "agent.workers"),
        model: overridden("kimi-k3", "agent.profiles.review.model"),
      });
      await renderPanel(doc);
      expect(optionTexts(screen.getByLabelText("review model"))).toEqual(["↳ inherit (tool default)", "kimi-k3", "Custom…"]);
      expect(screen.queryByTestId("stale-model-review")).not.toBeInTheDocument();
    });

    it("picking a suggestion POSTs it and picking inherit unsets", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "fast", { model: overridden("claude-opus-5-5", "agent.profiles.fast.model") });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("fast model"), { target: { value: "claude-sonnet-5-5" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.fast.model": "claude-sonnet-5-5" }));
      fireEvent.change(screen.getByLabelText("fast model"), { target: { value: "" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.fast.model": null }));
    });

    it("Custom… swaps to a focused text input that commits on Enter and returns to the list", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      pickCustom("doing");
      const input = screen.getByRole("textbox", { name: "doing model" });
      expect(input).toHaveFocus();
      expect(postFabConfig).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: " glm-latest[1m] " } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.model": "glm-latest[1m]" }));
      await waitFor(() => expect(screen.getByLabelText("doing model").tagName).toBe("SELECT"));
      expect(postFabConfig).toHaveBeenCalledTimes(1);
    });

    it("a blank custom commit on blur unsets the model", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "fast", { model: overridden("claude-opus-5-5", "agent.profiles.fast.model") });
      await renderPanel(doc);
      pickCustom("fast");
      const input = screen.getByRole("textbox", { name: "fast model" });
      expect(input).toHaveValue("claude-opus-5-5");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.fast.model": null }));
    });

    it("Escape in the custom input returns to the list without writing or closing the dialog", async () => {
      await renderPanel(makeDoc());
      const onDocumentKey = vi.fn();
      document.addEventListener("keydown", onDocumentKey);
      try {
        pickCustom("doing");
        const input = screen.getByRole("textbox", { name: "doing model" });
        fireEvent.change(input, { target: { value: "half-typed" } });
        fireEvent.keyDown(input, { key: "Escape" });
        expect(screen.getByLabelText("doing model").tagName).toBe("SELECT");
        expect(onDocumentKey).not.toHaveBeenCalled();
        expect(postFabConfig).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("keydown", onDocumentKey);
      }
    });

    it("a rejected custom commit keeps the draft and shows fab's message", async () => {
      vi.mocked(postFabConfig).mockRejectedValue(new Error("fab: refusing to set model"));
      await renderPanel(makeDoc());
      pickCustom("doing");
      const input = screen.getByRole("textbox", { name: "doing model" });
      fireEvent.change(input, { target: { value: "bad-model" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByRole("alert")).toHaveTextContent("refusing to set model");
      expect(screen.getByRole("textbox", { name: "doing model" })).toHaveValue("bad-model");
    });

    it("flags a pin the tool doesn't offer with a note whose action unsets it", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        tool: inherited("codex", "agent.workers"),
        model: overridden("claude-opus-5-5", "agent.profiles.review.model", "gpt-5.6-sol"),
      });
      await renderPanel(doc);
      expect(screen.getByTestId("stale-model-review")).toHaveTextContent(
        "pinned to claude-opus-5-5, which codex doesn't offer — inherit gpt-5.6-sol instead?",
      );
      expect(screen.getByLabelText("review model")).not.toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Inherit gpt-5.6-sol for review model" }));
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.review.model": null }));
    });

    it("words a stale claude pin as tracking the latest, not as unsupported", async () => {
      const doc = withRole(makeDoc(), "review", {
        model: overridden("claude-opus-4-1", "agent.profiles.review.model", "claude-opus-5-5"),
      });
      await renderPanel(doc);
      expect(screen.getByTestId("stale-model-review")).toHaveTextContent(
        "pinned to claude-opus-4-1, not in the list — inherit claude-opus-5-5 to track the latest",
      );
    });

    it("shows no stale note for a pin the tool offers", async () => {
      const doc = withRole(makeDoc(), "review", { model: overridden("claude-opus-5-5", "agent.profiles.review.model") });
      await renderPanel(doc);
      expect(screen.queryByTestId("stale-model-review")).not.toBeInTheDocument();
    });

    it("a tool change keeps model and effort overrides the new tool offers", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        model: overridden("gpt-5.6-sol", "agent.profiles.review.model"),
        effort: overridden("high", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "codex" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.review.tool": "codex" }));
    });

    it("a tool change unsets a model the new tool doesn't offer and keeps a suggested effort", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        model: overridden("claude-opus-5-5", "agent.profiles.review.model"),
        effort: overridden("high", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "codex" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": "codex",
          "agent.profiles.review.model": null,
        }),
      );
    });

    it("a tool change unsets an effort outside the effort suggestions", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        model: overridden("gpt-5.6-sol", "agent.profiles.review.model"),
        effort: overridden("ultra", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "codex" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": "codex",
          "agent.profiles.review.effort": null,
        }),
      );
    });

    it("picking inherit for the tool weighs the overrides against the depth knob's tool", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(withField(makeDoc(), "agent.workers", field("codex", "system")), "review", {
        tool: overridden("claude", "agent.profiles.review.provider", "codex"),
        model: overridden("claude-opus-5-5", "agent.profiles.review.model"),
        effort: overridden("high", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": null,
          "agent.profiles.review.model": null,
        }),
      );
    });

    it("re-picking the tool the row already resolves to writes only the tool key", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "doing", { model: overridden("glm-latest[1m]", "agent.profiles.doing.model") });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("doing CLI"), { target: { value: "claude" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.tool": "claude" }));
    });

    it("effort is a select over the suggestions plus inherit", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      const effort = screen.getByLabelText("doing effort") as HTMLSelectElement;
      expect(Array.from(effort.options).map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
      fireEvent.change(effort, { target: { value: "xhigh" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.effort": "xhigh" }));
    });

    it("a tool change to a tool with {effort} keeps a suggested effort", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        tool: overridden("codex", "agent.profiles.review.provider"),
        effort: overridden("high", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "claude" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": "claude",
          "agent.profiles.review.model": null,
        }),
      );
    });

    it("a tool change to a tool without {effort} unsets a suggested effort", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        tool: overridden("codex", "agent.profiles.review.provider"),
        effort: overridden("high", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review CLI"), { target: { value: "agy" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": "agy",
          "agent.profiles.review.model": null,
          "agent.profiles.review.effort": null,
        }),
      );
    });

    it("disables effort for a tool without {effort}, keeping a stale override visible and resettable", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", {
        tool: inherited("kimi", "agent.workers"),
        effort: overridden("high", "agent.profiles.review.effort"),
      });
      await renderPanel(doc);
      const effort = screen.getByLabelText("review effort") as HTMLSelectElement;
      expect(effort).toBeDisabled();
      expect(effort).toHaveAttribute("title", "this tool takes no effort setting");
      expect(effort.value).toBe("high");
      expect(screen.getByLabelText("doing effort")).toBeEnabled();
      expect(screen.getByLabelText("doing effort")).not.toHaveAttribute("title");

      fireEvent.click(screen.getByRole("button", { name: "Reset review overrides" }));
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": null,
          "agent.profiles.review.model": null,
          "agent.profiles.review.effort": null,
        }),
      );
    });

    it("keeps effort enabled for a tool the document doesn't classify", async () => {
      const doc = withRole(makeDoc({ effortCapable: undefined }), "review", { tool: inherited("kimi", "agent.workers") });
      await renderPanel(doc);
      expect(screen.getByLabelText("review effort")).toBeEnabled();
    });

    it("row reset appears only with an override and unsets all three leaves in one POST", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "hydrate", { effort: overridden("max", "agent.profiles.hydrate.effort") });
      await renderPanel(doc);
      expect(screen.queryByRole("button", { name: "Reset doing overrides" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reset hydrate overrides" }));
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.hydrate.tool": null,
          "agent.profiles.hydrate.model": null,
          "agent.profiles.hydrate.effort": null,
        }),
      );
    });

    it("keeps the row reset when an env var shadows a saved role value", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "doing", {
        tool: {
          override: null,
          effective: "kimi",
          source: "agent.profiles.doing.provider",
          origin: "env",
          originDetail: "FAB_AGENT_PROFILES",
          inherited: "claude",
          systemValue: "codex",
        },
      });
      await renderPanel(doc);
      fireEvent.click(screen.getByRole("button", { name: "Reset doing overrides" }));
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith(expect.objectContaining({ "agent.profiles.doing.tool": null })),
      );
    });

    it("warns when an env var sets a role's CLI", async () => {
      const doc = withRole(makeDoc(), "doing", {
        tool: { override: null, effective: "kimi", source: "agent.profiles.doing.provider", origin: "env", originDetail: "FAB_X", inherited: "claude" },
      });
      await renderPanel(doc);
      expect(screen.getByRole("img", { name: "CLI set by an environment variable" })).toHaveAttribute("title", expect.stringContaining("FAB_X"));
    });

    it("scrolls inside its own wrapper", async () => {
      await renderPanel(makeDoc());
      expect(screen.getByTestId("role-table-wrap").className).toContain("overflow-x-auto");
    });

    it("a failed role write shows the message under the table row", async () => {
      vi.mocked(postFabConfig).mockRejectedValue(new Error("unknown CLI"));
      await renderPanel(makeDoc());
      fireEvent.change(screen.getByLabelText("doing CLI"), { target: { value: "codex" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("unknown CLI");
    });
  });

  it("queues overlapping writes so an older response can't overwrite a newer one", async () => {
    let releaseFirst: (d: FabConfigDocument) => void = () => {};
    vi.mocked(postFabConfig)
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
      .mockResolvedValueOnce(withField(makeDoc(), "dispatch.mode", field("headless", "system")));
    await renderPanel(makeDoc());

    fireEvent.click(within(row("agent.workers")).getByRole("button", { name: "codex" }));
    fireEvent.click(within(row("dispatch.mode")).getByRole("button", { name: "headless" }));
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledTimes(1));

    releaseFirst(withField(makeDoc(), "agent.workers", field("codex", "system")));
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(row("dispatch.mode")).getByRole("button", { name: "headless" })).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("shows fab's POST warnings verbatim", async () => {
    vi.mocked(postFabConfig).mockResolvedValue(
      makeDoc({ warnings: ["fab: warning: agent.workers is shadowed by env $FAB_AGENT_WORKERS"] }),
    );
    await renderPanel(makeDoc());
    fireEvent.click(within(row("agent.workers")).getByRole("button", { name: "codex" }));
    expect(await screen.findByTestId("fab-warnings")).toHaveTextContent("shadowed by env $FAB_AGENT_WORKERS");
  });

  it("footer explains the unsettable keys and copies the config path", async () => {
    await renderPanel(makeDoc());
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" &&
          /^The CLI table \(providers: \/ clis:\) and other list\/map keys can't be set\s+from the command line\.$/.test(
            el.textContent?.trim() ?? "",
          ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Project-only keys \(fab\/project\/config.yaml\) aren't shown here/)).toBeInTheDocument();
    expect(screen.getByTestId("fab-system-path")).toHaveTextContent(SYSTEM_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Copy fab system config path" }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(SYSTEM_PATH));
  });

  it("shows the graceful empty state when fab is not installed", async () => {
    await renderPanel({ installed: false });
    expect(screen.getByTestId("fab-not-installed")).toHaveTextContent(
      "fab isn't installed on this host. Install fab-kit to manage agent defaults here.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("surfaces a load failure inline", async () => {
    vi.mocked(getFabConfig).mockRejectedValue(new Error("Request failed: 502"));
    render(<SettingsAgentsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed: 502");
  });

  it("fetches again on every mount (no client cache)", async () => {
    await renderPanel(makeDoc());
    cleanup();
    await renderPanel(makeDoc());
    expect(getFabConfig).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsAgentsPanel — discovered models", () => {
  const claudeModels: FabModelSuggestion[] = [
    { id: "glm-latest[1m]", label: "GLM 5.3 (Latest)", efforts: ["low", "high"] },
    { id: "opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-fable-5-1[1m]", default: true, efforts: ["low", "max"] },
  ];
  const kimiModels: FabModelSuggestion[] = Array.from({ length: 40 }, (_, i) => ({
    id: `kimi-a${i}`,
    label: i === 3 ? "Kimi K3.1 Pro" : undefined,
    default: i === 0,
  })).concat([{ id: "openrouter/moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro (router)", default: false }]);

  const kimiDoc = (model: FabRoleCell = inherited("", "")) =>
    withRole(makeDoc({ modelSuggestions: { ...makeDoc().modelSuggestions, kimi: kimiModels } }), "doing", {
      tool: inherited("kimi", "agent.workers"),
      model,
    });

  const trigger = (name = "doing") => screen.getByRole("button", { name: `${name} model` });
  const filter = (name = "doing") => screen.getByRole("combobox", { name: `Search ${name} models` });
  // Scoped to the open list: the other rows' native selects expose options too.
  const listOptions = () => within(screen.getByRole("listbox")).getAllByRole("option");
  const listOption = (name: string | RegExp) => within(screen.getByRole("listbox")).getByRole("option", { name });
  const optionLabels = () => listOptions().map((o) => o.textContent);

  describe("labels and default marker", () => {
    it("shows `label · id` when they differ, the id alone when not, and marks the tool default", async () => {
      await renderPanel(makeDoc({ modelSuggestions: { ...makeDoc().modelSuggestions, claude: claudeModels } }));
      expect(optionTexts(screen.getByLabelText("doing model"))).toEqual([
        "↳ inherit (tool default)",
        "GLM 5.3 (Latest) · glm-latest[1m]",
        "opus",
        "claude-fable-5-1[1m] · tool default",
        "Custom…",
      ]);
    });

    it("commits the id, not the display text", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc({ modelSuggestions: { ...makeDoc().modelSuggestions, claude: claudeModels } }));
      fireEvent.change(screen.getByLabelText("doing model"), { target: { value: "glm-latest[1m]" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.model": "glm-latest[1m]" }));
    });

    it("keeps a native select at the threshold and turns searchable above it", async () => {
      const thirty = { ...makeDoc().modelSuggestions, claude: suggest(...Array.from({ length: 30 }, (_, i) => `m${i}`)) };
      await renderPanel(makeDoc({ modelSuggestions: thirty }));
      expect(screen.getByLabelText("doing model").tagName).toBe("SELECT");
      cleanup();
      await renderPanel(
        makeDoc({ modelSuggestions: { ...thirty, claude: suggest(...Array.from({ length: 31 }, (_, i) => `m${i}`)) } }),
      );
      expect(screen.getByLabelText("doing model").tagName).toBe("BUTTON");
    });
  });

  describe("searchable list", () => {
    it("opens unfiltered with a saved override, listing every suggestion plus inherit and Custom…", async () => {
      await renderPanel(kimiDoc(overridden("kimi-a7", "agent.profiles.doing.model")));
      expect(trigger()).toHaveTextContent("kimi-a7");
      fireEvent.click(trigger());
      expect(filter()).toHaveValue("");
      expect(listOptions()).toHaveLength(kimiModels.length + 2);
      expect(optionLabels()[0]).toBe("↳ inherit (tool default)");
      expect(optionLabels().at(-1)).toBe("Custom…");
    });

    it("dims the closed trigger while inheriting and disables it while a write is in flight", async () => {
      vi.mocked(postFabConfig).mockReturnValue(new Promise(() => {}));
      await renderPanel(kimiDoc());
      expect(trigger()).toHaveTextContent("↳ inherit (tool default)");
      expect(trigger().className).toContain("text-text-secondary");
      fireEvent.click(trigger());
      fireEvent.click(listOption(/kimi-a1$/));
      await waitFor(() => expect(trigger()).toBeDisabled());
    });

    it("filters by label and by id, always keeping inherit and Custom…", async () => {
      await renderPanel(kimiDoc());
      fireEvent.click(trigger());

      fireEvent.change(filter(), { target: { value: "K3.1" } });
      expect(optionLabels()).toEqual([
        "↳ inherit (tool default)",
        expect.stringContaining("Kimi K3.1 Pro"),
        expect.stringContaining("Kimi K3.1 Pro (router)"),
        "Custom…",
      ]);

      fireEvent.change(filter(), { target: { value: "moonshotai" } });
      expect(optionLabels()).toEqual([
        "↳ inherit (tool default)",
        expect.stringContaining("Kimi K3.1 Pro (router)"),
        "Custom…",
      ]);

      fireEvent.change(filter(), { target: { value: "no-such-model" } });
      expect(optionLabels()).toEqual(["↳ inherit (tool default)", "Custom…"]);
    });

    it("shows the label as primary text with the id and default marker beside it", async () => {
      await renderPanel(kimiDoc());
      fireEvent.click(trigger());
      const labelled = listOptions().find((o) => o.textContent?.includes("Kimi K3.1 Pro"));
      expect(labelled).toHaveTextContent("Kimi K3.1 Pro");
      expect(labelled).toHaveTextContent("kimi-a3");
      expect(listOption(/kimi-a0/)).toHaveTextContent("tool default");
    });

    it("Enter commits the first match after typing, as one POST of its id", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(kimiDoc());
      fireEvent.click(trigger());
      fireEvent.change(filter(), { target: { value: "moonshotai" } });
      fireEvent.keyDown(filter(), { key: "Enter" });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.doing.model": "openrouter/moonshotai/kimi-k3.1-pro",
        }),
      );
      expect(postFabConfig).toHaveBeenCalledTimes(1);
    });

    it("arrow keys move the active option and Enter commits it", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(kimiDoc());
      fireEvent.click(trigger());
      // Starts on inherit; two steps down is the second suggestion.
      fireEvent.keyDown(filter(), { key: "ArrowDown" });
      fireEvent.keyDown(filter(), { key: "ArrowDown" });
      fireEvent.keyDown(filter(), { key: "ArrowUp" });
      expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
      fireEvent.keyDown(filter(), { key: "Enter" });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.model": "kimi-a0" }));
    });

    it("clicking an option commits it and picking inherit unsets", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(kimiDoc(overridden("kimi-a7", "agent.profiles.doing.model")));
      await renderPanel(kimiDoc(overridden("kimi-a7", "agent.profiles.doing.model")));
      fireEvent.click(trigger());
      fireEvent.click(listOption(/kimi-a9$/));
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.model": "kimi-a9" }));
      fireEvent.click(trigger());
      fireEvent.click(listOption(/↳ inherit/));
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.model": null }));
    });

    it("Escape closes without committing and never reaches the dialog", async () => {
      await renderPanel(kimiDoc());
      const onDocumentKey = vi.fn();
      document.addEventListener("keydown", onDocumentKey);
      try {
        fireEvent.click(trigger());
        fireEvent.change(filter(), { target: { value: "k3" } });
        fireEvent.keyDown(filter(), { key: "Escape" });
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(trigger()).toBeInTheDocument();
        expect(onDocumentKey).not.toHaveBeenCalled();
        expect(postFabConfig).not.toHaveBeenCalled();
        fireEvent.click(trigger());
        expect(filter()).toHaveValue("");
      } finally {
        document.removeEventListener("keydown", onDocumentKey);
      }
    });

    it("Custom… swaps to the free-text input", async () => {
      await renderPanel(kimiDoc());
      fireEvent.click(trigger());
      fireEvent.click(listOption("Custom…"));
      expect(screen.getByRole("textbox", { name: "doing model" })).toHaveFocus();
    });

    it("lists a pin the tool no longer offers and flags it", async () => {
      await renderPanel(kimiDoc(overridden("kimi-gone", "agent.profiles.doing.model")));
      expect(trigger()).toHaveTextContent("kimi-gone (not offered)");
      expect(screen.getByTestId("stale-model-doing")).toHaveTextContent("kimi-gone");
    });
  });

  describe("stale pins", () => {
    it("compare against discovered ids, so a custom model the tool offers is not flagged", async () => {
      const models = { ...makeDoc().modelSuggestions, claude: claudeModels };
      await renderPanel(
        withRole(makeDoc({ modelSuggestions: models }), "doing", {
          model: overridden("glm-latest[1m]", "agent.profiles.doing.model"),
        }),
      );
      expect(screen.queryByTestId("stale-model-doing")).not.toBeInTheDocument();
      cleanup();
      await renderPanel(
        withRole(makeDoc({ modelSuggestions: models }), "doing", {
          model: overridden("claude-opus-5-5", "agent.profiles.doing.model"),
        }),
      );
      expect(screen.getByTestId("stale-model-doing")).toBeInTheDocument();
    });
  });

  describe("effort options", () => {
    const codexModels: FabModelSuggestion[] = [
      { id: "gpt-6.1-sol", default: true, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { id: "gpt-5.6-sol", efforts: ["low", "medium", "high"] },
    ];
    const effortValues = (name: string) =>
      Array.from((screen.getByLabelText(`${name} effort`) as HTMLSelectElement).options).map((o) => o.value);
    const codexDoc = (model: FabRoleCell, suggestions = codexModels) =>
      withRole(makeDoc({ modelSuggestions: { ...makeDoc().modelSuggestions, codex: suggestions } }), "doing", {
        tool: inherited("codex", "agent.workers"),
        model,
      });

    it("offers the effective model's own efforts, including ultra", async () => {
      await renderPanel(codexDoc(overridden("gpt-6.1-sol", "agent.profiles.doing.model")));
      expect(effortValues("doing")).toEqual(["", "low", "medium", "high", "xhigh", "max", "ultra"]);
      cleanup();
      await renderPanel(codexDoc(overridden("gpt-5.6-sol", "agent.profiles.doing.model")));
      expect(effortValues("doing")).toEqual(["", "low", "medium", "high"]);
    });

    it("uses the default model's efforts when the effective model is empty", async () => {
      await renderPanel(codexDoc(inherited("", "")));
      expect(effortValues("doing")).toEqual(["", "low", "medium", "high", "xhigh", "max", "ultra"]);
    });

    it("falls back to the tool's union when the model reports none, then to the global list", async () => {
      await renderPanel(codexDoc(overridden("typed-by-hand", "agent.profiles.doing.model")));
      expect(effortValues("doing")).toEqual(["", "low", "medium", "high", "xhigh", "max", "ultra"]);
      cleanup();
      await renderPanel(codexDoc(overridden("a", "agent.profiles.doing.model"), suggest("a", "b")));
      expect(effortValues("doing")).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    });

    it("keeps an override outside the list visible and the disabled state for tools without {effort}", async () => {
      const doc = withRole(codexDoc(overridden("gpt-5.6-sol", "agent.profiles.doing.model")), "doing", {
        effort: overridden("ultra", "agent.profiles.doing.effort"),
      });
      await renderPanel(doc);
      expect(effortValues("doing")).toEqual(["", "low", "medium", "high", "ultra"]);
      cleanup();
      await renderPanel(
        withRole(makeDoc({ modelSuggestions: { ...makeDoc().modelSuggestions, kimi: kimiModels } }), "doing", {
          tool: inherited("kimi", "agent.workers"),
        }),
      );
      expect(screen.getByLabelText("doing effort")).toBeDisabled();
    });
  });

  describe("tool change", () => {
    const docWith = (effort: string, model: string) =>
      withRole(
        makeDoc({
          modelSuggestions: {
            ...makeDoc().modelSuggestions,
            claude: suggest("opus", "claude-opus-5-5"),
            codex: [
              { id: "gpt-6.1-sol", efforts: ["low", "medium", "high"] },
              { id: "gpt-5.6-sol", efforts: ["low"] },
            ],
          },
        }),
        "doing",
        {
          model: overridden(model, "agent.profiles.doing.model"),
          effort: overridden(effort, "agent.profiles.doing.effort"),
        },
      );

    it("clears a model the new tool doesn't offer and an effort outside its set", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(docWith("xhigh", "opus"));
      fireEvent.change(screen.getByLabelText("doing CLI"), { target: { value: "codex" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.doing.tool": "codex",
          "agent.profiles.doing.model": null,
          "agent.profiles.doing.effort": null,
        }),
      );
      expect(postFabConfig).toHaveBeenCalledTimes(1);
    });

    it("keeps a model id and an effort the new tool offers", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(docWith("medium", "gpt-5.6-sol"));
      fireEvent.change(screen.getByLabelText("doing CLI"), { target: { value: "codex" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.tool": "codex" }));
    });
  });

  describe("tool default", () => {
    const toolDefaults: Record<string, FabModelSuggestion> = {
      claude: { id: "tool-default", label: "tool default (claude-fable-5-1[1m])", efforts: ["low", "max"] },
      codex: { id: "tool-default", label: "tool default (gpt-6.1-sol)", efforts: ["low", "high", "ultra"] },
      kimi: { id: "tool-default", label: "tool default (kimi-a0)" },
    };
    const codexModels: FabModelSuggestion[] = [
      { id: "gpt-6.1-sol", default: true, efforts: ["low", "medium"] },
      { id: "gpt-5.6-sol", efforts: ["low"] },
    ];
    const docOn = (tool: string, model: FabRoleCell, defaults: Record<string, FabModelSuggestion> | undefined) =>
      withRole(
        makeDoc({
          modelSuggestions: { ...makeDoc().modelSuggestions, codex: codexModels, kimi: kimiModels },
          toolDefaults: defaults,
        }),
        "doing",
        { tool: inherited(tool, "agent.workers"), model },
      );
    const pinnedToToolDefault = () => overridden("tool-default", "agent.profiles.doing.model", "gpt-5.6-sol");

    it("is the second option, labelled from fab, and picking it POSTs fab's value", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(docOn("codex", inherited("gpt-5.6-sol", "clis.codex.profiles.doing.model"), toolDefaults));
      expect(optionTexts(screen.getByLabelText("doing model"))).toEqual([
        "↳ inherit (gpt-5.6-sol)",
        "↳ tool default (gpt-6.1-sol)",
        "gpt-6.1-sol · tool default",
        "gpt-5.6-sol",
        "Custom…",
      ]);
      fireEvent.change(screen.getByLabelText("doing model"), { target: { value: "tool-default" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.model": "tool-default" }));
    });

    it("is absent for a tool fab reports no default value for", async () => {
      await renderPanel(docOn("codex", inherited("", ""), undefined));
      expect(optionTexts(screen.getByLabelText("doing model"))).toEqual([
        "↳ inherit (tool default)",
        "gpt-6.1-sol · tool default",
        "gpt-5.6-sol",
        "Custom…",
      ]);
    });

    it("shows a row holding it as the tool default, never as a stale pin", async () => {
      await renderPanel(docOn("codex", pinnedToToolDefault(), toolDefaults));
      const select = screen.getByLabelText("doing model") as HTMLSelectElement;
      expect(select.selectedOptions[0]).toHaveTextContent("↳ tool default (gpt-6.1-sol)");
      expect(optionTexts(select).some((t) => t?.includes("not offered"))).toBe(false);
      expect(screen.queryByTestId("stale-model-doing")).not.toBeInTheDocument();
    });

    it("without fab naming it, the value is an ordinary unoffered pin", async () => {
      await renderPanel(docOn("codex", pinnedToToolDefault(), undefined));
      expect(optionTexts(screen.getByLabelText("doing model"))).toContain("tool-default (not offered)");
      expect(screen.getByTestId("stale-model-doing")).toBeInTheDocument();
    });

    it("reads an inherited tool-default value as 'tool default'", async () => {
      await renderPanel(docOn("codex", inherited("tool-default", "clis.codex.profiles.doing.model"), toolDefaults));
      expect(optionTexts(screen.getByLabelText("doing model"))[0]).toBe("↳ inherit (tool default)");
    });

    it("stays listed under any filter in the searchable list and shows on its trigger", async () => {
      await renderPanel(docOn("kimi", inherited("", ""), toolDefaults));
      fireEvent.click(trigger());
      expect(optionLabels()[1]).toBe("↳ tool default (kimi-a0)");
      fireEvent.change(filter(), { target: { value: "no-such-model" } });
      expect(optionLabels()).toEqual(["↳ inherit (tool default)", "↳ tool default (kimi-a0)", "Custom…"]);
      cleanup();
      await renderPanel(
        docOn("kimi", overridden("tool-default", "agent.profiles.doing.model", "kimi-a0"), toolDefaults),
      );
      expect(trigger()).toHaveTextContent("↳ tool default (kimi-a0)");
      expect(screen.queryByTestId("stale-model-doing")).not.toBeInTheDocument();
    });

    it("is never where Enter lands after typing", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(docOn("kimi", inherited("", ""), toolDefaults));
      fireEvent.click(trigger());
      fireEvent.change(filter(), { target: { value: "moonshotai" } });
      fireEvent.keyDown(filter(), { key: "Enter" });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.doing.model": "openrouter/moonshotai/kimi-k3.1-pro",
        }),
      );
    });

    it("offers the tool default's efforts when the row uses it or no model", async () => {
      const effortValues = () =>
        Array.from((screen.getByLabelText("doing effort") as HTMLSelectElement).options).map((o) => o.value);
      await renderPanel(docOn("codex", pinnedToToolDefault(), toolDefaults));
      expect(effortValues()).toEqual(["", "low", "high", "ultra"]);
      cleanup();
      await renderPanel(docOn("codex", inherited("", ""), toolDefaults));
      expect(effortValues()).toEqual(["", "low", "high", "ultra"]);
    });

    it("a tool change keeps it when the new tool has a default value and clears it otherwise", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(docOn("codex", pinnedToToolDefault(), toolDefaults));
      fireEvent.change(screen.getByLabelText("doing CLI"), { target: { value: "claude" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.doing.tool": "claude",
          "agent.profiles.doing.effort": null,
        }),
      );
      cleanup();
      vi.mocked(postFabConfig).mockClear();
      await renderPanel(docOn("codex", pinnedToToolDefault(), toolDefaults));
      fireEvent.change(screen.getByLabelText("doing CLI"), { target: { value: "agy" } });
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.doing.tool": "agy",
          "agent.profiles.doing.model": null,
          "agent.profiles.doing.effort": null,
        }),
      );
    });
  });

  describe("warnings", () => {
    it("renders the GET document's warnings on load", async () => {
      await renderPanel(makeDoc({ warnings: ["warning: codex: codex debug models: timed out after 3s"] }));
      expect(screen.getByTestId("fab-warnings")).toHaveTextContent("codex debug models: timed out after 3s");
    });

    it("a POST replaces them with its own", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc({ warnings: ["warning: after write"] }));
      await renderPanel(makeDoc({ warnings: ["warning: on load"] }));
      fireEvent.click(within(row("agent.workers")).getByRole("button", { name: "codex" }));
      await waitFor(() => expect(screen.getByTestId("fab-warnings")).toHaveTextContent("after write"));
      expect(screen.getByTestId("fab-warnings")).not.toHaveTextContent("on load");
    });
  });
});

describe("SettingsAgentsPanel — agent presets", () => {
  const PRESETS: FabAgentPreset[] = [
    { name: "claude", description: "All roles on Claude", source: "built-in", session: "claude", workers: "claude" },
    {
      name: "codex-review",
      description: "Only the review role on Codex",
      source: "built-in",
      profiles: { review: { cli: "codex" } },
    },
    { name: "codex-workers", description: "Pipeline workers on Codex", source: "built-in", workers: "codex" },
  ];

  /** The base machine (system session, everything else default) plus the preset list. */
  function presetDoc(overrides: Partial<Doc> = {}): Doc {
    const base = makeDoc();
    return makeDoc({
      agent_presets: PRESETS,
      // No explicit values unless a test adds them.
      fields: { ...base.fields, "agent.session": field("claude", "default") },
      ...overrides,
    });
  }

  const select = () => screen.getByTestId("agent-preset-select") as HTMLSelectElement;
  const toggle = () => screen.getByTestId("agent-customize-toggle");

  /** The doc fab reports with a system-chosen preset: leaves the preset supplied keep the system origin. */
  function withSystemPreset(name: string, doc: Doc = presetDoc()): Doc {
    return withField(doc, "agent.preset", field(name, "system"));
  }

  const presetCell = (effective: string, preset: string): FabRoleCell => ({
    override: null,
    effective,
    source: "agent.profiles.review.cli",
    origin: "system",
    originDetail: `preset ${preset}`,
    inherited: "claude",
    preset,
  });

  describe("dropdown", () => {
    it("is the first row, above Session CLI, with None then one option per preset", async () => {
      await renderPanel(presetDoc());
      const rows = within(screen.getByRole("region", { name: "Agent CLIs" })).getAllByTestId(/^fab-row-/);
      expect(rows[0]).toHaveAttribute("data-testid", "fab-row-agent.preset");
      expect(within(row("agent.preset")).getByText("Agent preset")).toBeInTheDocument();
      expect(optionTexts(select())).toEqual([
        "None",
        "claude — All roles on Claude",
        "codex-review — Only the review role on Codex",
        "codex-workers — Pipeline workers on Codex",
      ]);
      expect(select()).toHaveValue("");
    });

    it("selects the current preset and shows its provenance", async () => {
      await renderPanel(withSystemPreset("codex-review"));
      expect(select()).toHaveValue("codex-review");
      expect(within(row("agent.preset")).getByTestId("provenance-chip")).toHaveTextContent("system");
      expect(within(row("agent.preset")).getByRole("button", { name: "Reset agent.preset" })).toBeInTheDocument();
    });

    it("choosing a preset POSTs it and shows it after the re-read", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(withSystemPreset("codex-review"));
      await renderPanel(presetDoc());
      fireEvent.change(select(), { target: { value: "codex-review" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.preset": "codex-review" }));
      await waitFor(() => expect(select()).toHaveValue("codex-review"));
    });

    it("choosing None POSTs null", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(presetDoc());
      await renderPanel(withSystemPreset("claude"));
      fireEvent.change(select(), { target: { value: "" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.preset": null }));
      await waitFor(() => expect(select()).toHaveValue(""));
    });

    it("reset POSTs null like None does", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(presetDoc());
      await renderPanel(withSystemPreset("claude"));
      fireEvent.click(within(row("agent.preset")).getByRole("button", { name: "Reset agent.preset" }));
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.preset": null }));
    });

    it("shows a shell-set `none` as an extra option that stays selected", async () => {
      await renderPanel(withSystemPreset("none"));
      expect(select()).toHaveValue("none");
      expect(optionTexts(select())).toContain("none (opts out of project presets)");
    });

    it("offers `none` only when it is the current value", async () => {
      await renderPanel(presetDoc());
      expect(optionTexts(select()).some((t) => t?.startsWith("none"))).toBe(false);
    });

    it("keeps a preset fab no longer lists visible as `<name> (unknown)` and clearable", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(presetDoc());
      await renderPanel(withSystemPreset("gone"));
      expect(select()).toHaveValue("gone");
      expect(optionTexts(select())).toContain("gone (unknown)");
      fireEvent.change(select(), { target: { value: "" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.preset": null }));
    });

    it("warns when FAB_AGENT_PRESET in the daemon env shadows the saved preset", async () => {
      await renderPanel(
        withField(
          presetDoc(),
          "agent.preset",
          field("codex-review", "env", { originDetail: "FAB_AGENT_PRESET", systemValue: "claude" }),
        ),
      );
      const warning = within(row("agent.preset")).getByTestId("env-shadow-warning");
      expect(warning).toHaveTextContent("$FAB_AGENT_PRESET");
      expect(warning).toHaveTextContent("system value (claude) is shadowed");
    });

    it("shows fab's rejection on the preset row and leaves the selection", async () => {
      vi.mocked(postFabConfig).mockRejectedValue(new Error('agent.preset: unknown agent preset "x"'));
      await renderPanel(presetDoc());
      fireEvent.change(select(), { target: { value: "claude" } });
      expect(await within(row("agent.preset")).findByRole("alert")).toHaveTextContent("unknown agent preset");
      expect(select()).toHaveValue("");
    });

    it("is hidden, with no Customize disclosure, when the installed fab lists no presets", async () => {
      await renderPanel(makeDoc());
      expect(screen.queryByTestId("agent-preset-select")).not.toBeInTheDocument();
      expect(screen.queryByTestId("agent-customize")).not.toBeInTheDocument();
      // The knobs and the role grid render exactly as before.
      expect(within(row("agent.session")).getByRole("group", { name: "Session CLI" })).toBeInTheDocument();
      expect(screen.getByTestId("role-row-review")).toBeInTheDocument();
    });
  });

  describe("override note", () => {
    it("counts explicit values on keys the selected preset sets", async () => {
      const doc = withRole(withSystemPreset("codex-review"), "review", {
        tool: overridden("claude", "agent.profiles.review.cli", "claude"),
      });
      await renderPanel(doc);
      expect(screen.getByTestId("agent-preset-override-note")).toHaveTextContent(
        "1 explicit field overrides parts of this preset — see Customize",
      );
    });

    it("pluralises, counting depth knobs and role leaves together", async () => {
      const doc = withRole(
        withField(withSystemPreset("claude"), "agent.workers", field("kimi", "system")),
        "default",
        { tool: overridden("codex", "agent.profiles.default.cli", "claude") },
      );
      // claude sets session + workers; the explicit session is system-origin, workers is system-origin.
      await renderPanel(withField(doc, "agent.session", field("codex", "system")));
      expect(screen.getByTestId("agent-preset-override-note")).toHaveTextContent(
        "2 explicit fields override parts of this preset — see Customize",
      );
    });

    it("ignores explicit values on keys the preset does not set", async () => {
      const doc = withRole(withSystemPreset("codex-workers"), "review", {
        model: overridden("claude-opus-5-5", "agent.profiles.review.model"),
      });
      await renderPanel(doc);
      expect(screen.queryByTestId("agent-preset-override-note")).not.toBeInTheDocument();
    });

    it("ignores preset-supplied values", async () => {
      const doc = withRole(withSystemPreset("codex-review"), "review", { tool: presetCell("codex", "codex-review") });
      await renderPanel(doc);
      expect(screen.queryByTestId("agent-preset-override-note")).not.toBeInTheDocument();
    });

    it("is absent with no preset selected, and offers no clearing action", async () => {
      const doc = withRole(presetDoc(), "review", {
        tool: overridden("codex", "agent.profiles.review.cli", "claude"),
      });
      await renderPanel(doc);
      expect(screen.queryByTestId("agent-preset-override-note")).not.toBeInTheDocument();

      cleanup();
      await renderPanel(
        withRole(withSystemPreset("codex-review"), "review", {
          tool: overridden("claude", "agent.profiles.review.cli", "claude"),
        }),
      );
      const note = screen.getByTestId("agent-preset-override-note");
      expect(within(note).queryByRole("button")).toBeNull();
      expect(postFabConfig).not.toHaveBeenCalled();
    });
  });

  describe("Customize disclosure", () => {
    it("is collapsed with `0 set explicitly` when nothing is explicit", async () => {
      await renderPanel(presetDoc());
      expect(toggle()).toHaveTextContent("Customize · 0 set explicitly");
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("role-row-review")).not.toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Session CLI" })).not.toBeInTheDocument();
    });

    it("opens and closes from the keyboard-operable toggle", async () => {
      await renderPanel(presetDoc());
      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("role-row-review")).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Session CLI" })).toBeInTheDocument();
      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("role-row-review")).not.toBeInTheDocument();
    });

    it("is expanded when something is set explicitly, and counts it", async () => {
      const doc = withRole(presetDoc(), "review", {
        tool: overridden("codex", "agent.profiles.review.cli", "claude"),
      });
      await renderPanel(doc);
      expect(toggle()).toHaveTextContent("Customize · 1 set explicitly");
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("role-row-review")).toBeInTheDocument();
    });

    it("counts knobs and every role cell, and not preset-supplied or default values", async () => {
      let doc = withField(presetDoc(), "agent.session", field("claude", "system"));
      doc = withField(doc, "agent.workers", field("codex", "system", { preset: "codex-workers", originDetail: "preset codex-workers" }));
      doc = withRole(doc, "doing", { model: overridden("claude-sonnet-5-5", "agent.profiles.doing.model") });
      doc = withRole(doc, "review", { tool: presetCell("codex", "codex-review"), effort: overridden("high", "agent.profiles.review.effort") });
      await renderPanel(doc);
      expect(toggle()).toHaveTextContent("Customize · 3 set explicitly");
    });

    it("counts an env-set value", async () => {
      const doc = withField(presetDoc(), "agent.workers", field("kimi", "env", { originDetail: "FAB_AGENT_WORKERS" }));
      await renderPanel(doc);
      expect(toggle()).toHaveTextContent("Customize · 1 set explicitly");
    });
  });

  describe("preset-supplied values", () => {
    it("shows a supplied knob with a preset chip and no reset link", async () => {
      const doc = withField(
        withSystemPreset("codex-workers"),
        "agent.workers",
        field("codex", "system", { preset: "codex-workers", originDetail: "preset codex-workers" }),
      );
      await renderPanel(doc);
      fireEvent.click(toggle());
      const workers = row("agent.workers");
      expect(within(workers).getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "true");
      const chip = within(workers).getByTestId("provenance-chip");
      expect(chip).toHaveTextContent("preset");
      expect(chip).toHaveAttribute("title", "preset codex-workers");
      expect(within(workers).queryByRole("button", { name: "Reset agent.workers" })).not.toBeInTheDocument();
      expect(within(workers).getByTestId("modified-dot")).toHaveAttribute("aria-hidden", "true");
      expect(toggle()).toHaveTextContent("Customize · 0 set explicitly");
    });

    it("shows a supplied role cell as inherited, with a preset chip and no reset link", async () => {
      const doc = withRole(withSystemPreset("codex-review"), "review", { tool: presetCell("codex", "codex-review") });
      await renderPanel(doc);
      fireEvent.click(toggle());
      const reviewRow = screen.getByTestId("role-row-review");
      const cli = within(reviewRow).getByLabelText("review CLI") as HTMLSelectElement;
      expect(cli).toHaveValue("");
      expect(cli.options[0].textContent).toBe("↳ codex");
      const chip = within(reviewRow).getByTestId("provenance-chip");
      expect(chip).toHaveTextContent("preset");
      expect(chip).toHaveAttribute("title", "preset codex-review");
      expect(within(reviewRow).queryByRole("button", { name: "Reset review overrides" })).not.toBeInTheDocument();
    });

    it("shows no env warning on a leaf an env-chosen preset supplied", async () => {
      const supplied: FabRoleCell = { ...presetCell("codex", "codex-review"), origin: "env", originDetail: "preset codex-review" };
      await renderPanel(withRole(presetDoc(), "review", { tool: supplied }));
      fireEvent.click(toggle());
      expect(within(screen.getByTestId("role-row-review")).queryByRole("img", { name: /CLI set by an environment variable/ })).toBeNull();
    });

    it("still resets an explicit override sitting beside a preset", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(withSystemPreset("codex-review"));
      const doc = withRole(withSystemPreset("codex-review"), "review", {
        tool: overridden("claude", "agent.profiles.review.cli", "claude"),
      });
      await renderPanel(doc);
      fireEvent.click(within(screen.getByTestId("role-row-review")).getByRole("button", { name: "Reset review overrides" }));
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.review.tool": null,
          "agent.profiles.review.model": null,
          "agent.profiles.review.effort": null,
        }),
      );
    });
  });
});
