import { describe, it, expect } from "vitest";
import type { ShellServer } from "@/lib/shell";
import {
  activeShellHostName,
  adjacentShellServer,
  dragTarget,
  effectiveMotion,
  hostAcceleratorHint,
  hostMonogram,
  hostReach,
  isHintChord,
  keyHintLabel,
  keyHintTip,
  lightAx,
  lightDx,
  MAX_SHELL_SWITCHER_HINTS,
  moveInList,
  nameplateFields,
  osLabel,
  parseStripPrefs,
  previewNameplate,
  shellHostMenuRows,
  slotWhileDragging,
  SQUARE_PITCH_PX,
  squareDigit,
  visibleFieldCount,
  stripInsets,
  stripLabelColor,
  stripSwitcherEnabled,
} from "./shell-strip";

describe("stripLabelColor", () => {
  it("picks the light text over dark strip backgrounds", () => {
    expect(stripLabelColor("#0f1117")).toBe("#e5e7eb");
    expect(stripLabelColor("#20304a")).toBe("#e5e7eb");
  });

  it("picks the dark text over light strip backgrounds", () => {
    expect(stripLabelColor("#f8f9fb")).toBe("#111827");
    expect(stripLabelColor("#ffffff")).toBe("#111827");
  });
});

describe("stripInsets", () => {
  it("reserves 80px for the traffic lights on the left of darwin and only a gutter on the right", () => {
    expect(stripInsets("darwin")).toEqual({ left: "80px", right: "12px" });
  });

  it("uses titlebar-area env expressions elsewhere (WCO overlay)", () => {
    const insets = stripInsets("win32");
    expect(insets.left).toContain("titlebar-area-x");
    expect(insets.right).toContain("titlebar-area-width");
    expect(stripInsets("linux")).toEqual(insets);
  });
});

describe("activeShellHostName", () => {
  const a: ShellServer = { id: "a", name: "studio-mac", url: "http://a:3000", active: false };
  const b: ShellServer = { id: "b", name: "gcp-box", url: "http://b:3000", active: true };

  it("returns the active entry's name", () => {
    expect(activeShellHostName([a, b])).toBe("gcp-box");
  });

  it("returns null when no entry is active", () => {
    expect(activeShellHostName([a])).toBeNull();
  });

  it("returns null for an unavailable list (older shell / denial)", () => {
    expect(activeShellHostName(null)).toBeNull();
    expect(activeShellHostName([])).toBeNull();
  });
});

describe("hostAcceleratorHint", () => {
  it("maps darwin to the ⌥⌘ shell tier, index-ordered", () => {
    expect(hostAcceleratorHint("darwin", 0)).toBe("⌥⌘1");
    expect(hostAcceleratorHint("darwin", 8)).toBe("⌥⌘9");
  });

  it("maps every other platform to the Alt accelerators", () => {
    expect(hostAcceleratorHint("win32", 0)).toBe("Alt+1");
    expect(hostAcceleratorHint("linux", 2)).toBe("Alt+3");
  });

  it("returns null past the 9-cap and for out-of-range indices", () => {
    expect(hostAcceleratorHint("darwin", MAX_SHELL_SWITCHER_HINTS)).toBeNull();
    expect(hostAcceleratorHint("win32", 42)).toBeNull();
    expect(hostAcceleratorHint("darwin", -1)).toBeNull();
  });
});

describe("shellHostMenuRows", () => {
  const host = (id: string, name: string, url: string, active = false): ShellServer => ({
    id,
    name,
    url,
    active,
  });

  it("derives id/name/origin/active/hint per entry, list order preserved", () => {
    const rows = shellHostMenuRows(
      [host("a", "studio-mac", "http://a:3000", true), host("b", "gcp-box", "http://b:3000")],
      "darwin",
    );
    expect(rows).toEqual([
      { id: "a", name: "studio-mac", origin: "http://a:3000", active: true, hint: "⌥⌘1", accentColor: null, waiting: null },
      { id: "b", name: "gcp-box", origin: "http://b:3000", active: false, hint: "⌥⌘2", accentColor: null, waiting: null },
    ]);
  });

  it("keeps duplicate names apart via distinct origins", () => {
    const rows = shellHostMenuRows(
      [host("a", "dev", "http://one:3000", true), host("b", "dev", "https://two.example.com")],
      "linux",
    );
    expect(rows[0].origin).toBe("http://one:3000");
    expect(rows[1].origin).toBe("https://two.example.com");
    expect(rows[1].hint).toBe("Alt+2");
  });

  it("falls back to the raw url string when the url is unparseable", () => {
    const rows = shellHostMenuRows([host("a", "broken", "not a url")], "darwin");
    expect(rows[0].origin).toBe("not a url");
  });

  it("gives hosts beyond the ninth no hint", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      host(`h${i}`, `host-${i}`, `http://h${i}:3000`, i === 0),
    );
    const rows = shellHostMenuRows(many, "darwin");
    expect(rows[8].hint).toBe("⌥⌘9");
    expect(rows[9].hint).toBeNull();
  });
});

