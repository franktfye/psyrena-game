import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { createFreudSkillVfx, STAGE_TINTS, type FreudSkillVfx } from "./freudCasts";
import { createPavlovSkillVfx, PAVLOV_TINTS } from "./pavlovCasts";
import { createSkinnerSkillVfx, SKINNER_TINTS } from "./skinnerCasts";
import type { DressingKind } from "./projectiles";

/**
 * Hero-keyed skill-VFX selection. Both bars (hub and arena) call this instead
 * of a per-hero factory, so a new hero's VFX is one line here plus a module in
 * src/vfx/ — the call sites never change. Unknown ids borrow Freud's set, the
 * same fallback rule the rig loader uses.
 */
export type HeroSkillVfx = FreudSkillVfx;

export function createHeroSkillVfx(
  scene: Scene,
  hero: TransformNode,
  heroId: string,
  /** Live chest points of the caster's teammates — Skinner's team-flow streams. */
  allies?: () => Vector3[]
): HeroSkillVfx {
  if (heroId === "pavlov") return createPavlovSkillVfx(scene, hero);
  if (heroId === "skinner") return createSkinnerSkillVfx(scene, hero, allies);
  return createFreudSkillVfx(scene, hero);
}

/**
 * Palette-cast tint for a slot id, across every hero's naming (Freud's stage
 * suffixes, Pavlov's ucs/cs, Skinner's schedule suffixes). Falls back to
 * Freud's oral cyan, which is also what the pre-hero-keyed code did.
 */
export function paletteTint(slotId: string): Color3 {
  const suffix = slotId.split(".").pop() ?? "";
  return STAGE_TINTS[suffix] ?? PAVLOV_TINTS[suffix] ?? SKINNER_TINTS[suffix] ?? STAGE_TINTS.oral!;
}

/**
 * Basic-attack projectile style, shared by the hub bar and the arena bar so
 * the two cannot drift. Pavlov throws the little NS bell (spinning, like the
 * CS ring fan), Freud blows a cigar-smoke ring; everyone else keeps the
 * plain fast blue bolt.
 */
export function basicProjectileStyle(heroId: string): { color: Color3; dressing?: DressingKind } {
  if (heroId === "pavlov") return { color: new Color3(1.0, 0.84, 0.3), dressing: "bell" };
  if (heroId === "freud") return { color: new Color3(0.62, 0.64, 0.68), dressing: "smoke" };
  return { color: new Color3(0.45, 0.75, 1.0) };
}

/**
 * Ultimate projectile colour: Freud's Dream-Analysis pink, Pavlov's dome
 * cyan, Skinner's Shaping heal-gold.
 */
export function ultimateTint(heroId: string): Color3 {
  if (heroId === "pavlov") return new Color3(0.35, 0.9, 1.0);
  if (heroId === "skinner") return new Color3(1.0, 0.82, 0.45);
  return new Color3(1.0, 0.35, 0.72);
}
