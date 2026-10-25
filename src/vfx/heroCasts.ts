import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { createFreudSkillVfx, STAGE_TINTS, type FreudCastKind, type FreudSkillVfx } from "./freudCasts";
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
  if (heroId === "erikson") {
    return lazySkillVfx(() => import("./eriksonCasts").then((m) => m.createEriksonSkillVfx(scene, hero)));
  }
  if (heroId === "ainsworth") {
    return lazySkillVfx(() => import("./ainsworthCasts").then((m) => m.createAinsworthSkillVfx(scene, hero)));
  }
  if (heroId === "piaget") {
    return lazySkillVfx(() => import("./piagetCasts").then((m) => m.createPiagetSkillVfx(scene, hero)));
  }
  if (heroId === "bandura") {
    return lazySkillVfx(() => import("./banduraCasts").then((m) => m.createBanduraSkillVfx(scene, hero)));
  }
  return createFreudSkillVfx(scene, hero);
}

/**
 * A hero VFX module behind `import()` (CLAUDE.md rule 3: the boot chunk only
 * carries what the village needs on first frame). The load starts when the bar
 * mounts, well before a first cast; anything cast in the gap is replayed once
 * the module lands (at most two, so a mash during a slow load does not burst).
 */
function lazySkillVfx(load: () => Promise<HeroSkillVfx>): HeroSkillVfx {
  let impl: HeroSkillVfx | null = null;
  const pending: [FreudCastKind, string][] = [];
  load()
    .then((v) => {
      impl = v;
      for (const [kind, id] of pending.splice(0)) v.cast(kind, id);
    })
    .catch((err: unknown) => console.warn("[vfx] hero skill effects failed to load:", err));
  return {
    cast(kind, id) {
      if (impl) impl.cast(kind, id);
      else if (pending.length < 2) pending.push([kind, id]);
    },
  };
}

/**
 * Palette-cast tint for a slot id, across every hero's naming (Freud's stage
 * suffixes, Pavlov's ucs/cs, Skinner's schedule suffixes). Falls back to
 * Freud's oral cyan, which is also what the pre-hero-keyed code did.
 */
export function paletteTint(slotId: string): Color3 {
  const suffix = (slotId.split(".").pop() ?? "").split(":")[0] ?? "";
  return (
    STAGE_TINTS[suffix] ??
    PAVLOV_TINTS[suffix] ??
    SKINNER_TINTS[suffix] ??
    ERIKSON_TINTS[suffix] ??
    AINSWORTH_TINTS[suffix] ??
    PIAGET_TINTS[suffix] ??
    (slotId.startsWith("bandura.") ? BANDURA_COPY_TINT : undefined) ??
    STAGE_TINTS.oral!
  );
}

/**
 * Erikson's two keys, warm then gold — the plan's syntonic palette. He has no
 * casts module of his own yet (his skill VFX borrow Freud's), so the tints
 * live here.
 */
const ERIKSON_TINTS: Record<string, Color3> = {
  stage: new Color3(1.0, 0.62, 0.38), // the crisis, warm amber
  virtue: new Color3(1.0, 0.86, 0.42), // the virtue it yields, gold
};

/** Ainsworth's four styles, the hues of her icons and cast effects. */
const AINSWORTH_TINTS: Record<string, Color3> = {
  secure: new Color3(1.0, 0.48, 0.62), // rose
  avoidant: new Color3(0.62, 0.74, 0.88), // steel
  ambivalent: new Color3(1.0, 0.42, 0.28), // coral
  disorganized: new Color3(0.66, 0.42, 1.0), // violet
};

/** Piaget's four stages, the hues of his icons and cast effects. */
const PIAGET_TINTS: Record<string, Color3> = {
  sensorimotor: new Color3(1.0, 0.7, 0.25), // amber
  preoperational: new Color3(1.0, 0.45, 0.5), // coral
  concrete: new Color3(0.38, 0.75, 1.0), // sky
  formal: new Color3(0.68, 0.45, 1.0), // violet
};

/** Bandura's reproductions fly the cyan of the squares on his tie. */
const BANDURA_COPY_TINT = new Color3(0.3, 0.9, 1.0);

/**
 * Basic-attack projectile style, shared by the hub bar and the arena bar so
 * the two cannot drift. Pavlov throws the little NS bell (spinning, like the
 * CS ring fan), Freud blows a cigar-smoke ring; the other named heroes fly
 * their own procedural props and unknown heroes keep the plain fast blue bolt.
 */
export function basicProjectileStyle(heroId: string): { color: Color3; dressing?: DressingKind } {
  if (heroId === "pavlov") return { color: new Color3(1.0, 0.84, 0.3), dressing: "bell" };
  if (heroId === "freud") return { color: new Color3(0.62, 0.64, 0.68), dressing: "smoke" };
  // Erikson's add-on carries the cyan of his hourglass charm.
  if (heroId === "erikson") return { color: new Color3(0.4, 0.92, 0.95), dressing: "hourglass" };
  if (heroId === "ainsworth") return { color: new Color3(0.16, 0.78, 0.8), dressing: "thread" };
  if (heroId === "piaget") return { color: new Color3(0.28, 0.95, 0.58), dressing: "schema" };
  if (heroId === "bandura") return { color: new Color3(0.7, 0.88, 0.96), dressing: "echo" };
  return { color: new Color3(0.45, 0.75, 1.0) };
}

/**
 * Ultimate projectile colour: Freud's Dream-Analysis pink, Pavlov's dome
 * cyan, Skinner's Shaping heal-gold.
 */
/**
 * The prop a palette cast flies, if any — Pavlov's UCS steak, Erikson's
 * Life Stage ring and Virtue gem. Spread into a projectile spec by both bars.
 * Takes the slot id (a stage-suffixed key like "erikson.stage:5" works too).
 */
export function paletteDressing(slotId: string): { dressing?: DressingKind } {
  const id = slotId.split(":")[0];
  if (id === "pavlov.ucs") return { dressing: "steak" };
  if (id === "erikson.stage") return { dressing: "lifering" };
  if (id === "erikson.virtue") return { dressing: "gem" };
  // Her four styles fly her heart-in-shield, tinted by style (paletteTint).
  if (id.startsWith("ainsworth.")) return { dressing: "heart" };
  if (id.startsWith("piaget.")) return { dressing: "schema" };
  if (id.startsWith("bandura.")) return { dressing: "reproduction" };
  return {};
}

/** The prop the ultimate flies, if any. */
export function ultimateDressing(heroId: string): { dressing?: DressingKind } {
  if (heroId === "ainsworth") return { dressing: "locket" };
  if (heroId === "erikson") return { dressing: "spiral" };
  if (heroId === "piaget") return { dressing: "balance" };
  if (heroId === "bandura") return { dressing: "reproduction" };
  return {};
}

export function ultimateTint(heroId: string): Color3 {
  if (heroId === "pavlov") return new Color3(0.35, 0.9, 1.0);
  if (heroId === "skinner") return new Color3(1.0, 0.82, 0.45);
  if (heroId === "erikson") return new Color3(1.0, 0.86, 0.42); // the banked virtues' gold
  if (heroId === "ainsworth") return new Color3(1.0, 0.82, 0.34); // the mended heart's gold
  if (heroId === "piaget") return new Color3(1.0, 0.84, 0.36); // the scales' gold
  if (heroId === "bandura") return new Color3(1.0, 0.82, 0.32); // the triad's gold
  return new Color3(1.0, 0.35, 0.72);
}