describe("stripSwitcherEnabled", () => {
  it("is false for an unavailable or empty list (older shell / denial)", () => {
    expect(stripSwitcherEnabled(null)).toBe(false);
    expect(stripSwitcherEnabled([])).toBe(false);
  });

  it("is true for a non-empty list", () => {
    const a: ShellServer = { id: "a", name: "studio-mac", url: "http://a:3000", active: true };
    expect(stripSwitcherEnabled([a])).toBe(true);
  });
});

describe("shellHostMenuRows accentColor / waiting", () => {
  const base = { id: "a", name: "studio-mac", url: "http://a:3000", active: false };

  it("passes a valid hex accentColor through (#RGB / #RRGGBB / #RRGGBBAA)", () => {
    for (const hex of ["#fff", "#8b7ff0", "#8b7ff0cc", "#ABC"]) {
      const [row] = shellHostMenuRows([{ ...base, accentColor: hex }], "darwin");
      expect(row.accentColor).toBe(hex);
    }
  });

  it("nulls a non-hex accentColor (never reaches style interpolation)", () => {
    for (const bad of ["javascript:alert(1)", "red", "#12345", "8b7ff0", "#gggggg"]) {
      const [row] = shellHostMenuRows([{ ...base, accentColor: bad }], "darwin");
      expect(row.accentColor).toBeNull();
    }
  });

  it("nulls accentColor when the field is absent (older shell)", () => {
    const [row] = shellHostMenuRows([base], "darwin");
    expect(row.accentColor).toBeNull();
    expect(row.waiting).toBeNull();
  });

  it("carries a positive waiting count on a background row", () => {
    const [row] = shellHostMenuRows([{ ...base, waiting: 3 }], "darwin");
    expect(row.waiting).toBe(3);
  });

  it("suppresses waiting on the active row and on zero/absent counts", () => {
    const [active] = shellHostMenuRows([{ ...base, active: true, waiting: 2 }], "darwin");
    expect(active.waiting).toBeNull();
    const [zero] = shellHostMenuRows([{ ...base, waiting: 0 }], "darwin");
    expect(zero.waiting).toBeNull();
  });
});

describe("hostReach (kind + link from the origin)", () => {
  it("reads a loopback port in 3100-3199 as an ssh tunnel", () => {
    expect(hostReach("http://127.0.0.1:3142")).toEqual({ kind: "tunnel", link: "ssh tunnel :3142" });
    expect(hostReach("http://localhost:3100").kind).toBe("tunnel");
    expect(hostReach("http://127.0.0.1:3199").kind).toBe("tunnel");
  });

  it("reads any other loopback origin as local", () => {
    expect(hostReach("http://127.0.0.1:3000")).toEqual({ kind: "local", link: "local" });
    expect(hostReach("http://127.0.0.1:3200").kind).toBe("local");
    expect(hostReach("http://localhost:3099").kind).toBe("local");
  });

  it("reads a *.ts.net host as tailscale and every other host as lan", () => {
    expect(hostReach("https://box.tail1234.ts.net")).toEqual({ kind: "net", link: "tailscale" });
    expect(hostReach("http://10.0.0.5:3000")).toEqual({ kind: "net", link: "lan" });
  });

  it("degrades a malformed url to a network host", () => {
    expect(hostReach("not a url")).toEqual({ kind: "net", link: "lan" });
  });
});

describe("hostMonogram", () => {
  it("combines the first letter with the trailing number", () => {
    expect(hostMonogram("ws-01")).toBe("W1");
    expect(hostMonogram("loom_box.12")).toBe("L12");
  });

  it("takes the first letters of two name tokens", () => {
    expect(hostMonogram("mac-mini")).toBe("MM");
  });

  it("takes the first two characters of a single token", () => {
    expect(hostMonogram("laptop")).toBe("LA");
    expect(hostMonogram("")).toBe("");
  });
});

