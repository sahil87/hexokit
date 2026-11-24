import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import type { FabAgentPreset, FabConfigDocument, FabField, FabRoleCell, ServerInfo } from "@/api/client";
import type { ProjectSession } from "@/types";
import { resetPresetsIntent, requestPresetsIntent } from "@/lib/agent-presets-intent";
import { SettingsAgentsPanel } from "./settings-agents-panel";

// The panel reaches the daemon only through these functions; mocking them keeps
// every test off the network and off the real ~/.fab-kit/config.yaml.
vi.mock("@/api/client", () => ({
  getFabConfig: vi.fn(),
  postFabConfig: vi.fn(),
  resolveAgentPreset: vi.fn(),
  duplicateAgentPreset: vi.fn(),
  renameAgentPreset: vi.fn(),
  deleteAgentPreset: vi.fn(),
  moveLeftoverSettings: vi.fn(),
  clearLeftoverSettings: vi.fn(),
}));
import {
  clearLeftoverSettings,
  deleteAgentPreset,
  duplicateAgentPreset,
  getFabConfig,
  moveLeftoverSettings,
  postFabConfig,
  renameAgentPreset,
  resolveAgentPreset,
} from "@/api/client";

const SYSTEM_PATH = "/home/u/.fab-kit/config.yaml";
type Doc = Extract<FabConfigDocument, { installed: true }>;

const cell = (effective: string): FabRoleCell => ({ override: null, effective, source: "", origin: "default", inherited: effective });
const field = (value: FabField["value"], origin: FabField["origin"], extra: Partial<FabField> = {}): FabField => ({
  value,
  origin,
  ...(origin === "system" ? { originDetail: SYSTEM_PATH } : {}),
  ...extra,
});

