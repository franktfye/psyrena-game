/**
 * Arena combat glue — wires the fight sim to the scene.
 *
 * One function, called from the lookdev arena when the NIGHTMARE asset set
 * loaded: spawns the player's hero on the disc (resolved from the profile's
 * selectedHero through shared/heroes — Freud's GLB stands in for heroes with
 * no model yet), hands the boss's phase script to the sim, builds the action
 * bar off the HERO'S OWN kit data (slots, cooldowns, icons, the shared 1.5 s
 * GCD), and turns every cast into a homing, auto-aimed projectile whose
 * impact applies the sim's damage. The player never aims — doc 02's fight is
 * about WHEN and WHICH skill, not pointing.
 *
 * Everything combat-shaped lives in `bossFight.ts` + `shared/`; this file is
 * only allowed to know about Babylon nodes, DOM bars and window keys.
 *
 * WHOSE fight it is, is a `FightDriver` (fight/fightDriver.ts). A ranked run
 * renders the SERVER's fight — intents up, state and hooks down — while
 * practice keeps the sim in this tab. Nothing below cares which, except the
 * handful of places where the two genuinely differ; each is commented.
 */

import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";

import { ARENA } from "../core/budget";
import { heroById } from "../../shared/heroes";
import type { PaletteEntry } from "../../shared/types";
import { focusCostFor } from "../../shared/fight/costs";
import type { FanTelegraphs } from "./fanTelegraph";
import { NIGHTMARE_STANDARD } from "../../shared/bosses/nightmare";
import { petSpec } from "../../shared/progression";
import { practiceBotsFor } from "../../shared/bosses/practiceBots";
import { player } from "../state/player";
import { playCastSfx, playImpactSfx, playSfx } from "../state/sfx";
import { potionDamageMult, potionFocusRegenMult, potionHealingMult } from "../state/potions";
import { fightLoadout } from "../state/loadout";
import { ActionBar, type BarSlotDef } from "../ui/actionBar";
import { showCastWarning } from "../ui/castWarning";
import { detectControlScheme, isTypingInField } from "../ui/inputMode";
import { createCastProjectiles, type CastProjectiles } from "../vfx/projectiles";
import {
  basicProjectileStyle,
  createHeroSkillVfx,
  paletteTint,
  paletteDressing,
  ultimateTint,
  ultimateDressing,
  type HeroSkillVfx,
} from "../vfx/heroCasts";
import type { FreudCastKind } from "../vfx/freudCasts";
import { createDamageNumbers } from "../vfx/damageNumbers";
import { createAllyBars, type AllyBars } from "../ui/allyBars";
import {
  BossFight,
  type FightHooks,
  type FightSnapshot,
  type ModelingHudState,
  type PsychosocialHudState,
  type RetainedView,
} from "@shared/fight/bossFight";
import { psychosocialFaces } from "../ui/psychosocialFaces";
import { stageBannerFor } from "../ui/stageBanner";
import {
  LocalFightDriver,
  RemoteFightDriver,
  type FightDriver,
  type FightStateFrame,
  type FightResultFrame,
} from "./fightDriver";
import { wireBasicAttack } from "./basicAttack";
import { DIFFICULTY, getDifficulty } from "./difficulty";
import { getPracticeDifficulty, isPracticeMode } from "./practice";
import { postFightResult, getPartySeat, type FightResultResponse } from "../net/economy";
import { openLootResult, stashLootResult } from "../ui/lootPanel";
import { refreshImaginz, refreshProgress, refreshStance } from "../ui/playerHud";
import { BossFrame } from "./bossFrame";
import { STAGE_DETAIL } from "../ui/heroLore";
import { overTimeText, reachText } from "../ui/skillText";
import { SKILL_ICON_HEROES, loadArenaHero, stanceKey, type ArenaHero, type ArenaCastKind } from "./arenaHero";
import { VillageClient, type VillagePlayer } from "../net/village";
import { createHeroVoice, voiceKeyFor } from "../scenes/villageHub";
import { createPetSlot, petForHero } from "../scenes/petFollower";
import type { NightmareBoss } from "../scenes/nightmareBoss";

export interface ArenaCombat {
  tick(t: number, dt: number): void;
  /**
   * Set by the scene (lookdevArena): called after each attempt's result was
   * reported — with the server response, or null when the POST failed. The
   * scene uses it to spawn the 3D loot box and the return portal; the DOM
   * overlay (defeat / practice receipt) is handled here.
   */
  onFightEnd: ((result: FightResultResponse | null, win: boolean) => void) | null;
  /**
   * The player hero's live world position — the scene's return portal walks
   * against it (proximity trigger, scheme-agnostic so touch and keyboard get
   * the same portal). Read-only: treat the vector as borrowed.
   */
  heroPosition(): Vector3;
  /**
   * Join the party's arena presence session so teammates render in this
   * client's fight — where their bodies are, how they move, which gesture
   * they just played. Purely cosmetic, and deliberately separate from the
   * fight itself: the combat is one shared server sim (server/fight.mjs),
   * while this is what makes the people in it visible. Called by the scene
   * once the fight-ready barrier hands back the party's roomId. Idempotent.
   */
  wireParty(roomId: number): void;
}

/**
 * Cast refusals the player is already looking at. `refused` is the fight
 * declining to produce a cast (a gated CS button); the two timer words are
 * races against cooldowns the action bar draws itself.
 */
const SILENT_REFUSALS = new Set(["refused", "gcd", "cooling down"]);

/** Where the world-chat announcements go (main.ts exposes the chat panel). */
function announceWorld(text: string): void {
  const chat = (window as unknown as { psyrena?: { chat?: { announce?: (t: string) => void } } })
    .psyrena?.chat;
  if (chat?.announce) chat.announce(text);
  else console.info(`[world] ${text}`);
}

