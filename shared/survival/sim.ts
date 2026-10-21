/**
 * The survival simulation (docs/survival-design.md v2). Pure and engine-free:
 * the client scene runs it locally today; a server session can run the same
 * class later (positions are the only client input it trusts).
 *
 * The scene's job: feed player positions and kit casts in, render
 * `hostiles` / `hazards` / `projectiles` / `pickups`, and drain `events`
 * (sounds, voice lines, HUD).
 *
 * Damage numbers are percentages of the TARGET's max HP for everything that
 * hits a player (§3.0, §5.0); hero damage arrives already priced by the real
 * kit (the scene runs a BossFight against a dummy for that, like the practice
 * pit), and the sim applies elite Defended / debuff multipliers on top.
 */
import {
  DIFFICULTIES, MINIONS, ELITES, BOSSES, QUIZ, THEMES,
  MINION_HIT, ELITE_HIT, ELITE_RULES, BOSS_RULES, PICKUPS, RECOVERY, BOONS,
  type DifficultyId, type MinionDef, type BossDef, type BoonId, type BossId, type HeroKitId, type QuizItem,
} from "./content.ts";
import { buildWalkGrid, solidBoxes, pushOut, flowField, flowStep, snapToWalkable, cellOf, CELL, type MapDef, type Rect, type WalkGrid } from "./map/layout.ts";
import { rng } from "./map/lots.ts";

export const HERO_HP = 1000;
export const HERO_RADIUS = 0.4;
const ROLE_WEIGHT: Record<string, number> = { dps: 100, support: 75, tank: 65, healer: 60 };
const SIZE_MULT = [0, 0.7, 0.85, 1.0];
const SPAWN_SHARE = [0, 0.6, 0.8, 1.0];
const MAX_ALIVE = 24;
/** Threat multiplier on a tank's damage: monsters peel onto the tank. */
const TANK_THREAT = 3;
const AGE_TAGS = ["age.infant", "age.toddler", "age.child", "age.school", "age.adolescent"] as const;

export interface SimPlayer {
  id: string;
  hero: HeroKitId;
  role: string;
  x: number;
  z: number;
  hp: number;
  hpMax: number;
  alive: boolean;
  /** 0..1 multiplier on this frame's movement (pins, latches, slow zones). */
  moveMult: number;
  dashCharges: number;
  dashRecharge: number[];
  iframesUntil: number;
  mitigation: number;
  mitigationUntil: number;
  pinnedUntil: number;
  /** Second Wind used in this cycle (solo only). */
  secondWindCycle: number;
  downAt: number;
  /** Reach Out: seconds an ally has stood beside this downed player. */
  reviveT: number;
  /** Boons taken this run (§7), with stacks. */
  boons: Partial<Record<BoonId, number>>;
  /** Boons on offer right now (after a boss), or null. */
  offer: BoonId[] | null;
  kills: number;
  /** The rank board's numbers (RunStats.players). */
  score: PlayerScore;
}

export interface PlayerScore { dealt: number; healed: number; taken: number; kills: number; downs: number; revives: number }

/** One row of the after-game rank board. */
export interface PlayerRunStat extends PlayerScore { id: string; name: string; hero: HeroKitId }

export type HostileKind = "minion" | "elite" | "boss";

export interface Hostile {
  id: number;
  kind: HostileKind;
  def: string;            // minion / elite / boss id
  model: string;
  x: number;
  z: number;
  facing: number;
  radius: number;
  hp: number;
  hpMax: number;
  speed: number;
  /** walk | windup | strike | rooted | dead */
  state: "walk" | "windup" | "rooted" | "dead";
  stateT: number;
  attackCd: number;
  born: number;
  dmgMult: number;
  invulnerable?: boolean;
  /** Decoy twin of this hostile id (Afterimage). */
  twinOf?: number;
  /** Player who landed the last hit: the kill is theirs. */
  lastHit?: string;
  /** Threat per player id (damage dealt, ×3 for tanks; heals add half). It hunts the top of this list. */
  threat?: Record<string, number>;
  /** Player it is hunting right now (sticky: a rival needs 110 % of its threat). */
  tgtId?: string;
  /** Smoothed walking direction (unit), so turns are arcs, not snaps. */
  mvx?: number;
  mvz?: number;
  group?: number;        // Kanizsa trio id
  noSplit?: boolean;
  // Elites
  ageTag?: string;
  debuffUntil?: number;
  stacks?: number;       // Pigeon rituals
  ritualT?: number;
  skillT?: number;       // elite / boss skill timer
  latched?: string;      // Wraith: player id
  latchUntil?: number;
  // Bosses
  appearance?: number;
  awakened?: boolean;
  notches?: number[];
  invisibleUntil?: number;
  sigT?: number;
  projT?: number;
  burnT?: number;
  fightT?: number;
  pinHits?: number;
  /** Falling Dream: seconds until it despawns. */
  lifeLeft?: number;
  /** Priming boon: this enemy has already taken its first hit. */
  primed?: boolean;
}

export interface Hazard {
  id: number;
  kind: "circle" | "line" | "burn";
  x: number;
  z: number;
  x2?: number;
  z2?: number;
  r: number;
  /** Radius shown to players (the Ames Room lies; the shadow tells the truth). */
  displayR?: number;
  /** Bright decoy that does nothing (Displacement's fake). */
  fake?: boolean;
  t: number;            // seconds until it detonates (burns: seconds left)
  total: number;
  pct: number;
  owner: number;
  /** Short floor label (drawn over the decal), e.g. "REAL HIT", "DECOY". */
  label?: string;
  /** Key of the one-line explanation the HUD shows the first time (see HAZARD_NOTES). */
  note?: string;
}

/** What each floor mechanic means, shown on screen the first time it appears in a run. */
export const HAZARD_NOTES: Record<string, string> = {
  displacement: "Displacement: the bright circle is a lie. The real hit lands on its mirror, across the boss.",
  sizeDistance: "Size–Distance: the ring looks huge, but only the dark shadow inside it hurts.",
  gorilla: "Inattentional blindness: the Gorilla walks unseen. Watch for footprints, then get clear!",
  pin: "Pressure on the Chest: you are pinned. Hit the Hag 3 times to break free.",
  burn: "Burning ground: it keeps hurting. Step out and stay out.",
  charge: "The bell means a charge. Sidestep the line!",
  falling: "Falling Dream: something drops on the circle. Step out.",
  ring: "Stroop ring: step out before it closes.",
  slam: "Slam: get out of the circle before it fills.",
};

export interface Projectile { id: number; x: number; z: number; vx: number; vz: number; r: number; pct: number; life: number }

export interface Pickup { id: number; kind: "hp" | "focus" | "bigHp" | "bigFocus"; x: number; z: number; life: number }

export interface RecallState {
  item: QuizItem;
  answers: string[];
  correct: number;
  circles: Array<{ x: number; z: number; r: number }>;
  t: number;
  total: number;
}

export type SimEvent =
  | { type: "announce"; key: string; priority: number }
  | { type: "phase"; phase: SimPhase; wave: number; waves: number; label: string }
  | { type: "spawn"; id: number }
  | { type: "die"; id: number; kind: HostileKind; def: string }
  | { type: "hitPlayer"; player: string; amount: number; source: string }
  | { type: "hitHostile"; id: number; amount: number; crit: boolean; defended: boolean }
  | { type: "telegraph"; id: number }
  | { type: "note"; key: string }
  | { type: "gates"; closed: boolean }
  | { type: "boonOffer"; player: string; options: BoonId[] }
  | { type: "boon"; player: string; id: BoonId }
  | { type: "teleport"; player: string; x: number; z: number }
  | { type: "detonate"; id: number; heavy: boolean }
  | { type: "pickup"; player: string; kind: Pickup["kind"]; focus: number; heal: number }
  | { type: "eliteDebuff"; id: number; name: string }
  | { type: "bell"; id: number }
  | { type: "boss"; id: number; name: string; theory: string }
  | { type: "bossNotch"; id: number; frac: number }
  | { type: "recallOpen"; question: string; answers: string[]; seconds: number }
  | { type: "recallResult"; correct: boolean; answer: string; explain: string; index: number }
  | { type: "card"; title: string; text: string }
  | { type: "playerDown"; player: string }
  | { type: "secondWind"; player: string }
  | { type: "revive"; player: string }
  | { type: "end"; victory: boolean; stats: RunStats };

export type SimPhase = "intro" | "wave" | "breather" | "boss" | "intermission" | "victory" | "defeat";

export interface RunStats {
  difficulty: DifficultyId;
  wavesCleared: number;
  waves: number;
  kills: number;
  elitesKilled: number;
  bossesKilled: number;
  recallRight: number;
  recallTotal: number;
  durationS: number;
  loot: { common: number; jackpot: boolean; total: number } | null;
  /** Per player, for the rank board. */
  players: PlayerRunStat[];
}