describe("osLabel", () => {
  it("renders darwin as macOS and passes other values through", () => {
    expect(osLabel("darwin")).toBe("macOS");
    expect(osLabel("linux")).toBe("linux");
  });
});

describe("key hints", () => {
  it("labels the pill per platform", () => {
    expect(keyHintLabel("darwin")).toBe("⌥⌘");
    expect(keyHintLabel("win32")).toBe("Alt");
    expect(keyHintTip("darwin")).toContain("⇧⌘H");
    expect(keyHintTip("darwin")).toContain("⌥⌘←/→ cycles");
    expect(keyHintTip("linux")).toContain("Alt+1–9");
    expect(keyHintTip("linux")).toContain("Alt+PgUp/PgDn cycles");
    expect(keyHintTip("win32")).toContain("Alt+PgUp/PgDn cycles");
  });

  it("detects the chord: Option+Command on darwin, Alt elsewhere", () => {
    expect(isHintChord({ altKey: true, metaKey: true }, "darwin")).toBe(true);
    expect(isHintChord({ altKey: true, metaKey: false }, "darwin")).toBe(false);
    expect(isHintChord({ altKey: true, metaKey: false }, "linux")).toBe(true);
    expect(isHintChord({ altKey: false, metaKey: false }, "linux")).toBe(false);
  });
});

