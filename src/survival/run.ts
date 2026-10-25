/**
 * One Dream Siege run, mounted on the Old Kowloon scene. Glue only:
 *   - shared/survival/sim.ts plays the game;
 *   - casts are PRICED by the hero's real kit — a BossFight against the
 *     training dummy, exactly the practice pit's trick — and then LAND on the
 *     auto-targeted monster through `sim.hitHostile`, so every hero's beats,
 *     Marks, crits, conditioning and operant quadrants work unchanged;
 *   - kit heals heal the survival hero, a defensive cast grants mitigation;
 *   - view.ts draws, hud.ts informs, announcer.ts speaks.
 *
 * PARTY mode (`opts.party`): the server runs the sim (server/survival.mjs).
 * This client does not tick it — it applies the server's 10 Hz frames into the
 * same SurvivalSim object the view and HUD read, sends its position and
 * priced casts as inputs, predicts its own movement, and draws teammates.
 */
import type { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { BossFight } from "@shared/fight/bossFight";
import { TRAINING_DUMMY } from "@shared/bosses/trainingDummy";
import { BEAT_PERIOD_S } from "@shared/combat";
import type { Hero } from "@shared/types";
import { SurvivalSim, HAZARD_NOTES, HERO_RADIUS, HERO_HP, type Hostile, type RunStats } from "@shared/survival/sim";
import { pushOut } from "@shared/survival/map/layout";
import { BOONS, type DifficultyId, type HeroKitId } from "@shared/survival/content";
import { OLD_KOWLOON } from "@shared/survival/map/oldKowloon";
import { player } from "../state/player";
import { isTypingInField } from "../ui/inputMode";
import { createDamageNumbers } from "../vfx/damageNumbers";
import { postSurvivalSettle } from "../net/economy";
import { setupSkillBar, buildFreud, type HeroHandle, type HeroVoice, type SkillBarHandle, type Mats } from "../scenes/villageHub";
import { heroById } from "@shared/heroes";
import { petSpec } from "@shared/progression";
import { fightLoadout } from "../state/loadout";
import { potionFocusRegenMult } from "../state/potions";
import { petForHero } from "../scenes/petFollower";
import type { BoonId } from "@shared/survival/content";
import { createSurvivalView } from "./view";
import { createSurvivalHud, openResults, type RunSettlement } from "./hud";
import { createAnnouncer } from "./announcer";
import { createSurvivalSfx } from "./sfx";
import { createSurvivalMusic } from "./music";

/** Survival's reach for "every enemy" skills and ground zones (the server clamps to the same). */
const SURVIVAL_AOE_MAX_M = 8;
/** Ultimates tick as zones: 6 ticks, 0.75 s apart (first at once). */
const ULT_ZONE_TICKS = 6;
const ULT_ZONE_PERIOD_S = 0.75;

export interface SurvivalRun {
  /** Movement clamp hook: sim slows/pins, then the map push-out the scene already does. */
  constrain(pos: Vector3, prev: Vector3): void;
  tick(dt: number): void;
  dispose(): void;
}

export async function startSurvivalRun(opts: {
  scene: Scene;
  camera: ArcRotateCamera;
  hero: HeroHandle;
  voice: HeroVoice;
  mats: Mats;
  kit: Hero;
  difficulty: DifficultyId;
  /** A party run mirrors this server session instead of simulating locally. */
  party?: { session: number };
  /** The account's name: our row on the rank board, and how a party run finds us in the server's frames. */
  username?: string;
  leave: () => void;
}): Promise<SurvivalRun> {
  const { scene, hero, voice, kit, difficulty } = opts;
  const party = opts.party ?? null;

  // ---- party: frames from server/survival.mjs (via net/social.ts window events) --------
  type Frame = Record<string, unknown> & { session: number; players: Array<Record<string, unknown> & { id: string; name: string; hero: string }>; events: unknown[] };
  let latest: Frame | null = null;
  type EndInfo = RunSettlement & { victory: boolean; stats: RunStats };
  let endInfo: EndInfo | null = null;
  const onNet = (e: Event) => {
    const { type, data } = (e as CustomEvent<{ type: string; data: Frame & EndInfo }>).detail;
    if (!party || data.session !== party.session) return;
    if (type === "survivalState") {
      // Never drop a frame's EVENTS: keep the newest state, but carry older events forward.
      if (latest) data.events = [...latest.events, ...data.events];
      latest = data;
    } else if (type === "survivalEnd") endInfo = data;
  };
  window.addEventListener("psy:survival", onNet);
  let first: Frame | null = null;
  if (party) {
    const t0 = performance.now();
    while (!latest && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
    first = latest;
    if (!first) throw new Error("the party run did not start (no state from the server)");
  }
  // Gear set + equipped pet, read once at run start, exactly as a boss fight
  // does (fight/arenaCombat.ts): damage/healing price through the BossFight,
  // HP sizes the survival hero, Focus regen goes to the player store.
  const petId = petForHero(kit.id);
  const loadout = fightLoadout(kit.id, petId);
  player.manaRegenMult = loadout.focusRegen * potionFocusRegenMult();
  const username = opts.username ?? (window as unknown as { psyrena?: { profile?: { username?: string } } }).psyrena?.profile?.username;
  const me = party ? (first!.players.find((p) => p.name === username)?.id ?? first!.players[0].id) : "me";
  const sim = new SurvivalSim({
    difficulty, map: OLD_KOWLOON,
    players: party
      ? first!.players.map((p) => ({ id: p.id, hero: p.hero as HeroKitId, role: heroById(p.hero).role, name: p.name }))
      : [{ id: me, hero: kit.id as HeroKitId, role: kit.role, name: username ?? "You", hpMax: Math.round(HERO_HP * loadout.hpMult) }],
    seed: (Date.now() & 0xffff) ^ 0x5eed,
  });
  // Console poking (window.psyrena is assigned after the boot scene, so this
  // gets its own global): psyrenaSurvival.sim.phase, .tick(dt) to fast-forward.
  (window as unknown as { psyrenaSurvival?: unknown }).psyrenaSurvival = { sim };
  const view = createSurvivalView(scene, sim);
  await view.preload();
  const hud = createSurvivalHud();
  const announcer = createAnnouncer();
  const sfx = createSurvivalSfx();
  const music = createSurvivalMusic();
  const seenProjectiles = new Set<number>();
  let tickSecond = -1;
  let mapT = 0;
  const bossSquare = OLD_KOWLOON.squares.find((q) => q.role === "boss");
  // AoE and DoT ticks put many numbers up at once: a larger cap than the boss fight's.
  const dmg = typeof document === "undefined" ? null : createDamageNumbers(scene, { maxLive: 48 });
  /** A number's anchor that walks with its monster (party frames replace the objects, so look up by id). */
  const followHostile = (id: number) => () => {
    const h = sim.hostiles.find((x) => x.id === id);
    return h ? view.aimPoint(h) : null;
  };
  const meP = sim.player(me)!;
  player.setVitals(meP.hpMax);

  // ---- actions: straight into the local sim (solo), or queued as inputs (party) -------
  type Cast = { player: string; slotId: string; kind: string; answersTag?: string; consequence?: string };
  const out = { hits: [] as unknown[], heal: 0, mitigation: false, dash: false, boon: null as BoonId | null };
  const act = {
    hit(id: number, amount: number, crit: boolean, cast: Cast): number {
      if (!party) return sim.hitHostile(id, amount, crit, cast);
      out.hits.push({ target: id, amount, crit, ...cast });
      return 0; // the server's hitHostile event carries the real number
    },
    /** Area hit; returns the hostiles it struck (party: as this client sees them). */
    area(x: number, z: number, r: number, amount: number, crit: boolean, cast: Cast): number[] {
      if (!party) return sim.hitArea(x, z, r, amount, crit, cast);
      out.hits.push({ area: true, x, z, r, amount, crit, ...cast });
      return sim.hostiles.filter((h) => h.state !== "dead" && (h.x - x) ** 2 + (h.z - z) ** 2 <= (r + h.radius) ** 2).map((h) => h.id);
    },
    /** A damage zone on the ground: `total` per hostile inside, in ticks. */
    zone(x: number, z: number, r: number, total: number, ticks: number, periodS: number, cast: Cast, now = false): void {
      if (!party) { sim.addZone(x, z, r, total, ticks, periodS, cast, now); return; }
      out.hits.push({ zone: true, x, z, r, amount: total, ticks, periodS, now, ...cast });
    },
    dot(id: number, total: number, ticks: number, periodS: number, cast: Cast): void {
      if (!party) { sim.addDot(id, total, ticks, periodS, cast); return; }
      out.hits.push({ dot: true, target: id, amount: total, ticks, periodS, ...cast });
    },
    heal(n: number): void { if (!party) sim.healPlayer(me, n); else out.heal += n; },
    mitigate(): void { if (!party) sim.setMitigation(me, 0.35, 4); else out.mitigation = true; },
    dash(): boolean {
      if (!party) return sim.dash(me);
      if (meP.dashCharges <= 0 || !meP.alive) return false;
      meP.dashCharges--; // predicted; the next frame corrects it
      out.dash = true;
      return true;
    },
    boon(id: BoonId): void { if (!party) sim.pickBoon(me, id); else out.boon = id; },
  };

  // ---- targeting -----------------------------------------------------------------
  let target: Hostile | null = null;
  let retarget = 0;
  const aim = () => (target && target.state !== "dead" ? view.aimPoint(target) : hero.node.position.add(new Vector3(0, 1.2, 0)));

  // ---- the kit, priced by a real BossFight against the dummy -------------------------
  let beat = 0;
  let beatT = 0;
  let bar: SkillBarHandle | null = null;
  const fight = new BossFight(TRAINING_DUMMY, kit, [], {
    announce: () => {},
    setBossPhase: () => {},
    bossStrike: () => {},
    damagePlayer: () => {},
    healPlayer: () => {},
    combatantHealed: (_n, _eff, attempted) => {
      act.heal(attempted);
      const at = hero.node.position.clone();
      at.y += 2;
      dmg?.spawn(at, attempted, false, "heal");
    },
    playerHitReaction: () => {},
    playerBuff: (name, durationMs, kind, icon, id, desc) => {
      player.applyBuff({ id: `survival.${id ?? icon ?? name}`, name, durationMs, kind: kind ?? "buff", desc });
    },
    gainFocus: (n) => queueMicrotask(() => player.restoreMana(n)),
    // Ticks against the dummy are only the pricing run's echo: survival's own
    // zones and DoTs (sim.addZone / addDot) pay the real ones, on real monsters.
    dotTick: () => {},
    lockPaletteSlot: (i, ms) => {
      const id = bar?.paletteIds[i];
      if (id) bar?.lockSlot(id, ms);
    },
    conditioningChanged: (s) => { bar?.setTransformed(s.conditioned); },
    operantChanged: (s) => { bar?.setOperant(s); },
    psychosocialChanged: (s) => { bar?.setPsychosocial(s); },
  }, { hpMult: 1, dmgMult: 1 }, {}, loadout);
  const petBoosts = ([["HP", loadout.hpMult], ["damage", loadout.petDamage], ["healing", loadout.petHealing], ["Focus regen", loadout.focusRegen]] as const)
    .filter(([, m]) => m > 1)
    .map(([label, m]) => `${label} +${Math.round((m - 1) * 100)}%`);
  if (petId && petBoosts.length) {
    player.applyBuff({
      id: "survival.pet", name: `${petSpec(petId)?.name ?? "Pet"} — ${petBoosts.join(" · ")}`,
      icon: `/assets/ui/pets/${petId}.webp`, kind: "buff", durationMs: Infinity,
      desc: "Your equipped pet's passive boost. Level it up at the Pet Park.",
    });
  }

  bar = setupSkillBar(scene, hero, voice, {
    target: () => aim(),
    mountTransforming: true,
    simDrivesOperant: true,
    simDrivesPsychosocial: true,
    onCast: (slot, land) => {
      if (slot.kind === "stance") { fight.setThreatStance(bar?.stanceActive() ?? false); return; }
      const mult = kit.beats?.[beat]?.multiplier ?? 1;
      const tgt = target && target.state !== "dead" ? target : sim.nearestHostile(meP.x, meP.z, 22);
      if (slot.kind === "ultimate") {
        const at = tgt ? { x: tgt.x, z: tgt.z } : { x: meP.x, z: meP.z };
        land(() => {
          const total = fight.castUltimate();
          // A zone, not one slab: the payload ticks for ~4 s on everything
          // inside, monsters that walk in late included.
          act.zone(at.x, at.z, Math.min(SURVIVAL_AOE_MAX_M, kit.ultimate.zoneRadius ?? 6), total, ULT_ZONE_TICKS, ULT_ZONE_PERIOD_S,
            { player: me, slotId: slot.id, kind: "ultimate" }, true);
        });
        return;
      }
      if (slot.kind === "defense") {
        fight.castDefense();
        act.mitigate();
        // Defensive kits that touch an elite still count (Ainsworth's styles live on the palette).
        return;
      }
      const paletteIndex = kit.palette.findIndex((p) => p.id === slot.id);
      const hit =
        slot.kind === "basic" ? fight.castBasic(mult)
          : slot.kind === "palette" ? fight.castPalette(paletteIndex, mult)
            : slot.kind === "chain" ? fight.castChain(mult)
              : null;
      if (!hit || !tgt) {
        // Slots that are not damage (Erikson's R, Ainsworth's R) can still trigger an elite debuff.
        if (tgt) act.hit(tgt.id, 0, false, { player: me, slotId: slot.id, kind: slot.kind });
        return;
      }
      const answersTag = paletteIndex >= 0 ? kit.palette[paletteIndex].answersTag : undefined;
      const consequence = fight.operant?.consequence;
      const id = tgt.id;
      land(() => {
        const priced = fight.landHit(hit);
        const h = sim.hostiles.find((x) => x.id === id);
        if (!h) return;
        const cast = { player: me, slotId: slot.id, kind: slot.kind, answersTag, consequence };
        // Area skills reach everything around the target (map-wide ones too, within reason).
        const r = hit.aoeRadius ? Math.min(SURVIVAL_AOE_MAX_M, hit.aoeRadius) : 0;
        const struck = r > 0 ? act.area(h.x, h.z, r, priced, hit.crit, cast) : (act.hit(id, priced, hit.crit, cast), [id]);
        const ot = hit.overTime;
        if (ot) {
          // The dummy priced the impact part; the same ratio prices the ticks.
          const total = ot.total * (hit.damage > 0 ? priced / hit.damage : 1);
          if (ot.zoneRadius) act.zone(h.x, h.z, Math.min(SURVIVAL_AOE_MAX_M, ot.zoneRadius), total, ot.ticks, ot.periodS, cast);
          else for (const sid of struck) act.dot(sid, total, ot.ticks, ot.periodS, cast);
        }
      });
    },
  }, kit);
  hud.dockDash(kit.psychosocial !== undefined);
  const operant = fight.operant;
  if (operant) bar?.setOperant(operant);

  // ---- dash --------------------------------------------------------------------------
  let dashT = 0;
  const dashDir = new Vector3();
  // Where the hero is actually heading: the last real step (stick or WASD),
  // measured from position, so the dash follows movement, not the facing
  // (a hero turned to cast still dashes the way they run).
  const lastPos = hero.node.position.clone();
  const moveDir = new Vector3();
  let movedAt = -1;
  const doDash = () => {
    if (!act.dash()) return;
    sfx.play("dash");
    if (performance.now() - movedAt < 200) dashDir.copyFrom(moveDir);
    else {
      // Standing still: along the facing (models face -Z at yaw 0).
      const yaw = hero.node.rotation.y;
      dashDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    }
    dashT = 0.18;
    // Turn into the dash, so the body leads the burst.
    hero.node.rotation.y = Math.atan2(-dashDir.x, -dashDir.z);
  };
  hud.onDash(doDash);
  // Space dashes on a keyboard (Q stays the palette cycle it is everywhere else).
  // Survival has no jump: capture phase on window runs before the hero
  // controller's own Space (jump) handler, and stopping it there means the key
  // is only the dash. Outside survival, Space still jumps.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== " " || isTypingInField()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) doDash();
  };
  window.addEventListener("keydown", onKey, { capture: true });

  // ---- events ---------------------------------------------------------------------
  let ended = false;
  /** Each floor mechanic is explained once per run, the first time it appears. */
  const explained = new Set<string>();
  let bossId: number | null = null;
  let bossName = "";
  const handleEvents = () => {
    for (const e of sim.drainEvents()) {
      switch (e.type) {
        case "announce": announcer.say(e.key, e.priority); break;
        case "phase":
          if (e.phase === "wave") sfx.play("wave_start");
          // The last wave gets its own music (Frank's "fog_boss").
          if (e.phase === "boss" && e.wave === e.waves) music.final();
          hud.setWave(e.phase === "intro" ? e.label : `Wave ${Math.max(1, e.wave)} / ${e.waves}`);
          if (e.phase === "wave" || e.phase === "boss") hud.banner(e.label);
          if (e.phase === "intermission") hud.banner("Catch your breath", 2500);
          break;
        case "boss": bossId = e.id; bossName = e.name; hud.banner(e.name, 3000); sfx.play("boss_roar"); break; // her theory card toasts via "card"
        case "bossNotch": sfx.play("boss_roar"); break;
        case "hitHostile": {
          // Ticks stay quiet: a zone on ten monsters would be ten hit sounds a second.
          if (!e.dot) { if (e.defended) sfx.play("hit_defended"); else if (e.amount > 0) sfx.play("hit"); }
          // Every number comes from the sim's own event (solo and party alike), so
          // AoE and DoT ticks float over each monster they land on, and follow it.
          const h = e.amount > 0 ? sim.hostiles.find((x) => x.id === e.id) : null;
          if (h) {
            if (e.dot) dmg?.spawnDot(view.aimPoint(h), e.amount, "", followHostile(e.id));
            else dmg?.spawn(view.aimPoint(h), e.amount, e.crit, "damage", followHostile(e.id));
          }
          break;
        }
        case "die": sfx.play(e.kind === "minion" ? "die_minion" : "die_elite"); break;
        case "bell": sfx.play("bell"); break;
        case "telegraph": {
          const hz = sim.hazards.find((h) => h.id === e.id);
          sfx.play(hz?.kind === "burn" ? "burn" : "telegraph");
          break;
        }
        case "detonate": if (e.heavy) sfx.play("slam"); break;
        case "card": hud.toast(e.title, e.text); break;
        case "note":
          if (!explained.has(e.key) && HAZARD_NOTES[e.key]) { explained.add(e.key); hud.callout(HAZARD_NOTES[e.key]); }
          break;
        case "eliteDebuff": {
          sfx.play("shield_break");
          hud.toast(e.name, "Its defense is broken.", "debuff", 3000);
          const h = sim.hostiles.find((x) => x.id === e.id);
          if (h) dmg?.spawnText?.(view.aimPoint(h), e.name);
          break;
        }
        case "recallOpen": hud.openRecall(e.question, e.answers, e.seconds); sfx.play("recall_open"); break;
        case "recallResult":
          hud.closeRecall();
          sfx.play(e.correct ? "recall_right" : "recall_wrong");
          hud.showRecallResult(e.correct, e.answer, e.explain, e.index);
          break;
        case "hitPlayer": {
          if (e.player !== me) break;
          sfx.play("player_hit");
          const at = hero.node.position.clone();
          at.y += 1.8;
          dmg?.spawn(at, e.amount, false, "taken");
          break;
        }
        case "pickup": {
          if (e.player !== me) break;
          const at = hero.node.position.clone();
          at.y += 2.1;
          if (e.focus) {
            // What it actually filled: a full pool takes nothing.
            const filled = Math.min(e.focus, Math.max(0, player.manaMax - player.mana));
            player.restoreMana(e.focus);
            dmg?.spawnGain(at, filled > 0 ? `+${Math.round(filled)} Focus` : "Focus full", "focus");
          } else {
            dmg?.spawnGain(at, e.heal >= 1 ? `+${Math.round(e.heal)} HP` : "HP full", "heal");
          }
          sfx.play(e.focus ? "pickup_focus" : "pickup_hp");
          break;
        }
        case "playerDown": hud.banner(e.player === me ? "Down… an ally can Reach Out" : `${nameOf(e.player)} is down — stand beside them`, 2200); break;
        case "revive": hud.banner(e.player === me ? "Back on your feet" : `${nameOf(e.player)} is back`, 1800); break;
        case "teleport": if (e.player === me) { hero.node.position.x = e.x; hero.node.position.z = e.z; } break;
        case "gates": if (e.closed) hud.callout("The fog closes the square. Fight it out here."); break;
        case "boonOffer": if (e.player === me) hud.openBoons(e.options, (id) => act.boon(id)); break;
        case "boon":
          if (e.player === me) {
            hud.closeBoons();
            const b = BOONS.find((x) => x.id === e.id);
            if (b) hud.toast(b.name, b.text, "debuff", 4000);
          }
          break;
        case "secondWind": hud.banner("Second Wind", 2000); break;
        case "end": sfx.play(e.victory ? "victory" : "defeat"); if (!party) void finish(e.victory, e.stats); break;
      }
    }
  };

  const nameOf = (id: string) => (latest?.players.find((p) => p.id === id)?.name as string | undefined) ?? "An ally";

  async function finish(victory: boolean, stats: RunStats): Promise<void> {
    if (ended) return;
    ended = true;
    let settle: RunSettlement | null = null;
    const mine = stats.players.find((p) => p.id === me);
    try {
      settle = await postSurvivalSettle({
        difficulty, victory, wavesCleared: stats.wavesCleared, durationS: stats.durationS,
        score: mine && { dealt: mine.dealt, healed: mine.healed, kills: mine.kills, downs: mine.downs, revives: mine.revives },
        recallRight: stats.recallRight,
      });
    } catch (err) {
      console.warn("[survival] settle failed; showing the local result:", err);
    }
    showResults(stats, victory, settle);
  }

  function showResults(stats: RunStats, victory: boolean, settle: RunSettlement | null): void {
    window.setTimeout(() => openResults({
      stats, victory, settle, me,
      heroName: (id) => heroById(id).displayName,
      onLeave: opts.leave,
    }), 2500);
  }

  // ---- party: apply frames, draw teammates, send inputs ------------------------------
  const remotes = new Map<string, { h: HeroHandle | null; loading: boolean; lastX: number; lastZ: number }>();
  function applyFrame(f: Frame): void {
    const S = sim as unknown as Record<string, unknown>;
    for (const k of ["t", "phase", "wave", "gatesClosed"] as const) S[k] = f[k];
    sim.hostiles = f.hostiles as typeof sim.hostiles;
    sim.hazards = f.hazards as typeof sim.hazards;
    sim.projectiles = f.projectiles as typeof sim.projectiles;
    sim.pickups = f.pickups as typeof sim.pickups;
    sim.zones = (f.zones ?? []) as typeof sim.zones;
    const r = f.recall as null | { question: string; answers: string[]; circles: Array<{ x: number; z: number; r: number }>; t: number; total: number };
    sim.recall = r ? { item: { id: "", source: "", question: r.question, answers: ["", "", "", ""], explain: "" }, answers: r.answers, correct: -1, circles: r.circles, t: r.t, total: r.total } : null;
    for (const fp of f.players) {
      const p = sim.player(fp.id);
      if (!p) continue;
      const keepX = p.x, keepZ = p.z;
      Object.assign(p, fp);
      if (fp.id === me) {
        // Our own position is predicted locally; snap only on a big disagreement.
        if (Math.hypot(Number(fp.x) - keepX, Number(fp.z) - keepZ) > 4) {
          hero.node.position.x = Number(fp.x);
          hero.node.position.z = Number(fp.z);
        } else { p.x = keepX; p.z = keepZ; }
      }
    }
    sim.events.push(...(f.events as typeof sim.events));
  }
  function tickRemotes(dt: number): void {
    for (const p of sim.players) {
      if (p.id === me) continue;
      let r = remotes.get(p.id);
      if (!r) {
        r = { h: null, loading: true, lastX: p.x, lastZ: p.z };
        remotes.set(p.id, r);
        const rr = r;
        void buildFreud(scene, opts.mats, { castStyle: "fight", heroId: p.hero }).then((h) => { rr.h = h; rr.loading = false; h.node.position.set(p.x, 0, p.z); });
      }
      const h = r.h;
      if (!h) continue;
      const k = Math.min(1, dt * 10);
      const nx = h.node.position.x + (p.x - h.node.position.x) * k;
      const nz = h.node.position.z + (p.z - h.node.position.z) * k;
      const speed = Math.hypot(nx - h.node.position.x, nz - h.node.position.z) / Math.max(dt, 1e-3);
      h.node.position.x = nx;
      h.node.position.z = nz;
      const yaw = Number((latest?.players.find((q) => q.id === p.id) as { yaw?: number } | undefined)?.yaw ?? 0);
      h.node.rotation.y = yaw;
      h.node.setEnabled(true);
      for (const m of h.node.getChildMeshes()) m.visibility = p.alive ? 1 : 0.35;
      h.animator?.update(dt, { speed, moving: speed > 0.3 });
      h.tick(performance.now() / 1000);
    }
  }
  let sendT = 0;
  let sending = false;
  function sendInput(): void {
    if (!party || sending) return;
    sending = true;
    const body = {
      session: party.session, x: hero.node.position.x, z: hero.node.position.z, yaw: hero.node.rotation.y,
      // The first input declares the equipped pet (server/survival.mjs sizes our HP from it).
      pet: petId ?? undefined,
      dash: out.dash, hits: out.hits.splice(0), heal: out.heal, mitigation: out.mitigation, boon: out.boon ?? undefined,
    };
    out.dash = false; out.heal = 0; out.mitigation = false; out.boon = null;
    void fetch("/api/survival/input", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .catch(() => {})
      .finally(() => { sending = false; });
  }

  // ---- per frame ----------------------------------------------------------------------
  return {
    constrain(pos, prev) {
      // Pins / latches / Kanizsa slow scale this frame's step.
      const k = meP.alive ? meP.moveMult : 0;
      pos.x = prev.x + (pos.x - prev.x) * k;
      pos.z = prev.z + (pos.z - prev.z) * k;
      // The fog walls, while a boss holds the square.
      if (sim.gatesClosed) pushOut(pos, HERO_RADIUS, sim.solids(), sim.map.half);
    },
    tick(dt) {
      beatT += dt;
      while (beatT >= BEAT_PERIOD_S) { beatT -= BEAT_PERIOD_S; beat = (beat + 1) % (kit.beats?.length ?? 1); }
      fight.tick(dt);
      if (dashT <= 0) {
        const dx = hero.node.position.x - lastPos.x;
        const dz = hero.node.position.z - lastPos.z;
        const d = Math.hypot(dx, dz);
        if (dt > 0 && d / dt > 0.8) { moveDir.set(dx / d, 0, dz / d); movedAt = performance.now(); }
      }
      if (dashT > 0) {
        const step = Math.min(dashT, dt);
        hero.node.position.addInPlace(dashDir.scale((5 / 0.18) * step));
        dashT -= step;
      }
      lastPos.copyFrom(hero.node.position);
      if (party) {
        if (latest) { applyFrame(latest); latest = null; }
        meP.x = hero.node.position.x;
        meP.z = hero.node.position.z;
        tickRemotes(dt);
        sendT -= dt;
        if (sendT <= 0) { sendT = 0.1; sendInput(); }
        if (endInfo && !ended) {
          ended = true;
          const e = endInfo;
          showResults(e.stats, e.victory, e);
        }
      } else {
        sim.setPlayerPos(me, hero.node.position.x, hero.node.position.z);
        // The sim may have pushed us out of a wall after a dash: follow it.
        hero.node.position.x = meP.x;
        hero.node.position.z = meP.z;
        sim.tick(dt);
      }
      retarget -= dt;
      if (retarget <= 0 || !target || target.state === "dead") {
        target = sim.nearestHostile(meP.x, meP.z, 22);
        retarget = 0.25;
      }
      view.sync(dt);
      handleEvents();
      if (sim.recall) {
        hud.tickRecall(sim.recall.t, sim.recall.total);
        // Ticks for the last five seconds.
        const sec = Math.ceil(sim.recall.t);
        if (sec <= 5 && sec !== tickSecond) { tickSecond = sec; sfx.play("recall_tick"); }
      } else tickSecond = -1;
      for (const pr of sim.projectiles) if (!seenProjectiles.has(pr.id)) { seenProjectiles.add(pr.id); sfx.play("projectile"); }
      if (seenProjectiles.size > 500) seenProjectiles.clear();
      const boss = bossId !== null ? sim.hostiles.find((h) => h.id === bossId) : null;
      hud.setBoss(boss ? bossName : null, boss ? boss.hp / boss.hpMax : 0, boss?.notches ?? []);
      hud.setDash(meP.dashCharges, 2 + (meP.boons.lucid ?? 0));
      mapT -= dt;
      if (mapT <= 0) {
        mapT = 0.125;
        hud.minimap({
          half: OLD_KOWLOON.half, grid: sim.grid, bossSquare,
          gates: sim.gatesClosed ? OLD_KOWLOON.bossGates : null,
          me: { x: meP.x, z: meP.z, yaw: hero.node.rotation.y },
          hostiles: sim.hostiles.filter((h) => !h.twinOf && (h.invisibleUntil ?? 0) <= sim.t),
          pickups: sim.pickups.map((p) => ({ x: p.x, z: p.z, hp: p.kind === "hp" || p.kind === "bigHp" })),
        });
      }
      player.setPools(Math.max(0, meP.hp), meP.hpMax, player.mana, player.manaMax);
    },
    dispose() {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("psy:survival", onNet);
      // Leaving a party run mid-way: tell the server so the others are not held.
      if (party && !ended) void fetch("/api/survival/leave", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      for (const r of remotes.values()) r.h?.node.dispose();
      announcer.dispose();
      sfx.dispose();
      music.dispose();
      hud.dispose();
      view.dispose();
      for (const b of player.buffs) if (b.id.startsWith("survival.")) player.removeBuff(b.id);
      player.manaRegenMult = 1;
    },
  };
}
