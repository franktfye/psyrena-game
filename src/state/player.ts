/**
 * Runtime player state — HP, mana, buffs, party.
 *
 * The first mutable gameplay state on the client. It is a module singleton on
 * purpose: the HUD (created once in main.ts, survives scene switches) and the
 * scene code (skill bar in villageHub) both need it, and the SceneFactory
 * signature deliberately takes only the engine. When the Colyseus sim from
 * docs/06 arrives, its server snapshots write INTO this store and the HUD
 * never notices the difference.
 *
 * Numbers are scaffold values (100-pool, gentle regen) — doc 02 defines Focus
 * as the resource but has no tuning table yet, same caveat as the cooldowns
 * in shared/heroes/freud.ts.
 */

export interface BuffState {
  id: string;
  name: string;
  /** Icon URL; the HUD falls back to the first letter of `name` without one. */
  icon?: string;
  kind: "buff" | "debuff";
  /**
   * What the effect DOES, in a sentence — the body of the tile's hover/tap
   * popup (ui/playerHud.ts). Optional so a source with nothing to say still
   * gets a tile; the popup then shows just the name and timer.
   */
  desc?: string;
  /** Absolute ms timestamp when it drops; Infinity = until removeBuff. */
  until: number;
  durationMs: number;
}

export interface TeammateState {
  username: string;
  hero: string;
  /** 0..1 for the sliver bar under the portrait. */
  hpPct: number;
}

const HP_REGEN_PER_S = 2;
const MANA_REGEN_PER_S = 2;
const TICK_MS = 250;

class PlayerStore {
  hp = 100;
  hpMax = 100;
  mana = 100;
  manaMax = 100;
  /**
   * Focus regen multiplier — the pet Focus stat (docs/09 §3). Scales the
   * REGEN only; the pool stays 100 so burst windows stay skill territory.
   * Set at fight start from the loadout; 1 with no pet term.
   */
  manaRegenMult = 1;
  buffs: BuffState[] = [];
  teammates: TeammateState[] = [];

  private readonly listeners = new Set<() => void>();
  private lastTick = 0;

  constructor() {
    // Regen + buff expiry run on a plain interval, not the render loop: the
    // store predates the engine and must keep ticking across scene switches
    // (the render loop pauses during shader compilation).
    if (typeof window !== "undefined") {
      this.lastTick = performance.now();
      window.setInterval(() => this.tick(), TICK_MS);
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  spendMana(amount: number): void {
    if (amount <= 0) return;
    this.mana = Math.max(0, this.mana - amount);
    this.emit();
  }

  /** Direct Focus gain (Sublimation-style conversion), capped at the pool. */
  restoreMana(amount: number): void {
    if (amount <= 0) return;
    this.mana = Math.min(this.manaMax, this.mana + amount);
    this.emit();
  }

  damage(amount: number): void {
    if (amount <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.emit();
  }

  heal(amount: number): void {
    if (amount <= 0) return;
    this.hp = Math.min(this.hpMax, this.hp + amount);
    this.emit();
  }

  /**
   * Re-applying an active buff refreshes it in place instead of stacking.
   * Name/icon/kind repaint too: a stable-id tile is allowed to change face
   * (the operant quadrant flips "Positive Reinforcement" → "Negative
   * Reinforcement" under one id). `durationMs: Infinity` never expires —
   * pair it with `removeBuff` or it outlives the scene that pushed it.
   */
  applyBuff(buff: Omit<BuffState, "until"> & { durationMs: number }): void {
    const until = performance.now() + buff.durationMs;
    const existing = this.buffs.find((b) => b.id === buff.id);
    if (existing) {
      existing.until = until;
      existing.durationMs = buff.durationMs;
      existing.name = buff.name;
      existing.icon = buff.icon;
      existing.kind = buff.kind;
      existing.desc = buff.desc;
    } else {
      this.buffs.push({ ...buff, until });
    }
    this.emit();
  }

  /** Drop a buff by id — the only way out for a `durationMs: Infinity` tile. */
  removeBuff(id: string): void {
    const live = this.buffs.filter((b) => b.id !== id);
    if (live.length === this.buffs.length) return;
    this.buffs = live;
    this.emit();
  }

  setTeammates(mates: TeammateState[]): void {
    this.teammates = mates;
    this.emit();
  }

  /**
   * Swap the vitals pool and refill — the arena fight uses the (assumed)
   * 1000-point hero HP from the boss script instead of the 100-point hub
   * scaffold. The fight restores the scaffold values on scene dispose.
   */
  setVitals(hpMax: number, manaMax?: number): void {
    this.hpMax = hpMax;
    this.hp = hpMax;
    if (manaMax !== undefined) {
      this.manaMax = manaMax;
      this.mana = manaMax;
    }
    this.emit();
  }

  /**
   * Adopt the server's pools (ranked fights — server/fight.mjs owns HP and
   * Focus there). This is the "server snapshots write INTO this store" case
   * the file header promised: the local regen below keeps running between
   * frames as prediction, and every mirror corrects it.
   */
  setPools(hp: number, hpMax: number, mana: number, manaMax: number): void {
    if (
      Math.abs(this.hp - hp) < 0.01 &&
      this.hpMax === hpMax &&
      Math.abs(this.mana - mana) < 0.01 &&
      this.manaMax === manaMax
    )
      return;
    this.hp = hp;
    this.hpMax = hpMax;
    this.mana = mana;
    this.manaMax = manaMax;
    this.emit();
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(2, (now - this.lastTick) / 1000); // clamp across bg-tab gaps
    this.lastTick = now;

    let changed = false;
    if (this.hp < this.hpMax) {
      this.hp = Math.min(this.hpMax, this.hp + HP_REGEN_PER_S * dt);
      changed = true;
    }
    if (this.mana < this.manaMax) {
      this.mana = Math.min(this.manaMax, this.mana + MANA_REGEN_PER_S * this.manaRegenMult * dt);
      changed = true;
    }
    const live = this.buffs.filter((b) => b.until > now);
    if (live.length !== this.buffs.length) {
      this.buffs = live;
      changed = true;
    }
    if (changed) this.emit();
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

export const player = new PlayerStore();