describe("square geometry", () => {
  it("digits cover the first nine squares only", () => {
    expect(squareDigit(0)).toBe(1);
    expect(squareDigit(8)).toBe(9);
    expect(squareDigit(9)).toBeNull();
    expect(squareDigit(-1)).toBeNull();
  });

  it("moveInList moves one element and ignores out-of-range moves", () => {
    expect(moveInList(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveInList(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveInList(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });

  it("dragTarget picks the nearest slot and clamps travel to the row", () => {
    expect(dragTarget(0, 0, 4)).toEqual({ to: 0, offset: 0 });
    expect(dragTarget(0, SQUARE_PITCH_PX * 2 + 3, 4)).toEqual({ to: 2, offset: SQUARE_PITCH_PX * 2 + 3 });
    // Past the last slot: clamped (6px overshoot), still the last slot.
    expect(dragTarget(0, 10_000, 4)).toEqual({ to: 3, offset: SQUARE_PITCH_PX * 3 + 6 });
    // Left of the first slot.
    expect(dragTarget(2, -10_000, 4)).toEqual({ to: 0, offset: -SQUARE_PITCH_PX * 2 - 6 });
    expect(dragTarget(0, 50, 0)).toEqual({ to: 0, offset: 0 });
  });

  it("slotWhileDragging slides the siblings between the grab and drop slots aside", () => {
    // Drag 0 -> 2 over [a b c d]: b,c shift left; d stays.
    expect([0, 1, 2, 3].map((i) => slotWhileDragging(i, 0, 2))).toEqual([2, 0, 1, 3]);
    // Drag 3 -> 1: b,c shift right; a stays.
    expect([0, 1, 2, 3].map((i) => slotWhileDragging(i, 3, 1))).toEqual([0, 2, 3, 1]);
    expect([0, 1, 2].map((i) => slotWhileDragging(i, 1, 1))).toEqual([0, 1, 2]);
  });
});

describe("nameplate model", () => {
  it("orders fields user@machine, OS, link, agents and omits missing data", () => {
    const fields = nameplateFields({
      name: "ws-01",
      userMachine: "sahil@ws-01",
      os: "linux",
      kind: "net",
      link: "tailscale",
      agents: 11,
    });
    expect(fields.map((f) => f.key)).toEqual(["userMachine", "os", "link", "agents"]);
    expect(fields[1]).toEqual({ key: "os", text: "linux", kind: "net" });
    expect(fields[3].text).toBe("11 agents");
    expect(nameplateFields({ name: "x" })).toEqual([]);
    expect(nameplateFields({ name: "x", agents: 1 })[0].text).toBe("1 agent");
  });

  it("folds right-to-left: agents first, the name never", () => {
    const widths = [100, 80, 60, 70];
    const name = 50;
    // Everything fits.
    expect(visibleFieldCount(name, widths, 10_000)).toBe(4);
    // Not enough for agents (last) -> three fields.
    const three = name + 100 + 80 + 60;
    expect(visibleFieldCount(name, widths, three)).toBe(3);
    // Only the name fits.
    expect(visibleFieldCount(name, widths, name)).toBe(0);
    expect(visibleFieldCount(name, widths, 0)).toBe(0);
  });

  it("previews a background host from its own report, name-only without one", () => {
    const bare: ShellServer = { id: "a", name: "mac-mini", url: "http://10.0.0.5:3000", active: false };
    expect(previewNameplate(bare)).toEqual({ name: "mac-mini" });
    const reported: ShellServer = { ...bare, machine: "sahil@mac-mini", os: "darwin", agents: 3 };
    expect(previewNameplate(reported)).toEqual({
      name: "mac-mini",
      userMachine: "sahil@mac-mini",
      os: "darwin",
      kind: "net",
      link: "lan",
      agents: 3,
    });
  });
});

describe("light geometry", () => {
  it("centres --ax on the square and extends --dx past the last field", () => {
    expect(lightAx(40, 18)).toBe(49);
    expect(lightDx(300, 49)).toBe(322);
    expect(lightDx(null, 49)).toBe(89);
  });
});

describe("strip prefs", () => {
  it("parses a well-formed payload and rejects anything else", () => {
    expect(parseStripPrefs({ strip: { effect: "hex", motion: "cut" } })).toEqual({
      effect: "hex",
      motion: "cut",
    });
    expect(parseStripPrefs({ strip: { effect: "plaid", motion: "cut" } })).toBeNull();
    expect(parseStripPrefs({ strip: { effect: "hex" } })).toBeNull();
    expect(parseStripPrefs({ strip: null })).toBeNull();
    expect(parseStripPrefs(null)).toBeNull();
    expect(parseStripPrefs("glow")).toBeNull();
  });

  it("reduced motion forces cut", () => {
    expect(effectiveMotion("sweep", true)).toBe("cut");
    expect(effectiveMotion("sweep", false)).toBe("sweep");
  });
});

describe("self-host resolution", () => {
  const a: ShellServer = { id: "a", name: "a", url: "http://a:3000", active: true, current: false };
  const b: ShellServer = { id: "b", name: "b", url: "http://b:3000", active: false, current: true };

  it("prefers the per-view `current` flag over the cosmetic `active` record", () => {
    expect(activeShellHostName([a, b])).toBe("b");
    const rows = shellHostMenuRows([{ ...a, waiting: 2 }, { ...b, waiting: 1 }], "linux");
    expect(rows.map((r) => r.active)).toEqual([false, true]);
    expect(rows.map((r) => r.waiting)).toEqual([2, null]);
  });
});

describe("adjacentShellServer", () => {
  const list = (currentId: string | null, ids = ["a", "b", "c"]): ShellServer[] =>
    ids.map((id) => ({ id, name: id, url: `http://${id}:3000`, active: false, current: id === currentId }));

  it("steps to the neighbour and wraps at both ends", () => {
    expect(adjacentShellServer(list("a"), 1)?.id).toBe("b");
    expect(adjacentShellServer(list("b"), -1)?.id).toBe("a");
    expect(adjacentShellServer(list("c"), 1)?.id).toBe("a");
    expect(adjacentShellServer(list("a"), -1)?.id).toBe("c");
  });

  it("reads `current`, falling back to `active` on older shells", () => {
    const older: ShellServer[] = ["a", "b", "c"].map((id) => ({
      id,
      name: id,
      url: `http://${id}:3000`,
      active: id === "b",
    }));
    expect(adjacentShellServer(older, 1)?.id).toBe("c");
    // `current` wins over a stale `active` on another window's host.
    const split = list("a").map((s) => (s.id === "c" ? { ...s, active: true } : s));
    expect(adjacentShellServer(split, 1)?.id).toBe("b");
  });

  it("starts before the first when nothing is current", () => {
    expect(adjacentShellServer(list(null), 1)?.id).toBe("a");
    expect(adjacentShellServer(list(null), -1)?.id).toBe("c");
  });

  it("is null below two servers", () => {
    expect(adjacentShellServer([], 1)).toBeNull();
    expect(adjacentShellServer(list("a", ["a"]), -1)).toBeNull();
  });
});
