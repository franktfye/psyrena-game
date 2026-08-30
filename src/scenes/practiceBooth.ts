/**
 * The Practice Booth — the village's target range.
 *
 * Entered by tapping the Practice Booth attendant in the hub; left through the
 * glowing portal that is the only other thing in it.
 *
 * The brief is "the village foundation with nothing on it", and that is
 * literal: this scene calls the SAME `buildVillageFoundation` the hub does, so
 * the sky, fog, IBL, camera rig, three-light setup, material set, plaza paving
 * and the floating island underneath are not a copy that drifts — they are the
 * same code path. What it leaves out is everything that makes the village a
 * place: no facilities, no kit dressing, no props, no crowd, no shop NPCs, no
 * arena portal. What it adds is a dummy and a way home.
 *
 * Why a whole scene instead of a village sub-area: the hub is ~180 static
 * meshes with a render-once shadow map and frozen matrices. A practice mode
 * that hid all of it would still pay for it, and un-freezing the hub to hide
 * things is how a static scene stops being static. A separate scene through
 * the SceneManager also gets the leak-soak guarantee for free.
 */
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/torusBuilder";

import { PALETTE } from "../core/palette";
import { warmupShaders } from "../core/warmup";
import { heroById } from "@shared/heroes";
import { TRAINING_DUMMY } from "@shared/bosses/trainingDummy";
import { BEAT_PERIOD_S } from "@shared/combat";
import { BossFight } from "@shared/fight/bossFight";
import { player } from "../state/player";
import { createDamageNumbers } from "../vfx/damageNumbers";
import { createPracticeMeter } from "../ui/practiceMeter";
import {
  buildVillageFoundation,
  finishVillageRender,
  buildFreud,
  createHeroVoice,
  createHeroController,
  setupSkillBar,
  type SkillBarHandle,
  collectStaticColliders,
  holoMat,
  loadVillageProp,
  FREUD_SPOT,
  type Ticker,
} from "./villageHub";
import { createPetSlot } from "./petFollower";
import { bindOstPlayer } from "../state/musicSettings";
import { playSfx } from "../state/sfx";
import { audioUrl } from "../core/audio";

/** Where the dummy stands, in the paved circle the hub keeps clear anyway. */
const DUMMY_SPOT = new Vector3(-8.75, 0, 6.0);
/**
 * Total model height, base plate included.
 *
 * The design-prompt target is a 1.9 m FIGURE, but this glb ships standing on
 * its own weighted base, and `loadVillageProp` drives the whole bounding box —
 * so asking for 1.9 here buys a 1.55 m figure on a plinth, which reads as a
 * toy next to Freud. 2.35 puts the shoulders where a person's are.
 */
const DUMMY_HEIGHT = 2.35;
/** The way home. Off to the hero's other side so it is never behind the dummy. */
const PORTAL_SPOT = new Vector3(-15.5, 0, 15.0);