export interface SimOptions {
  difficulty: DifficultyId;
  map: MapDef;
  players: Array<{ id: string; hero: HeroKitId; role: string; hpMax?: number; name?: string }>;
  seed?: number;
  /** Extra jackpot chance from pity (server-tracked). */
  jackpotBonus?: number;
}

export class SurvivalSim {
  readonly difficulty: DifficultyId;
  readonly waves: number;
  readonly map: MapDef;
  grid: WalkGrid;
  readonly boxes: Rect[];
  players: SimPlayer[];
  hostiles: Hostile[] = [];
  hazards: Hazard[] = [];
  projectiles: Projectile[] = [];
  pickups: Pickup[] = [];
  recall: RecallState | null = null;
  events: SimEvent[] = [];

  phase: SimPhase = "intro";
  wave = 0;
  t = 0;
  private phaseT = 0;
  private rand: () => number;
  private nextId = 1;
  /** One flow field per living player, so a monster's detour leads to ITS target. */
  private fields = new Map<string, Uint16Array>();
  private fieldT = 0;
  private toSpawn = 0;
  private elitesToSpawn = 0;
  private spawnT = 0;
  private triangleGroup = 0;
  private bossAppear: Record<string, number> = {};
  private seenCards = new Set<string>();
  private told = new Set<string>();
  private usedQuiz = new Set<string>();
  private partyHp: number;
  private sizeMult: number;
  private stats: RunStats;
  private names: Map<string, string>;
  private jackpotBonus: number;
  private tauntT = 25;
  /** Temple Square's fog walls (§12.1): closed during a boss fight. */
  gatesClosed = false;
  private gateBoxes: Rect[];
  private gateCloseAt = 0;
  private gridOpen: WalkGrid;
  private gridShut: WalkGrid;

  constructor(opts: SimOptions) {
    this.difficulty = opts.difficulty;
    this.waves = DIFFICULTIES[opts.difficulty].waves;
    this.map = opts.map;
    this.grid = buildWalkGrid(opts.map);
    this.boxes = solidBoxes(this.grid);
    this.gridOpen = this.grid;
    // Gate walls are thin boxes across the square's openings; the shut grid is
    // the same map with those cells solid, so pathing knows the way is closed.
    this.gateBoxes = opts.map.bossGates.map((g) => ({ ...g, open: { x0: true, x1: true, z0: true, z1: true } }));
    this.gridShut = buildWalkGrid({ ...opts.map, obstacles: [...opts.map.obstacles, ...opts.map.bossGates.map((g, i) => ({ ...g, name: `gate${i}` }))] });
    this.rand = rng(opts.seed ?? 4242);
    this.jackpotBonus = opts.jackpotBonus ?? 0;
    const n = Math.max(1, Math.min(3, opts.players.length));
    this.sizeMult = SIZE_MULT[n];
    this.partyHp = opts.players.reduce((s, p) => s + (ROLE_WEIGHT[p.role] ?? 100), 0) / 100;
    this.players = opts.players.map((p, i) => ({
      id: p.id, hero: p.hero, role: p.role,
      x: opts.map.start.x + i * 1.5, z: opts.map.start.z,
      hp: p.hpMax ?? HERO_HP, hpMax: p.hpMax ?? HERO_HP, alive: true, moveMult: 1,
      dashCharges: 2, dashRecharge: [], iframesUntil: 0, mitigation: 0, mitigationUntil: 0,
      pinnedUntil: 0, secondWindCycle: -1, downAt: 0, reviveT: 0, boons: {}, offer: null, kills: 0,
      score: { dealt: 0, healed: 0, taken: 0, kills: 0, downs: 0, revives: 0 },
    }));
    this.names = new Map(opts.players.map((p) => [p.id, p.name ?? p.id]));
    this.stats = {
      difficulty: opts.difficulty, wavesCleared: 0, waves: this.waves, kills: 0, elitesKilled: 0,
      bossesKilled: 0, recallRight: 0, recallTotal: 0, durationS: 0, loot: null, players: [],
    };
    this.say(`intro_${opts.difficulty}`, 3);
    this.setPhase("intro", 9);
  }

  // ---- inputs ----------------------------------------------------------------

  setPlayerPos(id: string, x: number, z: number): void {
    const p = this.player(id);
    if (!p || !p.alive) return;
    const q = { x, z };
    pushOut(q, HERO_RADIUS, this.solids(), this.map.half);
    p.x = q.x;
    p.z = q.z;
  }

  /** Everything solid right now: the map, plus the fog walls while a boss lives. */
  solids(): Rect[] {
    return this.gatesClosed ? [...this.boxes, ...this.gateBoxes] : this.boxes;
  }

  /** Is (x, z) inside the boss square? */
  inBossSquare(x: number, z: number): boolean {
    const sq = this.map.squares.find((s) => s.role === "boss");
    return !!sq && x > sq.x0 && x < sq.x1 && z > sq.z0 && z < sq.z1;
  }

  private closeGates(): void {
    if (this.gatesClosed) return;
    const sq = this.map.squares.find((s) => s.role === "boss")!;
    // Anyone left outside steps through: nobody is locked out of the fight.
    for (const p of this.players) {
      if (!p.alive || this.inBossSquare(p.x, p.z)) continue;
      const q = { x: Math.max(sq.x0 + 2, Math.min(sq.x1 - 2, p.x)), z: Math.max(sq.z0 + 2, Math.min(sq.z1 - 2, p.z)) };
      p.x = q.x;
      p.z = q.z;
      this.events.push({ type: "teleport", player: p.id, x: q.x, z: q.z });
    }
    // Monsters stuck outside dissolve; the fight is in the square now.
    for (const h of this.hostiles) if (h.kind !== "boss" && !this.inBossSquare(h.x, h.z)) h.state = "dead";
    this.gatesClosed = true;
    this.grid = this.gridShut;
    this.fieldT = 0;
    this.events.push({ type: "gates", closed: true });
  }

  private openGates(): void {
    if (!this.gatesClosed) return;
    this.gatesClosed = false;
    this.grid = this.gridOpen;
    this.fieldT = 0;
    this.events.push({ type: "gates", closed: false });
  }

  /** Dash request; true if a charge was spent (the client then moves the hero). */
  dash(id: string): boolean {
    const p = this.player(id);
    if (!p || !p.alive || p.dashCharges <= 0 || this.t < p.pinnedUntil) return false;
    p.dashCharges--;
    p.dashRecharge.push(this.t + 7);
    p.iframesUntil = this.t + 0.3;
    // A dash tears a Clinging Wraith's tether.
    for (const h of this.hostiles) if (h.latched === id) { h.latched = undefined; h.skillT = 6; }
    this.tell("instr_dash", 1);
    return true;
  }

  /** Take one of the boons on offer (§7). */
  pickBoon(id: string, boon: BoonId): void {
    const p = this.player(id);
    if (!p?.offer?.includes(boon)) return;
    p.boons[boon] = (p.boons[boon] ?? 0) + 1;
    p.offer = null;
    if (boon === "lucid") p.dashCharges = Math.min(this.maxDash(p), p.dashCharges + 1);
    this.events.push({ type: "boon", player: p.id, id: boon });
  }

  private boon(p: SimPlayer, id: BoonId): number { return p.boons[id] ?? 0; }
  private maxDash(p: SimPlayer): number { return 2 + this.boon(p, "lucid"); }

  private offerBoons(): void {
    for (const p of this.players) {
      const pool = BOONS.filter((b) => this.boon(p, b.id) < b.max).map((b) => b.id);
      const options: BoonId[] = [];
      while (options.length < 3 && pool.length) options.push(pool.splice(Math.floor(this.rand() * pool.length), 1)[0]);
      p.offer = options;
      this.events.push({ type: "boonOffer", player: p.id, options });
    }
    this.say("boon_pick", 2);
  }

  /** E-style defensive: mitigation for a while (kits own the real number in BossFight). */
  setMitigation(id: string, frac: number, seconds: number): void {
    const p = this.player(id);
    if (!p) return;
    p.mitigation = Math.max(p.mitigation, frac);
    p.mitigationUntil = Math.max(p.mitigationUntil, this.t + seconds);
  }

  healPlayer(id: string, amount: number): void {
    const p = this.player(id);
    if (!p || !p.alive) return;
    const before = p.hp;
    p.hp = Math.min(p.hpMax, p.hp + amount);
    p.score.healed += p.hp - before;
    // Healing draws half its worth of threat from every monster already in the fight nearby.
    const healed = p.hp - before;
    if (healed > 0 && this.players.length > 1) {
      for (const h of this.hostiles) {
        if (!h.threat || h.state === "dead" || (h.x - p.x) ** 2 + (h.z - p.z) ** 2 > 20 * 20) continue;
        h.threat[p.id] = (h.threat[p.id] ?? 0) + healed * 0.5;
      }
    }
  }

