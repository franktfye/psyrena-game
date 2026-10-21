/**
 * Client for the economy API (server/economy.mjs): Imaginz balance, gear
 * tiers, loot boxes, fight results, and the seasonal rankings.
 *
 * Same fetch idiom as social.ts / roomsPanel.ts — same-origin, cookie auth,
 * JSON POST helper. Every call throws an `ApiError` carrying the HTTP status
 * and the parsed error body, so callers can branch on 402 (insufficient
 * Imaginz) without re-parsing anything.
 */

import type { FightDifficulty } from "../fight/difficulty";

export type { FightDifficulty } from "../fight/difficulty";

export type GearSlot = "hat" | "body" | "gloves" | "pants" | "shoes" | "pet";

export const GEAR_SLOTS: GearSlot[] = ["hat", "body", "gloves", "pants", "shoes", "pet"];

export interface GearTier {
  name: string;
  quality: string;
  color: string;
  /** Imaginz cost to upgrade INTO the next tier; null at max. */
  cost: number | null;
}

/** Mirrors server/economy.mjs — do not drift. */
export const GEAR_TIERS: GearTier[] = [
  { name: "Latent", quality: "Common", color: "#9aa3ad", cost: 200 },
  { name: "Emergent", quality: "Uncommon", color: "#57d977", cost: 600 },
  { name: "Lucid", quality: "Rare", color: "#4da3ff", cost: 1500 },
  { name: "Oneiric", quality: "Epic", color: "#b46bff", cost: 3500 },
  { name: "Transcendent", quality: "Legendary", color: "#ffc94d", cost: null },
];

export const MAX_GEAR_TIER = GEAR_TIERS.length - 1;

/** Loot box tier names, index = tier (0..3). Mirrors server/economy.mjs. */
export const LOOT_TIERS = [
  "Residue Cache",
  "Insight Cache",
  "Reverie Cache",
  "Transference Cache",
] as const;

export interface LootBox {
  id: string;
  tier: 0 | 1 | 2 | 3;
  name: string;
  source: string;
  createdAt: number;
}

/**
 * Account level and the fill of the HUD's exp bar. The curve lives on the
 * server (economy.mjs `progressionFor`) — the client renders `xpInto/xpNeeded`
 * and never recomputes a level from raw XP.
 */
export interface Progression {
  level: number;
  /** Lifetime XP, all levels included. */
  xp: number;
  /** XP earned into the CURRENT level; equals xpNeeded at the level cap. */
  xpInto: number;
  /** XP the current level costs to clear. */
  xpNeeded: number;
}

export interface EconomyState extends Progression {
  imaginz: number;
  gear: Record<GearSlot, number>;
  /** Owned pets as { petId: level 0..3 }. Hero-exclusives never appear (implicit). */
  pets: Record<string, number>;
  /** Pet shards — the loot pity floor (docs/09 §4). */
  shards: number;
  /** Unopened boxes only. */
  lootBoxes: LootBox[];
}

export interface UpgradeResponse {
  slot: GearSlot;
  tier: number;
  imaginz: number;
}

export interface OpenLootResponse {
  id: string;
  tier: number;
  /** The rolled Imaginz award. */
  imaginz: number;
  balance: number;
  /** Pet shards this open granted (×3 with the whole pool already owned). */
  shardsGained: number;
  /** Shard total after the grant. */
  shards: number;
  /** The whole-pet jackpot — a pet id, or null on an ordinary open. */
  pet: string | null;
}

export interface FightResultPayload {
  win: boolean;
  difficulty: FightDifficulty;
  durationMs: number;
  dps: number;
  healing: number;
  damageTaken: number;
  /** Bot-teammate practice run — fixed small award, no ranked records. */
  practice?: boolean;
}

export interface FightResultResponse extends Progression {
  score: number;
  rating: number;
  seasonId: string;
  imaginzAwarded: number;
  balance: number;
  /** XP this attempt paid — a loss still pays a consolation trickle. */
  xpAwarded: number;
  /** Absent on practice runs — practice pays Imaginz only, never a cache. */
  lootBox?: { id: string; tier: number; name: string };
  /** Practice-run receipt: today's total and the daily ceiling. */
  practice?: { awarded: number; today: number; cap: number };
  /**
   * The run beat one of the player's own records — absent otherwise. `kinds`
   * names what fell ("score" | "dps" | "time"); `bonus` is the extra Imaginz
   * already included in `imaginzAwarded`.
   */
  personalBest?: { kinds: string[]; bonus: number };
  /**
   * A hero this win unlocked (server/economy.mjs HERO_UNLOCK_WINS) — Skinner
   * on the first boss clear, Erikson on the second. Absent otherwise.
   */
  heroUnlocked?: string;
}

export interface RankingsResponse {
  season: { id: string; name: string; endsAt: number };
  top: { username: string; rating: number; battles: number; wins: number; bestScore: number }[];
  me: { rating: number; rank: number; battles: number; wins: number; bestScore: number };
}

