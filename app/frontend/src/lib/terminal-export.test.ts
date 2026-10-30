import { describe, expect, it, vi } from "vitest";
import {
  buildExportFilename,
  downloadTextFile,
  transcriptFromBuffer,
  trimSelectText,
  visibleScreenText,
  wrapHtmlSnapshot,
  type ExportBuffer,
  type ExportViewportBuffer,
} from "./terminal-export";

/** Build a structural fake buffer from physical rows: "text" rows are plain,
 *  ["text"]-wrapped marker rows join their predecessor without a newline. */
function fakeBuffer(rows: (string | { wrap: string })[]): ExportBuffer {
  const lines = rows.map((r) =>
    typeof r === "string"
      ? { translateToString: (trim: boolean) => (trim ? r.replace(/\s+$/, "") : r), isWrapped: false }
      : { translateToString: (trim: boolean) => (trim ? r.wrap.replace(/\s+$/, "") : r.wrap), isWrapped: true },
  );
  return {
    length: lines.length,
    getLine: (i) => lines[i],
  };
}

describe("buildExportFilename", () => {
  it("formats {session}-{window}-{YYMMDD-HHmmss}.{ext} with zero-padded clock fields", () => {
    // 2026-08-20 14:03:05 local time
    const date = new Date(2026, 7, 20, 14, 3, 5);
    expect(buildExportFilename("dev", "agent", date, "html")).toBe("dev-agent-260820-140305.html");
    expect(buildExportFilename("dev", "agent", date, "txt")).toBe("dev-agent-260820-140305.txt");
  });

  it("appends -full before the extension for the server capture arm", () => {
    const date = new Date(2026, 7, 20, 14, 3, 5);
    expect(buildExportFilename("dev", "agent", date, "txt", true)).toBe(
      "dev-agent-260820-140305-full.txt",
    );
  });

  it("safe-name sanitizes both tokens and falls back on empty", () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(buildExportFilename("my session", "win:name", date, "txt")).toBe(
      "my_session-win_name-260102-030405.txt",
    );
    expect(buildExportFilename("", "@5", date, "txt")).toBe("session-@5-260102-030405.txt");
  });
});

describe("transcriptFromBuffer", () => {
  it("joins a soft-wrapped line without a newline and trims trailing whitespace", () => {
    const buffer = fakeBuffer(["first  ", { wrap: "-continued  " }, "after"]);
    expect(transcriptFromBuffer(buffer)).toBe("first-continued\nafter");
  });

  it("keeps hard-wrapped (unwrapped-successor) rows as separate lines", () => {
    const buffer = fakeBuffer(["a", "b", "c"]);
    expect(transcriptFromBuffer(buffer)).toBe("a\nb\nc");
  });

  it("returns empty text for an empty buffer", () => {
    expect(transcriptFromBuffer(fakeBuffer([]))).toBe("");
  });
});

describe("visibleScreenText", () => {
  it("slices exactly the viewport rows from viewportY", () => {
    const rows = fakeBuffer(["h1", "h2", "v1", "v2", "v3", "t1"]);
    const buffer: ExportViewportBuffer = { ...rows, viewportY: 2 };
    expect(visibleScreenText(buffer, 3)).toBe("v1\nv2\nv3");
  });

  it("joins wrapped rows inside the viewport", () => {
    const rows = fakeBuffer(["scroll", { wrap: "-back" }, "v1", { wrap: "-v1cont" }]);
    const buffer: ExportViewportBuffer = { ...rows, viewportY: 2 };
    expect(visibleScreenText(buffer, 2)).toBe("v1-v1cont");
  });
});

describe("wrapHtmlSnapshot", () => {
  it("wraps the serialized buffer in a self-contained document", () => {
    const html = wrapHtmlSnapshot('<span style="color:#fff">hi</span>', "dev-agent");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>dev-agent</title>");
    expect(html).toContain("font-family:ui-monospace");
    expect(html).toContain('<pre><span style="color:#fff">hi</span></pre>');
  });

  it("escapes the title", () => {
    expect(wrapHtmlSnapshot("x", "a<b>&c")).toContain("<title>a&lt;b&gt;&amp;c</title>");
  });
});

describe("downloadTextFile", () => {
  it("downloads via a Blob + temporary anchor", () => {
    const createUrl = vi.fn().mockReturnValue("blob:mock");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clicks: string[] = [];
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = originalCreate(tag);
      if (tag === "a") {
        el.click = () => clicks.push((el as HTMLAnchorElement).download);
      }
      return el;
    }) as typeof document.createElement);

    downloadTextFile("dev-agent-260820-140305.txt", "text/plain", "hello");

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual(["dev-agent-260820-140305.txt"]);
    expect(revokeUrl).toHaveBeenCalledWith("blob:mock");
    expect(document.body.querySelector("a[download]")).toBeNull();

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe("trimSelectText", () => {
  it("drops each line's trailing padding and the trailing blank lines", () => {
    expect(trimSelectText("a   \n  b  \n\n   \n")).toBe("a\n  b");
  });
});
