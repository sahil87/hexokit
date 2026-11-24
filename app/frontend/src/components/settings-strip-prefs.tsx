import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { controlClass } from "@/components/control";
import { PreferenceRow, ScopeHeading } from "@/components/text-setting-core";
import { useInstanceAccent } from "@/contexts/instance-accent-context";
import { useTheme } from "@/contexts/theme-context";
import { useStripPrefs } from "@/hooks/use-strip-prefs";
import { isShell } from "@/lib/shell";
import { STRIP_EFFECTS, STRIP_MOTIONS, stripLabelColor } from "@/lib/shell-strip";
import type { CssVarStyle, StripEffect, StripMotion } from "@/lib/shell-strip";
import { deriveUIColors } from "@/themes";

/**
 * Settings → Appearance → THIS APP: the desktop app's own strip preferences,
 * stored in the shell (not localStorage — every host is a separate origin
 * there — and not any host's config.yaml). Rendered only in the shell and only
 * when the shell carries the prefs invokers; an older shell hides the whole
 * group and the defaults (Glow + Light slides) apply.
 */

const EFFECT_LABEL: Record<StripEffect, string> = {
  glow: "Glow",
  livery: "Livery",
  halftone: "Halftone",
  hex: "Hex mesh",
  scan: "Scanlines",
  edge: "Edge light",
  flat: "Flat (today)",
};

const EFFECT_NOTE: Record<StripEffect, string> = {
  glow: "Radial light on the active square",
  livery: "Colour panel with a slanted cut",
  halftone: "Dot grids thinning outwards",
  hex: "Honeycomb fading from the square",
  scan: "Scanlines fading across",
  edge: "Light rising from the bottom edge",
  flat: "Even fill across the band",
};

const MOTION_LABEL: Record<StripMotion, string> = {
  slide: "Light slides",
  sweep: "Slide + sweep",
  cut: "Cut",
};

/** Sample light position/extent inside a preview card. */
const PREVIEW_AX_PX = 34;
const PREVIEW_DX_PX = 112;
const PREVIEW_SQUARE_COUNT = 3;
const PREVIEW_ACTIVE_INDEX = 1;
/** Colour a preview falls back to on a host with no color of its own. */
const PREVIEW_FALLBACK_COLOR = "#7d9afb";

function EffectCard({
  effect,
  selected,
  color,
  chrome,
  onSelect,
  cardRef,
}: {
  effect: StripEffect;
  selected: boolean;
  color: string;
  chrome: string;
  onSelect: () => void;
  cardRef: (el: HTMLButtonElement | null) => void;
}) {
  const style: CssVarStyle = {
    backgroundColor: chrome,
    color: stripLabelColor(chrome),
    "--rk-ax": `${PREVIEW_AX_PX}px`,
    "--rk-dx": `${PREVIEW_DX_PX}px`,
    "--rk-acc": color,
    "--rk-strip-bg": chrome,
  };
  return (
    <button
      ref={cardRef}
      type="button"
      aria-pressed={selected}
      aria-label={EFFECT_LABEL[effect]}
      data-effect={effect}
      onClick={onSelect}
      className={`flex flex-col gap-1 rounded border p-1.5 text-left transition-colors ${
        selected ? "border-text-primary" : "border-border hover:border-text-secondary"
      }`}
    >
      {/* The real treatment CSS, drawn at card size with this host's color. */}
      <span
        aria-hidden="true"
        className={`rk-strip rk-strip-fx-${effect} block h-7 w-full overflow-hidden rounded-sm`}
        style={style}
      >
        <span className="rk-strip-layer" />
        <span className="rk-strip-row flex items-center gap-[5px] px-2">
          {Array.from({ length: PREVIEW_SQUARE_COUNT }, (_, i) => (
            <i
              key={i}
              className={`rk-strip-sq ${i === PREVIEW_ACTIVE_INDEX ? "rk-strip-sq-on" : ""}`}
              style={{ width: 10, height: 10, backgroundColor: i === PREVIEW_ACTIVE_INDEX ? color : undefined }}
            />
          ))}
          <b className="rk-strip-nameplate ml-2 text-[9px]">host</b>
        </span>
      </span>
      <span className="text-xs text-text-primary">{EFFECT_LABEL[effect]}</span>
      <span className="text-[10px] leading-snug text-text-secondary">{EFFECT_NOTE[effect]}</span>
    </button>
  );
}

export function SettingsStripPrefs() {
  const prefs = useStripPrefs();
  const { stripeHex } = useInstanceAccent();
  const { theme } = useTheme();
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!isShell() || !prefs.canSet) return null;

  const chrome = deriveUIColors(theme.palette, theme.category).bgChrome;

  // Roving arrow keys over the effect cards (Enter/Space select — native
  // button activation). Grid order is the DOM order, so ←/→ and ↑/↓ both step.
  function onCardKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    const index = cardRefs.current.findIndex((el) => el === document.activeElement);
    if (index < 0) return;
    e.preventDefault();
    const next = Math.min(Math.max(index + delta, 0), STRIP_EFFECTS.length - 1);
    cardRefs.current[next]?.focus();
  }

  return (
    <section aria-label="This app settings" className="mt-4">
      <ScopeHeading
        label="This app"
        hint="stored in HexoKit Desktop · applies to every host you open in it"
      />
      <div className="divide-y divide-border/40">
        <PreferenceRow
          label="Host strip effect"
          sublabel="How the titlebar lights up for the active host."
          meta="strip.effect"
        >
          <div
            role="group"
            aria-label="Host strip effect"
            onKeyDown={onCardKeyDown}
            className="grid max-w-[600px] gap-2"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
          >
            {STRIP_EFFECTS.map((effect, i) => (
              <EffectCard
                key={effect}
                effect={effect}
                selected={prefs.effect === effect}
                color={stripeHex ?? PREVIEW_FALLBACK_COLOR}
                chrome={chrome}
                onSelect={() => prefs.setEffect(effect)}
                cardRef={(el) => {
                  cardRefs.current[i] = el;
                }}
              />
            ))}
          </div>
        </PreferenceRow>
        <PreferenceRow label="On switch" sublabel="Reduced motion always uses Cut." meta="strip.motion">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="On switch">
            {STRIP_MOTIONS.map((motion) => (
              <button
                key={motion}
                type="button"
                onClick={() => prefs.setMotion(motion)}
                aria-pressed={prefs.motion === motion}
                className={controlClass({
                  variant: "toggle",
                  base: "px-2 py-1 border rounded text-xs transition-colors",
                  pressed: prefs.motion === motion,
                })}
              >
                {MOTION_LABEL[motion]}
              </button>
            ))}
          </div>
        </PreferenceRow>
      </div>
    </section>
  );
}
