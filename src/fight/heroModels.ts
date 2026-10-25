/**
 * Hero ids with a shipped /assets/heroes/<id>.glb; anyone else borrows Freud's rig.
 *
 * Kept free of imports so the Node tools can read it too:
 * `tools/ship-hero.mjs --install` adds an id here, and
 * `tools/verify-hero-assets.mjs` (end of `npm run build`) fails if this set and
 * the rigged glbs in public/assets/heroes/ disagree.
 */
export const MODELED_HEROES: ReadonlySet<string> = new Set(["freud", "pavlov", "skinner", "erikson", "ainsworth", "piaget", "bandura"]);
