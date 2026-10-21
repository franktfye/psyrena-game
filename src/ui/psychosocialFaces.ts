/**
 * What Erikson's bar says, from the rotation state — one function for the
 * arena bar and the hub/practice bar, so the words a student learns in the
 * village are the words the fight shows.
 *
 *   key 1   the stage's syntonic pole        "Identity"
 *   key 2   its virtue                       "Fidelity"
 *   LMB     the stage's significant relations, and whether the add-on is up
 *   caption the whole row of the chart,      "Stage 5 · Identity vs Role
 *           then what to press               Confusion · age 12 to 18"
 *                                            "press 2 → Fidelity · Virtues 3/8"
 */

import type { PsychosocialHudState } from "@shared/fight/psychosocial";
import type { PsychosocialSpec } from "../../shared/types";

export interface PsychosocialFaces {
  stage: string;
  virtue: string;
  /** Icon file stems for keys 1 and 2 — the stage's crisis glyph and virtue glyph. */
  stageIcon: string;
  virtueIcon: string;
  basic: string;
  caption: string;
}

export function psychosocialFaces(spec: PsychosocialSpec, s: PsychosocialHudState): PsychosocialFaces {
  const row = spec.stages[s.stage]!;
  const addonRow = spec.stages[s.addon ? s.addonStage : s.stage]!;
  const next = s.armed ? `press 2 → ${row.virtue}` : `press 1 → ${row.short}`;
  return {
    stage: row.short,
    virtue: row.virtue,
    stageIcon: `stage_${s.stage + 1}`,
    virtueIcon: `virtue_${s.stage + 1}`,
    basic: `${addonRow.relations}\n${s.addon ? "add-on ready" : "after 1 or 2"}`,
    caption: `Stage ${s.stage + 1} · ${row.crisis} · age ${row.age}\n${next} · Virtues ${s.virtues}/${spec.maxVirtues}`,
  };
}