  /**
   * Apply a priced hero hit to a hostile. `slotId` and `ctx` let the elite
   * debuffs fire (§4.3). Returns the damage actually dealt.
   */
  hitHostile(id: number, amount: number, crit: boolean, cast: { player: string; slotId: string; kind: string; answersTag?: string; consequence?: string }): number {
    const h = this.hostiles.find((x) => x.id === id);
    if (!h || h.state === "dead") return 0;
    if (h.kind === "elite") this.kitEffect(h, cast);
    if (h.kind === "boss" && this.players.some((p) => this.t < p.pinnedUntil)) {
      h.pinHits = (h.pinHits ?? 0) + 1;
      if (h.pinHits >= 3) for (const p of this.players) p.pinnedUntil = 0;
    }
    if (h.invulnerable) {
      this.events.push({ type: "hitHostile", id, amount: 0, crit, defended: true });
      return 0;
    }
    let mult = 1;
    let defended = false;
    if (h.kind === "elite") {
      const debuffed = (h.debuffUntil ?? 0) > this.t;
      const waned = this.t - h.born > ELITE_RULES.waneAfterS;
      if (!debuffed && !waned) {
        mult *= ELITE_RULES.defendedTaken;
        defended = true;
        this.tell("instr_defended", 1);
      }
      if (debuffed) mult *= 1 + (ELITES.find((e) => e.id === h.def)?.vuln ?? 0);
      if (h.def === "pigeon") mult *= 1 - 0.04 * (h.stacks ?? 0);
    }
    const caster = this.player(cast.player);
    if (caster) {
      if (caster.hp / caster.hpMax > 0.7) mult *= 1 + 0.12 * this.boon(caster, "secure");
      if (!h.primed) { mult *= 1 + 0.4 * this.boon(caster, "priming"); if (amount > 0) h.primed = true; }
    }
    const dealt = Math.round(amount * mult);
    if (caster) {
      // Threat: damage (tanks ×3); a damage-less debuff cast still draws a little.
      h.threat ??= {};
      h.threat[caster.id] = (h.threat[caster.id] ?? 0) + Math.max(5, dealt) * (caster.role === "tank" ? TANK_THREAT : 1);
    }
    if (caster && dealt > 0) {
      // Overkill does not count: a 900 crit on a 40 hp wisp is 40 damage.
      caster.score.dealt += Math.min(dealt, Math.max(0, h.hp));
      h.lastHit = caster.id;
    }
    h.hp -= dealt;
    this.events.push({ type: "hitHostile", id, amount: dealt, crit, defended });
    if (h.hp <= 0) this.kill(h);
    else if (h.kind === "boss") this.bossNotches(h);
    return dealt;
  }

  /** Area hit (ultimates): every hostile within r of (x, z). */
  hitArea(x: number, z: number, r: number, amount: number, crit: boolean, cast: { player: string; slotId: string; kind: string }): number {
    let total = 0;
    for (const h of [...this.hostiles]) {
      if (h.state === "dead") continue;
      if ((h.x - x) ** 2 + (h.z - z) ** 2 <= (r + h.radius) ** 2) total += this.hitHostile(h.id, amount, crit, cast);
    }
    return total;
  }

  /** Nearest damageable hostile to (x, z) within `maxD`, preferring elites/bosses at equal-ish range. */
  nearestHostile(x: number, z: number, maxD = 22): Hostile | null {
    let best: Hostile | null = null;
    let bestScore = maxD * maxD;
    for (const h of this.hostiles) {
      if (h.state === "dead" || (h.invisibleUntil ?? 0) > this.t) continue;
      const d2 = (h.x - x) ** 2 + (h.z - z) ** 2;
      const score = h.kind === "minion" ? d2 : d2 * 0.6;
      if (score < bestScore) { best = h; bestScore = score; }
    }
    return best;
  }

  // ---- main tick -------------------------------------------------------------

  tick(dt: number): void {
    if (this.phase === "victory" || this.phase === "defeat") return;
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this.phaseT -= dt;
    this.stats.durationS = this.t;
    this.tickPlayers(dt);
    this.tickDirector(dt);
    if (this.recall) this.tickRecall(dt);
    this.fieldT -= dt;
    if (this.fieldT <= 0) {
      this.fields.clear();
      for (const p of this.players) if (p.alive) this.fields.set(p.id, flowField(this.grid, [p]));
      this.fieldT = 0.5;
    }
    for (const h of this.hostiles) if (h.state !== "dead") this.tickHostile(h, dt);
    this.separate();
    this.tickHazards(dt);
    this.tickProjectiles(dt);
    this.tickPickups(dt);
    this.hostiles = this.hostiles.filter((h) => h.state !== "dead");
    this.tickTaunts(dt);
  }

  // ---- director ---------------------------------------------------------------

  private cycleOf(wave: number): number { return Math.floor((wave - 1) / 5) + 1; }
  private isBossWave(wave: number): boolean { return wave % 5 === 0; }

  private setPhase(phase: SimPhase, seconds: number): void {
    this.phase = phase;
    this.phaseT = seconds;
    const label =
      phase === "wave" ? `Wave ${this.wave}` :
      phase === "boss" ? `Wave ${this.wave} · Boss` :
      phase === "intro" ? DIFFICULTIES[this.difficulty].name :
      phase === "breather" ? "Breathe" : phase === "intermission" ? "Intermission" : phase;
    this.events.push({ type: "phase", phase, wave: this.wave, waves: this.waves, label });
  }

  private tickDirector(dt: number): void {
    const alive = this.hostiles.filter((h) => h.state !== "dead" && !h.twinOf);
    if (this.phase === "intro" || this.phase === "breather" || this.phase === "intermission") {
      // Catch your breath: a breather and a boss intermission give HP back.
      const share = this.phase === "breather" ? RECOVERY.breather / 6 : this.phase === "intermission" ? RECOVERY.intermission / 15 : 0;
      for (const p of this.players) if (p.alive) p.hp = Math.min(p.hpMax, p.hp + share * p.hpMax * dt);
      if (this.phaseT <= 0) {
        // An untaken offer is not lost: take one at random.
        for (const p of this.players) if (p.offer?.length) this.pickBoon(p.id, p.offer[Math.floor(this.rand() * p.offer.length)]);
        this.startWave(this.wave + 1);
      }
      return;
    }
    if (this.phase === "wave") {
      this.spawnT -= dt;
      if ((this.toSpawn > 0 || this.elitesToSpawn > 0) && this.spawnT <= 0 && alive.length < MAX_ALIVE) {
        if (this.elitesToSpawn > 0 && (this.toSpawn <= 0 || this.rand() < 0.15)) { this.spawnElite(); this.elitesToSpawn--; }
        else { this.spawnMinionGroup(); }
        this.spawnT = 0.55;
      }
      const done = this.toSpawn <= 0 && this.elitesToSpawn <= 0 && alive.length === 0;
      if (done || this.phaseT <= 0) this.endWave();
      return;
    }
    if (this.phase === "boss") {
      // The fog walls close 10 s after the boss arrives, or as soon as the whole party is in the square.
      if (!this.gatesClosed && (this.t >= this.gateCloseAt || this.players.every((p) => !p.alive || this.inBossSquare(p.x, p.z)))) this.closeGates();
      // A light trickle of minions while the boss lives — inside the square once it is shut.
      this.spawnT -= dt;
      if (this.spawnT <= 0 && alive.length < 10 && !this.recall) {
        if (this.gatesClosed) this.spawnInSquare();
        else this.spawnMinionGroup(1);
        this.spawnT = 4;
      }
      if (!alive.some((h) => h.kind === "boss")) { this.openGates(); this.endWave(); }
    }
  }

  private startWave(wave: number): void {
    if (wave > this.waves) return;
    this.wave = wave;
    const cycle = this.cycleOf(wave);
    const n = this.players.length;
    if (this.isBossWave(wave)) {
      this.setPhase("boss", 9999);
      this.gateCloseAt = this.t + 10;
      this.spawnBoss(wave === this.waves);
      this.spawnT = 6;
      return;
    }
    const inCycle = ((wave - 1) % 5) + 1;
    // More of them (2026-10-20: "it's easy"): the 24-alive cap keeps the crowd refilling.
    this.toSpawn = Math.round((24 + 6 * cycle) * SPAWN_SHARE[Math.min(3, n)]);
    this.elitesToSpawn = (inCycle <= 2 ? 1 : 2) + (cycle >= 5 ? 1 : 0);
    this.spawnT = 1.5;
    this.setPhase("wave", 55);
    this.say(["wave_start_1", "wave_start_2", "wave_start_3"][Math.floor(this.rand() * 3)], 1);
    if (wave === 1) this.tell("instr_move", 2);
  }

