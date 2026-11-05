import { useEffect, useState } from "react";
import { saveOpenAIMCPKey, restartOpenAIMCP } from "@/api/client";
import { useOpenAIMCP, type OpenAIMCPSignal } from "@/contexts/session-context";
import type { SettingsRegistry } from "@/components/settings-registry-seam";
import { BoolToggle } from "@/components/settings-all-panel";
import { controlClass } from "@/components/control";
import {
  useTextSettingDraft,
  textSettingInputClass,
  TextSettingError,
  PreferenceRow,
} from "@/components/text-setting-core";

/** Where an OpenAI tunnel is created and its ID copied from. */
export const OPENAI_TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";

/** The slice of the settings registry the connector rows read and write. */
export type OpenAIMCPRegistry = Pick<SettingsRegistry, "entries" | "settingValue" | "commitSetting">;

const chipClass = controlClass({ variant: "chip" });

/**
 * The ChatGPT connector rows in Settings → General (docs/specs/openai-mcp.md
 * § The curated row): the switch and tunnel ID ride the settings registry;
 * the API key is write-only through its own route and is never prefilled or
 * read back; the status line and Restart come from the `openai-mcp` stream.
 */
export function OpenAIMCPSettingsRows({ registry }: { registry: OpenAIMCPRegistry }) {
  const signal = useOpenAIMCP();
  const enabledEntry = registry.entries.find((e) => e.key === "openai_mcp.enabled");
  const tunnelValue = registry.settingValue("openai_mcp.tunnel_id");
  return (
    <>
      <PreferenceRow
        label="ChatGPT connector"
        sublabel={
          enabledEntry?.description ??
          "Lets ChatGPT call the daemon's MCP tools through OpenAI's Secure MCP Tunnel. Every tool is reachable, including ones that type into agents."
        }
        htmlFor="settings-openai-mcp-enabled"
      >
        <BoolToggle
          id="settings-openai-mcp-enabled"
          label="ChatGPT connector"
          on={registry.settingValue("openai_mcp.enabled") === true}
          commit={(on) => registry.commitSetting("openai_mcp.enabled", on)}
        />
      </PreferenceRow>
      <TunnelIDRow
        value={typeof tunnelValue === "string" ? tunnelValue : ""}
        commit={(trimmed) => registry.commitSetting("openai_mcp.tunnel_id", trimmed === "" ? null : trimmed)}
      />
      <APIKeyRow keySetFromStream={signal?.keySet ?? false} />
      <StatusRow signal={signal} />
    </>
  );
}

function TunnelIDRow({ value, commit }: { value: string; commit: (trimmed: string) => Promise<void> }) {
  const { draft, error, handleCommit, onChange, onKeyDown } = useTextSettingDraft(value, commit);
  return (
    <PreferenceRow
      label="Tunnel ID"
      sublabel="From platform.openai.com → Settings → Tunnels. Associate the tunnel with your ChatGPT workspace."
      htmlFor="settings-openai-mcp-tunnel-id"
    >
      <input
        id="settings-openai-mcp-tunnel-id"
        type="text"
        value={draft}
        onChange={onChange}
        onBlur={handleCommit}
        onKeyDown={onKeyDown}
        placeholder="tunnel_…"
        spellCheck={false}
        autoComplete="off"
        className={textSettingInputClass}
      />
      <TextSettingError error={error} />
    </PreferenceRow>
  );
}

/** The write-only key field. `saved` overrides the stream's keySet from the
 *  moment a save or clear answers until the stream catches up. */
function APIKeyRow({ keySetFromStream }: { keySetFromStream: boolean }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSaved(null);
  }, [keySetFromStream]);

  const keySet = saved ?? keySetFromStream;
  const showInput = !keySet || editing;

  const submit = async (key: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await saveOpenAIMCPKey(key);
      setSaved(res.keySet);
      setDraft("");
      setEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : "Failed to save the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PreferenceRow
      label="API key"
      sublabel="A runtime key with Tunnels Read + Use. Saved in the daemon's state dir (0600), never shown again."
      htmlFor={showInput ? "settings-openai-mcp-key" : undefined}
    >
      {showInput ? (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() !== "") void submit(draft.trim());
          }}
        >
          <input
            id="settings-openai-mcp-key"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            className={textSettingInputClass}
          />
          <button type="submit" className={chipClass} disabled={busy || draft.trim() === ""} aria-label="Save key">
            Save
          </button>
          {keySet && (
            <button type="button" className={chipClass} onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2 min-[480px]:pt-0.5">
          <span className="text-xs text-text-primary">Saved</span>
          <button type="button" className={chipClass} onClick={() => setEditing(true)} aria-label="Replace key">
            Replace
          </button>
          <button type="button" className={chipClass} disabled={busy} onClick={() => void submit("")} aria-label="Clear key">
            Clear
          </button>
        </div>
      )}
      <TextSettingError error={error} />
    </PreferenceRow>
  );
}

const STATE_LABEL: Record<OpenAIMCPSignal["state"], string> = {
  off: "Off",
  unconfigured: "Needs setup",
  installing: "Installing tunnel-client…",
  stopped: "Not running",
  starting: "Starting…",
  ready: "Ready. In ChatGPT: Settings → Connectors → add a custom MCP server, Connection: Tunnel",
  degraded: "Degraded",
};

function StatusRow({ signal }: { signal: OpenAIMCPSignal | null }) {
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);
  const state = signal?.state ?? "off";
  const label = STATE_LABEL[state];
  const text = signal?.detail ? `${label}: ${signal.detail}` : label;
  const canRestart = signal !== null && signal.enabled && state !== "off" && state !== "unconfigured" && state !== "installing";
  return (
    <PreferenceRow
      label="Connector status"
      sublabel="One tunnel-client per tunnel: a second host polling the same tunnel splits ChatGPT's requests."
    >
      <div className="flex flex-wrap items-start gap-2 min-[480px]:pt-0.5">
        <p data-testid="settings-openai-mcp-status" data-state={state} className="min-w-0 text-xs text-text-primary pt-1">
          {signal === null ? "Waiting for status…" : text}
        </p>
        {state === "unconfigured" && (
          <a href={OPENAI_TUNNELS_URL} target="_blank" rel="noreferrer" className={chipClass}>
            Create a tunnel
          </a>
        )}
        {canRestart && (
          <button
            type="button"
            className={chipClass}
            disabled={restarting}
            onClick={() => {
              if (restarting) return;
              setRestarting(true);
              setError("");
              restartOpenAIMCP()
                .then((res) => {
                  if (!res.ok) setError("The connector is off");
                })
                .catch((err: unknown) =>
                  setError(err instanceof Error && err.message ? err.message : "Restart failed"),
                )
                .finally(() => setRestarting(false));
            }}
          >
            Restart
          </button>
        )}
      </div>
      <TextSettingError error={error} />
    </PreferenceRow>
  );
}