const BUILT_IN: FabAgentPreset[] = [
  { name: "claude", description: "All roles on Claude", source: "built-in", session: "claude", workers: "claude" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in", profiles: { review: { cli: "codex" } } },
  { name: "codex-workers", description: "Pipeline workers on Codex", source: "built-in", workers: "codex" },
];
const NIGHT_SHIFT: FabAgentPreset = {
  name: "night-shift",
  description: "Overnight",
  source: "system",
  workers: "codex",
  profiles: { review: { cli: "codex", effort: "xhigh" } },
};
const SOLO: FabAgentPreset = { name: "solo", description: "Just a description", source: "system" };

const ROLES = [
  ["default", "session"],
  ["operator", "session"],
  ["doing", "workers"],
  ["fast", "workers"],
  ["hydrate", "workers"],
  ["review", "workers"],
] as const;

function makeDoc(over: Partial<Doc> = {}): Doc {
  return {
    installed: true,
    systemPath: SYSTEM_PATH,
    tools: ["claude", "codex"],
    agent_presets: [...BUILT_IN, NIGHT_SHIFT],
    fields: {
      "agent.preset": field("night-shift", "system"),
      "agent.session": field("claude", "default"),
      "agent.workers": field("claude", "default"),
      "dispatch.mode": field("pane", "default"),
      "dispatch.column_width": field(45, "default"),
      "dispatch.min_cols": field(50, "default"),
      "dispatch.min_rows": field(20, "default"),
      "dispatch.reap_done": field(true, "default"),
    },
    roles: ROLES.map(([role, depth]) => ({ role, depth, tool: cell("claude"), model: cell(""), effort: cell("") })),
    modelSuggestions: {
      claude: [{ id: "claude-opus-5-5" }],
      codex: [{ id: "gpt-5.6-sol", efforts: ["high", "xhigh"] }],
    },
    effortSuggestions: ["low", "medium", "high", "xhigh"],
    effortCapable: { claude: true, codex: true },
    ...over,
  };
}

/** A doc with the loose machine-wide values the Customize grid used to set. */
function looseDoc(over: Partial<Doc> = {}): Doc {
  const doc = makeDoc(over);
  return {
    ...doc,
    fields: { ...doc.fields, "agent.workers": field("codex", "system") },
    roles: doc.roles.map((r) =>
      r.role === "review"
        ? { ...r, effort: { override: "low", effective: "low", source: "agent.profiles.review.effort", origin: "system", originDetail: SYSTEM_PATH, inherited: "" } }
        : r,
    ),
  };
}

type Props = Parameters<typeof SettingsAgentsPanel>[0];

async function renderPanel(doc: FabConfigDocument, props: Props = {}) {
  vi.mocked(getFabConfig).mockResolvedValue(doc);
  render(<SettingsAgentsPanel {...props} />);
  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
}

const option = (name: string) => within(screen.getByRole("listbox", { name: "Presets" })).getByRole("option", { name: new RegExp(`^${name}`) });
const choosePreset = (name: string) => fireEvent.click(option(name));
const editor = () => screen.getByTestId("preset-editor");
const nameInput = () => screen.getByLabelText("Preset name") as HTMLInputElement;
const descInput = () => screen.getByLabelText("Preset description") as HTMLInputElement;

const server = (name: string, agent_preset?: string) => ({ name, agent_preset }) as ServerInfo;
const session = (name: string, agent_preset?: string) => ({ name, agent_preset }) as ProjectSession;

beforeEach(() => {
  for (const fn of [getFabConfig, postFabConfig, duplicateAgentPreset, renameAgentPreset, deleteAgentPreset, moveLeftoverSettings, clearLeftoverSettings]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(resolveAgentPreset).mockReset().mockResolvedValue({});
  resetPresetsIntent();
});
afterEach(cleanup);

describe("section layout", () => {
  it("renders Use a preset, Presets and Dispatch as boxed sections, each with its job, and no Customize", async () => {
    await renderPanel(makeDoc());
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Use a preset", "Presets", "Dispatch"]);
    expect(screen.getByText("Pick which preset this machine uses. Nothing here changes what a preset contains.")).toBeInTheDocument();
    expect(screen.getByText("Create, edit and delete presets. Nothing here changes which preset is in use.")).toBeInTheDocument();
    expect(screen.queryByText(/Customize/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("leftover-settings")).not.toBeInTheDocument();
  });

  it("puts Leftover settings first while loose values exist", async () => {
    await renderPanel(looseDoc());
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Leftover settings",
      "Use a preset",
      "Presets",
      "Dispatch",
    ]);
  });

  it("stacks the list above the editor on a phone and goes two-column from 641px", async () => {
    await renderPanel(makeDoc());
    const grid = editor().parentElement!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("min-[641px]:grid-cols-[220px_minmax(0,1fr)]");
    expect(within(editor()).getByTestId("role-table-wrap").className).toContain("overflow-x-auto");
  });

  it("keeps the New button in the Presets header", async () => {
    await renderPanel(makeDoc());
    const section = screen.getByRole("region", { name: "Presets" });
    expect(within(section).getByRole("button", { name: "+ New preset" })).toBeInTheDocument();
  });
});

describe("preset list", () => {
  it("tags the machine default and each preset built-in or yours", async () => {
    await renderPanel(makeDoc());
    expect(option("night-shift")).toHaveTextContent("default");
    expect(option("night-shift")).toHaveTextContent("yours");
    expect(option("claude")).toHaveTextContent("built-in");
    expect(option("claude")).not.toHaveTextContent("default");
    expect(option("night-shift")).toHaveAttribute("aria-selected", "false");
    expect(option("claude")).toHaveAttribute("aria-selected", "true");
  });

  it("opens the chosen preset in the editor", async () => {
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    expect(within(editor()).getByText("night-shift")).toBeInTheDocument();
    expect(within(editor()).getByText("yours")).toBeInTheDocument();
    expect(option("night-shift")).toHaveAttribute("aria-selected", "true");
  });

  it("arrow keys move focus within the list and wrap", async () => {
    await renderPanel(makeDoc());
    option("claude").focus();
    fireEvent.keyDown(option("claude"), { key: "ArrowDown" });
    expect(option("codex-review")).toHaveFocus();
    fireEvent.keyDown(option("codex-review"), { key: "ArrowUp" });
    fireEvent.keyDown(option("claude"), { key: "ArrowUp" });
    expect(option("night-shift")).toHaveFocus();
  });

  it("selecting an item closes an open name form and delete confirm", async () => {
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.click(screen.getByRole("button", { name: "+ New preset" }));
    expect(screen.getByTestId("preset-name-form")).toBeInTheDocument();
    choosePreset("claude");
    expect(screen.queryByTestId("preset-name-form")).not.toBeInTheDocument();
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog", { name: "Delete preset" })).toBeInTheDocument();
    choosePreset("claude");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("editor", () => {
  it("renders a built-in read-only: every control disabled, Duplicate the only op, and the note", async () => {
    await renderPanel(makeDoc());
    choosePreset("codex-review");
    const ed = editor();
    expect(within(ed).getByText("built-in · read-only")).toBeInTheDocument();
    expect(within(ed).getByText("Built-in presets are read-only. Duplicate this one to change it.")).toBeInTheDocument();
    expect(within(ed).getByLabelText("Description")).toBeDisabled();
    expect(within(ed).getByLabelText("Session CLI")).toBeDisabled();
    expect(within(ed).getByLabelText("Worker CLI")).toBeDisabled();
    for (const control of within(ed).getAllByRole("combobox")) expect(control).toBeDisabled();
    expect(within(ed).getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(within(ed).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(ed).getByRole("button", { name: "Duplicate" })).toBeEnabled();
  });

  it("renders your preset editable with the save-as-you-go note", async () => {
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    const ed = editor();
    expect(within(ed).getByLabelText("Description")).toHaveValue("Overnight");
    expect(within(ed).getByLabelText("Worker CLI")).toHaveValue("codex");
    expect(within(ed).getByLabelText("Session CLI")).toHaveValue("");
    expect(within(ed).getByLabelText("review CLI")).toHaveValue("codex");
    expect(within(ed).getByLabelText("review effort")).toHaveValue("xhigh");
    expect(within(ed).getByTestId("preset-editor-note")).toHaveTextContent(
      "↳ means the field is not set and the value shown is what applies. Each change is saved as you make it.",
    );
    expect(within(ed).getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(within(ed).getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("lists the six roles with their tier, and shows what applies for an unset Session CLI", async () => {
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    const rows = within(editor()).getAllByTestId(/^role-row-/).map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(ROLES.map(([r]) => `role-row-${r}`));
    expect((within(editor()).getByLabelText("Session CLI") as HTMLSelectElement).options[0].textContent).toBe("↳ claude");
  });

  it("shows fab's resolution dimmed for an unset leaf, and a failed resolution leaves it blank", async () => {
    vi.mocked(resolveAgentPreset).mockResolvedValue({ review: { cli: "codex", model: "gpt-5.6-sol", effort: "xhigh" } });
    await renderPanel(makeDoc());
    choosePreset("codex-review");
    await waitFor(() => expect((within(editor()).getByLabelText("review effort") as HTMLSelectElement).options[0].textContent).toBe("↳ xhigh"));
    expect(resolveAgentPreset).toHaveBeenCalledWith("codex-review");
    expect((within(editor()).getByLabelText("review model") as HTMLSelectElement).options[0].textContent).toContain("gpt-5.6-sol");

    vi.mocked(resolveAgentPreset).mockRejectedValue(new Error("no dispatch mode is available"));
    choosePreset("night-shift");
    await waitFor(() => expect(resolveAgentPreset).toHaveBeenCalledWith("night-shift"));
    expect((within(editor()).getByLabelText("doing model") as HTMLSelectElement).options[0].textContent).toContain("tool default");
  });

  it("writes one leaf to agent_presets.<name>.* per change and re-renders from the returned document", async () => {
    const next = makeDoc({ agent_presets: [...BUILT_IN, { ...NIGHT_SHIFT, profiles: { review: { cli: "codex", effort: "xhigh" }, fast: { effort: "high" } } }] });
    vi.mocked(postFabConfig).mockResolvedValue(next);
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.change(within(editor()).getByLabelText("fast effort"), { target: { value: "high" } });
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent_presets.night-shift.profiles.fast.effort": "high" }));
    await waitFor(() => expect(within(editor()).getByLabelText("fast effort")).toHaveValue("high"));
  });

  it("writes the Worker CLI, and the role CLI under the preset's cli leaf", async () => {
    vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.change(within(editor()).getByLabelText("Session CLI"), { target: { value: "codex" } });
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent_presets.night-shift.session": "codex" }));
    fireEvent.change(within(editor()).getByLabelText("doing CLI"), { target: { value: "codex" } });
    await waitFor(() =>
      expect(postFabConfig).toHaveBeenCalledWith(expect.objectContaining({ "agent_presets.night-shift.profiles.doing.cli": "codex" })),
    );
    for (const call of vi.mocked(postFabConfig).mock.calls) {
      for (const key of Object.keys(call[0])) expect(key).not.toMatch(/\.tool$|^agent\.profiles/);
    }
  });

  it("commits the description on Enter and unsets nothing else", async () => {
    vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    const description = within(editor()).getByLabelText("Description");
    fireEvent.change(description, { target: { value: "  Late nights " } });
    fireEvent.keyDown(description, { key: "Enter" });
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent_presets.night-shift.description": "Late nights" }));
  });

  it("refuses clearing the description when it is the only field, inline and without a request", async () => {
    await renderPanel(makeDoc({ agent_presets: [...BUILT_IN, SOLO] }));
    choosePreset("solo");
    const description = within(editor()).getByLabelText("Description");
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.keyDown(description, { key: "Enter" });
    expect(await within(editor()).findByRole("alert")).toHaveTextContent("a preset needs at least one setting — delete it instead");
    expect(postFabConfig).not.toHaveBeenCalled();
  });

  it("clearing the description is allowed while other fields remain", async () => {
    vi.mocked(postFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    const description = within(editor()).getByLabelText("Description");
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.keyDown(description, { key: "Enter" });
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent_presets.night-shift.description": null }));
  });

  it("refuses a role reset that would remove the last field", async () => {
    const onlyRole: FabAgentPreset = { name: "only-role", source: "system", profiles: { review: { cli: "codex" } } };
    await renderPanel(makeDoc({ agent_presets: [...BUILT_IN, onlyRole] }));
    choosePreset("only-role");
    fireEvent.click(within(screen.getByTestId("role-row-review")).getByRole("button", { name: "Reset review overrides" }));
    expect(await screen.findByText("a preset needs at least one setting — delete it instead")).toBeInTheDocument();
    expect(postFabConfig).not.toHaveBeenCalled();
  });

  it("shows fab's rejection on the row that wrote", async () => {
    vi.mocked(postFabConfig).mockRejectedValue(new Error("agent_presets.night-shift.session: boom"));
    vi.mocked(getFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.change(within(editor()).getByLabelText("Session CLI"), { target: { value: "codex" } });
    expect(await within(editor()).findByRole("alert")).toHaveTextContent("boom");
  });
});

describe("usage note", () => {
  it("names the machine default, workspaces and groups that use the preset", async () => {
    await renderPanel(makeDoc(), {
      servers: [server("default"), server("work", "night-shift")],
      sessionsByServer: new Map([["default", [session("hexokit", "night-shift"), session("other")]]]),
    });
    choosePreset("night-shift");
    expect(within(editor()).getByTestId("preset-usage-note")).toHaveTextContent(
      "Used by the machine default, workspace work, group hexokit. A change applies to the next stage dispatched in every tab launched with this preset.",
    );
  });

  it("says a preset is not used anywhere yet", async () => {
    await renderPanel(makeDoc());
    choosePreset("codex-workers");
    expect(within(editor()).getByTestId("preset-usage-note")).toHaveTextContent(
      "Not used anywhere yet. A change applies to the next stage dispatched in every tab launched with this preset.",
    );
  });
});

describe("name form", () => {
  const openNew = () => fireEvent.click(screen.getByRole("button", { name: "+ New preset" }));

  it("opens focused with the placeholder and a 64-character limit, and disables the New button", async () => {
    await renderPanel(makeDoc());
    openNew();
    expect(screen.getByText("New preset")).toBeInTheDocument();
    expect(nameInput()).toHaveFocus();
    expect(nameInput()).toHaveAttribute("placeholder", "name, e.g. night-shift");
    expect(nameInput()).toHaveAttribute("maxlength", "64");
    expect(screen.getByRole("button", { name: "+ New preset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it.each([
    ["night shift", "Use letters, digits, - and _ only; no spaces."],
    ["-x", "Use letters, digits, - and _ only; no spaces."],
    ["none", '"none" is reserved; it means no preset.'],
    ["claude", "A preset named claude already exists."],
    ["night-shift", "A preset named night-shift already exists."],
  ])("refuses %j inline and posts nothing", async (name, message) => {
    await renderPanel(makeDoc());
    openNew();
    fireEvent.change(nameInput(), { target: { value: name } });
    fireEvent.change(descInput(), { target: { value: "A description" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(postFabConfig).not.toHaveBeenCalled();
  });

  it("requires a description for a new preset", async () => {
    await renderPanel(makeDoc());
    openNew();
    fireEvent.change(nameInput(), { target: { value: "late-shift" } });
    fireEvent.keyDown(nameInput(), { key: "Enter" });
    expect(await screen.findByText("Add a one-line description; it is shown wherever the preset is picked.")).toBeInTheDocument();
    expect(postFabConfig).not.toHaveBeenCalled();
  });

  it("creates with one description write on Enter and opens the new preset", async () => {
    const created: FabAgentPreset = { name: "late-shift", description: "Later", source: "system" };
    vi.mocked(postFabConfig).mockResolvedValue(makeDoc({ agent_presets: [...BUILT_IN, NIGHT_SHIFT, created] }));
    await renderPanel(makeDoc());
    openNew();
    fireEvent.change(nameInput(), { target: { value: "late-shift" } });
    fireEvent.change(descInput(), { target: { value: "Later" } });
    fireEvent.keyDown(descInput(), { key: "Enter" });
    await waitFor(() => expect(postFabConfig).toHaveBeenCalledWith({ "agent_presets.late-shift.description": "Later" }));
    await waitFor(() => expect(within(editor()).getByText("late-shift")).toBeInTheDocument());
    expect(screen.queryByTestId("preset-name-form")).not.toBeInTheDocument();
  });

  it("shows the backend's refusal inline and keeps the form", async () => {
    vi.mocked(postFabConfig).mockRejectedValue(new Error("agent_presets.late-shift.description: must not contain '#'"));
    vi.mocked(getFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    openNew();
    fireEvent.change(nameInput(), { target: { value: "late-shift" } });
    fireEvent.change(descInput(), { target: { value: "a # b" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await within(screen.getByTestId("preset-name-form")).findByRole("alert")).toHaveTextContent("must not contain '#'");
    expect(screen.getByTestId("preset-name-form")).toBeInTheDocument();
  });

  it("Escape cancels the form without closing anything else", async () => {
    await renderPanel(makeDoc());
    openNew();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(nameInput(), { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(screen.queryByTestId("preset-name-form")).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "+ New preset" })).toBeEnabled();
  });

  it("Duplicate prefills <name>-copy and the source's description, then copies through one request", async () => {
    vi.mocked(duplicateAgentPreset).mockResolvedValue(
      makeDoc({ agent_presets: [...BUILT_IN, NIGHT_SHIFT, { name: "codex-review-copy", description: "Only the review role on Codex", source: "system" }] }),
    );
    await renderPanel(makeDoc());
    choosePreset("codex-review");
    fireEvent.click(within(editor()).getByRole("button", { name: "Duplicate" }));
    expect(screen.getByText("Duplicate codex-review as")).toBeInTheDocument();
    expect(nameInput()).toHaveValue("codex-review-copy");
    expect(descInput()).toHaveValue("Only the review role on Codex");
    fireEvent.click(within(screen.getByTestId("preset-name-form")).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(duplicateAgentPreset).toHaveBeenCalledWith("codex-review", "codex-review-copy", "Only the review role on Codex"));
    await waitFor(() => expect(within(editor()).getByText("codex-review-copy")).toBeInTheDocument());
  });

  it("Duplicate makes the prefilled name unique", async () => {
    await renderPanel(makeDoc({ agent_presets: [...BUILT_IN, NIGHT_SHIFT, { name: "claude-copy", description: "d", source: "system" }] }));
    fireEvent.click(within(editor()).getByRole("button", { name: "Duplicate" }));
    expect(nameInput()).toHaveValue("claude-copy-2");
  });

  it("Rename of a preset in use says who follows and that running tabs fall back", async () => {
    await renderPanel(makeDoc(), { sessionsByServer: new Map([["default", [session("hexokit", "night-shift")]]]) });
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Rename" }));
    expect(screen.getByText("Rename night-shift to")).toBeInTheDocument();
    expect(nameInput()).toHaveValue("night-shift");
    expect(screen.queryByLabelText("Preset description")).not.toBeInTheDocument();
    expect(screen.getByText(
      "Used by the machine default, group hexokit; they follow the new name. Tabs already running under the old name fall back to the default.",
    )).toBeInTheDocument();
  });

  it("Rename sends one request and opens the renamed preset; the same name just closes", async () => {
    vi.mocked(renameAgentPreset).mockResolvedValue(
      makeDoc({ agent_presets: [...BUILT_IN, { ...NIGHT_SHIFT, name: "late-shift" }], fields: { ...makeDoc().fields, "agent.preset": field("late-shift", "system") } }),
    );
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Rename" }));
    fireEvent.keyDown(nameInput(), { key: "Enter" });
    expect(renameAgentPreset).not.toHaveBeenCalled();
    expect(screen.queryByTestId("preset-name-form")).not.toBeInTheDocument();

    fireEvent.click(within(editor()).getByRole("button", { name: "Rename" }));
    fireEvent.change(nameInput(), { target: { value: "late-shift" } });
    fireEvent.keyDown(nameInput(), { key: "Enter" });
    await waitFor(() => expect(renameAgentPreset).toHaveBeenCalledWith("night-shift", "late-shift"));
    await waitFor(() => expect(within(editor()).getByText("late-shift")).toBeInTheDocument());
    expect(option("late-shift")).toHaveTextContent("default");
  });

  it("a partial rename failure shows the message inline and re-reads fab", async () => {
    vi.mocked(renameAgentPreset).mockRejectedValue(new Error("set agent.preset late-shift failed: disk full. Already done: set agent_presets.late-shift.description Overnight"));
    vi.mocked(getFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Rename" }));
    fireEvent.change(nameInput(), { target: { value: "late-shift" } });
    fireEvent.keyDown(nameInput(), { key: "Enter" });
    expect(await within(screen.getByTestId("preset-name-form")).findByRole("alert")).toHaveTextContent("Already done");
    expect(getFabConfig).toHaveBeenCalledTimes(2);
  });
});

describe("delete confirm", () => {
  it("asks first, naming what uses the preset", async () => {
    await renderPanel(makeDoc(), {
      servers: [server("work", "night-shift")],
      sessionsByServer: new Map([["default", [session("hexokit", "night-shift")]]]),
    });
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete preset" });
    expect(confirm).toHaveTextContent(
      "Delete night-shift? It is used by the machine default, workspace work, group hexokit. Their choice is cleared, and tabs already running with it fall back to the default.",
    );
    expect(deleteAgentPreset).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("deletes an unused preset in one request and selects the first remaining", async () => {
    vi.mocked(deleteAgentPreset).mockResolvedValue(makeDoc({ agent_presets: [...BUILT_IN, NIGHT_SHIFT] }));
    await renderPanel(makeDoc({ agent_presets: [...BUILT_IN, NIGHT_SHIFT, SOLO] }));
    choosePreset("solo");
    fireEvent.click(within(editor()).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete preset" });
    expect(confirm).toHaveTextContent("Delete solo?");
    expect(confirm).not.toHaveTextContent("It is used by");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteAgentPreset).toHaveBeenCalledWith("solo"));
    await waitFor(() => expect(screen.queryByRole("option", { name: /^solo/ })).not.toBeInTheDocument());
    expect(option("claude")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("a failed delete shows the message in the confirm", async () => {
    vi.mocked(deleteAgentPreset).mockRejectedValue(new Error("clear workspace default failed: tmux refused"));
    vi.mocked(getFabConfig).mockResolvedValue(makeDoc());
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(await within(screen.getByRole("alertdialog")).findByRole("alert")).toHaveTextContent("tmux refused");
  });

  it("Escape cancels the confirm", async () => {
    await renderPanel(makeDoc());
    choosePreset("night-shift");
    fireEvent.click(within(editor()).getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("leftover settings", () => {
  const box = () => screen.getByTestId("leftover-settings");

  it("lists the loose values in plain words and states fab's real precedence", async () => {
    await renderPanel(looseDoc());
    expect(within(box()).getByTestId("leftover-summary")).toHaveTextContent(
      "2 settings are set outside any preset: worker CLI = codex, review effort = low.",
    );
    expect(within(box()).getByText("They override the machine default, and fill in anything a group's or workspace's preset leaves unset.")).toBeInTheDocument();
    expect(within(box()).getByText("From the old Customize grid. This box goes away once they are moved or cleared.")).toBeInTheDocument();
  });

  it("does not count environment values as leftovers", async () => {
    const doc = makeDoc();
    await renderPanel({ ...doc, fields: { ...doc.fields, "agent.workers": field("codex", "env", { originDetail: "FAB_AGENT_WORKERS" }) } });
    expect(screen.queryByTestId("leftover-settings")).not.toBeInTheDocument();
  });

  it("Move asks for a name prefilled my-overrides and the standard description, then moves in one request", async () => {
    vi.mocked(moveLeftoverSettings).mockResolvedValue(makeDoc());
    await renderPanel(looseDoc());
    fireEvent.click(within(box()).getByRole("button", { name: "Move into a new preset" }));
    expect(nameInput()).toHaveValue("my-overrides");
    expect(descInput()).toHaveValue("Moved from loose machine-wide settings");
    fireEvent.click(within(box()).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(moveLeftoverSettings).toHaveBeenCalledWith("my-overrides", "Moved from loose machine-wide settings"));
    await waitFor(() => expect(screen.queryByTestId("leftover-settings")).not.toBeInTheDocument());
  });

  it("Move makes its default name unique and applies the name rules", async () => {
    await renderPanel(looseDoc({ agent_presets: [...BUILT_IN, NIGHT_SHIFT, { name: "my-overrides", description: "d", source: "system" }] }));
    fireEvent.click(within(box()).getByRole("button", { name: "Move into a new preset" }));
    expect(nameInput()).toHaveValue("my-overrides-2");
    fireEvent.change(nameInput(), { target: { value: "claude" } });
    fireEvent.click(within(box()).getByRole("button", { name: "Move" }));
    expect(await screen.findByText("A preset named claude already exists.")).toBeInTheDocument();
    expect(moveLeftoverSettings).not.toHaveBeenCalled();
  });

  it("Clear asks first, then unsets the loose keys in one request", async () => {
    vi.mocked(clearLeftoverSettings).mockResolvedValue(makeDoc());
    await renderPanel(looseDoc());
    fireEvent.click(within(box()).getByRole("button", { name: "Clear them" }));
    const confirm = screen.getByRole("alertdialog", { name: "Clear leftover settings" });
    expect(clearLeftoverSettings).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clearLeftoverSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("leftover-settings")).not.toBeInTheDocument());
  });

  it("names the groups and workspaces that would stop inheriting a loose value, in Move and in Clear", async () => {
    const props = {
      servers: [server("work", "codex-workers")],
      sessionsByServer: new Map([["default", [session("hexokit", "codex-review")]]]),
    };
    await renderPanel(looseDoc(), props);
    fireEvent.click(within(box()).getByRole("button", { name: "Move into a new preset" }));
    const disclosure =
      "These have their own preset and will stop inheriting the loose values — workspace work: review effort = low; group hexokit: worker CLI = codex, review effort = low.";
    expect(within(box()).getByText(disclosure)).toBeInTheDocument();
    fireEvent.click(within(box()).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(box()).getByRole("button", { name: "Clear them" }));
    expect(screen.getByRole("alertdialog", { name: "Clear leftover settings" })).toHaveTextContent(disclosure);
  });

  it("adds no disclosure when no group or workspace has its own preset", async () => {
    await renderPanel(looseDoc());
    fireEvent.click(within(box()).getByRole("button", { name: "Move into a new preset" }));
    expect(within(box()).queryByText(/will stop inheriting/)).not.toBeInTheDocument();
  });
});

describe("palette intents", () => {
  it("an intent recorded before the section mounts opens the New form on mount", async () => {
    requestPresetsIntent({ action: "new" });
    await renderPanel(makeDoc());
    expect(screen.getByText("New preset")).toBeInTheDocument();
    expect(nameInput()).toHaveFocus();
  });

  it("opens Duplicate, Rename and Delete for the named preset", async () => {
    requestPresetsIntent({ action: "rename", name: "night-shift" });
    await renderPanel(makeDoc());
    expect(screen.getByText("Rename night-shift to")).toBeInTheDocument();
    expect(option("night-shift")).toHaveAttribute("aria-selected", "true");

    requestPresetsIntent({ action: "delete", name: "night-shift" });
    expect(await screen.findByRole("alertdialog", { name: "Delete preset" })).toBeInTheDocument();
    expect(screen.queryByTestId("preset-name-form")).not.toBeInTheDocument();

    requestPresetsIntent({ action: "duplicate", name: "codex-review" });
    expect(await screen.findByText("Duplicate codex-review as")).toBeInTheDocument();
  });

  it("focuses the list, live, when the section is already open", async () => {
    await renderPanel(makeDoc());
    requestPresetsIntent({ action: "focus" });
    expect(option("claude")).toHaveFocus();
  });

  it("ignores an intent naming a preset that is not listed", async () => {
    requestPresetsIntent({ action: "rename", name: "gone" });
    await renderPanel(makeDoc());
    expect(screen.queryByTestId("preset-name-form")).not.toBeInTheDocument();
  });
});
