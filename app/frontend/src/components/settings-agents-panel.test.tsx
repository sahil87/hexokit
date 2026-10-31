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
});

const overridden = (value: string, key: string): FabRoleCell => ({
  override: value,
  effective: value,
  source: key,
  origin: "system",
  originDetail: SYSTEM_PATH,
});

function role(name: string, depth: FabRole["depth"], provider: string, tier: string): FabRole {
  return {
    role: name,
    depth,
    provider: inherited(provider, tier),
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
    providers: ["agy", "claude", "codex", "kimi"],
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

beforeEach(() => {
  vi.mocked(getFabConfig).mockReset();
  vi.mocked(postFabConfig).mockReset();
  vi.mocked(copyToClipboard).mockClear();
});

afterEach(cleanup);

describe("SettingsAgentsPanel", () => {
  it("renders provider chips with the effective one latched", async () => {
    await renderPanel(makeDoc());
    const group = within(row("agent.session")).getByRole("group", { name: "Session agent" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["agy", "claude", "codex", "kimi"]);
    expect(within(group).getByRole("button", { name: "claude" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "false");
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

    it("shows inherited cells dimmed with a ↳ prefix and 'provider default' when unknown", async () => {
      const doc = withRole(makeDoc(), "doing", { provider: inherited("kimi", "agent.workers") });
      await renderPanel(doc);
      const provider = screen.getByLabelText("doing provider") as HTMLSelectElement;
      expect(provider.value).toBe("");
      expect(provider.options[0].textContent).toBe("↳ kimi");
      expect(provider.className).toContain("text-text-secondary");
      expect(screen.getByLabelText("doing model")).toHaveAttribute("placeholder", "↳ provider default");
    });

    it("choosing inherit on an overridden leaf POSTs null for that key", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "review", { provider: overridden("codex", "agent.profiles.review.provider") });
      await renderPanel(doc);
      fireEvent.change(screen.getByLabelText("review provider"), { target: { value: "" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.review.provider": null }));
    });

    it("a provider pick POSTs that role's provider key", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      fireEvent.change(screen.getByLabelText("operator provider"), { target: { value: "codex" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.operator.provider": "codex" }));
    });

    it("model commits on blur, and clearing it unsets", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "fast", { model: overridden("claude-opus-5-5", "agent.profiles.fast.model") });
      await renderPanel(doc);
      const model = screen.getByLabelText("fast model");
      expect(model).toHaveValue("claude-opus-5-5");
      fireEvent.change(model, { target: { value: "" } });
      fireEvent.blur(model);
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.fast.model": null }));
    });

    it("offers the resolved provider's models as datalist suggestions", async () => {
      await renderPanel(makeDoc());
      const input = screen.getByLabelText("doing model");
      const list = document.getElementById(input.getAttribute("list") ?? "");
      expect(Array.from(list?.querySelectorAll("option") ?? []).map((o) => o.getAttribute("value"))).toEqual([
        "claude-opus-5-5",
        "claude-sonnet-5-5",
      ]);
    });

    it("flags a model override outside the resolved provider's suggestions without blocking", async () => {
      const doc = withRole(makeDoc(), "review", {
        provider: inherited("codex", "agent.workers"),
        model: overridden("claude-opus-5-5", "agent.profiles.review.model"),
      });
      await renderPanel(doc);
      expect(screen.getByRole("img", { name: /model not in the provider/ })).toBeInTheDocument();
      expect(screen.getByLabelText("review model")).not.toBeDisabled();
    });

    it("does not flag a model when the provider has no suggestions", async () => {
      const doc = withRole(makeDoc(), "review", {
        provider: inherited("kimi", "agent.workers"),
        model: overridden("kimi-k3", "agent.profiles.review.model"),
      });
      await renderPanel(doc);
      expect(screen.queryByRole("img", { name: /model not in the provider/ })).not.toBeInTheDocument();
    });

    it("effort is a select over the suggestions plus inherit", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      await renderPanel(makeDoc());
      const effort = screen.getByLabelText("doing effort") as HTMLSelectElement;
      expect(Array.from(effort.options).map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
      fireEvent.change(effort, { target: { value: "xhigh" } });
      await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent.profiles.doing.effort": "xhigh" }));
    });

    it("row reset appears only with an override and unsets all three leaves in one POST", async () => {
      vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
      const doc = withRole(makeDoc(), "hydrate", { effort: overridden("max", "agent.profiles.hydrate.effort") });
      await renderPanel(doc);
      expect(screen.queryByRole("button", { name: "Reset doing overrides" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reset hydrate overrides" }));
      await waitFor(() =>
        expect(postFabConfig).toHaveBeenCalledWith({
          "agent.profiles.hydrate.provider": null,
          "agent.profiles.hydrate.model": null,
          "agent.profiles.hydrate.effort": null,
        }),
      );
    });

    it("warns when an env var sets a role's provider", async () => {
      const doc = withRole(makeDoc(), "doing", {
        provider: { override: null, effective: "kimi", source: "agent.profiles.doing.provider", origin: "env", originDetail: "FAB_X" },
      });
      await renderPanel(doc);
      expect(screen.getByRole("img", { name: "provider set by an environment variable" })).toHaveAttribute("title", expect.stringContaining("FAB_X"));
    });

    it("scrolls inside its own wrapper", async () => {
      await renderPanel(makeDoc());
      expect(screen.getByTestId("role-table-wrap").className).toContain("overflow-x-auto");
    });

    it("a failed role write shows the message under the table row", async () => {
      vi.mocked(postFabConfig).mockRejectedValue(new Error("unknown provider"));
      await renderPanel(makeDoc());
      fireEvent.change(screen.getByLabelText("doing provider"), { target: { value: "codex" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("unknown provider");
    });
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
    expect(screen.getByText(/providers table and other list\/map keys can't be set from the CLI/)).toBeInTheDocument();
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
