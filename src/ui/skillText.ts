/**
 * Player-facing words for a skill's reach and its damage over time — one
 * source for the bar tooltips, the arena bar and the codex, read off the kit
 * data (`aoeRadius`, `overTime`) so the text cannot drift from the numbers.
 * House style: no dash characters in player-facing text.
 */
import { AOE_MAP_WIDE_M } from "@shared/combat";
import type { OverTime } from "@shared/types";

/** " to every enemy" / " to every enemy within 6 m of the target" / "". */
export function reachText(a: { aoeRadius?: number }): string {
  if (!a.aoeRadius) return "";
  return a.aoeRadius >= AOE_MAP_WIDE_M ? " to every enemy" : ` to every enemy within ${a.aoeRadius} m of the target`;
}

/** A sentence for the over-time share, or "" when the skill has none. */
export function overTimeText(a: { overTime?: OverTime }): string {
  const ot = a.overTime;
  if (!ot) return "";
  const share = `${Math.round(ot.share * 100)} percent of it`;
  const sec = ot.durationMs / 1000;
  return ot.zoneRadius
    ? `${share} burns on the ground where it lands for ${sec} sec, hitting every enemy in the ${ot.zoneRadius} m circle, including any that walk in late.`
    : `${share} keeps hurting each enemy it hit over ${sec} sec.`;
}
