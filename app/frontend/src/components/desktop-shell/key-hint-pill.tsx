import { Tip } from "@/components/tip";
import { keyHintLabel, keyHintTip } from "@/lib/shell-strip";

/**
 * The strip's modifier pill (`⌥⌘` on macOS, `Alt` elsewhere). Its space is
 * ALWAYS reserved — visibility, never conditional render, is what the
 * `.rk-strip-pill` rules toggle (visible while the band is hovered, the chord
 * is held, or a square is dragged) — so showing it moves nothing. It is a
 * no-drag island so hovering it can reveal the digits in the squares.
 */
export function KeyHintPill({
  platform,
  onHoverChange,
}: {
  platform: string;
  onHoverChange: (hovered: boolean) => void;
}) {
  return (
    <Tip label={keyHintTip(platform)}>
      <span
        data-testid="shell-key-hint-pill"
        className="rk-strip-pill rk-shell-no-drag"
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
      >
        {keyHintLabel(platform)}
      </span>
    </Tip>
  );
}
