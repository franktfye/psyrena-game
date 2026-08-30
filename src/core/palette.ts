import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";

/**
 * The locked Psyrena palette — doc 01 "visual direction", doc 06 lookdev rules.
 *
 * One palette, two scenes. The arena is the cold half (void black, cyan/violet
 * holo, red-warn telegraphs); the village is the same palette with the *warm*
 * half switched on — dusk sky, spilled coffee-shop light, magenta storefronts.
 * Keeping both in one file is what stops the hub and the arena from drifting
 * into two different games.
 *
 * WARNING: these are shared object references. A material assignment
 * (`mat.emissiveColor = PALETTE.cyan`) does NOT copy. If a scene ever animates
 * a colour, `.clone()` it first — otherwise the mutation follows the constant
 * into the next scene, which survives `scene.dispose()` and is miserable to
 * track down.
 */
export const PALETTE = {
  /** Arena clear colour — the void the fractured office floats in. */
  void: new Color4(0.016, 0.027, 0.047, 1),
  fog: new Color3(0.035, 0.055, 0.09),
  cyan: new Color3(0.25, 0.9, 1.0),
  violet: new Color3(0.62, 0.35, 1.0),
  warn: new Color3(1.0, 0.35, 0.42),
  floor: new Color3(0.05, 0.06, 0.085),
} as const;

/**
 * Village-hub extension — the dusk half of the palette.
 *
 * Sampled off the concept set (`assets/concept/village/`): V3 is the colour
 * script (warm coffee light left, cold holo right), V1 is the layout.
 */
export const VILLAGE = {
  /** Dusk haze. The hub has no skybox — this colour IS the sky (see doc 06). */
  sky: new Color4(0.075, 0.078, 0.105, 1),
  fog: new Color3(0.10, 0.10, 0.135),

  /** Wet dusk pavement. Dark enough that every emissive reads as a light source. */
  pavement: new Color3(0.055, 0.058, 0.075),
  plazaInlay: new Color3(0.085, 0.09, 0.115),

  /** Building shells: matte charcoal panel + brick, per the V2 sheet. */
  shell: new Color3(0.045, 0.048, 0.062),
  shellLight: new Color3(0.13, 0.13, 0.15),
  /** Hall of Minds only — the one pale material in the block. */
  marble: new Color3(0.42, 0.43, 0.47),

  /** Storefront accents. Magenta is the Outfitter/Style Lab signature in V1. */
  magenta: new Color3(1.0, 0.22, 0.72),
  /** Coffee-shop interior + its spill on the pavement. The only warm light. */
  warmLight: new Color3(1.0, 0.62, 0.28),
  /** Pet-park turf, lit at dusk. */
  turf: new Color3(0.09, 0.19, 0.11),
} as const;

/**
 * DAY variant of the village colour script.
 *
 * The hub now renders at midday rather than dusk. This is a deliberate
 * departure from the dusk script in doc 01 / concept V3, and it has a cost
 * worth writing down: the dusk values above are dark specifically so that every
 * emissive surface — storefront glass, holo signage, the function glyphs, the
 * queue screen — reads as a *light source*. Under a bright sky those same
 * emissives read as flat colour instead, because nothing around them is dark
 * enough for them to out-shine.
 *
 * These values push back where they can: surfaces stay a little desaturated and
 * mid-valued rather than blown out, so emissives keep as much separation as
 * daylight allows. If the neon identity ever matters more than the brightness,
 * the cheapest route back is golden hour — keep this sky and sun, drop the
 * exposure and warm the key.
 */
export const VILLAGE_DAY = {
  /** Sky behind the skybox; only visible if the skybox ever fails to load. */
  sky: new Color4(0.44, 0.62, 0.86, 1),
  /**
   * Island-edge sea-air veil. Tuned to the painted village_sky horizon band
   * (pale blue-white haze) so fogged geometry blends into the skybox instead
   * of cutting a grey ring against it.
   */
  fog: new Color3(0.72, 0.80, 0.90),

  /** Sunlit paving. Mid-value, not white — blown-out ground kills every decal. */
  pavement: new Color3(0.38, 0.39, 0.42),
  plazaInlay: new Color3(0.44, 0.45, 0.48),

  shell: new Color3(0.30, 0.30, 0.33),
  shellLight: new Color3(0.52, 0.52, 0.55),
  marble: new Color3(0.74, 0.75, 0.78),

  /** Sunlit grass, several stops up from the dusk turf. */
  turf: new Color3(0.24, 0.42, 0.20),
} as const;