export async function createPracticeBooth(
  engine: AbstractEngine,
  heroId?: string
): Promise<Scene> {
  const scene = new Scene(engine);
  // The booth quotes the SELECTED hero's kit — same resolution as the arena,
  // so the numbers over the dummy are the numbers the boss fight pays.
  const HERO = heroById(heroId);
  const { camera, key, mats } = await buildVillageFoundation(scene);

  const tickers: Ticker[] = [];

  // ---- The dummy ---------------------------------------------------------
  const dummy = await loadVillageProp(
    scene,
    "/assets/village/practice_dummy.glb",
    "practiceDummy",
    { axis: "height", metres: DUMMY_HEIGHT, limits: { width: 1.4, depth: 1.2 } },
    // The glb comes out of Tripo facing −X. The hero spawns at +Z of the pad,
    // so −90° turns the chest target ring toward whoever is shooting at it.
    // Verified by sweeping all four quadrants against the spawn camera.
    -Math.PI / 2
  );
  if (dummy) {
    dummy.position.copyFrom(DUMMY_SPOT);
  }

  // A wide invisible cylinder is what casts actually test against: the mesh is
  // a 29k-triangle humanoid and picking against a limb gap would read as a
  // miss the player cannot explain.
  const dummyHitbox = MeshBuilder.CreateCylinder(
    "practiceDummyHitbox",
    { diameter: 1.3, height: DUMMY_HEIGHT + 0.2, tessellation: 12 },
    scene
  );
  dummyHitbox.position.set(DUMMY_SPOT.x, (DUMMY_HEIGHT + 0.2) / 2, DUMMY_SPOT.z);
  dummyHitbox.isVisible = false;
  dummyHitbox.isPickable = true;

  // Emitter pad underfoot — the booth's violet, so the dummy reads as issued
  // equipment rather than as a villager who wandered in and stopped moving.
  const pad = MeshBuilder.CreateCylinder(
    "practicePad",
    { diameter: 2.6, height: 0.12, tessellation: 32 },
    scene
  );
  pad.position.set(DUMMY_SPOT.x, 0.06, DUMMY_SPOT.z);
  pad.material = mats.metal;

  const padRing = MeshBuilder.CreateTorus(
    "practicePadRing",
    { diameter: 2.6, thickness: 0.07, tessellation: 40 },
    scene
  );
  padRing.position.set(DUMMY_SPOT.x, 0.13, DUMMY_SPOT.z);
  padRing.material = holoMat(scene, mats, PALETTE.violet);

  // ---- The exit portal ---------------------------------------------------
  const portal = buildExitPortal(scene, mats);
  tickers.push(portal.ticker);

  // ---- Hero, controls, and the bar --------------------------------------
  // Fight-style casts: full-body takeovers at the same speeds as the boss
  // arena (see arenaHero.ts). The village keeps run-and-cast overlays; the
  // practice pit is where players learn attack timing, so the read matches.
  const hero = await buildFreud(scene, mats, { castStyle: "fight", heroId: HERO.id });
  hero.node.position.set(FREUD_SPOT.x, 0, FREUD_SPOT.z);
  hero.node.rotation.y = FREUD_SPOT.ry;
  tickers.push({ tick: hero.tick });

  const voice = createHeroVoice(HERO.id);
  scene.onDisposeObservable.add(() => voice.dispose());

  const music = createBoothMusic();
  scene.onDisposeObservable.add(() => music.dispose());

  tickers.push(
    createHeroController(scene, camera, hero, mats, collectStaticColliders(scene), voice)
  );

  // The pet comes to the range too — it is the same hero and the same heel,
  // and the same live slot: a Pet Park change lands here on the next frame.
  tickers.push(createPetSlot(scene, hero, HERO.id));

  // The dummy's whole job: turn a cast into a number in the air — and, since
  // 2026-08-04, into every buff and debuff that cast carries. Casts resolve
  // through the REAL fight sim against TRAINING_DUMMY, so Marks, mitigation,
  // taunt, vulnerability, the conditioning loop and zone effects all behave
  // exactly as they will against the boss. Gear and a team are still absent,
  // so the numbers remain the honest solo floor rather than a padded one.
  const dmgNumbers = typeof document === "undefined" ? null : createDamageNumbers(scene);
  const hitPoint = new Vector3(DUMMY_SPOT.x, DUMMY_HEIGHT * 0.62, DUMMY_SPOT.z);

  // The beat the number is quoted at has to be the beat the HUD is showing, so
  // this runs the SAME clock the bar does rather than a counter of its own —
  // `BEAT_PERIOD_S`, free-running, never advanced by a cast. A practice range
  // that disagreed with the stance readout above it would teach the wrong
  // timing, which is the one thing it exists to teach.
  let beat = 0;
  let beatT = 0;
  tickers.push({
    tick: () => {
      beatT += scene.getEngine().getDeltaTime() / 1000;
      while (beatT >= BEAT_PERIOD_S) {
        beatT -= BEAT_PERIOD_S;
        beat = (beat + 1) % (HERO.beats?.length ?? 1);
      }
    },
  });

  const meter = createPracticeMeter();
  scene.onDisposeObservable.add(() => meter.dispose());

  // NOTE: the ultimate's tick-by-tick payout used to be faked here by a small
  // private scheduler (5 ticks, 500 ms apart). It is gone — the sim owns that
  // rhythm now and reports it through the `dotTick` hook at its real
  // ULT_TICK_PERIOD_S, so the pit and the arena cannot disagree about it.

  // ---- The dummy runs the REAL fight sim ---------------------------------
  // Previously the pit priced casts with a private `resolveHit` call and
  // `marks: 0, amp: 0`, so nothing a kit does BESIDES damage happened here:
  // no Marks, no mitigation, no taunt, no vulnerability, no UCR window, no
  // CONDITIONED, no Extinction dome. Every hero's buffs and debuffs were
  // invisible until a boss fight.
  //
  // Now the same `BossFight` the arena runs drives the pit, against
  // TRAINING_DUMMY (see shared/bosses/trainingDummy.ts) — a target that never
  // swings and never dies. One implementation, so the pit cannot drift from
  // the fight, and every rider fires here exactly as it will in the arena.
  const BUFF_ICONS = "/assets/ui/buffs";
  const SKILL_ICONS = `/assets/ui/skills/${HERO.id}`;
  const slug = (id: string): string => (id.split(".").pop() ?? id).replace(/-/g, "_");
  // Palette slugs included for Skinner's FI/VI HoT buffs — same routing rule
  // as the arena (arenaCombat.ts): a buff keyed on the skill that armed it
  // reuses the bar icon.
  const SKILL_BUFF_KEYS = new Set(
    [HERO.defense.id, HERO.chain.id, HERO.ultimate.id, ...HERO.palette.map((p) => p.id)].map(slug)
  );
  const buffIconUrl = (key?: string): string | undefined => {
    if (!key) return undefined;
    return SKILL_BUFF_KEYS.has(key) ? `${SKILL_ICONS}/${key}.webp` : `${BUFF_ICONS}/${key}.webp`;
  };

  let barHandle: SkillBarHandle | null = null;
  const fight = new BossFight(TRAINING_DUMMY, HERO, [], {
    // The dummy announces nothing and swings at nobody, so the fight-flow
    // hooks are deliberately inert rather than wired to chat: a practice range
    // that narrated phase changes would be lying about what it is.
    announce: () => {},
    setBossPhase: () => {},
    bossStrike: () => {},
    damagePlayer: () => {},
    // Kit sub-events keep their sounds in the pit — the schedules and the
    // operant engine are learned here, and the jackpot should pay out in the
    // ear where it is first met. Boss beats can't fire against the dummy.
    sfxEvent: (name) => {
      if (name === "vr.jackpot") playSfx("skinner.variable-ratio.jackpot");
      else if (name === "hot.tick") playSfx("skinner.hot.tick");
      else if (name === "operant.proc") playSfx("skinner.proc");
    },
    // Nothing in here damages the player, so every heal the sim resolves is
    // pure overheal and lands as 0 — correct, and it is exactly where the
    // "Team Amp" tiles come from. The float and the HPS row therefore quote
    // the ATTEMPTED amount the sim reports through `combatantHealed`, so the
    // meter says what the button PAYS rather than what a topped-up player
    // absorbed.
    healPlayer: () => {},
    // Every heal the kit resolves — the E/ultimate floor, Skinner's FR/VR
    // pellets, the FI/VI over-time ticks, reinforcement procs — floats green
    // over the caster and feeds the HPS row under the sim's own source label.
    // Before this hook only the E and ultimate quotes showed; a schedule kit
    // healed invisibly in the one place it is meant to be learned.
    combatantHealed: (_name, _effective, attempted, _isPlayer, label) => {
      const at = hero.node.position.clone();
      at.y += 2.0;
      dmgNumbers?.spawn(at, attempted, false, "heal");
      meter.record(label, attempted, "heal");
    },
    playerHitReaction: () => {},
    // THE POINT OF ALL THIS: every buff/debuff tile the arena raises now
    // raises here too, through the same hook and the same icon set.
    playerBuff: (name, durationMs, kind, icon, id, desc) => {
      player.applyBuff({
        // A sim-supplied id wins (the operant quadrant tile renames AND
        // re-icons on every flip; keying on either would stack four tiles).
        id: `practice.${id ?? icon ?? name}`,
        name,
        durationMs,
        kind: kind ?? "buff",
        icon: buffIconUrl(icon),
        desc,
      });
    },
    defenseProc: (name) => {
      const at = hero.node.position.clone();
      at.y += 2.4;
      dmgNumbers?.spawnText?.(at, name);
    },
    // The pit is where the conditioning loop is meant to be LEARNED, so the
    // pairing's Focus reward has to be visible here too — same hook, same
    // pool the arena fills (`restoreMana`), or the pit would teach a bell that
    // pays nothing.
    gainFocus: (n) => player.restoreMana(n),
    dotTick: (label, amount) => {
      dmgNumbers?.spawnDot(hitPoint, amount, label);
      meter.record(label, amount, "damage");
      flashDummy(padRing.material as StandardMaterial);
    },
    lockPaletteSlot: (paletteIndex, ms) => {
      const id = barHandle?.paletteIds[paletteIndex];
      if (id) barHandle?.lockSlot(id, ms);
    },
    // Pavlov's NS ⇄ CS swap. The pit is the one place a player can practise
    // the conditioning loop without a boss on top of them, so the gated button
    // has to actually light up.
    conditioningChanged: (state) => {
      barHandle?.setTransformed(state.conditioned);
    },
    // Skinner's E/R faces flip here exactly as they do in the arena — the pit
    // is where the quadrant matrix is meant to be LEARNED, so the buttons
    // must wear the live cell.
    operantChanged: (state) => {
      barHandle?.setOperant(state);
    },
  });
  tickers.push({ tick: () => fight.tick(scene.getEngine().getDeltaTime() / 1000) });
  // The quadrant tile never times out — the pit buries it on the way out.
  scene.onDisposeObservable.add(() => player.removeBuff("practice.operant_quadrant"));

  const recordHit = (label: string, amount: number, crit: boolean): void => {
    if (amount <= 0) return;
    dmgNumbers?.spawn(hitPoint, amount, crit, "damage");
    meter.record(label, amount, "damage");
    flashDummy(padRing.material as StandardMaterial);
  };

  barHandle = setupSkillBar(scene, hero, voice, {
    // Casts home on the dummy's chest, the same auto-aim the boss fight uses.
    // A practice range where the player has to lead the target would be
    // teaching an aiming skill the game does not have.
    target: () => hitPoint,
    // The pit has a live sim, so the gated CS button mounts and the handle
    // above swaps it as the loop comes up.
    mountTransforming: true,
    // …and the same sim owns Skinner's operant quadrant: faces repaint from
    // `operantChanged` → `setOperant`, never from the bar's own hub-side flip.
    simDrivesOperant: true,
    onCast: (slot, land) => {
      const label = slot.label.replace(/\n/g, " ");
      // Resolved at CAST time so it captures the beat that was up when the
      // button went down, then shown on impact — see `SkillBarHooks.onCast`.
      const mult = HERO.beats?.[beat]?.multiplier ?? 1;

      // The bar already flipped the stance and painted it (it owns that state
      // so the village's dock button is not dead). All the pit adds is the
      // mechanical half — read the new value back rather than tracking a
      // second copy that could disagree with the button.
      if (slot.kind === "stance") {
        fight.setThreatStance(barHandle?.stanceActive() ?? false);
        return;
      }

      if (slot.kind === "ultimate") {
        // The ultimate resolves as a whole (Marks consumed, dome raised, team
        // heal paid — the heal floats through `combatantHealed`) and then
        // ticks out through the `dotTick` hook above, so the pit gets the
        // arena's 5-tick payout rhythm for free.
        land(() => fight.castUltimate());
        return;
      }

      const paletteIndex = HERO.palette.findIndex((p) => p.id === slot.id);
      const hit =
        slot.kind === "basic"
          ? fight.castBasic(mult)
          : slot.kind === "palette"
            ? fight.castPalette(paletteIndex, mult)
            : slot.kind === "defense"
              ? (fight.castDefense(), null)
              : slot.kind === "chain"
                ? fight.castChain(mult)
                : null;
      // A gated button the sim refused (CS while not CONDITIONED) returns
      // null: nothing flies, nothing lands, which is the button being grey.
      if (!hit) return;
      land(() => {
        const dealt = fight.landHit(hit);
        recordHit(label, dealt, hit.crit);
      });
    },
    // The bar must wear the same kit the damage math above prices — leaving
    // this off mounts Freud's slots and every palette lookup pays 0.
  }, HERO);

  // Initial paint: the mounted E/R defs wear the starting quadrant statically;
  // swap in the live faces so the bar opens naming the sim's actual state.
  const operant = fight.operant;
  if (operant) barHandle?.setOperant(operant);


  // ---- Leaving -----------------------------------------------------------
  // Same tap-vs-drag gate the hub's portal uses: the ArcRotateCamera owns
  // drags for the orbit, so only a short, still press counts as a tap.
  let pressX = 0;
  let pressY = 0;
  let pressAt = 0;
  scene.onPointerObservable.add((pi) => {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      pressX = scene.pointerX;
      pressY = scene.pointerY;
      pressAt = performance.now();
      return;
    }
    if (pi.type !== PointerEventTypes.POINTERUP) return;
    const dx = scene.pointerX - pressX;
    const dy = scene.pointerY - pressY;
    if (dx * dx + dy * dy > 12 * 12 || performance.now() - pressAt > 500) return;
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === portal.pickable);
    if (hit?.hit) leave();
  });

  // Walking into it works too — a portal you have to click is a button, and
  // the player is already steering the hero toward it.
  tickers.push({
    tick: () => {
      const d = Vector3.Distance(hero.node.position, PORTAL_SPOT);
      if (d < 1.6) leave();
    },
  });

  let leaving = false;
  function leave(): void {
    if (leaving) return;
    leaving = true;
    // Deferred out of the current frame ON PURPOSE. The proximity check below
    // runs inside `onBeforeRenderObservable`, and `go()` disposes the live
    // scene synchronously — calling it from in there tears the scene down
    // mid-frame and the render loop finishes the pass against a disposed
    // camera ("No camera defined"). A microtask lands us after the frame.
    queueMicrotask(() => {
      const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } })
        .psyrena;
      void psy?.go?.("village");
    });
  }

  // Restore the hub's scaffold vitals on the way out, exactly as the arena does.
  scene.onDisposeObservable.add(() => {
    player.setTeammates([]);
  });

  finishVillageRender(scene, camera, key);

  let t = 0;
  scene.onBeforeRenderObservable.add(() => {
    t += engine.getDeltaTime() / 1000;
    for (const c of tickers) c.tick(t);
  });

  await warmupShaders(scene);
  return scene;
}