export async function setupArenaCombat(
  scene: Scene,
  nightmare: NightmareBoss,
  camera: ArcRotateCamera,
  heroId?: string
): Promise<ArenaCombat> {
  // The player's kit — everything below reads HERO, never a named import, so
  // the arena fights whoever the picker chose (shared/heroes/index.ts).
  const HERO = heroById(heroId);
  const script = NIGHTMARE_STANDARD;
  const headless = typeof document === "undefined";
  // Practice mode (fight/practice.ts): the other two heroes of the trio fill
  // in as bots. teamSize becomes 3, so the boss fields its 3-man HP and full
  // outgoing — the bots are calibrated to clear Standard and lose Hard and
  // Nightmare (shared/bosses/practiceBots.ts).
  const practice = isPracticeMode();
  const botSpecs = practice ? practiceBotsFor(HERO.id) : [];
  // Difficulty rides localStorage from the rooms panel: the panel and this
  // scene never meet, so storage is the whole hand-off. Practice carries its
  // OWN choice (default Standard, its own picker) so a Hard/Nightmare ranked
  // selection never silently bleeds into a learning run.
  const difficulty = practice ? getPracticeDifficulty() : getDifficulty();
  const diffSpec = DIFFICULTY[difficulty];

  // Skill voice lines, same packs as the hub/booth but ducked to 70%: in the
  // arena the VO competes with the boss's own lines and the fight OST, so the
  // hero speaks under them instead of over them.
  const voice = createHeroVoice(HERO.id, 0.7);

  // The sim owns phases from here: sheet timing (P2 = 5 × 6 s), no lookdev
  // auto-advance, no lookdev auto-kill.
  const p2 = script.phases[1];
  nightmare.setControlled(true, {
    totalS: p2.durationS,
    stageS: p2.skillCheck?.stageDurS ?? 6,
  });

  // ---- hero -----------------------------------------------------------------
  const floorR = ARENA.playableExtent * 0.45;
  const BOSS_POINT = new Vector3(0, 2.2, 0);

  // Walkable ground = the lit disc + the south spawn pad and its bridge.
  // Radii mirror buildFloatingOfficeProps in lookdevArena.ts (pad 0 sits at
  // angle -π/2 → (0, -SPAWN_R), the camera-side pad).
  const SPAWN_R = floorR + 3.6;
  const BRIDGE_INNER = floorR - 0.15;
  const BRIDGE_OUTER = SPAWN_R - 1.1;
  const BRIDGE_TOP = 0.31; // bridge box: y 0.12 + 0.38/2
  const PAD_TOP = 0.475; // pad box: y 0.2 + 0.55/2
  const DISC_R = floorR - 0.6; // same edge margin the old clamp used
  const BRIDGE_HALF = 0.7; // bridge deck is 1.55 deep
  const PAD_HALF = 1.15; // pad is 2.5 deep
  const PAD_END = SPAWN_R + 1.15;
  const terrain = {
    heightAt(x: number, z: number): number {
      const r = Math.hypot(x, z);
      if (r <= BRIDGE_INNER) return 0;
      if (r <= BRIDGE_OUTER) return BRIDGE_TOP;
      return PAD_TOP;
    },
    clamp(pos: Vector3): void {
      const r = Math.hypot(pos.x, pos.z);
      if (r <= DISC_R) return;
      // South corridor: the bridge + spawn pad live down -Z.
      if (pos.z < 0 && Math.abs(pos.x) <= PAD_HALF + 0.5) {
        const half = r > BRIDGE_OUTER ? PAD_HALF : BRIDGE_HALF;
        pos.x = Math.max(-half, Math.min(half, pos.x));
        if (-pos.z > PAD_END) pos.z = -PAD_END;
        return;
      }
      const k = DISC_R / r;
      pos.x *= k;
      pos.z *= k;
    },
  };

  // Party members share one pad, so stagger them across it by seat — every
  // client derives the same seat order from the same roster, so the three
  // heroes land on three spots and each tab draws the party in the same
  // arrangement. Solo (and practice) runs keep the exact centre spawn.
  // One offset per seat of a 3-stack (ROOM_CAP), all inside the pad's
  // PAD_HALF (1.15 m) half-width so nobody spawns into the clamp.
  const SEAT_OFFSETS = [0, -0.95, 0.95];
  // The account name is this client's identity in the server's fight too —
  // the actor rows come back named after players, not heroes.
  const myName = (
    (window as unknown as { psyrena?: { profile?: { username?: string } } }).psyrena?.profile
      ?.username ?? ""
  ).toLowerCase();
  const seat = practice || headless ? null : await getPartySeat(myName).catch(() => null);
  const spawn = new Vector3(SEAT_OFFSETS[seat?.index ?? 0] ?? 0, 0, -SPAWN_R); // ON the pad
  const hero: ArenaHero = await loadArenaHero(
    scene,
    spawn,
    Vector3.Zero(),
    camera,
    terrain,
    HERO.id
  );

  // The equipped pet comes to the boss fight too — same heel as the hub, but
  // fed the arena's ground so it stands ON the spawn pad and bridge instead
  // of wading through them. Cosmetic only: no combatant, no threat row.
  const pet = createPetSlot(scene, hero, HERO.id, {
    heightAt: (x, z) => terrain.heightAt(x, z),
  });

  // ---- practice bots ---------------------------------------------------------
  // The bots exist as sim numbers, but they stand in the arena as the real
  // rigged heroes — same glb, scale canon and clip stack as the player
  // (arenaHero.ts), just loaded with `input: false` so they never answer the
  // player's WASD or mount a second touch stick. Each bot holds a fixed
  // battle station facing the boss: tank in melee on the far side, healer at
  // cast range. Stations don't move, so the chest anchor (boss facing + P4
  // lightning endpoint) stays a static point.
  const STATION_BY_ROLE: Record<string, Vector3> = {
    tank: new Vector3(0.9, 0, 3.4),
    healer: new Vector3(-6.0, 0, -5.5),
    dps: new Vector3(6.0, 0, -5.0),
  };
  const botMarks = await Promise.all(
    botSpecs.map(async (spec, i) => {
      const name = spec.displayName.split(" — ")[0] ?? spec.displayName;
      const foot = (STATION_BY_ROLE[spec.role] ?? STATION_BY_ROLE.dps!).clone();
      foot.y = terrain.heightAt(foot.x, foot.z);
      const rig = await loadArenaHero(scene, foot, BOSS_POINT, camera, terrain, spec.heroId, {
        input: false,
        name: `bot_${i}_${spec.heroId}`,
      });
      return { name, rig, chest: new Vector3(foot.x, foot.y + 1.2, foot.z) };
    })
  );
  const botChest = new Map(botMarks.map((m) => [m.name, m.chest]));

  // Real teammates are wired later (`wireParty`, once the ready barrier hands
  // over the room), but the fight's hooks name them from the first server
  // frame — a party member's death or damage float can arrive before their
  // rig finishes loading. Both lookups are hoisted here and filled in there.
  let mateRig: (name: string) => ArenaHero | null = () => null;
  /** username (lowercase) → hero id, from the arena presence roster. */
  const mateHero = new Map<string, string>();
  /** Chest point of whichever teammate this is — bot station or live rig. */
  const teammateChest = (name: string): Vector3 | null => {
    const bot = botChest.get(name);
    if (bot) return bot;
    const rig = mateRig(name);
    return rig ? rig.node.position.add(new Vector3(0, 1.7, 0)) : null;
  };
  /**
   * Chest points of every LIVE networked teammate. Filled in by `wireParty`;
   * empty in practice and solo runs, where `botChest` is the whole party.
   *
   * Skinner's schedule casts stream to these, so before this existed his heals
   * visibly went nowhere in a real party — the ally list was built from bot
   * stations alone, and a ranked run has no bots.
   */
  let liveMateChests: () => Vector3[] = () => [];

  // Follow camera, same grammar as the village hub: the orbit target rides the
  // hero's chest (soft lerp — hard-locking bobs), the player orbits/zooms.
  // MUST be setTarget(..., cloneAlphaBetaRadius = true) — see villageHub.ts for
  // the NaN-view-matrix war story behind that flag.
  camera.lowerRadiusLimit = 3.4;
  camera.radius = 11;
  camera.setTarget(new Vector3(spawn.x, 1.55 + PAD_TOP, spawn.z), false, false, true);
  const followGoal = new Vector3();

  // ---- action bar + frame (DOM; skipped in headless soak runs) ---------------
  const touch = detectControlScheme() === "touch";
  const ICONS = SKILL_ICON_HEROES.has(HERO.id) ? `/assets/ui/skills/${HERO.id}` : null;
  /** A skill icon URL, or undefined for a hero whose icon set is not drawn yet. */
  const skillIcon = (name: string): string | undefined => (ICONS ? `${ICONS}/${name}.webp` : undefined);
  /** "freud.dream-analysis" → "dream_analysis" — the icon-file naming. */
  const slug = (id: string): string => (id.split(".").pop() ?? id).replace(/-/g, "_");
  /** "Spontaneous Recovery" → "Spontaneous\nRecovery" — two-line bar labels. */
  const wrapLabel = (name: string): string => {
    const words = name.split(" ");
    if (words.length < 2) return name;
    const mid = Math.ceil(words.length / 2);
    return `${words.slice(0, mid).join(" ")}\n${words.slice(mid).join(" ")}`;
  };
  // Buff-tile art for the sim's semantic icon keys (FightHooks.playerBuff).
  // Riders/Fixation/Team Amp have their own set; keys matching this hero's
  // E/R/F slugs reuse the bar icons instead of needing duplicate buff art.
  const BUFF_ICONS = "/assets/ui/buffs";
  // Palette slugs are included for Skinner's interval schedules: the FI/VI
  // HoT buffs key on the SKILL that armed them, so the tile reuses the bar
  // icon instead of needing duplicate buff art. Harmless for palette heroes
  // whose sub-skill slugs never appear as buff keys.
  const SKILL_BUFF_KEYS = new Set(
    [HERO.defense.id, HERO.chain.id, HERO.ultimate.id, ...HERO.palette.map((p) => p.id)].map(slug)
  );
  const buffIconUrl = (key?: string): string | undefined => {
    if (!key) return undefined;
    if (SKILL_BUFF_KEYS.has(key)) return skillIcon(key);
    return `${BUFF_ICONS}/${key}.webp`;
  };

  let bar: ActionBar | null = null;
  let frame: BossFrame | null = null;
  /** Logs a landed palette cast for variety gates; bound once the bar exists. */
  let noteStyleCast: (id: string) => void = () => {};

  // Player death: the body lies where it fell and the bar goes cold; the sim
  // allies fight on until the whole party is down (bossFight decides the loss).
  let heroDead = false;

  /**
   * Fight-over routing. Victory keeps you in the arena with NO overlay when
   * the server awarded a cache — the result is stashed and the scene's 3D
   * loot box beside the dead boss is the whole collect flow (tap it → panel;
   * leave without tapping → the hub's unclaimed-cache prop has it). Cacheless
   * wins (practice receipt, failed POST) still get the overlay, or the win
   * would be silent. Defeat returns the party to the village FIRST, then pops
   * the result overlay (a DOM panel, so it survives the scene switch).
   */
  const finishAttempt = (res: FightResultResponse | null, win: boolean): void => {
    // The server says so once, on the win that earned it.
    if (res?.heroUnlocked) {
      announceWorld(
        `${heroById(res.heroUnlocked).displayName} joins your roster — pick them from the hero list.`
      );
    }
    if (!headless) {
      if (win) {
        if (res?.lootBox) stashLootResult(res, true);
        else openLootResult(res, true);
      } else {
        const go = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } })
          .psyrena?.go;
        if (typeof go === "function") {
          void Promise.resolve(go("village"))
            .catch(() => {})
            .then(() => openLootResult(res, false));
        } else {
          openLootResult(res, false);
        }
      }
    }
    combat.onFightEnd?.(res, win);
  };

  // The conditioning hook lands before the bar exists — late-bind it.
  let onConditioning: ((s: { conditioned: boolean }) => void) | null = null;
  // Same late-bind for Skinner's operant toggles (E/R quadrant faces).
  let onOperant:
    | ((s: { contingency: "positive" | "negative"; consequence: "reinforcement" | "punishment" }) => void)
    | null = null;
  // …and for Erikson's rotation (keys 1/2/LMB relabel on every press).
  let onPsychosocial: ((s: PsychosocialHudState) => void) | null = null;
  /** Erikson's rotation as last reported — keys the stage-specific VO lines. */
  let lastPsycho: PsychosocialHudState | null = null;
  // …and for Bandura's retention slots (keys 1-4 wear the copied skills).
  let onModeling: ((s: ModelingHudState) => void) | null = null;

  // Gear set bonus + equipped-pet stats, resolved once at fight start — same
  // read-once contract as the potions. The pet Focus stat is client-side
  // (the Focus pool lives in the player store, not the sim), so it applies
  // here rather than through the BossFight param. `petId` is the ONE pet
  // resolution for this fight: the loadout, the follower slot, and the ranked
  // `begin` declaration all read it, so local and server stats agree.
  const equippedPetId = petForHero(HERO.id);
  const loadout = fightLoadout(HERO.id, equippedPetId);
  // Pet Focus stat × a Cold Brew from the Coffee Shop (server fights apply the cup in server/fight.mjs).
  player.manaRegenMult = loadout.focusRegen * potionFocusRegenMult();

  // The loadout as HUD tiles, beside the potion buffs — without these, a gear
  // or pet upgrade is invisible outside the damage floats. Fight-scoped:
  // neither ever times out, so the dispose hook below buries both.
  const gearPct = Math.round((loadout.gear - 1) * 100);
  if (gearPct > 0) {
    player.applyBuff({
      id: "loadout.gear",
      name: `Armor Set +${gearPct}%`,
      icon: "/assets/ui/gear/gear.webp",
      kind: "buff",
      durationMs: Infinity,
      desc: `Armor set bonus: every hit you deal is increased ${gearPct}%. The set reads your LOWEST armor slot — upgrade evenly.`,
    });
  }
  const petBoosts = (
    [
      ["HP", loadout.hpMult],
      ["damage", loadout.petDamage],
      ["healing", loadout.petHealing],
      ["Focus regen", loadout.focusRegen],
    ] as const
  )
    .filter(([, m]) => m > 1)
    .map(([label, m]) => `${label} +${Math.round((m - 1) * 100)}%`);
  if (equippedPetId && petBoosts.length > 0) {
    player.applyBuff({
      id: "loadout.pet",
      name: `${petSpec(equippedPetId)?.name ?? "Pet"} — ${petBoosts.join(" · ")}`,
      icon: `/assets/ui/pets/${equippedPetId}.webp`,
      kind: "buff",
      durationMs: Infinity,
      desc: "Your equipped pet's passive boost. Level it up at the Pet Park.",
    });
  }

  /**
   * The presentation event stream, and the reason the server fight was a
   * retrofit rather than a rewrite: this object is what the local sim calls,
   * and it is ALSO what `RemoteFightDriver` replays the server's events into.
   * Every VFX/SFX/HUD path below it is identical in both modes.
   */
  // Ground fans (the dodgeable sweep): drawn here, landed here, and reported
  // by this client for its own hero only — see fight/fanTelegraph.ts.
  // Lazy (CLAUDE.md rule 2): the arena is in the boot chunk, the decals need not be.
  let fans: FanTelegraphs | null = null;
  if (!headless) void import("./fanTelegraph").then((m) => (fans = m.createFanTelegraphs(scene)));
  const BOSS_FLOOR = new Vector3(0, 0, 0);

  const hooks: FightHooks = {
    conditioningChanged: (s) => onConditioning?.(s),
    operantChanged: (s) => onOperant?.(s),
    psychosocialChanged: (s) => onPsychosocial?.(s),
    modelingChanged: (s) => onModeling?.(s),
    announce: announceWorld,
    setBossPhase: (p) => {
      // The two audible entrances: idle→p1 is the pull the countdown was
      // building to, p3 is the armor slamming on.
      if (p === "p1") playSfx("fight.boss.engage");
      else if (p === "p3") playSfx("boss.armor.up");
      nightmare.setPhase(p);
    },
    // Real outgoing hits drive the boss's attack animation (P1 swings face
    // the hate target; P4 AOE = blast + boss→hero lightning).
    bossStrike: (targets) => {
      playSfx(targets === "all" ? "boss.terror.aoe" : "boss.melee.swing");
      nightmare.strike(targets === "all");
    },
    bossFan: (f) => {
      if (!fans) return;
      // Aimed once, at where the target stands NOW — it never tracks.
      const aim = f.targetIsPlayer ? hero.node.position : (teammateChest(f.targetName) ?? hero.node.position);
      const at = new Vector3(aim.x, 0, aim.z);
      nightmare.sweep(at, f.wide);
      playSfx("boss.fan.windup");
      fans.cast(f, BOSS_FLOOR, at, (inside) => {
        nightmare.sweep(null, f.wide);
        playSfx(f.wide ? "boss.fan.land.wide" : "boss.fan.land");
        if (!heroDead && inside(hero.node.position)) driver.fanHit(f.id);
      });
    },
    // Sim-only beats → sounds. The sim names the moment, this table names
    // the file — kit sub-events and boss telegraphs share one channel.
    sfxEvent: (name) =>
      playSfx(
        (
          {
            "vr.jackpot": "skinner.variable-ratio.jackpot",
            "skillcheck.correct": "boss.skillcheck.correct",
            "skillcheck.wrong": "boss.skillcheck.wrong",
            "hot.tick": "skinner.hot.tick",
            "operant.proc": "skinner.proc",
            shapeshift: "boss.shapeshift",
            "phase.warning": "fight.phase.warning",
          } as const
        )[name]
      ),
    damagePlayer: (n) => player.damage(n),
    healPlayer: (n) => player.heal(n),
    // Damage-taken floats for EVERY hero — red, over the head that took it.
    combatantDamaged: (name, amount, isPlayer) => takenFloatRef?.(name, amount, isPlayer),
    // Heal floats for EVERY hero — green, over the head that got topped up,
    // self and practice bots alike. Floats the EFFECTIVE amount (overheal
    // became Amp upstream), so it never shows a +N the HP bar didn't gain.
    combatantHealed: (name, effective, _attempted, isPlayer) =>
      healFloatRef?.(name, effective, isPlayer),
    combatantDied: (name, isPlayer) => {
      playSfx("fight.player.death");
      if (isPlayer) {
        heroDead = true;
        hero.die();
        return;
      }
      // Somebody else went down: a practice bot on its station, or — in a
      // server fight — a real teammate, whose body has to lie there on MY
      // screen too, or a party wipe reads as everyone disconnecting.
      (botMarks.find((m) => m.name === name)?.rig ?? mateRig(name))?.die();
    },
    // Bot GCD casts drive the rigs — a heal reads as the chain/meditate
    // gesture, everything else as the throw, same clips the player's own
    // cast() picks from.
    allyCast: (name, action) => {
      botMarks.find((m) => m.name === name)?.rig.cast(action === "heal" ? "chain" : "palette");
    },
    // The Shapeshift-wound bleed, floated with its name — the P3 counter
    // must read as damage, not as a mysteriously sagging boss HP bar.
    dotTick: (label, amount) => dotFloatRef?.(label, amount),
    playerBuff: (name, durationMs, kind = "buff", icon, id, desc) =>
      // Stack counts ride the NAME ("Team Amp +30%", "Approximation 3/5",
      // "Response Strength 4/10 — basic +80%"); the id must stay stable
      // across refreshes or every count change spawns a second tile — so
      // both the trailing "+N%" and any " N/M…" tail are stripped. A sim-
      // supplied id wins outright (the operant quadrant renames on flip).
      player.applyBuff({
        id: `fight.${id ?? name.replace(/ \d+\/\d+.*$/, "").replace(/ \+[\d.]+%$/, "")}`,
        name,
        durationMs,
        kind,
        icon: buffIconUrl(icon),
        desc,
      }),
    gainFocus: (n) => player.restoreMana(n),
    // Rider procs float over the boss like the damage ticks, slow-fade.
    // Bound once the DOM layer exists (same pattern as showBeatRef).
    defenseProc: (procName) => procFloatRef?.(procName),
    lockPaletteSlot: (i, ms) => {
      const entry = HERO.palette[i];
      if (entry) bar?.lockSlot(entry.id, ms);
    },
    playerHitReaction: () => hero.hit(),
    // Attempt over → report to the server, then show the loot overlay and
    // let the scene spawn the 3D cache. Fire-and-forget: a network failure
    // downgrades the overlay to "rewards unavailable", never breaks combat.
    fightEnd: (stats) => {
      playSfx(stats.win ? "fight.victory" : "fight.defeat");
      // A ranked fight on the server pays itself: server/fight.mjs settles from
      // its own stat block and pushes the receipt down this same stream, ahead
      // of the end event that got us here. Reporting again would be asking to
      // be paid twice, and the server refuses it. Practice runs and the offline
      // fallback still report — nobody else holds their numbers.
      const settled = driver.settlement();
      if (settled) {
        refreshImaginz(settled.balance);
        refreshProgress(settled);
        finishAttempt(settled, stats.win);
        return;
      }
      void postFightResult({
        win: stats.win,
        difficulty,
        durationMs: Math.round(stats.durationMs),
        dps: Math.round(stats.dps * 10) / 10,
        healing: Math.round(stats.healing),
        damageTaken: Math.round(stats.damageTaken),
        // Practice runs pay a small fixed award (capped per day) and touch
        // none of the ranked records — server/economy.mjs branches on this.
        practice,
      })
        .then((res) => {
          refreshImaginz(res.balance);
          // The fight response already carries the new level/XP, so the bar
          // moves the moment the kill lands — no extra round-trip.
          refreshProgress(res);
          finishAttempt(res, stats.win);
        })
        .catch(() => {
          finishAttempt(null, stats.win);
        });
    },
  };

  // The sim in this tab. Practice fights it; a ranked run keeps it built but
  // untouched, as the fallback the remote driver drops to if the server fight
  // cannot be opened (see fightDriver.ts). A practice run fields the two bots,
  // so the boss fields its full 3-man script; ranked passes none, because the
  // server's fight is where real teammates now live.
  const fight = new BossFight(
    script,
    HERO,
    botSpecs,
    hooks,
    { hpMult: diffSpec.hpMult, dmgMult: diffSpec.dmgMult },
    // Coffee Shop potions (24 h account buffs): read once at fight start —
    // a cup that expires mid-attempt keeps its kick until the report.
    { damage: potionDamageMult(), healing: potionHealingMult() },
    // Gear set bonus + the equipped pet's stats (docs/09), read once the same
    // way. Exclusivity is checked against the hero actually fighting.
    loadout
  );
  const local = new LocalFightDriver(fight, HERO);

  // Ranked runs render the SERVER's fight — one boss for the whole party, and
  // no number this client can forge. The social stream is already open and
  // already carries the frames, so the driver borrows it rather than opening a
  // second EventSource; without it (headless soak, a stream that never came
  // up) there is nothing to render a remote fight FROM, so the local sim
  // stands in. Practice never goes near the server: there is no session for a
  // learning pit, and its bots only exist in this tab.
  const social = (
    window as unknown as {
      psyrena?: {
        social?: {
          onFightState(cb: (f: unknown) => void): () => void;
          onFightResult(cb: (r: unknown) => void): () => void;
        };
      };
    }
  ).psyrena?.social;
  const driver: FightDriver =
    practice || headless || !social
      ? local
      : new RemoteFightDriver({
          hero: HERO,
          difficulty,
          // The equipped pet still lives in client storage, so it is the one
          // thing `begin` has to be told (server/fight.mjs loadoutFor).
          petId: equippedPetId,
          subscribe: (cb) => social.onFightState((f) => cb(f as FightStateFrame)),
          subscribeResult: (cb) => social.onFightResult((r) => cb(r as FightResultFrame)),
          local,
          hooks,
        });
  scene.onDisposeObservable.add(() => driver.dispose());

  // World anchors for the boss: `aim` = the hate target's chest (P1 swing
  // facing + the P4 stare), `heroes` = every living hero's chest (P4
  // lightning endpoints). The player's point is live (they move); practice
  // bots sit on their stations. With no bots both resolve to the player —
  // the P4 volley degrades to a single bolt, at them specifically.
  // Reads ride the last snapshot — one frame stale at most.
  let lastSnap: FightSnapshot | null = null;
  const aimScratch = new Vector3();
  nightmare.setCombatAnchors({
    aim: () => {
      const top = lastSnap?.threat.find((r) => r.alive);
      if (!top) return null;
      // `isPlayer` marks the sim's PRIMARY actor, which in a server-run party
      // is whoever took the first seat. Only my account name means me there;
      // offline the rows are named after heroes and isPlayer is exact.
      if (driver.remote ? top.name.toLowerCase() === myName : top.isPlayer) {
        aimScratch.copyFrom(hero.node.position);
        aimScratch.y += 1.3;
        return aimScratch;
      }
      return teammateChest(top.name);
    },
    heroes: () => {
      const pts = heroDead ? [] : [hero.node.position.add(new Vector3(0, 1.3, 0))];
      for (const a of lastSnap?.allies ?? []) {
        if (!a.alive) continue;
        const p = teammateChest(a.name);
        if (p) pts.push(p);
      }
      return pts;
    },
  });

  // Boss model → sim, and only in the offline fight. The local sim has no
  // stage clock: it learns which form the boss wears from the model that is
  // drawing it, which is the presentation layer holding the answer key. The
  // server owns the phase, so a ranked run runs this the other way round —
  // `tick` below pushes `snap.p2Stage` INTO the model.
  // Preserve whatever onPhase the arena already set (ring tint etc.).
  const prevOnPhase = nightmare.onPhase;
  nightmare.onPhase = (phase, detail) => {
    prevOnPhase?.(phase, detail);
    if (driver.remote) return;
    if (phase === "p2" && detail) {
      const m = /stage (\d+)/.exec(detail);
      if (m) driver.notifyP2Stage(Number(m[1]) - 1);
    }
  };

  // The 3-beat cycle: Id → Ego → Superego, advanced by a CLOCK (doc 02 —
  // "basic attacks cycle automatically"). It used to step on each basic attack
  // and on Tab, which made the payoff beat something a player could hold
  // rather than time; the boss-math sheet assumes half of skill casts land on
  // it, and that assumption only holds against a clock. The clock itself now
  // sits inside the driver — offline it is this tab's, in a ranked run it is
  // the server's, and a beat a client could re-roll is a beat that pays.
  let beat = driver.self().beat;
  // Set once the HUD exists; headless runs still advance the beat, silently.
  let showBeatRef: (() => void) | null = null;
  // Rider-proc floating text — set with the damage numbers; null in headless.
  let procFloatRef: ((text: string) => void) | null = null;
  // Wound-DoT ticks (number + skill name) and damage-taken floats — same deal.
  let dotFloatRef: ((label: string, amount: number) => void) | null = null;
  let takenFloatRef: ((name: string, amount: number, isPlayer: boolean) => void) | null = null;
  // Green +N over whichever head the heal landed on — player or practice bot.
  let healFloatRef: ((name: string, amount: number, isPlayer: boolean) => void) | null = null;
  // Thin HP bars over the bot teammates — mounted only for a healer-role hero.
  let allyBars: AllyBars | null = null;

  // The fight pools the player's vitals from the (assumed) hero HP, scaled by
  // the pet HP stat exactly as the sim scales its own actor (bossFight
  // makeActor) — otherwise the bar empties while the actor still stands, and
  // the pet boost never shows. Ranked runs overwrite this with the server's
  // pools (setPools below), which carry the same term.
  player.setVitals(Math.round(script.heroHp * loadout.hpMult));

  if (!headless) {
    // Skinner's schedule casts stream to every living teammate — the same
    // chest anchors the ally bars and the boss's chain lightning use.
    const skillFx = createHeroSkillVfx(scene, hero.node, HERO.id, () => {
      const pts: Vector3[] = [];
      for (const a of lastSnap?.allies ?? []) {
        if (!a.alive) continue;
        const p = botChest.get(a.name);
        if (p) pts.push(p);
      }
      // Real teammates are not in `botChest` — in a ranked party there are no
      // bots at all, so without this the stream had nowhere to go. Their
      // liveness is the rig being enabled rather than the snapshot's `alive`:
      // the two agree, and the rig is the thing the stream has to reach.
      pts.push(...liveMateChests());
      return pts;
    });
    const projectiles = createCastProjectiles(scene, hero.node);
    const dmgNumbers = createDamageNumbers(scene);
    procFloatRef = (text) => dmgNumbers.spawnText(BOSS_POINT, text);
    dotFloatRef = (label, n) => dmgNumbers.spawnDot(BOSS_POINT, n, label);
    takenFloatRef = (name, n, isPlayer) => {
      const at = isPlayer ? hero.node.position.add(new Vector3(0, 1.7, 0)) : teammateChest(name);
      if (at) dmgNumbers.spawn(at, n, false, "taken");
    };
    healFloatRef = (name, n, isPlayer) => {
      const at = isPlayer ? hero.node.position.add(new Vector3(0, 1.7, 0)) : teammateChest(name);
      if (at) dmgNumbers.spawn(at, n, false, "heal");
    };

    // The healer's field readout: every teammate wears a thin HP bar above
    // their head, up for the whole fight. Role-gated — the tank and DPS play
    // watching the boss; the healer plays watching the party.
    if (HERO.role === "healer" && botMarks.length > 0) {
      allyBars = createAllyBars(
        scene,
        new Map(botMarks.map((m) => [m.name, m.chest.add(new Vector3(0, 0.85, 0))]))
      );
    }

    // The cost table used to be a literal right here, which is precisely why a
    // client could cast for free — it now lives in shared/fight/costs.ts and
    // the server charges from the same function. A stance stays free by
    // definition (`ThreatStance.toggle`), which is also what lets a
    // Focus-starved hero drop aggro, exactly when they need it most.
    const focusCost = (slot: BarSlotDef): number =>
      focusCostFor(
        HERO,
        slot.kind,
        slot.kind === "palette" ? HERO.palette.findIndex((p) => p.id === slot.id) : undefined
      );

    // ---- slot text, composed from the kit's own data -----------------------
    const BASIC_LABEL: Record<string, string> = {
      freud: "Id\nAttack",
      pavlov: "NS\nBell",
      skinner: "Response\nRate",
      // Repainted from the rotation on mount — see onPsychosocial below.
      erikson: "Significant\nRelations",
      ainsworth: "Sensitivity",
      piaget: "Assimilation",
      bandura: "Modeled\nAggression",
    };
    /** The plain shared effect kinds (bossFight applySharedEffects), in words. */
    const sec = (e: { durationMs?: number }): number => (e.durationMs ?? 0) / 1000;
    const sharedBit = (e: { kind: string; magnitude?: number; durationMs?: number; target?: string }): string | null => {
      if (!e) return null;
      const pct = Math.round((e.magnitude ?? 0) * 100);
      switch (e.kind) {
        case "mitigation.grant":
          return `${e.target === "team" ? "the team takes" : "you take"} ${pct} percent less damage for ${sec(e)} sec`;
        case "taunt":
          return `the boss locks onto you for ${sec(e)} sec`;
        case "team.cleanse":
          return "lifts Fixation off every teammate";
        case "team.amp":
          return `the whole team deals ${pct} percent more damage for ${sec(e)} sec`;
        case "threat.drop":
          return `you shed ${pct} percent of your threat`;
        case "self.stagger":
          return `for ${sec(e)} sec, hits you take bleed out over ${e.magnitude ?? 4} sec instead of landing at once`;
        case "heal.cut.self":
          return `healing on you is cut ${pct} percent for ${sec(e)} sec`;
        case "team.immunity":
          return `every other teammate is immune to the boss for ${sec(e)} sec (not you)`;
        case "vulnerability":
          return `the boss takes ${pct} percent more damage for ${sec(e)} sec`;
        case "heal.hot":
          return `heals the most wounded teammate ${e.magnitude} over ${sec(e)} sec`;
        case "heal.single":
          return `heals the most wounded teammate ${e.magnitude}, and nobody else`;
        case "conservation":
          return `shares the team's health out evenly (the same total, a new shape), then heals the team ${e.magnitude}`;
        case "shield.team":
          return `shields the team for ${e.magnitude} in total, absorbing damage for ${sec(e)} sec; what is left becomes team Amp`;
        case "ally.undying":
          return `the most wounded teammate cannot drop below 1 health for ${sec(e)} sec, then is healed ${e.magnitude}`;
        case "decoy":
          return `the boss's single-target blows hit the doll for ${sec(e)} sec, and it rebounds ${pct} percent of them`;
        default:
          return null;
      }
    };
    /** "age.toddler" → "a toddler": the forms in the P2 announcements' words. */
    const FORM_WORDS: Record<string, string> = {
      "age.infant": "an infant",
      "age.toddler": "a toddler",
      "age.child": "a child",
      "age.school": "a schoolchild",
      "age.adolescent": "an adolescent",
    };
    const paletteTooltip = (p: PaletteEntry): string => {
      // Several forms per button (Piaget's stages): the heal in words, then
      // which Shapeshift forms the stage answers.
      if (p.answersTags) {
        const what = p.effects.map(sharedBit).filter(Boolean);
        const forms = p.answersTags.map((t) => FORM_WORDS[t] ?? t).join(" or ");
        const head = p.base > 0 ? [`Deals ${p.base} damage`, ...what] : what;
        return `${p.name}. ${[...head, `places a ${p.markType.charAt(0).toUpperCase()}${p.markType.slice(1)} Mark`].join("; ")}. While the boss shapeshifts: the correct answer when it takes the form of ${forms}.`;
      }
      // Bandura's retention slots: what the slot holds is the model's.
      if (p.effects.some((e) => e.kind === "modeling.reproduce") && HERO.modeling) {
        const m = HERO.modeling;
        return `${p.name}. Holds a copy of a skill your model cast. Press to reproduce it: ${Math.round(p.base * m.motivatedMult)} if the model was rewarded for it (a crit or a right answer), ${Math.round(p.base * m.unmotivatedMult)} if not, with the original's effects. A copied heal heals instead. Empty, it rehearses for ${Math.round(p.base * m.emptyMult)}. Copies fade after ${m.retentionMs / 1000} sec.`;
      }
      if (p.answersAxis) {
        // Human words, not the internal answer tag — STAGE_DETAIL mirrors the
        // P2 form announcements ("NIGHTMARE takes the form of an infant…").
        return `${p.name}. Deals ${p.base} damage and places an Analysis Mark. While the boss shapeshifts: the correct answer when it takes the form of ${STAGE_DETAIL[p.id]?.form ?? "this stage"} — outside the transformation no stage is wrong.`;
      }
      // Erikson's two keys: the rotation, in one sentence each.
      const ps = HERO.psychosocial;
      if (ps && p.effects.some((e) => e.kind === "psychosocial.stage"))
        return `${p.name}. Deals ${p.base} damage and casts the current life stage, arming its virtue (key 2). One add-on basic attack follows.`;
      if (ps && p.effects.some((e) => e.kind === "psychosocial.virtue"))
        return `${p.name}. After key 1: deals ${p.base} damage, completes the stage and banks a virtue for Life Review. Without a stage armed it deals only ${Math.round(p.base * ps.unmatchedVirtueMult)}. One add-on basic attack follows.`;
      // Skinner's schedules deal nothing — say what each delivery contract
      // pays, with the numbers read off the spec so they cannot go stale.
      const rf = HERO.reinforcement;
      if (rf) {
        const s = rf.schedules;
        const SCHEDULE_TIP: Record<string, string> = {
          "schedule.fixed-ratio": `${p.name}. Heals the whole team ${s.fixedRatio.teamTotal}, split evenly. Every cast, the same pellet, zero variance.`,
          "schedule.variable-ratio": `${p.name}. Heals the most wounded teammate (you count): ${Math.round(s.variableRatio.highChance * 100)} percent chance of a ${s.variableRatio.high} JACKPOT, otherwise ${s.variableRatio.low}. Same average as Fixed Ratio. You will press it anyway.`,
          "schedule.fixed-interval": `${p.name}. Heals the team ${s.fixedInterval.tickTeamTotal} every ${s.fixedInterval.periodMs / 1000} sec for ${s.fixedInterval.durationMs / 1000} sec — payout on the clock. Stacks with itself, up to ${s.maxStacks} windows.`,
          "schedule.variable-interval": `${p.name}. For ${s.variableInterval.durationMs / 1000} sec the team is healed ${s.variableInterval.tickTeamTotal} at random moments. Stacks with itself, up to ${s.maxStacks} windows.`,
        };
        const tip = p.effects.map((e) => SCHEDULE_TIP[e.kind]).find(Boolean);
        if (tip) return tip;
      }
      // Chain-kit entries answer nothing; say what their riders actually do.
      const bits = [`Deals ${p.base} damage`];
      if (HERO.kit === "palette") bits.push(`places a ${p.markType.charAt(0).toUpperCase()}${p.markType.slice(1)} Mark`);
      for (const e of p.effects) {
        const shared = sharedBit(e);
        if (shared) bits.push(shared);
        else if (e.kind === "ucr.window")
          bits.push(`opens the ${(e.durationMs ?? 0) / 1000} s UCR window — ring the bell into it to bank a Pairing`);
        else if (e.kind === "pairing.focus")
          bits.push(`returns ${e.magnitude ?? 0} Focus for every pairing that lands — a missed window pays none`);
        else if (e.kind === "mark.grant") bits.push(`places ${e.magnitude ?? 1} Conditioning Marks`);
        else if (e.kind === "conditioned-response.stagger")
          bits.push("teaches the Conditioned Response — Anticipation-beat bells stagger the boss");
      }
      if (p.requiresVariety)
        bits.push(`needs ${p.requiresVariety.distinct} different styles cast in the last ${p.requiresVariety.withinMs / 1000} sec`);
      if (p.cooldownMs) bits.push(`${p.cooldownMs / 1000} sec cooldown`);
      return `${p.name}. ${bits.join("; ")}. ${overTimeText(p)}`.trim();
    };
    const defenseTooltip = (): string => {
      const a = HERO.defense;
      const bits: string[] = [];
      if (a.heal) bits.push(`Heals ${a.heal}${a.healTarget === "team" ? ", split across the team" : ""}`);
      if (a.mitigation)
        bits.push(
          `reduces damage taken by ${Math.round(a.mitigation.magnitude * 100)} percent for ${a.mitigation.durationMs / 1000} sec${a.mitigation.target === "team" ? " (whole team)" : ""}`
        );
      for (const e of a.effects) {
        const shared = sharedBit(e);
        if (shared) bits.push(shared);
      }
      const RIDER_LINE: Record<string, string> = {
        freud: "One of six mechanisms rides along at random.",
        pavlov: "After Extinction, the rest period restores one free Pairing.",
      };
      return `${a.name}. ${bits.join(" and ")}. ${RIDER_LINE[HERO.id] ?? ""}`.trim();
    };
    const chainTooltip = (): string => {
      const a = HERO.chain;
      const bits = a.base > 0 ? [`Deals ${a.base} damage${reachText(a)}`] : [];
      for (const e of a.effects) {
        if (e.kind === "palette.auto-correct")
          bits.push("your next 3 stage casts cannot be wrong, though their Marks count at half value");
        else if (e.kind === "taunt") bits.push(`taunts the boss for ${(e.durationMs ?? 0) / 1000} sec`);
        else if (sharedBit(e)) bits.push(sharedBit(e)!);
      }
      return `${a.name}. ${bits.join("; ")}. ${overTimeText(a)}`.trim();
    };
    const ultimateTooltip = (): string => {
      const u = HERO.ultimate;
      // Skinner's cash-out is ally-side: Approximations, not boss Marks.
      if (HERO.reinforcement) {
        const s = HERO.reinforcement;
        return `${u.name}. The holo pigeon hops teammate to teammate, healthiest first, each landing bigger: heals the team ${u.heal} plus ${s.shaping.perApproximation} for every Approximation consumed (cap ${s.approximation.capPerAlly} per ally). Overheal becomes team Amp.`;
      }
      if (HERO.psychosocial) {
        return `${u.name}. Deals ${u.base} damage plus ${u.perMark} for every virtue you have banked (up to ${u.maxMarksConsumed}), then spends them. The stages carry on where they were.`;
      }
      const eq = u.effects.find((e) => e.kind === "equilibration.release");
      const bits = eq
        ? [`Heals the team ${u.heal ?? 0} plus ${eq.magnitude} for every Mark consumed, up to ${u.maxMarksConsumed} Marks`]
        : [`Deals ${u.base} damage plus ${u.perMark} for every Mark consumed, up to ${u.maxMarksConsumed} Marks`];
      if (u.heal && !eq) bits.push(`heals the team for ${u.heal}`);
      for (const e of u.effects) {
        if (e.kind === "zone.extinction")
          bits.push(
            `drops a dome — the boss deals ${Math.round((e.magnitude ?? 0) * 100)} percent less to everyone inside for ${(e.durationMs ?? 0) / 1000} sec`
          );
        else if (e.kind === "conditioning.reset")
          bits.push("extinguishes his own conditioning: Pairings and CS reset");
        else if (sharedBit(e)) bits.push(sharedBit(e)!);
      }
      return `${u.name}. ${bits.join("; ")}.`;
    };

    // Both schemes get the basic slot: desktop casts it via LMB + the bar row,
    // touch via the big corner button (ActionBar mounts a "basic" slot there).
    const BASIC_ID = HERO.basic.id;
    // A transforming entry (Pavlov's CS) shares its base ability's button and
    // key instead of mounting its own slot — resolved here, swapped by the
    // sim's conditioningChanged hook below. The base may be a palette entry
    // or the BASIC attack: CS rides the bell (2026-08-08), so a conditioned
    // boss turns the attack button itself into the payoff and the UCS button
    // never changes face.
    const transformEntry = HERO.palette.find((p) => p.transformsFrom);
    const transformsBasic = transformEntry?.transformsFrom === BASIC_ID;
    const transformBase =
      transformEntry && !transformsBasic
        ? HERO.palette.find((p) => p.id === transformEntry.transformsFrom)
        : undefined;
    const mountedPalette = HERO.palette.filter((p) => !p.transformsFrom);
    const paletteSlotDef = (p: PaletteEntry, key: string): BarSlotDef => ({
      id: p.id,
      key,
      label: p.name.replace(" Stage", "").split(" — ")[0] ?? p.name,
      tooltip: paletteTooltip(p),
      icon: skillIcon(slug(p.id)),
      // 3 s per stage, on top of the shared 1.5 s GCD — the bar shows
      // whichever keeps the slot dark longer. An entry with its own cooldown
      // (Ainsworth's Disorganized, 30 s) shows that instead.
      cooldownMs: p.cooldownMs ?? 3_000,
      kind: "palette" as const,
    });
    const slots: BarSlotDef[] = [
      {
        id: BASIC_ID,
        key: "lmb",
        label: BASIC_LABEL[HERO.id] ?? "Attack",
        tooltip: HERO.psychosocial
          ? `Add-on attack. Deals ${HERO.basic.base} damage, once after each key 1 or key 2. Named for the people who matter at the current stage. Left click.`
          : HERO.beats
            ? `Basic attack. Deals ${HERO.basic.base} damage and rides the current beat. Left click.`
            : `Basic attack. Deals a flat ${HERO.basic.base} damage. Left click.`,
        cooldownMs: HERO.basic.cooldownMs,
        kind: "basic" as const,
        flat: HERO.beats === undefined,
        // A basic that transforms (Pavlov's NS ⇄ CS) wears palette geometry
        // on the desktop row — icon face, 44 px square — so the CS swap is a
        // repaint of the same shape. Touch ignores both: circle, text face.
        ...(transformsBasic
          ? { paletteFace: true, icon: skillIcon(slug(BASIC_ID)) }
          : {}),
      },
      ...mountedPalette.map((p, i) => paletteSlotDef(p, String(i + 1))),
      // The threat stance, if the hero has one. Key "4" rather than Tab: Tab
      // is the browser's focus-walk key, and preventDefault-ing it inside a
      // canvas game fights the page for a binding the player cannot see. "4"
      // is free — Pavlov mounts a single palette button, so 2/3/4/5 are all
      // unused — and it sits where a fourth skill would. A kit that fills
      // 1-4 itself (Ainsworth's four styles) takes the next free number.
      ...(HERO.threatStance
        ? [
            {
              id: HERO.threatStance.id,
              key: stanceKey(mountedPalette.length),
              label: wrapLabel(HERO.threatStance.name),
              tooltip: `${HERO.threatStance.name}. Toggle: while held you bank ${HERO.threatStance.multiplier}x threat per point of damage, so the boss looks at you. Drop it to hand that attention away. Free, no cooldown.`,
              icon: skillIcon(slug(HERO.threatStance.id)),
              cooldownMs: 0,
              kind: "stance" as const,
            },
          ]
        : []),
      {
        id: HERO.defense.id,
        key: "e",
        label: wrapLabel(HERO.defense.name),
        tooltip: defenseTooltip(),
        // A reinforcement kit's E/R buttons are ACTION faces (they wear the
        // state a press switches to) — the operantChanged hook repaints these
        // immediately, but the mount face must still be a file that exists.
        // The sim opens Positive/Reinforcement, so the buttons offer the
        // opposites.
        icon: HERO.reinforcement
          ? skillIcon("contingency_negative")
          : skillIcon(slug(HERO.defense.id)),
        cooldownMs: HERO.defense.cooldownMs,
        kind: "defense",
      },
      {
        id: HERO.chain.id,
        key: "r",
        label: wrapLabel(HERO.chain.name),
        tooltip: chainTooltip(),
        icon: HERO.reinforcement
          ? skillIcon("consequence_punishment")
          : skillIcon(slug(HERO.chain.id)),
        cooldownMs: HERO.chain.cooldownMs,
        kind: "chain",
      },
      {
        id: HERO.ultimate.id,
        key: "f",
        label: wrapLabel(HERO.ultimate.name),
        tooltip: ultimateTooltip(),
        icon: skillIcon(slug(HERO.ultimate.id)),
        cooldownMs: HERO.ultimate.cooldownMs,
        kind: "ultimate",
      },
    ];

    bar = new ActionBar(
      slots,
      (slot) => {
        // The dead don't cast — the bar stays mounted but goes inert.
        if (heroDead) return;
        // A stance is not a cast: no facing, no animation, no Focus, no
        // projectile. It flips a sim flag and repaints the button, and it
        // returns BEFORE any of the cast machinery below runs.
        if (slot.kind === "stance") {
          playCastSfx(slot.id);
          toggleStance();
          return;
        }
        // Skinner's E/R quadrant toggles: free flips (no facing, no Focus, no
        // projectile — `freeOfGcd` already kept the GCD out of it). The sim
        // flips its state and reports through `operantChanged`, which repaints
        // both faces; the flick animation + VFX are the press feedback.
        if (HERO.reinforcement && (slot.kind === "defense" || slot.kind === "chain")) {
          hero.cast(slot.kind);
          partyNet?.sendCast(slot.id, slot.kind);
          voice.cast(slot.id);
          playCastSfx(slot.id);
          skillFx.cast(slot.kind, slot.id);
          void driver.cast(slot.kind);
          return;
        }
        // Auto-aim: every cast squares the hero onto the boss first.
        hero.faceTarget(BOSS_POINT);
        hero.cast(slot.kind, slot.id);
        // Teammates' clients play the same gesture (cosmetic only — their
        // sims resolve nothing from it).
        partyNet?.sendCast(slot.id, slot.kind);
        // Packs carry no basic-attack lines and cast() no-ops on an unmapped
        // id, so this fires for every slot without a kind check — exactly the
        // hub's setupSkillBar contract. Erikson's 1/2 key on the stage they
        // cast (`voiceKeyFor`), read before the cast moves the rotation; the
        // same key tells his skill VFX which stage to light, and the centre
        // banner flashes the stage or virtue.
        const castKey = voiceKeyFor(HERO, slot.id, lastPsycho);
        voice.cast(castKey);
        playCastSfx(slot.id);
        if (slot.kind !== "basic") skillFx.cast(slot.kind, castKey);
        stageBannerFor(HERO, slot.id, lastPsycho);

        // The cast is a round trip now: the gesture, the voice line and the
        // VFX are the press's own feedback, and the PROJECTILE waits for the
        // fight to resolve the intent. Nothing here invents a number — remote
        // shows what the server applied, local what its own sim did on land.
        const paletteIndex =
          slot.kind === "palette" ? HERO.palette.findIndex((p) => p.id === slot.id) : undefined;
        // Erikson's add-on: lit the moment 1/2 goes down and spent the moment
        // LMB does, so a fast `1 → LMB` is not refused for a server round
        // trip. The fight's own psychosocialChanged repaints the truth.
        if (HERO.psychosocial && slot.kind === "palette") bar?.setAvailable(BASIC_ID, true);
        if (HERO.psychosocial && slot.kind === "basic") bar?.setAvailable(BASIC_ID, false);
        // Variety gates count the PRESS, as the sim clocks the cast: logging
        // on the server's reply would add a round trip to an 8 s window.
        if (slot.kind === "palette") noteStyleCast(slot.id);
        void driver.cast(slot.kind, { paletteIndex }).then((out) => {
          if (!out.ok) {
            // Say why, unless the player can already see it. "refused" is the
            // sim declining to give a cast at all (a gated CS button); "gcd"
            // and "cooling down" are races against timers the bar is already
            // drawing — a popup for either is noise on a button that is
            // visibly dark.
            if (out.why && !SILENT_REFUSALS.has(out.why)) showCastWarning(out.why);
            return;
          }
          if (out.dealt <= 0) {
            // A pure heal (Skinner's schedules, base 0) — nothing flies at the
            // boss, but the rider (the P2 wound stack a chain-kit cast grants)
            // still has to land, so it settles on the spot.
            out.land?.();
            return;
          }
          const strike = (): number => out.land?.() ?? out.dealt;
          if (slot.kind === "basic") {
            projectiles.fire({
              ...basicProjectileStyle(HERO.id),
              size: 0.14,
              speed: 14,
              lifeSec: 2.5,
              target: () => BOSS_POINT,
              onHit: () => {
                playImpactSfx(slot.id);
                dmgNumbers.spawn(BOSS_POINT, strike(), out.crit);
              },
            });
          } else if (slot.kind === "palette") {
            projectiles.fire({
              color: paletteTint(slot.id),
              size: 0.26,
              speed: 9,
              lifeSec: 3,
              wobble: 0.35,
              ...paletteDressing(slot.id),
              target: () => BOSS_POINT,
              onHit: () => {
                playImpactSfx(slot.id);
                dmgNumbers.spawn(BOSS_POINT, strike(), out.crit);
              },
            });
          } else if (slot.kind === "chain") {
            // Free Association is AOE — the fight fans it over every hostile
            // in range. One projectile still reads it, since NIGHTMARE has a
            // single target for it to converge on.
            projectiles.fire({
              color: new Color3(0.86, 0.72, 1.0),
              size: 0.3,
              speed: 11,
              lifeSec: 3,
              wobble: 0.5,
              target: () => BOSS_POINT,
              onHit: () => {
                dmgNumbers.spawn(BOSS_POINT, strike(), out.crit);
              },
            });
          } else if (slot.kind === "ultimate") {
            // The ultimate always homes onto the boss, and floats no number of
            // its own: impact starts the 5-tick payout and each tick floats
            // itself through the dotTick hook.
            projectiles.fire({
              color: ultimateTint(HERO.id),
              ...ultimateDressing(HERO.id),
              size: 0.42,
              speed: 10,
              lifeSec: 4,
              target: () => BOSS_POINT,
              onHit: () => void strike(),
            });
          }
        });
      },
      {
        layout: touch ? "touch" : "bar",
        // The touch cluster's word for the wheel: Skinner's palette is his
        // four schedules, not "Stages".
        paletteWord: HERO.reinforcement ? "Schedules" : HERO.modeling ? "Copies" : undefined,
        // Erikson's 1 and 2 are a rhythm, not a menu — two direct buttons.
        paletteInline: HERO.psychosocial !== undefined,
        gcdMs: 1_500,
        // Focus gates the cast BEFORE it commits: an empty pool refuses the
        // press (red flash, no cooldown, no GCD) instead of casting for free —
        // depleted Focus actually stops the casting now. The dead are refused
        // too, so a corpse's key-mash doesn't burn cooldowns. The pool read is
        // the DRIVER's: in a ranked run the server owns it and this store is
        // only a mirror, so asking the store would be asking the prediction.
        canCast: (slot) => !heroDead && driver.self().focus >= focusCost(slot),
        // The red flash says the press failed; this says why. Only the empty
        // pool earns the popup — a dead hero's mash already has a death
        // overlay explaining itself.
        onRefused: (slot) => {
          if (!heroDead && driver.self().focus < focusCost(slot))
            showCastWarning("Not enough Focus");
        },
      }
    );

    const showBeat = (): void => {
      const beats = HERO.beats;
      if (!beats) return; // no cycle, no readout — the pill never mounts
      const next = (beat + 1) % beats.length;
      bar!.setBeat(beats[beat]!.name, beats[beat]!.multiplier, (beats[next]?.multiplier ?? 0) >= 1.5);
    };
    showBeatRef = showBeat;
    showBeat();

    // ---- the transforming button (Pavlov's NS ⇄ CS) ------------------------
    // CONDITIONED up → the base button becomes the payoff; consumed/decayed/
    // extinguished → it reverts. Same key, same element, cooldown carries.
    // The base is the BELL (2026-08-08; was the UCS palette button), so the
    // swap lands on the basic slot: LMB on desktop, the corner circle on
    // touch. `liveBasicId` tracks the rename for the LMB wiring below —
    // wireBasicAttack casting the frozen mount id would go dead the moment
    // the slot is renamed to CS.
    let transformUp = false;
    let liveBasicId = BASIC_ID;
    if (transformEntry && (transformsBasic || transformBase)) {
      const baseDef = transformsBasic
        ? slots[0]!
        : paletteSlotDef(
            transformBase!,
            String(mountedPalette.findIndex((p) => p.id === transformBase!.id) + 1)
          );
      const csDef = paletteSlotDef(transformEntry, baseDef.key);
      onConditioning = (s): void => {
        if (s.conditioned && !transformUp) transformUp = Boolean(bar?.replaceSlot(baseDef.id, csDef));
        else if (!s.conditioned && transformUp) transformUp = !bar?.replaceSlot(csDef.id, baseDef);
        if (transformsBasic) liveBasicId = transformUp ? csDef.id : baseDef.id;
      };
    }

    // ---- Erikson's rotation (keys 1/2/LMB name the stage they cast) --------
    const psSpec = HERO.psychosocial;
    if (psSpec) {
      const stageId = HERO.palette.find((p) => p.effects.some((e) => e.kind === "psychosocial.stage"))?.id;
      const virtueId = HERO.palette.find((p) => p.effects.some((e) => e.kind === "psychosocial.virtue"))?.id;
      onPsychosocial = (st): void => {
        lastPsycho = st;
        const f = psychosocialFaces(psSpec, st);
        if (stageId) bar?.setLabel(stageId, f.stage, skillIcon(f.stageIcon));
        if (virtueId) bar?.setLabel(virtueId, f.virtue, skillIcon(f.virtueIcon));
        bar?.setLabel(BASIC_ID, f.basic);
        bar?.setAvailable(BASIC_ID, st.addon);
        bar?.setCaption(f.caption);
      };
      const initial = driver.psychosocial;
      if (initial) onPsychosocial(initial);
    }

    // ---- Bandura's retention slots (keys 1-4 wear the copied skills) --------
    // Each slot shows the COPY: its name and the original hero's own icon
    // (a modeled boss blow wears his Modeled Aggression face), a star when
    // the model was rewarded for it. The caption names the model; tapping it
    // moves the pin (automatic → each teammate → automatic), which is the
    // touch path a party-frame tap would otherwise need.
    if (HERO.modeling) {
      const slotIds = HERO.palette.map((p) => p.id);
      const copyIcon = (v: RetainedView): string | undefined =>
        v.heroId === "boss"
          ? skillIcon("modeled_aggression")
          : SKILL_ICON_HEROES.has(v.heroId)
            ? `/assets/ui/skills/${v.heroId}/${slug(v.id)}.webp`
            : skillIcon("reproduction");
      onModeling = (st): void => {
        st.slots.forEach((v, i) => {
          const id = slotIds[i];
          if (!id) return;
          if (v) bar?.setLabel(id, wrapLabel(`${v.motivated ? "★ " : ""}${v.name}`), copyIcon(v));
          else bar?.setLabel(id, "Empty", skillIcon(slug(id)));
        });
        const who = st.model ? st.model.name : "the boss";
        bar?.setCaption(`Watching ${who}${st.pinned ? " (pinned)" : ""} · tap to change model\n★ = rewarded, full power`);
        // The caption exists from its first paint on; wire the tap once. In a
        // ranked fight that is the first server frame, not the bar's mount.
        const captionEl = document.getElementById("action-caption");
        if (captionEl && !captionEl.dataset.modelTap) {
          captionEl.dataset.modelTap = "1";
          captionEl.style.pointerEvents = "auto";
          captionEl.style.cursor = "pointer";
          captionEl.addEventListener("click", () => driver.cycleModel());
        }
      };
      const initial = driver.modeling;
      if (initial) onModeling(initial);
    }

    // ---- Skinner's quadrant toggles (E ⇄ contingency, R ⇄ consequence) -----
    // Each face is its own slot def (replaceSlot refuses same-id swaps, the
    // NS⇄CS precedent), painted from the sim's operantChanged hook. A face
    // is an ACTION, not a status readout (2026-08-05): the button wears the
    // axis icon and word of the state a press will switch TO, so clicking
    // "Positive" always activates Positive. The tooltip names the live state;
    // the combo_<E>_<R> icons are retired from the bar for exactly this
    // reason — two buttons wearing the same live-cell icon read as one.
    const rf = HERO.reinforcement;
    if (rf) {
      const eFace = (active: "positive" | "negative"): BarSlotDef => {
        const next = active === "positive" ? "negative" : "positive";
        return {
          id: `${HERO.defense.id}-${next}`,
          key: "e",
          label: next === "positive" ? "Positive" : "Negative",
          tooltip:
            next === "negative"
              ? `Switch Contingency to Negative — teammates earn a consequence for every ${rf.negativeCleanSeconds} sec spent taking no damage. Currently Positive: every ${rf.positiveDamagePerProc} damage dealt earns one.`
              : `Switch Contingency to Positive — teammates earn a consequence for every ${rf.positiveDamagePerProc} damage they deal. Currently Negative: every ${rf.negativeCleanSeconds} sec without taking damage earns one.`,
          icon: skillIcon(`contingency_${next}`),
          cooldownMs: HERO.defense.cooldownMs,
          kind: "defense" as const,
          freeOfGcd: true,
        };
      };
      const rFace = (active: "reinforcement" | "punishment"): BarSlotDef => {
        const next = active === "reinforcement" ? "punishment" : "reinforcement";
        return {
          id: `${HERO.chain.id}-${next}`,
          key: "r",
          label: next === "reinforcement" ? "Reinforce" : "Punish",
          tooltip:
            next === "punishment"
              ? `Switch Consequence to Punishment — every proc grants ${Math.round(rf.procMitigation.magnitude * 100)} percent damage reduction for ${rf.procMitigation.durationMs / 1000} sec. Currently Reinforcement: a proc heals its earner (${rf.procHeal.positive} on Positive, ${rf.procHeal.negative} on Negative).`
              : `Switch Consequence to Reinforcement — every proc heals its earner (${rf.procHeal.positive} on Positive, ${rf.procHeal.negative} on Negative). Currently Punishment: a proc grants mitigation instead. Either way procs bank Approximations.`,
          icon: skillIcon(`consequence_${next}`),
          cooldownMs: HERO.chain.cooldownMs,
          kind: "chain" as const,
          freeOfGcd: true,
        };
      };
      let eSlotId = HERO.defense.id;
      let rSlotId = HERO.chain.id;
      onOperant = (s): void => {
        const eDef = eFace(s.contingency);
        const rDef = rFace(s.consequence);
        if (eSlotId !== eDef.id && bar?.replaceSlot(eSlotId, eDef)) eSlotId = eDef.id;
        if (rSlotId !== rDef.id && bar?.replaceSlot(rSlotId, rDef)) rSlotId = rDef.id;
      };
      // Initial paint: the mounted E/R defs are the kit's bare abilities —
      // swap in the live faces immediately so the bar opens naming a quadrant.
      const initial = driver.operant;
      if (initial) onOperant(initial);
    }

    // ---- the threat stance (dock slot, key 4) ------------------------------
    // Discrimination: ×6 threat while held, 1× while not — the toggle that
    // replaced the automatic tank multiplier (shared/combat.ts THREAT).
    //
    // ★ 2026-08-04: this was a bare Tab keydown handler on window, and Tab is
    // a bad binding in a browser game — it is the focus-walk key, so holding
    // it meant preventDefault-ing the page's own navigation, and any element
    // that took focus first (a chat box, the canvas losing it) swallowed the
    // press with no feedback. It is now a real bar slot on "4": visible,
    // rebindable with the rest of the row, and it shows whether it is HELD,
    // which the invisible keybind never could.
    const stance = HERO.threatStance;
    const toggleStance = (): void => {
      if (!stance || heroDead) return;
      const on = !driver.threatStanceActive;
      driver.setThreatStance(on);
      bar?.setToggle(stance.id, on);
      refreshStance({ name: stance.name, multiplier: stance.multiplier, held: on });
      player.applyBuff({
        id: "fight.threat-stance",
        name: `${stance.name} — threat ×${stance.multiplier}`,
        // Held until toggled off; the 1 ms re-apply is the "remove".
        durationMs: on ? 3_600_000 : 1,
        kind: "buff",
        icon: buffIconUrl(`stance_${slug(stance.id)}`),
        desc: `While held, everything you do generates ×${stance.multiplier} threat — the boss keeps its eyes on you. Banked threat does not fade when you drop it.`,
      });
      announceWorld(
        on
          ? `${HERO.displayName.split(" — ")[0]} holds ${stance.name} — the boss's eyes lock on.`
          : `${HERO.displayName.split(" — ")[0]} drops ${stance.name} — aggro cools.`
      );
    };
    // Variety gates (Ainsworth's Disorganized): the slot is dark until enough
    // DIFFERENT other styles landed inside its window. The sim holds the same
    // line; this only keeps the button honest, ticking so it darkens again as
    // the window lapses.
    const gatedPalette = HERO.palette.filter((p) => p.requiresVariety);
    const styleLog: { id: string; t: number }[] = [];
    const refreshVariety = (): void => {
      const now = performance.now();
      for (const p of gatedPalette) {
        const gate = p.requiresVariety!;
        const seen = new Set(styleLog.filter((x) => x.t >= now - gate.withinMs && x.id !== p.id).map((x) => x.id));
        bar?.setAvailable(p.id, seen.size >= gate.distinct);
      }
    };
    noteStyleCast = (id: string): void => {
      if (!gatedPalette.length) return;
      styleLog.push({ id, t: performance.now() });
      if (styleLog.length > 12) styleLog.shift();
      refreshVariety();
    };
    const varietyTimer = gatedPalette.length ? window.setInterval(refreshVariety, 250) : 0;
    refreshVariety();
    scene.onDisposeObservable.add(() => window.clearInterval(varietyTimer));

    // Paint the resting state once so the button reads as "off", not "broken",
    // and put the same word under the portrait.
    if (stance) {
      bar?.setToggle(stance.id, driver.threatStanceActive);
      refreshStance({
        name: stance.name,
        multiplier: stance.multiplier,
        held: driver.threatStanceActive,
      });
    }

    // LMB = basic: a click fires one swing, holding keeps swinging (governed
    // by the slot cooldown), idle fires nothing; a left-drag orbits the
    // camera instead. Q = palette cycle. Tab no longer drives the stance:
    // it's a clock now.
    if (!touch) {
      // Live id, not BASIC_ID: while the boss is CONDITIONED the basic slot
      // is renamed to CS (the NS ⇄ CS transform above), so a click casts
      // whatever face the button is wearing.
      wireBasicAttack(scene, () => bar!.cast(liveBasicId));
    }
    let qIdx = 0;
    const qHandler = (e: KeyboardEvent): void => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "q") return;
      if (isTypingInField()) return;
      // Cycle the MOUNTED buttons — when the transform is up, the base
      // entry's slot answers to the transformed id.
      const p = mountedPalette[qIdx % mountedPalette.length]!;
      const id = transformUp && p.id === transformBase?.id ? transformEntry!.id : p.id;
      if (bar!.cast(id)) qIdx++;
    };
    window.addEventListener("keydown", qHandler);

    // The frame badges the difficulty this run resolved to (practice carries
    // its own), so a player can always see which boss they are actually on.
    frame = new BossFrame(difficulty);

    scene.onDisposeObservable.add(() => {
      window.removeEventListener("keydown", qHandler);
      dmgNumbers.dispose();
      allyBars?.dispose();
      bar?.dispose();
      frame?.dispose();
    });
  }

  // Restore the hub's scaffold vitals when the arena scene goes away. The
  // quadrant tile never times out, so the fight that raised it must bury it.
  scene.onDisposeObservable.add(() => {
    voice.dispose();
    player.setVitals(100, 100);
    player.manaRegenMult = 1;
    player.setTeammates([]);
    player.removeBuff("fight.operant_quadrant");
    player.removeBuff("loadout.gear");
    player.removeBuff("loadout.pet");
  });

  // ---- Party presence (ranked party runs) ----------------------------------
  // Teammates are REAL players mirrored from the shared arena presence
  // session (server/village.mjs "a<roomId>"), rendered with the same rig
  // loader the practice bots use and driven by interpolated network state.
  // Cosmetic-only by design: their casts play, their bodies move, but every
  // member still fights their own copy of the boss. Remote pets are
  // deliberately NOT spawned here — village-only, for fight fluency.
  interface RemoteMate {
    rig: ArenaHero | null;
    target: Vector3;
    targetRy: number;
  }
  let partyNet: { tick(dt: number): void; sendCast(id: string, kind: string): void } | null = null;
  /** Names of the teammates whose rigs are live right now (E2E/debug hook). */
  let remoteMateNames: () => string[] = () => [];
  const REMOTE_CAST_KINDS = new Set(["basic", "palette", "defense", "chain", "ultimate"]);
  /** Kinds the per-skill magic-moment layer knows (skillFx.cast's domain) —
   *  the basic keeps just its projectile, the same anti-strobe rule the local
   *  bar follows. Mirrors villageHub's set of the same name. */
  const SKILL_FX_KINDS = new Set<string>(["palette", "defense", "chain", "ultimate"]);
  const wireParty = (roomId: number): void => {
    if (partyNet || headless) return;
    const selfName = myName;
    const client = new VillageClient();
    const mates = new Map<string, RemoteMate>();

    // ---- teammates' skill VFX ----------------------------------------------
    // Until now a teammate's cast played their gesture and nothing else: the
    // rune circles, shield bubbles and eyes that make a fight read as co-op
    // were strictly first-person, so three players hit their keys and saw one
    // person's magic. The village already solved this
    // (villageHub playRemoteCast); this is the same solution in the arena,
    // with the arena's homing projectiles instead of the plaza's loose ones.
    //
    // ONE kit per DISTINCT hero id, not per player — villageHub's rule and its
    // reasons apply verbatim: the pools are fat (orb pools, rune circles,
    // particle systems, a GlowLayer apiece) and none of the factories expose
    // dispose, so per-player copies would both bloat the phone budget and leak
    // as members churn. A party is at most three heroes, and the kit's anchor
    // re-parents onto whoever cast last, so a running effect follows its
    // caster. Two same-hero teammates casting in the same second hand the tail
    // of the first effect to the second — cosmetic, rare, and far cheaper.
    interface MateFxKit {
      node: TransformNode;
      skillFx: HeroSkillVfx;
      projectiles: CastProjectiles;
    }
    const mateFxKits = new Map<string, MateFxKit>();
    const mateFxFor = (heroId: string): MateFxKit => {
      const id = heroId || "freud"; // roster gaps fall back like the rig loader
      let kit = mateFxKits.get(id);
      if (!kit) {
        const node = new TransformNode(`mateCastFx_${id}`, scene);
        kit = {
          node,
          // Skinner's schedules stream to the caster's OWN allies — which from
          // a teammate's point of view includes me. `castAnchors` is that
          // list, minus whoever is casting.
          skillFx: createHeroSkillVfx(scene, node, id, castAnchors),
          projectiles: createCastProjectiles(scene, node),
        };
        mateFxKits.set(id, kit);
      }
      return kit;
    };

    /**
     * Whose cast the shared kits are currently playing. A kit is built once and
     * its ally callback is fixed at that moment, so the caster cannot be closed
     * over — it is stamped here on each cast instead and read back by
     * `castAnchors`.
     */
    let fxCaster: TransformNode | null = null;

    /** Chest points a remote caster's team-flow effects can reach: me, the
     *  bots, and every other live teammate — minus the caster, so a heal
     *  stream does not terminate on the hero casting it. */
    const castAnchors = (): Vector3[] => {
      const pts: Vector3[] = [hero.node.position.add(new Vector3(0, 1.2, 0))];
      for (const m of botMarks) pts.push(m.chest);
      for (const mate of mates.values()) {
        const rig = mate.rig;
        if (!rig || !rig.node.isEnabled() || rig.node === fxCaster) continue;
        pts.push(rig.node.position.add(new Vector3(0, 1.2, 0)));
      }
      return pts;
    };

    liveMateChests = () => {
      const pts: Vector3[] = [];
      for (const mate of mates.values()) {
        const rig = mate.rig;
        if (rig?.node.isEnabled()) pts.push(rig.node.position.add(new Vector3(0, 1.2, 0)));
      }
      return pts;
    };
    // The fight names its actors after accounts, so this is how a server event
    // ("jung took 300") finds the body it belongs to.
    mateRig = (name) => {
      const mate = mates.get(name.toLowerCase());
      return mate?.rig?.node.isEnabled() ? mate.rig : null;
    };

    const addMate = (p: VillagePlayer): void => {
      const key = p.username.toLowerCase();
      if (!key || key === selfName) return;
      mateHero.set(key, p.hero || "freud");
      const existing = mates.get(key);
      if (existing) {
        existing.target.set(p.x, p.y, p.z);
        existing.targetRy = p.ry;
        existing.rig?.node.setEnabled(true); // back after a reconnect
        return;
      }
      const mate: RemoteMate = { rig: null, target: new Vector3(p.x, p.y, p.z), targetRy: p.ry };
      mates.set(key, mate);
      void loadArenaHero(scene, mate.target.clone(), BOSS_POINT, camera, terrain, p.hero || "freud", {
        input: false,
        name: `mate_${key}`,
      })
        .then((rig) => {
          if (!mates.has(key)) {
            rig.node.setEnabled(false); // left while the glb was loading
            return;
          }
          mate.rig = rig;
        })
        .catch(() => {
          mates.delete(key);
        });
    };

    client.onRoster = (players) => {
      const seen = new Set(players.map((p) => p.username.toLowerCase()));
      for (const p of players) addMate(p);
      for (const [key, mate] of mates) {
        if (!seen.has(key)) mate.rig?.node.setEnabled(false);
      }
    };
    client.onJoin = addMate;
    client.onLeave = (username) => {
      // Keep the rig loaded (streams reconnect); just stop drawing it.
      mates.get(username.toLowerCase())?.rig?.node.setEnabled(false);
    };
    client.onState = (map) => {
      for (const [username, [x, y, z, ry]] of Object.entries(map)) {
        const mate = mates.get(username.toLowerCase());
        if (!mate) continue;
        mate.target.set(x, y, z);
        mate.targetRy = ry;
      }
    };
    client.onCast = (c) => {
      const key = c.username.toLowerCase();
      if (key === selfName) return; // own echo
      const mate = mates.get(key);
      const rig = mate?.rig;
      if (!rig?.node.isEnabled()) return;
      // No faceTarget here: the caster's own client already squared them onto
      // the boss, so the network yaw carries the facing.
      const kind = (REMOTE_CAST_KINDS.has(c.kind) ? c.kind : "basic") as ArenaCastKind;
      // The slot id picks a per-style clip where the rig ships one.
      rig.cast(kind, c.id);

      // Their magic, on my screen. Mirrors the local bar's own rules below
      // (arenaCombat's ActionBar handler) so the two clients show the same
      // cast: skill VFX for everything but the basic, and a projectile that
      // homes on the shared boss.
      const heroId = mateHero.get(key) ?? "freud";
      const kitDef = heroById(heroId);
      const kit = mateFxFor(heroId);
      // Follow the caster: an identity transform under their wrapper puts the
      // kit exactly where `hero.node` sits for a local cast (feet origin).
      fxCaster = rig.node;
      kit.node.parent = rig.node;
      kit.node.position.setAll(0);
      kit.node.rotation.set(0, 0, 0);

      if (SKILL_FX_KINDS.has(kind)) kit.skillFx.cast(kind as FreudCastKind, c.id);

      // What actually flies, decided the same way the local bar decides it.
      // A defense is a bubble around the caster; a reinforcement kit's E/R are
      // free quadrant flips and its palette/ultimate are heals — none of those
      // send anything at the boss, and inventing a projectile for them would
      // show a teammate attacking when they were shielding or healing.
      const reinforcement = !!kitDef.reinforcement;
      const nothingFlies =
        kind === "defense" ||
        (reinforcement && (kind === "chain" || kind === "palette" || kind === "ultimate"));
      if (nothingFlies) return;
      // No onHit and no damage numbers: the SERVER's hurt/dot events already
      // float this cast's damage over the boss (see the hooks above), and a
      // second float from the presentation channel would double-count it.
      if (kind === "basic") {
        kit.projectiles.fire({
          ...basicProjectileStyle(kitDef.id),
          size: 0.14,
          speed: 14,
          lifeSec: 2.5,
          target: () => BOSS_POINT,
        });
      } else if (kind === "palette") {
        kit.projectiles.fire({
          color: paletteTint(c.id),
          size: 0.26,
          speed: 9,
          lifeSec: 3,
          wobble: 0.35,
          ...paletteDressing(c.id),
          target: () => BOSS_POINT,
        });
      } else if (kind === "chain") {
        kit.projectiles.fire({
          color: new Color3(0.86, 0.72, 1.0),
          size: 0.3,
          speed: 11,
          lifeSec: 3,
          wobble: 0.5,
          target: () => BOSS_POINT,
        });
      } else {
        kit.projectiles.fire({
          color: ultimateTint(kitDef.id),
          ...ultimateDressing(kitDef.id),
          size: 0.42,
          speed: 10,
          lifeSec: 4,
          target: () => BOSS_POINT,
        });
      }
    };

    remoteMateNames = () =>
      [...mates.entries()].filter(([, m]) => m.rig?.node.isEnabled()).map(([key]) => key);

    scene.onDisposeObservable.add(() => void client.leave());
    void client
      .join({ arena: roomId })
      .catch((err) => console.warn("[fight] party presence unavailable:", err));

    partyNet = {
      sendCast: (id, kind) => client.sendCast(id, kind),
      tick(dt) {
        // Report the local hero; the client throttles to the server's rate.
        const pos = hero.node.position;
        client.sendState(pos.x, pos.y, pos.z, hero.node.rotation.y, "fight");
        // Interpolate teammates toward their latest reported pose. x/z only —
        // the rig's own update() eases y onto the terrain.
        for (const mate of mates.values()) {
          const rig = mate.rig;
          if (!rig || !rig.node.isEnabled()) continue;
          const node = rig.node;
          const dx = mate.target.x - node.position.x;
          const dz = mate.target.z - node.position.z;
          if (dx * dx + dz * dz > 25) {
            // Way off (spawn, big teleport) — snap instead of a long glide.
            node.position.x = mate.target.x;
            node.position.z = mate.target.z;
            rig.driveSpeed(0);
          } else {
            const k = Math.min(1, dt * 10);
            node.position.x += dx * k;
            node.position.z += dz * k;
            terrain.clamp(node.position);
            // Feed the observed glide speed into the walk/run blend.
            rig.driveSpeed(dt > 0 ? Math.min(7, Math.hypot(dx * k, dz * k) / dt) : 0);
          }
          let dy = mate.targetRy - node.rotation.y;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          node.rotation.y += dy * Math.min(1, dt * 10);
          rig.update(dt);
        }
      },
    };
  };

  let mateTimer = 0;
  const combat: ArenaCombat = {
    onFightEnd: null,
    heroPosition: () => hero.node.position,
    wireParty,
    tick(_t, dt) {
      hero.update(dt);
      for (const m of botMarks) m.rig.update(dt);
      // Networked teammates (ranked party runs) — reports our pose, then
      // interpolates and updates theirs.
      partyNet?.tick(dt);
      fans?.tick(dt);
      pet.tick();
      followGoal.copyFrom(hero.node.position);
      followGoal.y += 1.55;
      camera.setTarget(Vector3.Lerp(camera.target, followGoal, Math.min(1, dt * 10)), false, false, true);
      driver.tick(dt);
      const snap = driver.snapshot();
      lastSnap = snap;
      frame?.update(snap);
      allyBars?.update(snap.allies);

      // This player's own row. Death is read here rather than latched from the
      // died hook, because in a party the hook's "player" is whoever took the
      // first seat — `self()` is always me.
      const me = driver.self();
      heroDead = !me.alive;
      if (me.beat !== beat) {
        beat = me.beat;
        showBeatRef?.();
      }
      if (driver.remote) {
        // The server owns HP and Focus in a ranked run, so the store is a
        // mirror of it — its own regen is prediction between frames.
        player.setPools(me.hp, me.hpMax, me.focus, me.focusMax);
        // …and it owns the Shapeshift clock, so the dolls follow the answer
        // key instead of defining it (the P2 inversion, fixed).
        nightmare.setP2Stage(snap.p2Stage);
      }

      // Party frames ride the player store; 2 Hz is plenty for HP slivers.
      mateTimer += dt;
      if (mateTimer >= 0.5) {
        mateTimer = 0;
        if (botSpecs.length > 0) {
          player.setTeammates(
            snap.allies.map((a, i) => ({
              username: a.name,
              hero: botSpecs[i]?.heroId ?? "freud",
              hpPct: a.hpPct,
            }))
          );
          // Fallen bots stay visible — combatantDied played the rig's death
          // clip where it stood; only the lightning volley drops them (the
          // heroes() anchor list already filters on alive).
        } else if (driver.remote && snap.allies.length > 0) {
          // Real teammates in a server fight. `allies` is "everyone but the
          // primary actor", which includes ME whenever I am not that actor —
          // so it is filtered by name, the only identity both the fight and
          // the presence session agree on.
          player.setTeammates(
            snap.allies
              .filter((a) => a.name.toLowerCase() !== myName)
              .map((a) => ({
                username: a.name,
                hero: mateHero.get(a.name.toLowerCase()) ?? "freud",
                hpPct: a.hpPct,
              }))
          );
        }
      }
    },
  };

  // Console poking + E2E introspection, same spirit as window.psyrena.
  Object.assign(window, {
    psyrenaFight: {
      snapshot: () => driver.snapshot(),
      // Live operant pair (Skinner), null for other kits — E2E asserts that a
      // button press landed in the FIGHT, not just on the repainted bar face.
      operant: () => driver.operant,
      // Force a rider-proc float (the real trigger — a rider absorbing a live
      // hit — is a dice roll, useless for screenshots).
      procFloat: (name: string) => procFloatRef?.(name),
      // End the attempt without the 5-minute kill / 8-minute enrage — the
      // whole win/defeat flow (loot box, town round-trip) in one call.
      // Networked teammates currently rendered in THIS client's arena — the
      // only way to prove party presence without reading pixels
      // (tools/party-arena-e2e.mjs asserts mutual visibility through it).
      mates: () => [...remoteMateNames()],
      // In a ranked run these travel to the server (POST …/sim/debug, dev-only)
      // — the sim is not in this tab to reach into any more.
      debugWin: () => driver.debugWin(),
      debugLose: () => driver.debugLose(),
      debugKillPlayer: () => driver.debugKillPlayer(),
    },
  });

  return combat;
}