  private endWave(): void {
    this.stats.wavesCleared = this.wave;
    if (this.wave >= this.waves) return this.finish(true);
    if (this.isBossWave(this.wave)) {
      this.setPhase("intermission", 15);
      this.offerBoons();
    } else {
      this.say(["wave_clear_1", "wave_clear_2"][Math.floor(this.rand() * 2)], 1);
      this.setPhase("breather", 6);
    }
  }

  private finish(victory: boolean): void {
    if (victory) {
      const d = DIFFICULTIES[this.difficulty];
      const jackpot = this.rand() < d.loot.chance + this.jackpotBonus;
      this.stats.loot = { common: d.loot.common, jackpot, total: d.loot.common + (jackpot ? d.loot.jackpot : 0) };
      this.say(jackpot ? "jackpot" : "victory", 3);
    } else {
      const d = DIFFICULTIES[this.difficulty];
      const bossesTotal = this.waves / 5;
      const common = Math.round(0.2 * d.loot.common * (this.stats.bossesKilled / bossesTotal));
      this.stats.loot = { common, jackpot: false, total: common };
      this.say("defeat", 3);
    }
    this.setPhase(victory ? "victory" : "defeat", 0);
    this.events.push({ type: "end", victory, stats: this.statsNow });
  }

  // ---- spawning ---------------------------------------------------------------

  /** A spawn point out of sight: inside the fog (≥ 22 m), nearest such to the party. */
  private spawnPoint(): { x: number; z: number } {
    const live = this.players.filter((p) => p.alive);
    const c = live.length ? live[Math.floor(this.rand() * live.length)] : this.players[0];
    const far = this.map.spawns.filter((s) => (s.x - c.x) ** 2 + (s.z - c.z) ** 2 > 22 * 22);
    const pool = (far.length ? far : this.map.spawns).slice().sort((a, b) =>
      (a.x - c.x) ** 2 + (a.z - c.z) ** 2 - ((b.x - c.x) ** 2 + (b.z - c.z) ** 2));
    const s = pool[Math.min(pool.length - 1, Math.floor(this.rand() * Math.min(3, pool.length)))];
    return snapToWalkable(this.grid, s.x + (this.rand() - 0.5) * 3, s.z + (this.rand() - 0.5) * 3);
  }

  private themeMinions(): MinionDef[] {
    const cycle = this.cycleOf(this.wave);
    const inCycle = ((this.wave - 1) % 5) % 4;
    const themes = [THEMES[inCycle]];
    if (cycle >= 3) themes.push(THEMES[(inCycle + 1 + Math.floor(this.rand() * 3)) % 4]);
    return MINIONS.filter((m) => themes.includes(m.theme));
  }

  private minionHp(def: MinionDef): number {
    return 60 * (1 + 0.12 * (this.wave - 1)) * this.partyHp * def.hpMult;
  }

  private dmgMult(): number { return (1 + 0.03 * (this.wave - 1)) * this.sizeMult * DIFFICULTIES[this.difficulty].damage; }

  private spawnMinionGroup(max = 4): void {
    const pool = this.themeMinions();
    const def = pool[Math.floor(this.rand() * pool.length)];
    this.card(def.id, def.name, def.theory);
    if (def.trick === "fall") return this.spawnFalling(def);
    const at = this.spawnPoint();
    const count = def.trick === "triangle" ? 3 : Math.min(max, 2 + Math.floor(this.rand() * 3), Math.max(1, this.toSpawn));
    const group = def.trick === "triangle" ? ++this.triangleGroup : undefined;
    for (let i = 0; i < count; i++) {
      const p = snapToWalkable(this.grid, at.x + (this.rand() - 0.5) * 2.5, at.z + (this.rand() - 0.5) * 2.5);
      const h = this.addMinion(def, p.x, p.z);
      h.group = group;
      if (def.trick === "decoy") {
        const twin = this.addMinion(def, p.x + 1.2, p.z);
        twin.invulnerable = true;
        twin.twinOf = h.id;
      }
    }
    this.toSpawn -= count;
  }

  /** One minion at a random point on the boss square's rim. */
  private spawnInSquare(): void {
    const sq = this.map.squares.find((s) => s.role === "boss")!;
    const pool = MINIONS.filter((m) => m.trick !== "fall" && m.trick !== "triangle" && m.trick !== "decoy");
    const def = pool[Math.floor(this.rand() * pool.length)];
    const side = Math.floor(this.rand() * 4);
    const u = this.rand();
    const x = side < 2 ? sq.x0 + 1.5 + u * (sq.x1 - sq.x0 - 3) : side === 2 ? sq.x0 + 1.5 : sq.x1 - 1.5;
    const z = side >= 2 ? sq.z0 + 1.5 + u * (sq.z1 - sq.z0 - 3) : side === 0 ? sq.z0 + 1.5 : sq.z1 - 1.5;
    const p = snapToWalkable(this.grid, x, z);
    this.addMinion(def, p.x, p.z);
  }

  private addMinion(def: MinionDef, x: number, z: number, hpScale = 1): Hostile {
    const hp = Math.round(this.minionHp(def) * hpScale);
    const h: Hostile = {
      id: this.nextId++, kind: "minion", def: def.id, model: def.model, x, z, facing: 0, radius: 0.45,
      hp, hpMax: hp, speed: def.speed, state: "walk", stateT: 0, attackCd: 1, born: this.t, dmgMult: this.dmgMult(),
      skillT: 4 + this.rand() * 4,
    };
    this.hostiles.push(h);
    this.events.push({ type: "spawn", id: h.id });
    return h;
  }

  private spawnFalling(def: MinionDef): void {
    const live = this.players.filter((p) => p.alive);
    if (!live.length) return;
    const target = live[Math.floor(this.rand() * live.length)];
    const p = snapToWalkable(this.grid, target.x + (this.rand() - 0.5) * 4, target.z + (this.rand() - 0.5) * 4);
    const h = this.addMinion(def, p.x, p.z);
    h.state = "rooted";
    h.lifeLeft = 9;
    h.invulnerable = true; // until it lands
    h.stateT = 1.2;
    this.hazard({ kind: "circle", x: p.x, z: p.z, r: 1.6, t: 1.2, pct: 0.08, owner: h.id, label: "FALLING", note: "falling" });
    this.tell("instr_telegraph", 1);
    this.toSpawn -= 1;
  }

  private spawnElite(): void {
    // §4.1: pick a player SLOT uniformly; that slot's hero's elite comes.
    const slot = this.players[Math.floor(this.rand() * this.players.length)];
    const def = ELITES.find((e) => e.hero === slot.hero) ?? ELITES[Math.floor(this.rand() * ELITES.length)];
    const at = this.spawnPoint();
    const hp = Math.round(60 * (1 + 0.12 * (this.wave - 1)) * this.partyHp * ELITE_RULES.hpMult);
    const h: Hostile = {
      id: this.nextId++, kind: "elite", def: def.id, model: def.model, x: at.x, z: at.z, facing: 0, radius: 0.7,
      hp, hpMax: hp, speed: def.speed, state: "walk", stateT: 0, attackCd: 1.5, born: this.t, dmgMult: this.dmgMult(),
      skillT: 5, stacks: 0, ritualT: 4,
      ageTag: def.id === "repressed" ? AGE_TAGS[Math.floor(this.rand() * AGE_TAGS.length)] : undefined,
    };
    this.hostiles.push(h);
    this.events.push({ type: "spawn", id: h.id });
    this.card(def.id, def.name, def.theory);
    this.tell("instr_elite", 2);
  }

  private spawnBoss(final: boolean): void {
    let def: BossDef;
    if (final) def = BOSSES.find((b) => b.id === "hag")!;
    else def = BOSSES[(this.cycleOf(this.wave) - 1) % BOSSES.length];
    const appearance = (this.bossAppear[def.id] = (this.bossAppear[def.id] ?? 0) + 1);
    const sq = this.map.squares.find((s) => s.role === "boss")!;
    const x = (sq.x0 + sq.x1) / 2;
    const z = sq.z1 - 6;
    const cycle = this.cycleOf(this.wave);
    const hp = Math.round(def.hp * (1 + 0.2 * (cycle - 1)) * this.partyHp * (final ? 1.5 : 1));
    const notches = this.difficulty === "lucid" ? [0.5] : [0.66, 0.33];
    if (final) notches.push(0.1);
    const h: Hostile = {
      id: this.nextId++, kind: "boss", def: def.id, model: def.model, x, z, facing: Math.PI, radius: 1.6,
      hp, hpMax: hp, speed: BOSS_RULES.walk, state: "walk", stateT: 0, attackCd: 2, born: this.t, dmgMult: this.sizeMult * DIFFICULTIES[this.difficulty].damage,
      appearance: final ? 3 : appearance, awakened: final, notches, sigT: 6, projT: 9, burnT: 12, fightT: 0,
    };
    this.hostiles.push(h);
    this.events.push({ type: "spawn", id: h.id });
    this.events.push({ type: "boss", id: h.id, name: final ? `${def.name}, Awakened` : def.name, theory: def.theory });
    this.card(def.id, def.name, def.theory);
    this.tell("instr_boss", 2);
    this.say(final ? "final_wave" : `boss_${def.id}`, 2);
  }

