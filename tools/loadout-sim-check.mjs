/**
 * Headless guard for the gear/pet progression ladder (docs/09 §5) — the
 * check that keeps shared/progression.ts honest when someone "just nudges"
 * a number. Asserts, over the live BossFight sim with the loadout wiring:
 *
 *   1. the loadout terms actually move the pipeline (exact ratios, and the
 *      gear term CLAMPS at COMBAT.maxGear — the 12% Rule has teeth)
 *   2. STANDARD 3-man clears ungeared (the free tier stays free)
 *   3. HARD 3-man does NOT clear on full gear+pets alone (progression is
 *      the bridge's floor, not the whole bridge)
 *   4. HARD 3-man DOES clear at full gear+pets+both coffees (the ladder's
 *      top rung lands inside the enrage window)
 *   5. NIGHTMARE never clears at the maximum stack (stat-proof by design)
 *
 * The 3-man comp is the calibrated practice trio (driven Freud + bot tank +
 * bot healer); bots stand in for teammates, so "team-wide" boosts scale
 * their specs the way the docs/09 receipts were measured. Majority verdicts
 * over N runs — single runs ride crit and jackpot RNG.
 *
 * Run: node tools/loadout-sim-check.mjs
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function bundle(entry) {
  const f = join(mkdtempSync(join(tmpdir(), "psyrena-loadout-")), "mod.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", outfile: f, logLevel: "silent" });
  return f;
}

const { BossFight } = await import(pathToFileURL(await bundle("shared/fight/bossFight.ts")).href);
const { NIGHTMARE_STANDARD } = await import(
  pathToFileURL(await bundle("shared/bosses/nightmare.ts")).href
);
const { FREUD } = await import(pathToFileURL(await bundle("shared/heroes/freud.ts")).href);
const { practiceBotsFor } = await import(
  pathToFileURL(await bundle("shared/bosses/practiceBots.ts")).href
);
const { DIFFICULTY } = await import(pathToFileURL(await bundle("src/fight/difficulty.ts")).href);
const { GEAR_SET_BONUS, PET_STAT_LADDER, resolveLoadout, gearMultiplier } = await import(
  pathToFileURL(await bundle("shared/progression.ts")).href
);
const { COMBAT } = await import(pathToFileURL(await bundle("shared/combat.ts")).href);

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. The loadout terms move the pipeline — exact ratios, no RNG.
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999; // no crits — ratios stay exact
  const hooks = {
    announce: () => {}, setBossPhase: () => {}, bossStrike: () => {},
    damagePlayer: () => {}, healPlayer: () => {}, playerBuff: () => {},
    lockPaletteSlot: () => {}, playerHitReaction: () => {},
  };
  const DT = 0.1;
  const hit = (loadout) => {
    const f = new BossFight(NIGHTMARE_STANDARD, FREUD, [], hooks, undefined, undefined, loadout);
    for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);
    return f.castBasic(1.0).damage;
  };
  const base = hit({});
  const maxGear = 1 + GEAR_SET_BONUS[GEAR_SET_BONUS.length - 1];
  const maxPet = 1 + PET_STAT_LADDER[PET_STAT_LADDER.length - 1];
  const gearRatio = hit({ gear: maxGear }) / base;
  const petRatio = hit({ petDamage: maxPet }) / base;
  const bothRatio = hit({ gear: maxGear, petDamage: maxPet }) / base;
  const overRatio = hit({ gear: 1.5 }) / base; // must CLAMP, not pay
  console.log(
    `pipeline: gear ×${gearRatio.toFixed(3)} (want ${maxGear}), pet ×${petRatio.toFixed(3)} (want ${maxPet}), ` +
      `both ×${bothRatio.toFixed(3)}, gear-1.5 clamps to ×${overRatio.toFixed(3)} (cap ${COMBAT.maxGear})`
  );
  if (Math.abs(gearRatio - maxGear) > 1e-9) fail(`gear term paid ${gearRatio}, want ${maxGear}`);
  if (Math.abs(petRatio - maxPet) > 1e-9) fail(`pet Attack term paid ${petRatio}, want ${maxPet}`);
  if (Math.abs(bothRatio - maxGear * maxPet) > 1e-9) fail("gear × pet did not compose");
  if (Math.abs(overRatio - COMBAT.maxGear) > 1e-9) {
    fail(`an over-cap gear term paid ×${overRatio} — the 12% Rule clamp is broken`);
  }
  // The top of the authored ladder IS the cap — docs/09 §2 ends at 12% so no
  // upgrade step is silently wasted against the resolveHit clamp.
  if (maxGear > COMBAT.maxGear + 1e-9) fail(`GEAR_SET_BONUS tops out over COMBAT.maxGear`);
  // resolveLoadout: an exclusive pet must not pay stats to the wrong hero.
  const wrongHero = resolveLoadout({ hat: 4, body: 4, gloves: 4, pants: 4, shoes: 4 }, "druzhok", 3, "freud");
  if (wrongHero.focusRegen !== 1) fail("Druzhok's Focus stat leaked onto Freud");
  if (Math.abs(wrongHero.gear - gearMultiplier({ hat: 4, body: 4, gloves: 4, pants: 4, shoes: 4 })) > 1e-9) {
    fail("resolveLoadout gear term disagrees with gearMultiplier");
  }
  Math.random = realRandom;
  console.log("CHECK 1 (loadout terms in the pipeline, 12% clamp): PASSED");
}

// ---------------------------------------------------------------------------
// The driven 3-man fight — same competent-player script as the practice
// check, with team-wide boost knobs the docs/09 receipts were measured with.
// ---------------------------------------------------------------------------
const DT = 0.1;
const GCD_S = 1.5;
const SLOT_CD_S = 3.0;
const PALETTE_FOCUS = 8;
const BEATS = [0.8, 1.0, 1.5];

function run(diffKey, { teamDmg = 1, teamHeal = 1, teamHp = 1, loadout = {}, potions = {} } = {}) {
  const spec = DIFFICULTY[diffKey];
  const script = { ...NIGHTMARE_STANDARD, heroHp: Math.round(NIGHTMARE_STANDARD.heroHp * teamHp) };
  const bots = practiceBotsFor("freud").map((b) => ({
    ...b,
    baseDamage: b.baseDamage * teamDmg,
    skillBase: b.skillBase * teamDmg,
    ...(b.healBase ? { healBase: b.healBase * teamHeal } : {}),
  }));
  let playerDead = false;
  let focus = 100;
  let taken = 0;
  let healed = 0;
  const fight = new BossFight(
    script,
    FREUD,
    bots,
    {
      announce: () => {}, setBossPhase: () => {}, bossStrike: () => {},
      damagePlayer: (n) => (taken += n),
      healPlayer: (n) => (healed += n),
      playerBuff: () => {}, lockPaletteSlot: () => {}, playerHitReaction: () => {},
      gainFocus: (n) => (focus = Math.min(100, focus + n)),
      combatantDied: (_n, isPlayer) => { if (isPlayer) playerDead = true; },
      fightEnd: () => {},
    },
    { hpMult: spec.hpMult, dmgMult: spec.dmgMult },
    potions,
    loadout
  );

  let t = 0, gcdAt = 0, basicAt = 0, defenseAt = 0, p2Stage = -1;
  const slotAt = FREUD.palette.map(() => 0);
  while (t < 900) {
    fight.tick(DT);
    t += DT;
    focus = Math.min(100, focus + 2 * DT);
    const snap = fight.snapshot();
    if (snap.phase === "dead") return { win: true, t };
    if (playerDead) return { win: false, t };
    if (snap.phase === "idle") continue;
    if (snap.phase === "p2") {
      const stage = Math.min(4, Math.floor((30 - snap.phaseRemainingS) / 6));
      if (stage !== p2Stage) { p2Stage = stage; fight.notifyP2Stage(stage); }
    } else p2Stage = -1;
    if (t >= basicAt) {
      basicAt = t + FREUD.basic.cooldownMs / 1000;
      const hit = fight.castBasic(BEATS[Math.floor(t / 1.5) % 3]);
      if (hit) fight.landHit(hit);
    }
    if (t < gcdAt) continue;
    if (t >= defenseAt && focus >= FREUD.defense.focusCost && taken - healed > 120) {
      defenseAt = t + FREUD.defense.cooldownMs / 1000;
      focus -= FREUD.defense.focusCost;
      gcdAt = t + GCD_S;
      fight.castDefense();
      continue;
    }
    if (focus < PALETTE_FOCUS) continue;
    let idx = -1;
    if (snap.phase === "p2" && snap.p2Stage >= 0) {
      if (t >= slotAt[snap.p2Stage]) idx = snap.p2Stage;
    } else {
      idx = slotAt.findIndex((r) => t >= r);
    }
    if (idx >= 0) {
      const hit = fight.castPalette(idx, BEATS[Math.floor(t / 1.5) % 3]);
      if (hit) {
        slotAt[idx] = t + SLOT_CD_S;
        focus -= PALETTE_FOCUS;
        gcdAt = t + GCD_S;
        fight.landHit(hit);
      }
    }
  }
  return { win: false, t };
}

const N = 9;
const wins = (diff, opts) => Array.from({ length: N }, () => run(diff, opts)).filter((r) => r.win).length;

// Full progression per docs/09: gear ×1.12, pet stats ×1.15. The player
// carries an Attack pet (gear+pet on their own hits, HP stat on their pool);
// bot teammates stand in for equally-progressed players via team knobs.
const GEAR = 1 + GEAR_SET_BONUS[GEAR_SET_BONUS.length - 1];
const PET = 1 + PET_STAT_LADDER[PET_STAT_LADDER.length - 1];
const FULL = {
  teamDmg: GEAR * PET,
  teamHeal: PET,
  teamHp: PET,
  loadout: { gear: GEAR, petDamage: PET, hpMult: PET },
};
const COFFEE = { damage: 1.2, healing: 1.2 }; // server/coffee.mjs Latte/Americano S

// 2. Standard stays free.
const std = wins("standard", {});
console.log(`standard ungeared: ${std}/${N} wins`);
if (std < Math.ceil(N * 0.7)) fail(`STANDARD should clear ungeared — won ${std}/${N}`);

// 3. Hard does not fall to progression alone.
const hardGeared = wins("hard", FULL);
console.log(`hard, full gear+pets, no coffee: ${hardGeared}/${N} wins (must be 0)`);
if (hardGeared > 0) fail("HARD cleared on gear+pets alone — the ladder lost its consumable rung");

// 4. Hard falls to the full stack.
const hardFull = wins("hard", {
  ...FULL,
  teamDmg: FULL.teamDmg * 1.2,
  teamHeal: FULL.teamHeal * 1.2,
  potions: COFFEE,
});
console.log(`hard, full gear+pets+coffees: ${hardFull}/${N} wins (majority must win)`);
if (hardFull < Math.ceil(N * 0.5)) fail(`HARD should clear at the full stack — won ${hardFull}/${N}`);

// 5. Nightmare stays stat-proof.
const nm = wins("nightmare", {
  ...FULL,
  teamDmg: FULL.teamDmg * 1.2,
  teamHeal: FULL.teamHeal * 1.2,
  potions: COFFEE,
});
console.log(`nightmare, maximum stack: ${nm}/${N} wins (must be 0)`);
if (nm > 0) fail("NIGHTMARE cleared on stats — it must stay mechanics-gated");

console.log("\nLOADOUT LADDER CHECKS PASSED");
