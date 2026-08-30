/**
 * Fight loadout state — the client-side cache of gear tiers and pet levels,
 * resolved into the stat terms a fight consumes (shared/progression.ts).
 *
 * Same module-singleton + sync discipline as state/potions.ts: the server
 * (/api/economy) is the authority on tiers, ownership, and levels; this cache
 * is only ever what the last snapshot (or purchase receipt) said. The sim
 * falls back to a neutral loadout when nothing has synced — an ungeared fight
 * beats a broken one.
 *
 * `syncLoadout()` runs at village load (villageHub.ts, beside
 * syncPotionBuffs) and after every gear/pet purchase (the panels push their
 * receipts). The equipped pet itself lives in state/wardrobe.ts; the caller
 * resolves it (petFollower.petForHero) and passes it into `fightLoadout`.
 */

import {
  NEUTRAL_LOADOUT,
  resolveLoadout,
  type FightLoadout,
} from "../../shared/progression";
import { getEconomy } from "../net/economy";

let gear: Record<string, number> | null = null;
let pets: Record<string, number> = {};
let shards = 0;

const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((cb) => cb());

/** Repaint hook for panels showing shard counts / levels. */
export function onLoadoutChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Adopt a fresh /api/economy snapshot (or the relevant slice of one). */
export function setLoadoutState(next: {
  gear?: Record<string, number>;
  pets?: Record<string, number>;
  shards?: number;
}): void {
  if (next.gear) gear = { ...next.gear };
  if (next.pets) pets = { ...next.pets };
  if (next.shards !== undefined) shards = next.shards;
  emit();
}

/** One pet's server-owned level; 0 covers unowned and hero-exclusives alike. */
export function petLevel(petId: string): number {
  return pets[petId] ?? 0;
}

export function ownedPets(): Record<string, number> {
  return { ...pets };
}

export function shardCount(): number {
  return shards;
}

/** Whether a snapshot has landed — panels use it to tell 0 from "unknown". */
export function loadoutSynced(): boolean {
  return gear !== null;
}

/**
 * Refresh from the server. Failures are swallowed — a neutral loadout beats
 * a broken village load, same contract as syncPotionBuffs.
 */
export function syncLoadout(): Promise<void> {
  return getEconomy()
    .then((s) => setLoadoutState({ gear: s.gear, pets: s.pets, shards: s.shards }))
    .catch(() => undefined);
}

/**
 * The stat terms for a fight starting NOW: gear set bonus + the equipped
 * pet's stats, exclusivity checked against the hero actually fighting.
 *
 * `petId` is the caller's resolved pet — scenes/petFollower.petForHero, the
 * SAME resolution the follower rig and the ranked `begin` declaration use.
 * Reading wardrobe.pet here instead once made the default hero-exclusive pet
 * (petChosen=false) count in ranked fights but not in practice ones.
 */
export function fightLoadout(heroId: string, petId: string | null): FightLoadout {
  if (!gear) return { ...NEUTRAL_LOADOUT };
  return resolveLoadout(gear, petId, petLevel(petId ?? ""), heroId);
}
