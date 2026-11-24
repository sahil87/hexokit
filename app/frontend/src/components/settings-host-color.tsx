import { PreferenceRow } from "@/components/text-setting-core";
import { useInstanceAccent } from "@/contexts/instance-accent-context";
import { useTheme } from "@/contexts/theme-context";
import { useShellServers } from "@/hooks/use-shell-servers";
import {
  HOST_COLOR_FAMILIES,
  hostColorClashMessage,
  hostColorValue,
  snapHostColor,
  usedHostHues,
} from "@/lib/host-colors";
import { isShell } from "@/lib/shell";
import { isSelfHost, stripLabelColor } from "@/lib/shell-strip";
import { colorValueToHex } from "@/themes";

/**
 * Settings → Appearance → Host color (THIS HOST scope): the host-owned identity
 * color — `instance_color` in this host's config.yaml, so every device sees the
 * same color. An inline row of the well-separated Host color hues (plus None);
 * a stored value outside the set highlights its nearest member and is not
 * rewritten until the user picks again.
 *
 * In the desktop shell a swatch whose hue another connected host already uses
 * is labelled with that host's monogram, and picking a clashing hue shows an
 * advisory — never a block. Browsers have no host list, so no labels.
 */
export function HostColorControl() {
  const { color, setColor } = useInstanceAccent();
  const { theme } = useTheme();
  const shellServers = useShellServers();
  const selected = snapHostColor(color);
  const used = usedHostHues(isShell() ? shellServers.filter((s) => !isSelfHost(s)) : []);
  const clash = hostColorClashMessage(selected, used);

  return (
    <PreferenceRow
      label="Host color"
      sublabel="This host's square and strip light, seen from every device. Spaced hues only. A hue another connected host already uses is labelled with that host's monogram."
      meta="instance_color"
    >
      <div role="radiogroup" aria-label="Host color" className="flex flex-wrap items-center gap-1.5">
        {HOST_COLOR_FAMILIES.map((family) => {
          const hex = colorValueToHex(family, theme.palette) ?? theme.palette.foreground;
          const isSelected = selected === family;
          const usedBy = used.get(family);
          return (
            <button
              key={family}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={
                usedBy ? `Color ${family}, used by ${usedBy.names.join(", ")}` : `Color ${family}`
              }
              data-color-value={family}
              onClick={() => setColor(hostColorValue(family))}
              className={`flex h-[22px] min-w-[22px] items-center justify-center rounded-sm px-0.5 text-[8px] font-bold leading-none transition-all coarse:h-[32px] coarse:min-w-[32px] ${
                isSelected ? "ring-2 ring-text-primary ring-offset-1 ring-offset-bg-primary" : ""
              }`}
              style={{ backgroundColor: hex, color: stripLabelColor(hex) }}
            >
              {usedBy ? usedBy.monograms[0] : ""}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setColor(null)}
          aria-pressed={selected === null}
          aria-label="No host color"
          className={`h-[22px] rounded-sm border border-border px-1.5 text-[10px] text-text-secondary transition-colors hover:text-text-primary coarse:h-[32px] ${
            selected === null ? "ring-1 ring-text-primary" : ""
          }`}
        >
          None
        </button>
      </div>
      {clash && (
        <p role="status" className="mt-1.5 text-[10px] text-amber-600">
          {clash}
        </p>
      )}
    </PreferenceRow>
  );
}