  // ---- hostiles ---------------------------------------------------------------

  /**
   * Who a monster hunts: the only hero standing; else the top of its threat
   * list (whoever hurts it — tanks most of all), sticky until a rival reaches
   * 110 %; else, untouched, the nearest hero (sticky by 2 m so it does not
   * dither between two).
   */
  private target(h: Hostile): SimPlayer | null {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) { h.tgtId = alive[0]?.id; return alive[0] ?? null; }
    const cur = alive.find((p) => p.id === h.tgtId) ?? null;
    if (h.threat) {
      let best: SimPlayer | null = null;
      let bt = 0;
      for (const p of alive) { const t = h.threat[p.id] ?? 0; if (t > bt) { bt = t; best = p; } }
      if (best) {
        const curT = cur ? h.threat[cur.id] ?? 0 : 0;
        const pick = cur && curT > 0 && bt < curT * 1.1 ? cur : best;
        h.tgtId = pick.id;
        return pick;
      }
    }
    let near: SimPlayer | null = null;
    let nd = Infinity;
    for (const p of alive) { const d = Math.hypot(p.x - h.x, p.z - h.z); if (d < nd) { nd = d; near = p; } }
    if (cur && near && near !== cur && Math.hypot(cur.x - h.x, cur.z - h.z) < nd + 2) near = cur;
    h.tgtId = near?.id;
    return near;
  }

  /** True when the walk grid is open along the straight line from a to b (sampled every half cell). */
  private lineClear(ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / (CELL * 0.5));
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      if (!this.grid.walk[cellOf(this.grid, ax + (bx - ax) * k, az + (bz - az) * k)]) return false;
    }
    return true;
  }

  private tickHostile(h: Hostile, dt: number): void {
    const tgt = this.target(h);
    if (h.kind === "minion" && h.lifeLeft !== undefined) {
      h.lifeLeft -= dt;
      if (h.lifeLeft <= 0) { h.state = "dead"; return; }
    }
    if (h.state === "rooted") {
      h.stateT -= dt;
      if (h.def === "falling") { if (h.stateT <= 0) h.invulnerable = false; return; }
      if (this.recall) return;
      if (h.stateT <= 0) h.state = "walk";
      return;
    }
    if (!tgt) return;
    const dx = tgt.x - h.x;
    const dz = tgt.z - h.z;
    const dist = Math.hypot(dx, dz);
    if (this.recall && h.kind !== "boss") { this.turn(h, Math.atan2(dx, dz), dt); return; } // everyone holds still while the party thinks

    const x0 = h.x, z0 = h.z;
    if (h.kind === "minion") this.tickMinion(h, tgt, dist, dt);
    else if (h.kind === "elite") this.tickElite(h, tgt, dist, dt);
    else this.tickBoss(h, tgt, dist, dt);
    // Facing: along its walk while it walks; at the hero once it stands and fights.
    const walked = Math.hypot(h.x - x0, h.z - z0) > 0.2 * dt * h.speed && h.mvx !== undefined;
    this.turn(h, walked ? Math.atan2(h.mvx!, h.mvz!) : Math.atan2(dx, dz), dt);
  }

  /** Turn toward `yaw` at a body's pace (bosses slower), shortest way round. */
  private turn(h: Hostile, yaw: number, dt: number): void {
    let d = (yaw - h.facing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    h.facing += d * Math.min(1, dt * (h.kind === "boss" ? 4 : 9));
  }

  private move(h: Hostile, tgt: SimPlayer, dist: number, dt: number, speed = h.speed): void {
    if (speed <= 0 || dist < h.radius + HERO_RADIUS + 0.4) return;
    // Straight at the hero whenever the street between is open; the grid path
    // only to get round buildings (its 8-way steps read as sidling up the road).
    let dir = { x: (tgt.x - h.x) / dist, z: (tgt.z - h.z) / dist };
    const field = this.fields.get(tgt.id);
    if (dist >= 4 && field && !this.lineClear(h.x, h.z, tgt.x, tgt.z)) {
      const f = flowStep(this.grid, field, h.x, h.z);
      if (f.x || f.z) dir = f;
    }
    // Ease the heading round so a turn is an arc, not a snap.
    const k = Math.min(1, dt * 6);
    let mx = (h.mvx ?? dir.x) + (dir.x - (h.mvx ?? dir.x)) * k;
    let mz = (h.mvz ?? dir.z) + (dir.z - (h.mvz ?? dir.z)) * k;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    h.mvx = mx; h.mvz = mz;
    const q = { x: h.x + mx * speed * dt, z: h.z + mz * speed * dt };
    pushOut(q, h.radius, this.solids(), this.map.half);
    h.x = q.x;
    h.z = q.z;
  }

  private melee(h: Hostile, tgt: SimPlayer, dist: number, dt: number, spec: { pct: number; windup: number; cooldown: number; reach: number }, label: string): void {
    h.attackCd -= dt;
    if (h.state === "windup") {
      h.stateT -= dt;
      if (h.stateT <= 0) {
        h.state = "walk";
        if (dist <= spec.reach * 1.3 + h.radius) this.damage(tgt, spec.pct * h.dmgMult * this.fadeMult(h), label);
        h.attackCd = spec.cooldown;
      }
      return;
    }
    if (dist <= spec.reach + h.radius && h.attackCd <= 0) {
      h.state = "windup";
      h.stateT = spec.windup;
    }
  }

  private fadeMult(h: Hostile): number {
    return h.def === "fade" ? Math.min(2.5, 1 + 0.03 * (this.t - h.born)) : 1;
  }

  private tickMinion(h: Hostile, tgt: SimPlayer, dist: number, dt: number): void {
    const def = MINIONS.find((m) => m.id === h.def)!;
    let speed = h.speed;
    if (def.trick === "bandwagon") {
      const near = this.hostiles.filter((o) => o !== h && o.def === "bandwagon" && (o.x - h.x) ** 2 + (o.z - h.z) ** 2 < 16).length;
      speed = Math.min(3.3, h.speed * (1 + 0.05 * near));
    }
    if (def.trick === "ring") {
      h.skillT! -= dt;
      if (h.skillT! <= 0 && dist < 12) {
        this.hazard({ kind: "circle", x: tgt.x, z: tgt.z, r: 2.0, t: 1.2, pct: 0.08, owner: h.id, label: "STROOP", note: "ring" });
        h.skillT = 6 + this.rand() * 2;
      }
    }
    if (h.twinOf) {
      // A decoy shadows its twin and never attacks.
      const twin = this.hostiles.find((o) => o.id === h.twinOf);
      if (!twin || twin.state === "dead") { h.state = "dead"; return; }
    }
    if (h.state !== "windup") this.move(h, tgt, dist, dt, speed);
    if (!h.twinOf) this.melee(h, tgt, dist, dt, MINION_HIT, def.name);
    if (this.crowdAround(tgt) >= 6) this.tell("instr_crowd", 1);
  }

  private crowdAround(p: SimPlayer): number {
    let n = 0;
    for (const h of this.hostiles) if (h.state !== "dead" && (h.x - p.x) ** 2 + (h.z - p.z) ** 2 < 16) n++;
    return n;
  }

  private tickElite(h: Hostile, tgt: SimPlayer, dist: number, dt: number): void {
    const def = ELITES.find((e) => e.id === h.def)!;
    const debuffed = (h.debuffUntil ?? 0) > this.t;
    h.skillT! -= dt;
    switch (def.id) {
      case "repressed":
        // Projects a bolt at whoever it can see every 6 s.
        if (h.skillT! <= 0 && dist < 18) {
          this.shoot(h.x, h.z, tgt.x, tgt.z, 6, 0.06);
          h.skillT = 7;
        }
        break;
      case "hound":
        if (debuffed) return; // Frozen: no move, no charge.
        if (h.skillT! <= 0 && dist < 14) {
          // Bell, then a line telegraph and the charge lands where it pointed.
          this.events.push({ type: "bell", id: h.id });
          const ex = h.x + ((tgt.x - h.x) / dist) * Math.min(12, dist + 3);
          const ez = h.z + ((tgt.z - h.z) / dist) * Math.min(12, dist + 3);
          this.hazard({ kind: "line", x: h.x, z: h.z, x2: ex, z2: ez, r: 0.9, t: 1.0, pct: 0.12, owner: h.id, label: "CHARGE", note: "charge" });
          h.state = "rooted";
          h.stateT = 1.0;
          h.skillT = 7;
          // The hound arrives at the end of the line when it detonates (see tickHazards).
          return;
        }
        break;
      case "pigeon":
        if (!debuffed) {
          h.ritualT! -= dt;
          if (h.ritualT! <= 0) { h.stacks = Math.min(6, (h.stacks ?? 0) + 1); h.ritualT = 4; }
        }
        h.dmgMult = this.dmgMult() * (1 + 0.08 * (h.stacks ?? 0));
        break;
      case "wraith":
        if (h.latched) {
          const p = this.player(h.latched);
          if (!p || !p.alive || this.t > (h.latchUntil ?? 0)) { h.latched = undefined; h.skillT = 8; }
          else { this.damage(p, 0.03 * dt * h.dmgMult, "Clinging Wraith", true); p.moveMult = Math.min(p.moveMult, 0.5); }
          return;
        }
        if (h.skillT! <= 0 && dist < 8 && !debuffed) {
          // Latches onto the player farthest from the group (solo: the only one).
          const far = this.players.filter((p) => p.alive).sort((a, b) => this.isolation(b) - this.isolation(a))[0];
          if (far) { h.latched = far.id; h.latchUntil = this.t + 6; }
        }
        break;
    }
    if (h.state !== "windup") this.move(h, tgt, dist, dt);
    this.melee(h, tgt, dist, dt, ELITE_HIT, def.name);
  }

  private isolation(p: SimPlayer): number {
    const others = this.players.filter((o) => o !== p && o.alive);
    if (!others.length) return 0;
    return Math.min(...others.map((o) => Math.hypot(o.x - p.x, o.z - p.z)));
  }

  /** §4.3: the hero's own buttons strip an elite's Defended. */
  private kitEffect(h: Hostile, cast: { player: string; slotId: string; kind: string; answersTag?: string; consequence?: string }): void {
    const def = ELITES.find((e) => e.id === h.def);
    if (!def) return;
    let fired = false;
    switch (def.id) {
      case "repressed":
        fired = cast.kind === "palette" && !!cast.answersTag && cast.answersTag === h.ageTag;
        break;
      case "hound":
        fired = cast.slotId === "pavlov.cs";
        break;
      case "pigeon":
        if (cast.kind === "basic" && cast.consequence === "punishment" && (h.stacks ?? 0) > 0) {
          h.stacks = (h.stacks ?? 0) - 1;
          fired = h.stacks === 0;
        }
        break;
      case "diffusion":
        fired = cast.slotId === "erikson.identity-crisis";
        break;
      case "wraith":
        fired = cast.slotId === "ainsworth.strange-situation";
        if (fired) h.latched = undefined;
        break;
    }
    if (cast.slotId === "ainsworth.secure") for (const o of this.hostiles) if (o.def === "wraith") o.latched = undefined;
    if (fired) {
      const caster = this.player(cast.player);
      const dur = (def.debuffMs / 1000) * (1 + 0.5 * (caster ? this.boon(caster, "insight") : 0));
      h.debuffUntil = this.t + dur;
      if (def.id === "hound") { h.state = "rooted"; h.stateT = def.debuffMs / 1000; }
      if (def.id === "pigeon") h.ritualT = def.debuffMs / 1000;
      this.events.push({ type: "eliteDebuff", id: h.id, name: def.debuffName });
    }
  }

  // ---- bosses -------------------------------------------------------------------

  private tickBoss(h: Hostile, tgt: SimPlayer, dist: number, dt: number): void {
    h.fightT! += dt;
    const enraged = h.hp / h.hpMax < BOSS_RULES.enrageBelow;
    const cdMul = enraged ? 0.7 : 1;
    if (this.recall) return; // rooted while the party answers
    if ((h.fightT ?? 0) > BOSS_RULES.hardEnrageS && this.rand() < dt / 2) {
      this.burnAt(tgt.x + (this.rand() - 0.5) * 6, tgt.z + (this.rand() - 0.5) * 6, h.id);
    }
    if ((h.invisibleUntil ?? 0) > this.t) {
      // The Gorilla walks in unseen (footprints only), then slams.
      this.move(h, tgt, dist, dt, 1.43);
      if (this.t + dt >= (h.invisibleUntil ?? 0)) this.hazard({ kind: "circle", x: h.x, z: h.z, r: BOSS_RULES.slam.radius, t: 0.6, pct: BOSS_RULES.slam.pct, owner: h.id, label: "GORILLA SLAM", note: "slam" });
      return;
    }
    if (h.state !== "windup") this.move(h, tgt, dist, dt);
    this.melee(h, tgt, dist, dt, BOSS_RULES.swing, BOSSES.find((b) => b.id === h.def)!.name);

    h.sigT! -= dt;
    if (h.sigT! <= 0) { this.bossSignature(h, tgt); h.sigT = 9 * cdMul; }
    if ((h.appearance ?? 1) >= 2) {
      h.projT! -= dt;
      if (h.projT! <= 0) { this.bossProjectiles(h, tgt); h.projT = 7 * cdMul; }
    }
    if ((h.appearance ?? 1) >= 3) {
      h.burnT! -= dt;
      if (h.burnT! <= 0) {
        this.burnAt(tgt.x, tgt.z, h.id);
        this.tell("instr_burn", 1);
        h.burnT = 10 * cdMul;
      }
    }
  }

  private bossSignature(h: Hostile, tgt: SimPlayer): void {
    const S = BOSS_RULES.slam;
    const id = h.awakened ? (["weaver", "ames", "gorilla", "hag"] as BossId[])[Math.floor(this.rand() * 4)] : (h.def as BossId);
    switch (id) {
      case "weaver": {
        // Displacement: a bright decoy under the player, the real mark mirrored across the boss.
        const mx = 2 * h.x - tgt.x;
        const mz = 2 * h.z - tgt.z;
        const real = snapToWalkable(this.grid, mx, mz);
        this.hazard({ kind: "circle", x: tgt.x, z: tgt.z, r: S.radius, t: S.telegraph, pct: 0, owner: h.id, fake: true, label: "DECOY", note: "displacement" });
        this.hazard({ kind: "circle", x: real.x, z: real.z, r: S.radius, t: S.telegraph, pct: S.pct, owner: h.id, label: "REAL HIT" });
        break;
      }
      case "ames":
        // Size–distance: the decal LOOKS huge; the shadow (true radius) is smaller.
        this.hazard({ kind: "circle", x: tgt.x, z: tgt.z, r: S.radius, displayR: S.radius * 1.8, t: S.telegraph, pct: S.pct, owner: h.id, label: "TRUE SIZE: SHADOW", note: "sizeDistance" });
        break;
      case "gorilla":
        h.invisibleUntil = this.t + 4;
        this.events.push({ type: "note", key: "gorilla" });
        break;
      case "hag":
        tgt.pinnedUntil = this.t + 3;
        h.pinHits = 0;
        this.events.push({ type: "note", key: "pin" });
        break;
    }
    this.tell("instr_telegraph", 1);
  }

  private bossProjectiles(h: Hostile, tgt: SimPlayer): void {
    const P = BOSS_RULES.projectile;
    if (h.def === "weaver") {
      const base = this.rand() * Math.PI * 2;
      for (let i = 0; i < 12; i++) {
        const a = base + (i / 12) * Math.PI * 2;
        this.projectiles.push({ id: this.nextId++, x: h.x, z: h.z, vx: Math.sin(a) * P.speed * 0.8, vz: Math.cos(a) * P.speed * 0.8, r: P.radius, pct: 0.1, life: 6 });
      }
      return;
    }
    const a0 = Math.atan2(tgt.x - h.x, tgt.z - h.z);
    for (let i = -2; i <= 2; i++) {
      const a = a0 + i * 0.18;
      this.projectiles.push({ id: this.nextId++, x: h.x, z: h.z, vx: Math.sin(a) * P.speed, vz: Math.cos(a) * P.speed, r: P.radius, pct: P.pct, life: 5 });
    }
  }

  private burnAt(x: number, z: number, owner: number): void {
    const B = BOSS_RULES.burn;
    this.hazard({ kind: "burn", x, z, r: B.radius, t: B.seconds, pct: B.pctPerS, owner, label: "BURNING", note: "burn" });
  }

  private bossNotches(h: Hostile): void {
    if (!h.notches?.length) return;
    const frac = h.hp / h.hpMax;
    if (frac > h.notches[0]) return;
    const n = h.notches.shift()!;
    this.events.push({ type: "bossNotch", id: h.id, frac: n });
    // Roar, a ring of adds, then the Recall Test.
    const pool = MINIONS.filter((m) => m.trick !== "fall");
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const p = snapToWalkable(this.grid, h.x + Math.sin(a) * 6, h.z + Math.cos(a) * 6);
      this.addMinion(pool[Math.floor(this.rand() * pool.length)], p.x, p.z);
    }
    this.openRecall();
  }

  // ---- Recall Test ---------------------------------------------------------------

  private openRecall(): void {
    const D = DIFFICULTIES[this.difficulty].recall;
    const fresh = QUIZ.filter((q) => !this.usedQuiz.has(q.id));
    const taught = fresh.filter((q) => this.seenCards.has(q.source));
    const pool = taught.length ? taught : fresh.length ? fresh : QUIZ;
    const item = pool[Math.floor(this.rand() * pool.length)];
    this.usedQuiz.add(item.id);
    const answers = item.answers.slice(0, D.circles);
    const order = answers.map((_, i) => i).sort(() => this.rand() - 0.5);
    const shuffled = order.map((i) => answers[i]);
    const correct = order.indexOf(0);
    // Circles around the party's centre, inside the boss square, within 15 m of everyone.
    const live = this.players.filter((p) => p.alive);
    const cx = live.reduce((s, p) => s + p.x, 0) / Math.max(1, live.length);
    const cz = live.reduce((s, p) => s + p.z, 0) / Math.max(1, live.length);
    const sq = this.map.squares.find((s) => s.role === "boss")!;
    const circles = shuffled.map((_, i) => {
      const a = (i / shuffled.length) * Math.PI * 2 + this.rand() * 0.5;
      const x = Math.max(sq.x0 + 3, Math.min(sq.x1 - 3, cx + Math.sin(a) * 7));
      const z = Math.max(sq.z0 + 3, Math.min(sq.z1 - 3, cz + Math.cos(a) * 7));
      return { x, z, r: 1.5 };
    });
    this.recall = { item, answers: shuffled, correct, circles, t: D.seconds, total: D.seconds };
    this.stats.recallTotal++;
    this.tell("instr_recall", 3) || this.say(this.rand() < 0.5 ? "recall_open_1" : "recall_open_2", 3);
    this.events.push({ type: "recallOpen", question: item.question, answers: shuffled, seconds: D.seconds });
    for (const h of this.hostiles) if (h.kind !== "boss") { h.state = "rooted"; h.stateT = D.seconds; }
  }

  private tickRecall(dt: number): void {
    const r = this.recall!;
    r.t -= dt;
    if (r.t > 0) return;
    const pct = DIFFICULTIES[this.difficulty].recall.damagePct;
    const c = r.circles[r.correct];
    let allRight = true;
    for (const p of this.players) {
      if (!p.alive) continue;
      const inside = (p.x - c.x) ** 2 + (p.z - c.z) ** 2 <= (c.r + 0.15) ** 2;
      if (!inside) { allRight = false; this.damage(p, pct, "Recall Test", true, true); }
    }
    if (allRight) this.stats.recallRight++;
    this.say(allRight ? "recall_right" : "recall_wrong", 3);
    this.events.push({ type: "recallResult", correct: allRight, answer: r.answers[r.correct], explain: r.item.explain, index: r.correct });
    this.recall = null;
    for (const h of this.hostiles) if (h.state === "rooted" && h.def !== "falling") h.stateT = 0;
  }

  // ---- hazards, projectiles, pickups ---------------------------------------------

  private hazard(hz: Omit<Hazard, "id" | "total">): void {
    const h: Hazard = { ...hz, id: this.nextId++, total: hz.t };
    this.hazards.push(h);
    this.events.push({ type: "telegraph", id: h.id });
    if (h.note) this.events.push({ type: "note", key: h.note });
  }

  private tickHazards(dt: number): void {
    for (const hz of this.hazards) {
      hz.t -= dt;
      if (hz.kind === "burn") {
        for (const p of this.players) {
          if (p.alive && (p.x - hz.x) ** 2 + (p.z - hz.z) ** 2 < hz.r * hz.r) this.damage(p, hz.pct * dt, "Burning ground", true);
        }
        continue;
      }
      if (hz.t > 0) continue;
      this.events.push({ type: "detonate", id: hz.id, heavy: !hz.fake && hz.pct >= 0.2 });
      if (hz.fake || hz.pct <= 0) continue;
      for (const p of this.players) {
        if (!p.alive) continue;
        let inside: boolean;
        if (hz.kind === "line") {
          const ax = hz.x, az = hz.z, bx = hz.x2!, bz = hz.z2!;
          const abx = bx - ax, abz = bz - az;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * abx + (p.z - az) * abz) / (abx * abx + abz * abz || 1)));
          inside = (p.x - (ax + abx * t)) ** 2 + (p.z - (az + abz * t)) ** 2 < (hz.r + HERO_RADIUS) ** 2;
        } else {
          inside = (p.x - hz.x) ** 2 + (p.z - hz.z) ** 2 < (hz.r + HERO_RADIUS) ** 2;
        }
        if (inside) this.damage(p, hz.pct * this.dmgMult(), "Telegraph");
      }
      // The hound arrives at the end of its charge; a falling dream lands.
      const owner = this.hostiles.find((h) => h.id === hz.owner);
      if (owner && hz.kind === "line" && hz.x2 !== undefined) {
        const q = { x: hz.x2, z: hz.z2! };
        pushOut(q, owner.radius, this.solids(), this.map.half);
        owner.x = q.x; owner.z = q.z; owner.state = "walk";
      }
    }
    this.hazards = this.hazards.filter((h) => h.t > 0);
  }

  private shoot(x: number, z: number, tx: number, tz: number, speed: number, pct: number): void {
    const d = Math.hypot(tx - x, tz - z) || 1;
    this.projectiles.push({ id: this.nextId++, x, z, vx: ((tx - x) / d) * speed, vz: ((tz - z) / d) * speed, r: 0.5, pct, life: 4 });
  }

  private tickProjectiles(dt: number): void {
    for (const pr of this.projectiles) {
      pr.x += pr.vx * dt;
      pr.z += pr.vz * dt;
      pr.life -= dt;
      const ix = Math.floor(pr.x + this.grid.half);
      const iz = Math.floor(pr.z + this.grid.half);
      if (ix < 0 || iz < 0 || ix >= this.grid.n || iz >= this.grid.n || !this.grid.walk[iz * this.grid.n + ix]) { pr.life = 0; continue; }
      for (const p of this.players) {
        if (p.alive && (p.x - pr.x) ** 2 + (p.z - pr.z) ** 2 < (pr.r + HERO_RADIUS) ** 2) {
          this.damage(p, pr.pct * this.dmgMult(), "Projectile");
          pr.life = 0;
          break;
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.life > 0);
  }

  private dropAt(x: number, z: number, kind: Pickup["kind"]): void {
    const p = snapToWalkable(this.grid, x + (this.rand() - 0.5), z + (this.rand() - 0.5));
    this.pickups.push({ id: this.nextId++, kind, x: p.x, z: p.z, life: PICKUPS.lifeS });
  }

  private tickPickups(dt: number): void {
    for (const pk of this.pickups) {
      pk.life -= dt;
      for (const p of this.players) {
        if (!p.alive) continue;
        const d2 = (p.x - pk.x) ** 2 + (p.z - pk.z) ** 2;
        const reach = PICKUPS.magnet + 2 * this.boon(p, "chunking");
        if (d2 < reach * reach) {
          // Magnetised: drift toward the player, collect on contact.
          const d = Math.sqrt(d2) || 1;
          pk.x += ((p.x - pk.x) / d) * Math.min(d, 8 * dt);
          pk.z += ((p.z - pk.z) / d) * Math.min(d, 8 * dt);
          if (d < 0.6) {
            const heal = pk.kind === "hp" ? PICKUPS.hpOrbPct * p.hpMax : pk.kind === "bigHp" ? PICKUPS.largeHpPct * p.hpMax * (1 + 0.5 * this.boon(p, "spacing")) : 0;
            const focus = pk.kind === "focus" ? PICKUPS.focusOrb : pk.kind === "bigFocus" ? PICKUPS.largeFocus : 0;
            p.hp = Math.min(p.hpMax, p.hp + heal);
            this.events.push({ type: "pickup", player: p.id, kind: pk.kind, focus, heal });
            pk.life = 0;
            break;
          }
        }
      }
    }
    this.pickups = this.pickups.filter((p) => p.life > 0);
  }

  private kill(h: Hostile): void {
    h.state = "dead";
    h.hp = 0;
    this.events.push({ type: "die", id: h.id, kind: h.kind, def: h.def });
    if (h.twinOf === undefined) {
      this.stats.kills++;
      const by = h.lastHit ? this.player(h.lastHit) : undefined;
      if (by) by.score.kills++;
      for (const p of this.players) {
        if (!p.alive) continue;
        p.kills++;
        if (this.boon(p, "token") && p.kills % Math.max(8, 25 - 5 * (this.boon(p, "token") - 1)) === 0) this.dropAt(p.x, p.z, "focus");
      }
    }
    if (h.kind === "minion") {
      const def = MINIONS.find((m) => m.id === h.def);
      const avg = this.players.reduce((s, p) => s + p.hp / p.hpMax, 0) / this.players.length;
      const hpChance = PICKUPS.minionHpChance * (avg < 0.3 ? 2 : 1);
      const r = this.rand();
      if (r < hpChance) { this.dropAt(h.x, h.z, "hp"); this.tell("instr_pickup", 1); }
      else if (r < hpChance + PICKUPS.minionFocusChance) { this.dropAt(h.x, h.z, "focus"); this.tell("instr_pickup", 1); }
      if (def?.trick === "split" && !h.noSplit && this.rand() < 0.3) {
        for (let i = 0; i < 2; i++) {
          const c = this.addMinion(def, h.x + (i ? 0.8 : -0.8), h.z, 0.5);
          c.noSplit = true;
        }
      }
    } else if (h.kind === "elite") {
      this.stats.elitesKilled++;
      const low = this.players.some((p) => p.hp / p.hpMax < 0.5);
      this.dropAt(h.x, h.z, low ? "bigHp" : "bigFocus");
      this.say("elite_killed", 1);
    } else {
      this.stats.bossesKilled++;
      for (const p of this.players) if (!p.alive && this.players.length > 1) this.revive(p);
      for (let i = 0; i < 3; i++) { this.dropAt(h.x, h.z, "bigHp"); this.dropAt(h.x, h.z, "bigFocus"); }
      if (this.wave < this.waves) this.say(this.rand() < 0.5 ? "boss_down_1" : "boss_down_2", 2);
      this.hazards = this.hazards.filter((z) => z.owner !== h.id);
      this.projectiles = [];
    }
  }

  // ---- players ------------------------------------------------------------------

  private tickPlayers(dt: number): void {
    for (const p of this.players) {
      p.moveMult = this.t < p.pinnedUntil ? 0 : 1;
      p.dashRecharge = p.dashRecharge.filter((at) => {
        if (this.t >= at) { p.dashCharges = Math.min(this.maxDash(p), p.dashCharges + 1); return false; }
        return true;
      });
      if (this.t > p.mitigationUntil) p.mitigation = 0;
      if (!p.alive && p.downAt && this.players.length === 1 && p.secondWindCycle === this.cycleOf(this.wave) && this.t - p.downAt > 1.5) {
        p.alive = true;
        p.hp = Math.round(p.hpMax * 0.3);
        p.downAt = 0;
        this.events.push({ type: "secondWind", player: p.id });
        this.say("second_wind", 3);
      }
      if (p.pinnedUntil > this.t) this.damage(p, 0.04 * dt, "The Old Hag", true);
      // Reach Out (party): a living ally beside a downed one for 3 s revives them at 30 %.
      if (!p.alive && this.players.length > 1 && this.phase !== "victory" && this.phase !== "defeat") {
        const helper = this.players.some((o) => o.alive && (o.x - p.x) ** 2 + (o.z - p.z) ** 2 < 1.6 * 1.6);
        p.reviveT = helper ? p.reviveT + dt : 0;
        if (p.reviveT >= 3) this.revive(p);
      }
    }
    // Kanizsa: inside a live triangle, movement slows.
    const groups = new Map<number, Hostile[]>();
    for (const h of this.hostiles) if (h.group && h.state !== "dead") groups.set(h.group, [...(groups.get(h.group) ?? []), h]);
    for (const tri of groups.values()) {
      if (tri.length < 3) continue;
      for (const p of this.players) if (inTriangle(p, tri[0], tri[1], tri[2])) p.moveMult = Math.min(p.moveMult, 0.6);
    }
  }

  private revive(p: SimPlayer): void {
    for (const o of this.players) if (o !== p && o.alive && (o.x - p.x) ** 2 + (o.z - p.z) ** 2 < 1.6 * 1.6) o.score.revives++;
    p.alive = true;
    p.hp = Math.round(p.hpMax * 0.3);
    p.reviveT = 0;
    p.downAt = 0;
    this.events.push({ type: "revive", player: p.id });
    this.say("player_revived", 2);
  }

  /** A wipe that did not come through damage (everyone dropped out): end the run. */
  endIfWiped(): void {
    if (this.phase !== "victory" && this.phase !== "defeat" && !this.players.some((p) => p.alive)) this.finish(false);
  }

  private damage(p: SimPlayer, pct: number, source: string, ignoreIframes = false, trueDamage = false): void {
    if (!p.alive) return;
    if (!ignoreIframes && this.t < p.iframesUntil) return;
    const mit = trueDamage ? 0 : p.mitigation;
    const exposure = trueDamage ? 1 : Math.pow(0.85, this.boon(p, "exposure"));
    const amount = pct * p.hpMax * (1 - mit) * exposure;
    if (amount <= 0) return;
    p.score.taken += Math.min(amount, Math.max(0, p.hp));
    p.hp -= amount;
    this.events.push({ type: "hitPlayer", player: p.id, amount: Math.round(amount), source });
    if (p.hp / p.hpMax < 0.3) this.taunt("taunt_heart", 0.15);
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      p.downAt = this.t;
      p.score.downs++;
      this.events.push({ type: "playerDown", player: p.id });
      const cycle = this.cycleOf(this.wave);
      if (this.players.length === 1 && p.secondWindCycle !== cycle) {
        p.secondWindCycle = cycle; // revives in tickPlayers
        return;
      }
      this.say("player_down", 2);
      if (!this.players.some((o) => o.alive)) this.finish(false);
    }
  }

  // ---- crowd separation ----------------------------------------------------------

  private separate(): void {
    const hs = this.hostiles;
    for (let i = 0; i < hs.length; i++) {
      const a = hs[i];
      if (a.state === "dead") continue;
      for (let j = i + 1; j < hs.length; j++) {
        const b = hs[j];
        if (b.state === "dead") continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const min = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) / 2 / d;
        const wa = a.kind === "boss" ? 0 : 1;
        const wb = b.kind === "boss" ? 0 : 1;
        a.x -= dx * push * wa * (wb ? 1 : 2);
        a.z -= dz * push * wa * (wb ? 1 : 2);
        b.x += dx * push * wb * (wa ? 1 : 2);
        b.z += dz * push * wb * (wa ? 1 : 2);
      }
    }
  }

  // ---- voice + cards -------------------------------------------------------------

  /** Queue a voice line (the client plays one at a time by priority). */
  private say(key: string, priority: number): void {
    this.events.push({ type: "announce", key, priority });
  }

  /** An instruction line plays once per run. Returns true if it was queued. */
  private tell(key: string, priority: number): boolean {
    if (this.told.has(key)) return false;
    this.told.add(key);
    this.say(key, priority + 1);
    return true;
  }

  private taunt(key: string, chance: number): void {
    if (this.tauntT > 0 || this.rand() > chance) return;
    this.say(key, 0);
    this.tauntT = 30;
  }

  private tickTaunts(dt: number): void {
    this.tauntT -= dt;
    if (this.tauntT > 0 || (this.phase !== "wave" && this.phase !== "boss")) return;
    const pool = ["taunt_run", "taunt_thousand", "taunt_fear", "taunt_theories", "taunt_freud", "taunt_love", "taunt_sleeping", "taunt_fog", "taunt_tired"];
    this.say(pool[Math.floor(this.rand() * pool.length)], 0);
    this.tauntT = 28 + this.rand() * 14;
  }

  private card(id: string, title: string, text: string): void {
    if (this.seenCards.has(id)) return;
    this.seenCards.add(id);
    this.events.push({ type: "card", title, text });
  }

  player(id: string): SimPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get statsNow(): RunStats {
    return {
      ...this.stats,
      players: this.players.map((p) => ({
        id: p.id, name: this.names.get(p.id) ?? p.id, hero: p.hero,
        ...p.score, dealt: Math.round(p.score.dealt), healed: Math.round(p.score.healed), taken: Math.round(p.score.taken),
      })),
    };
  }
}

function inTriangle(p: { x: number; z: number }, a: Hostile, b: Hostile, c: Hostile): boolean {
  const s = (p1: { x: number; z: number }, p2: { x: number; z: number }, p3: { x: number; z: number }) =>
    (p1.x - p3.x) * (p2.z - p3.z) - (p2.x - p3.x) * (p1.z - p3.z);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