/** Pulse the pad ring on a landed cast — the dummy's only tell. */
function flashDummy(mat: StandardMaterial): void {
  const peak = new Color3(0.85, 0.6, 1.0);
  const rest = PALETTE.violet;
  mat.emissiveColor = peak;
  setTimeout(() => {
    mat.emissiveColor = rest;
  }, 120);
}

/**
 * The way out: a violet ring standing in a column of light.
 *
 * Deliberately NOT the hub's black-hole portal. That one means "queue for the
 * boss"; this one means "go back", and two portals that look alike in a game
 * with one-tap travel is a way to lose a player's afternoon.
 */
function buildExitPortal(
  scene: Scene,
  mats: Parameters<typeof holoMat>[1]
): { pickable: Mesh; ticker: Ticker } {
  const ring = MeshBuilder.CreateTorus(
    "exitPortalRing",
    { diameter: 2.4, thickness: 0.14, tessellation: 48 },
    scene
  );
  ring.position.copyFrom(PORTAL_SPOT);
  ring.position.y = 1.5;
  ring.rotation.x = Math.PI / 2;
  ring.material = holoMat(scene, mats, PALETTE.cyan);

  const column = MeshBuilder.CreateCylinder(
    "exitPortalFx",
    { diameter: 2.1, height: 3.0, tessellation: 24 },
    scene
  );
  column.position.copyFrom(PORTAL_SPOT);
  column.position.y = 1.5;
  column.material = holoMat(scene, mats, PALETTE.cyan, 0.22);
  column.isPickable = false;

  const base = MeshBuilder.CreateCylinder(
    "exitPortalBase",
    { diameter: 2.6, height: 0.14, tessellation: 32 },
    scene
  );
  base.position.copyFrom(PORTAL_SPOT);
  base.position.y = 0.07;
  base.material = mats.metal;

  // One invisible proxy carries the picking, same trick as the hub portal —
  // no scene-wide isPickable audit, and the thin torus stays easy to tap.
  const pickable = MeshBuilder.CreateCylinder(
    "exitPortalPick",
    { diameter: 2.6, height: 3.2, tessellation: 12 },
    scene
  );
  pickable.position.copyFrom(PORTAL_SPOT);
  pickable.position.y = 1.6;
  pickable.isVisible = false;
  pickable.isPickable = true;

  return {
    pickable,
    ticker: {
      tick: (t: number) => {
        ring.rotation.y = t * 0.6;
        const pulse = 0.8 + Math.sin(t * 2.4) * 0.2;
        column.scaling.x = pulse;
        column.scaling.z = pulse;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// BGM — one violet loop for the whole booth stay
// ---------------------------------------------------------------------------

const BOOTH_OST = audioUrl("/assets/village/ost/violet_practice_pit");
/** Under the hero VO, same bus discipline as the fight OST (VO = 1.0). */
const BOOTH_OST_VOLUME = 0.3;

interface BoothMusic {
  dispose(): void;
}

/**
 * Same contract as the fight OST (nightmareBoss's createBossMusic): looping
 * HTMLAudio, a one-shot gesture retry for blocked autoplay, and an aggressive
 * dispose (mute → pause → drop src → load()) so the V-key that leaves the
 * booth cannot carry the loop back into the village.
 */
function createBoothMusic(): BoothMusic {
  const player = typeof Audio !== "undefined" ? new Audio() : null;
  if (!player) return { dispose: () => {} };
  let disposed = false;
  player.src = BOOTH_OST;
  player.loop = true;
  player.volume = BOOTH_OST_VOLUME;
  player.preload = "auto";
  // System-tab music settings: mute plus an optional single-track override.
  const unbindSettings = bindOstPlayer(player, () => {
    player.src = BOOTH_OST;
    player.loop = true;
    void player.play().catch(() => {});
  });
  const unlock = (): void => {
    if (disposed) return;
    void player.play().catch(() => {});
  };
  void player.play().catch(() => {
    if (disposed) return;
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  });
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unbindSettings();
      // Drop unlock first so the same key that switches scenes cannot re-play.
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      try {
        player.volume = 0;
        player.pause();
        player.removeAttribute("src");
        // Abort any in-flight decode; prevents a late canplay → sound.
        player.load();
      } catch {
        // Some browsers throw if load() races a dead element — ignore.
      }
    },
  };
}