/** HTTP failure with the server's parsed error body attached. */
export class ApiError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) {
    super(typeof data.error === "string" ? data.error : `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export function getEconomy(): Promise<EconomyState> {
  return api<EconomyState>("/api/economy");
}

export function upgradeGear(slot: GearSlot): Promise<UpgradeResponse> {
  return api<UpgradeResponse>("/api/gear/upgrade", { slot });
}

export function openLoot(id: string): Promise<OpenLootResponse> {
  return api<OpenLootResponse>("/api/loot/open", { id });
}

export interface PetUpgradeResponse {
  petId: string;
  level: number;
  imaginz: number;
}

export interface PetAdoptResponse {
  petId: string;
  level: number;
  shards: number;
}

/** Level up an owned pet (both stats climb together) — 402 when short. */
export function upgradePet(petId: string): Promise<PetUpgradeResponse> {
  return api<PetUpgradeResponse>("/api/pet/upgrade", { petId });
}

/** Spend the shard pity floor on a chosen pool pet — 402 when short. */
export function adoptPet(petId: string): Promise<PetAdoptResponse> {
  return api<PetAdoptResponse>("/api/pet/adopt", { petId });
}

/** Endgame sink: all shards → Imaginz; 409 until every pool pet is owned. */
export function convertShards(): Promise<{ converted: number; imaginz: number; balance: number; shards: number }> {
  return api("/api/pet/shards/convert", {});
}

/** Dream Siege settlement (server/economy.mjs handleSurvivalSettle): the server rolls the jackpot. */
export interface SurvivalSettleResponse {
  awarded: number; jackpot: boolean; bestWave: number; newBest: boolean; balance: number;
  /** The cache the run left (null: a loss before the first boss). Unopened, it waits in the village. */
  lootBox: Pick<LootBox, "id" | "tier" | "name"> | null;
}
export function postSurvivalSettle(body: {
  difficulty: string; victory: boolean; wavesCleared: number; durationS: number;
  score?: { dealt: number; healed: number; kills: number; downs: number; revives: number };
  recallRight?: number;
}): Promise<SurvivalSettleResponse> {
  return api<SurvivalSettleResponse>("/api/survival/settle", body);
}

export function postFightResult(stats: FightResultPayload): Promise<FightResultResponse> {
  return api<FightResultResponse>("/api/fight/result", stats);
}

/**
 * Fight-ready barrier (server/app.mjs): "my arena scene finished loading".
 * `solo: true` means nobody to wait for — start immediately. Otherwise the
 * party's `fightStart` SSE push (net/social.ts) releases the barrier.
 */
export interface FightReadyStatus {
  solo: boolean;
  roomId?: number;
  ready?: number;
  total?: number;
}

export function postFightReady(): Promise<FightReadyStatus> {
  return api<FightReadyStatus>("/api/fight/ready", {});
}

/**
 * This player's seat in their party, or null when they are running solo.
 *
 * Seats are the party roster's order, which every member computes from the
 * same server list — so the three clients agree on who is seat 0/1/2 without
 * anyone coordinating. The arena uses it to stand party members on separate
 * spots: without it every member spawns on the identical pad and a 3-stack
 * renders as one body with three nameplates.
 */
export async function getPartySeat(username: string): Promise<{ index: number; size: number } | null> {
  const lobby = await api<{ room?: { members?: { username: string }[] } }>("/api/lobby");
  const members = lobby.room?.members ?? [];
  if (members.length <= 1) return null;
  const index = members.findIndex((m) => m.username.toLowerCase() === username.toLowerCase());
  if (index < 0) return null;
  return { index, size: members.length };
}

/**
 * "I am not coming" — the party was launched but this player stayed behind
 * (declined the paid entry, or admission refused). It satisfies their slot in
 * the barrier so the teammates who ARE loading start as soon as they are
 * ready, instead of waiting out the 45 s timeout on someone who never left
 * the village. Fire-and-forget: a failure just costs the party that timeout.
 */
export function postFightSkip(): Promise<FightReadyStatus> {
  return api<FightReadyStatus>("/api/fight/ready", { skip: true });
}

export function getRankings(): Promise<RankingsResponse> {
  return api<RankingsResponse>("/api/rankings");
}

/**
 * Arena admission. Three entries a day are free (reset at the server's
 * midnight); past those each entry charges `extraCost` Imaginz. `enterArena`
 * throws `ApiError` 402 when the allowance is spent and the wallet is short.
 */
export interface ArenaStatus {
  used: number;
  freePerDay: number;
  freeLeft: number;
  extraCost: number;
  balance: number;
  /** Imaginz per practice run, what today's runs already paid, and the cap. */
  practiceAward: number;
  practiceToday: number;
  practiceCap: number;
}

export interface ArenaEnterResponse extends ArenaStatus {
  ok: true;
  /** Imaginz charged for this admission — 0 while free entries remain. */
  cost: number;
}

export function getArenaStatus(): Promise<ArenaStatus> {
  return api<ArenaStatus>("/api/arena/status");
}

export function enterArena(): Promise<ArenaEnterResponse> {
  return api<ArenaEnterResponse>("/api/arena/enter", {});
}
