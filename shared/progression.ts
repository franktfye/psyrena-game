/**
 * Gear & pet progression — the numbers, in one place (docs/09).
 *
 * Client, fight sim, and UI all read THIS module; server/economy.mjs mirrors
 * the same constants (it is plain node ESM and cannot import TS — same
 * "mirrors — do not drift" discipline as GEAR_TIERS in src/net/economy.ts).
 *
 * The balance receipts behind every number are docs/09 §5 (sim grids over
 * src/fight/bossFight.ts, 2026-08-07). Change a number here and the ladder
 * guard in tools/loadout-sim-check.mjs is the thing that catches the drift.
 */

/** The five armor slots that form the damage set. The `pet` slot is NOT here —
 *  pet progression is per-pet (PET_ROSTER below), not a set term. */
export const ARMOR_SLOTS = ["hat", "body", "gloves", "pants", "shoes"] as const;

/**
 * Damage-side set bonus by SET TIER — the lowest tier among the five armor
 * slots, so upgrading evenly is the optimal path. Index = set tier 0..4.
 * Ends at +12% because `resolveHit` clamps gear at COMBAT.maxGear (×1.12,
 * the 12% Rule) — a bigger number here would silently do nothing.
 */
export const GEAR_SET_BONUS = [0, 0.05, 0.075, 0.1, 0.12] as const;

/** The set tier: lowest tier among the armor slots (pet slot ignored). */
export function gearSetTier(gear: Record<string, number>): number {
  return Math.min(...ARMOR_SLOTS.map((s) => Math.max(0, Math.floor(gear[s] ?? 0))));
}

/** The gear term the damage pipeline consumes: 1.00 .. 1.12. */
export function gearMultiplier(gear: Record<string, number>): number {
  return 1 + (GEAR_SET_BONUS[Math.min(gearSetTier(gear), GEAR_SET_BONUS.length - 1)] ?? 0);
}

// ---------------------------------------------------------------------------
// Pets — stat items in the pet slot. A pet NEVER acts in combat; both stats
// are passive boosts to the owning player's character (docs/09 §3).
// ---------------------------------------------------------------------------

export type PetStatKind = "attack" | "healing" | "hp" | "focus";

/** Both pet stats ride this ladder together; index = pet level 0..3. */
export const PET_STAT_LADDER = [0.05, 0.08, 0.11, 0.15] as const;
export const PET_MAX_LEVEL = PET_STAT_LADDER.length - 1;

/** Imaginz to go level N → N+1 — same shape as the gear tier costs. */
export const PET_UPGRADE_COST = [200, 600, 1500] as const;

export interface PetSpec {
  id: string;
  name: string;
  /** The identity stat — what stat 2 boosts on the player. Stat 1 is always HP. */
  stat2: PetStatKind;
  /**
   * Hero-exclusive pet: implicitly owned while playing this hero, never in
   * the loot-box pool, never adoptable. (Druzhok's achievement acquisition —
   * docs/09 §4 — replaces the implicit grant when achievements wire up.)
   */
  exclusiveTo?: string;
}

/** Ids mirror ui/petPanel.ts PETS / scenes/petFollower.ts PET_PARK_ROSTER. */
export const PET_ROSTER: readonly PetSpec[] = [
  { id: "druzhok", name: "Druzhok", stat2: "focus", exclusiveTo: "pavlov" },
  { id: "robot", name: "Robot", stat2: "attack" },
  { id: "corgi", name: "Corgi", stat2: "hp" },
  { id: "husky", name: "Husky", stat2: "attack" },
  { id: "blackcat", name: "Black Cat", stat2: "focus" },
  { id: "dino", name: "Dino", stat2: "hp" },
  { id: "unicorn", name: "Unicorn", stat2: "healing" },
] as const;

export function petSpec(petId: string | null | undefined): PetSpec | null {
  return PET_ROSTER.find((p) => p.id === petId) ?? null;
}

/** Pets the loot boxes can drop and shards can adopt — the non-exclusives. */
export const PET_BOX_POOL: readonly string[] = PET_ROSTER.filter((p) => !p.exclusiveTo).map(
  (p) => p.id
);

/**
 * Acquisition (docs/09 §4). Index = loot box tier 0..3 (loss, standard win,
 * hard win, nightmare win). Difficulty scales the RATE, never the access.
 */
export const PET_LOOT = {
  dropRateByBoxTier: [0, 0.02, 0.05, 0.12],
  shardsByBoxTier: [1, 2, 5, 10],
  /** Shards to adopt any pet from the box pool — the pity floor. */
  adoptCost: 60,
  /** With every pool pet owned the drop slot pays shards ×this instead. */
  allOwnedShardMult: 3,
  /** Endgame sink: shards → Imaginz, this many Imaginz per shard. */
  shardToImaginz: 10,
} as const;

// ---------------------------------------------------------------------------
// Loadout — what a fight actually consumes.
// ---------------------------------------------------------------------------

/** Per-player stat terms the fight sim consumes at setup (docs/09 §6.3). */
export interface FightLoadout {
  /** Gear term for resolveHit, 1.00..1.12 (clamped there regardless). */
  gear: number;
  /** Scalar on every hit the player deals — pet "attack" stat. */
  petDamage: number;
  /** Scalar on every heal the player's kit delivers — pet "healing" stat. */
  petHealing: number;
  /** Player max-HP multiplier — pet stat 1 (+ stat 2 when it is "hp"). */
  hpMult: number;
  /** Focus regen multiplier — pet "focus" stat (pool size unchanged). */
  focusRegen: number;
}

export const NEUTRAL_LOADOUT: FightLoadout = {
  gear: 1,
  petDamage: 1,
  petHealing: 1,
  hpMult: 1,
  focusRegen: 1,
};

/**
 * Resolve gear tiers + the equipped pet into the fight terms.
 *
 * `petLevel` is the server-owned level (0..3); pass null `petId` for no pet.
 * A hero-exclusive pet only counts for its hero — the caller passes the
 * selected hero so a stale wardrobe save can't smuggle Druzhok's stats onto
 * Freud.
 */
export function resolveLoadout(
  gear: Record<string, number>,
  petId: string | null,
  petLevel: number,
  selectedHero: string
): FightLoadout {
  const out: FightLoadout = { ...NEUTRAL_LOADOUT, gear: gearMultiplier(gear) };
  const pet = petSpec(petId);
  if (!pet) return out;
  if (pet.exclusiveTo && pet.exclusiveTo !== selectedHero) return out;
  const lvl = Math.max(0, Math.min(PET_MAX_LEVEL, Math.floor(petLevel)));
  const v = PET_STAT_LADDER[lvl] ?? PET_STAT_LADDER[0];
  out.hpMult = 1 + v;
  if (pet.stat2 === "hp") out.hpMult += v; // stacks: up to +30% at max
  else if (pet.stat2 === "attack") out.petDamage = 1 + v;
  else if (pet.stat2 === "healing") out.petHealing = 1 + v;
  else if (pet.stat2 === "focus") out.focusRegen = 1 + v;
  return out;
}
