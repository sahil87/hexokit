import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import type { FabConfigDocument, FabField, FabRole, FabRoleCell } from "@/api/client";
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
    modelSuggestions: { claude: ["claude-opus-5-5", "claude-sonnet-5-5"], codex: ["gpt-5.6-sol"], agy: [], kimi: [] },
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
