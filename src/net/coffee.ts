/**
 * Client for the Coffee Shop API (server/coffee.mjs): the potion menu, the
 * buy call, and the redeem-a-code hook. Same fetch idiom as economy.ts —
 * same-origin, cookie auth, `ApiError` carrying status + parsed body so the
 * storefront can branch on 402 without re-parsing anything.
 */

import { ApiError } from "./economy";

export type PotionEffect = "damage" | "healing" | "focus";

export interface CoffeeItem {
  id: string;
  name: string;
  size: "S" | "M" | "L";
  /** Imaginz. null on the grayed coming-soon sizes. */
  price: number | null;
  effect: PotionEffect;
  /** Additive multiplier bonus while active (0.2 = +20%). */
  magnitude: number;
  /** False = catalogued but not purchasable (M/L teasers). */
  available: boolean;
  desc: string;
}

/** A live potion effect on the account, HUD presentation included. */
export interface ActivePotion {
  effect: PotionEffect;
  magnitude: number;
  /** Absolute wall-clock ms (server Date.now()). */
  expiresAt: number;
  /** Buff-tile face: "Espresso Veins" / "Steady Hands". */
  name: string;
  icon: string;
}

export interface CoffeeState {
  items: CoffeeItem[];
  imaginz: number;
  active: ActivePotion[];
}

export interface CoffeeBuyResponse {
  ok: true;
  item: string;
  balance: number;
  active: ActivePotion[];
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

export function getCoffee(): Promise<CoffeeState> {
  return api<CoffeeState>("/api/coffee");
}

export function buyCoffee(item: string): Promise<CoffeeBuyResponse> {
  return api<CoffeeBuyResponse>("/api/coffee/buy", { item });
}

export interface CoffeeRedeemResponse {
  ok: true;
  /** Human-readable receipt: what the code paid out. */
  message: string;
  imaginz: number;
  active: ActivePotion[];
}

/** Redeem a gift code (minted in the admin console): Imaginz or a free cup. */
export function redeemCoffeeCode(code: string): Promise<CoffeeRedeemResponse> {
  return api<CoffeeRedeemResponse>("/api/coffee/redeem", { code });
}
