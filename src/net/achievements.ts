/**
 * Client for the achievements / titles / leaderboards API: the 33-achievement
 * list with per-account progress, the owned/equipped title state, and the
 * three Hall boards (global rating, fastest boss clears, account levels).
 *
 * Same fetch idiom as economy.ts — same-origin, cookie auth, `ApiError`
 * carrying the HTTP status. `cmp` semantics stay server-side; the client only
 * ever renders `progress` against `target`.
 */

import { ApiError } from "./economy";

export type AchievementCategory =
  | "collection"
  | "ranking"
  | "damage"
  | "levels"
  | "boss"
  | "friends"
  | "gear";

export interface AchievementDef {
  id: string;
  category: AchievementCategory;
  name: string;
  desc: string;
  icon: string;
  target: number;
  progress: number;
  unlocked: boolean;
  unlockedAt: number | null;
  /** Server flags a freshly unlocked, not-yet-seen achievement. */
  isNew: boolean;
  /** The title this achievement awards on unlock; null when it grants none. */
  title: string | null;
}

export interface TitleState {
  owned: string[];
  /** Null when no title is equipped. */
  equipped: string | null;
}

export interface AchievementsResponse {
  achievements: AchievementDef[];
  titles: TitleState;
}

export interface EquipTitleResponse {
  ok: boolean;
  title: string | null;
}

export interface GlobalBoardRow {
  rank: number;
  username: string;
  rating: number;
  level: number;
}

export interface ClearBoardRow {
  rank: number;
  username: string;
  ms: number;
  difficulty: string;
}

export interface LevelBoardRow {
  rank: number;
  username: string;
  level: number;
  xp: number;
}

export interface LeaderboardsResponse {
  global: {
    top: GlobalBoardRow[];
    own: { rank: number | null; rating: number; level: number };
  };
  clears: {
    top: ClearBoardRow[];
    own: { rank: number | null; ms: number; difficulty: string };
  };
  levels: {
    top: LevelBoardRow[];
    own: { rank: number | null; level: number; xp: number };
  };
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

export function getAchievements(): Promise<AchievementsResponse> {
  return api<AchievementsResponse>("/api/achievements");
}

/** Equip a title (must be owned — 400 otherwise), or unequip with null. */
export function equipTitle(title: string | null): Promise<EquipTitleResponse> {
  return api<EquipTitleResponse>("/api/title/equip", { title });
}

export function getLeaderboards(): Promise<LeaderboardsResponse> {
  return api<LeaderboardsResponse>("/api/leaderboards");
}
