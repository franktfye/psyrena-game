/**
 * Headless sanity check for the boss fight sim (not shipped — dev tool).
 * Bundles shared/fight/bossFight.ts with esbuild and drives it with a scripted
 * "reasonable player" to verify: phase script + warnings, P2 answer mechanic
 * with Fixation, threat stances, a kill before enrage, and Pavlov's kit
 * against the role contract. The fight is SOLO — the sim allies are gone
 * (only real players engage the boss), so the boss's HP and outgoing both
 * ride the size-scaled corner (hpByTeamSize[1], BossFight.sizeMult) and the
 * scripted player weaves Defense on cooldown to survive what the tank+healer
 * pair used to absorb.
 *
 * Run: node tools/sim-check.mjs
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const out = join(mkdtempSync(join(tmpdir(), "psyrena-sim-")), "sim.mjs");
await build({
  entryPoints: ["shared/fight/bossFight.ts"],
  bundle: true,
  format: "esm",
  outfile: out,
  logLevel: "silent",
});
const { BossFight } = await import(pathToFileURL(out).href);
const { resolveHit, COMBAT } = await import(pathToFileURL(await bundle("shared/combat.ts")).href);
const { NIGHTMARE_STANDARD } = await import(
  pathToFileURL(await bundle("shared/bosses/nightmare.ts")).href
);
const { FREUD } = await import(pathToFileURL(await bundle("shared/heroes/freud.ts")).href);
const { PAVLOV, PAVLOV_CONDITIONING } = await import(
  pathToFileURL(await bundle("shared/heroes/pavlov.ts")).href
);
const { THREAT } = await import(pathToFileURL(await bundle("shared/combat.ts")).href);

async function bundle(entry) {
  const f = join(mkdtempSync(join(tmpdir(), "psyrena-sim-")), "mod.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", outfile: f, logLevel: "silent" });
  return f;
}

const announcements = [];
const locks = [];
const debuffs = [];
let playerDamageTaken = 0;
let playerHealed = 0;
let phaseSets = [];

const hooks = {
  announce: (t) => announcements.push(t),
  setBossPhase: (p) => phaseSets.push(p),
  bossStrike: () => {},
  damagePlayer: (n) => (playerDamageTaken += n),
  healPlayer: (n) => (playerHealed += n),
  playerBuff: (name, ms, kind) => kind === "debuff" && debuffs.push(name),
  lockPaletteSlot: (i, ms) => locks.push({ i, ms }),
  playerHitReaction: () => {},
};

const fight = new BossFight(NIGHTMARE_STANDARD, FREUD, [], hooks);

const DT = 0.1;
let t = 0;
let nextCastAt = 0;
let ultReadyAt = 0;
let defenseReadyAt = 0;
let p2Stage = -1;
let p3MaxStacks = 0;
let prevP3Hp = null;
const p3QuietDeltas = []; // hp change on P3 ticks (regen − wound DoT ± hits)
let fixationTested = false;
let fixationDamage = null;
let fixationExpected = null;
let normalDamage = null;

// Scripted competent player: palette on every GCD, the CORRECT stage during
// P2, ult whenever 6+ Marks and off cooldown. One deliberate wrong answer in
// the first P2 to prove Fixation fires.
while (t < 500 && fight.snapshot().phase !== "dead") {
  fight.tick(DT);
  t += DT;
  const snap = fight.snapshot();

  // P3 Fortress: the P2 wounds must still be live, and their DoT must tick
  // through the armor. Quiet ticks (no hit landing) change hp by exactly
  // (regen − stacks·DoT)·dt, so the most common positive delta exposes both.
  if (snap.phase === "p3") {
    p3MaxStacks = Math.max(p3MaxStacks, snap.debuffStacks);
    if (prevP3Hp !== null && snap.hp > prevP3Hp) p3QuietDeltas.push(snap.hp - prevP3Hp);
    prevP3Hp = snap.hp;
  } else {
    prevP3Hp = null;
  }

  // The scene forwards doll-stage events; here we derive them from phase time.
  if (snap.phase === "p2") {
    const stage = Math.min(4, Math.floor((NIGHTMARE_STANDARD.phases[1].durationS - snap.phaseRemainingS) / 6));
    if (stage !== p2Stage) {
      p2Stage = stage;
      fight.notifyP2Stage(stage);
    }
  }

  // Solo has no pocket healer: Defense Mechanism on cooldown is the whole
  // sustain plan, exactly what a competent solo player does.
  if (t >= defenseReadyAt && snap.phase !== "idle") {
    defenseReadyAt = t + FREUD.defense.cooldownMs / 1000;
    fight.castDefense();
  }

  if (t >= nextCastAt && snap.phase !== "idle") {
    // Not every GCD: the real bar is Focus-gated, so a player sustains about
    // one palette cast per 3 s, not the theoretical 1.5 s ceiling. (Solo the
    // boss is 30k — a GCD-perfect spammer with infinite Focus kills it inside
    // P1/P2 of the first cycle and the phase-coverage checks go blind.)
    nextCastAt = t + 3;
    if (snap.marks >= 6 && t >= ultReadyAt) {
      ultReadyAt = t + 60;
      // No projectile in the headless sim — the eye lands immediately and the
      // 5-tick payout runs on the sim clock like any other DoT.
      fight.landUltimate(fight.castUltimate());
      continue;
    }
    let idx = 0;
    if (snap.phase === "p2") {
      idx = snap.p2Stage >= 0 ? snap.p2Stage : 0;
      if (!fixationTested && snap.p2Stage === 1) {
        fixationTested = true;
        idx = 3; // wrong on purpose
        const wrong = fight.castPalette(idx, 1.0);
        fixationDamage = wrong?.damage ?? null;
        // Expected WITHOUT the penalty, from the same pipeline inputs — the
        // kit's REAL palette base (the wrong cast carries the ×0.7 itself),
        // scaled by the crit roll if it fired.
        const expected = resolveHit({
          base: FREUD.palette[0].base, beat: 1.0, marks: snap.marks, amp: snap.amp,
          gear: 1.0, format: "match", isSkill: true,
        });
        fixationExpected = expected * 0.7 * (wrong?.crit ? COMBAT.critMult : 1);
        fight.landHit(wrong);
        continue;
      }
    }
    const hit = fight.castPalette(idx, 1.1);
    if (hit) {
      if (snap.phase === "p1" && normalDamage === null) normalDamage = hit.damage;
      fight.landHit(hit);
    }
  }
}

const snap = fight.snapshot();
const threats = snap.threat;
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

const CYCLE_S = NIGHTMARE_STANDARD.phases.reduce((a, p) => a + p.durationS, 0);
const ENRAGE_S = NIGHTMARE_STANDARD.enrageCycles * CYCLE_S; // phase time only, idle excluded
console.log(`kill time: ${t.toFixed(0)}s (enrage after ${NIGHTMARE_STANDARD.enrageCycles} cycles = ${ENRAGE_S}s)`);
console.log(`phases seen: ${[...new Set(phaseSets)].join(" → ")}`);
console.log(`threat top: ${threats[0].name} (${threats[0].role}) ${Math.round(threats[0].value)}`);
console.log(`threat player: ${Math.round(threats.find((x) => x.isPlayer).value)}`);
console.log(`player damage taken: ${Math.round(playerDamageTaken)}, healed: ${Math.round(playerHealed)}`);
console.log(`fixation locks: ${JSON.stringify(locks)}, debuffs: ${JSON.stringify(debuffs)}`);
console.log(`normal palette hit: ${normalDamage?.toFixed(0)}, fixation hit: ${fixationDamage?.toFixed(0)}`);

if (snap.phase !== "dead") fail("boss not dead within 500 s");
// P3 wound bleed: full stacks live through Fortress, DoT rate exactly on-sheet.
if (p3MaxStacks !== NIGHTMARE_STANDARD.p2Debuff.maxStacks) {
  fail(`expected ${NIGHTMARE_STANDARD.p2Debuff.maxStacks} wound stacks live in P3, saw ${p3MaxStacks}`);
}
{
  const { hpMax } = snap;
  const expected =
    DT * hpMax *
    (NIGHTMARE_STANDARD.phases[2].regenPctPerS -
      p3MaxStacks * (NIGHTMARE_STANDARD.p2Debuff.dotPctMaxHpPerStackPerS / 100));
  // Mode of the positive deltas — quiet ticks all share one exact value;
  // ticks where a (armored) hit also lands are rarer and spread out.
  const counts = new Map();
  for (const d of p3QuietDeltas) {
    const key = d.toFixed(1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const mode = Number([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? NaN);
  console.log(`p3 quiet tick: +${mode} hp/tick (expected ${expected.toFixed(1)} = regen − ${p3MaxStacks} wounds)`);
  if (!(Math.abs(mode - expected) < 0.5)) {
    fail(`P3 wound DoT off-sheet: quiet ticks regen ${mode}/tick, expected ${expected.toFixed(1)}`);
  }
}
if (t > ENRAGE_S) fail("kill after enrage");
for (const p of ["p1", "p2", "p3", "p4"]) {
  if (!phaseSets.includes(p)) fail(`phase ${p} never entered`);
}
// Solo: the hate table is one row long and it is the player — every
// single-target swing lands on them (which is why sizeMult scales it down).
if (threats.length !== 1) fail(`expected a 1-row threat table, got ${threats.length}`);
if (!threats[0].isPlayer) fail("solo threat top is not the player");
if (locks.length === 0 || locks[0].ms !== 10_000) fail("fixation lock did not fire");
if (debuffs.length === 0) fail("fixation debuff indicator did not fire");
if (
  fixationDamage === null ||
  fixationExpected === null ||
  Math.abs(fixationDamage - fixationExpected) > 0.5
) {
  fail(`fixation penalty wrong: got ${fixationDamage}, expected ~${fixationExpected}`);
}
const warnings = announcements.filter((a) => a.includes("in 5 seconds"));
if (warnings.length < 4) fail(`expected >=4 phase warnings, got ${warnings.length}`);
if (!announcements.some((a) => a.includes("ENRAGE") === false && a.includes("engaged"))) {
  fail("no engage announcement");
}
if (!announcements.some((a) => a.includes("defeated"))) fail("no victory announcement");
if (playerDamageTaken <= 0) fail("player never got hit (they are the only hate target)");
if (playerHealed <= 0) fail("defense weaving never healed");
console.log("\nSCENARIO 1 (competent player): ALL CHECKS PASSED");

// ---------------------------------------------------------------------------
// Scenario 2: AFK player — with no sim allies there is nobody to hide
// behind: the boss's every swing lands on the only hero present, an
// undefended 1 000 HP pool loses to the P1 pressure inside the first cycle,
// and that one death IS the wipe. fightEnd(win=false) fires once and the sim
// freezes (defeat routes the player back to the village — there is no
// in-arena reset any more).
// ---------------------------------------------------------------------------
announcements.length = 0;
phaseSets = [];
const fightEnds = [];
const deaths = [];
const fight2 = new BossFight(NIGHTMARE_STANDARD, FREUD, [], {
  ...hooks,
  combatantDied: (name, isPlayer) => deaths.push({ name, isPlayer }),
  fightEnd: (stats) => fightEnds.push(stats),
});
let t2 = 0;
while (t2 < NIGHTMARE_STANDARD.idleS + ENRAGE_S + 300 && fightEnds.length === 0) {
  fight2.tick(DT);
  t2 += DT;
}
const snap2 = fight2.snapshot();
console.log(
  `\nscenario 2: t=${t2.toFixed(0)}s bossHp=${Math.round(snap2.hp)} deaths=${deaths.map((d) => d.name).join(", ")}`
);
console.log(`defeat announced: ${announcements.some((a) => a.includes("party has fallen"))}`);
if (fightEnds.length === 0) fail("attempt never lost");
if (fightEnds[0].win !== false) fail("defeat reported as a win");
if (deaths.length !== 1) fail(`expected exactly 1 death (the player), got ${deaths.length}`);
if (!deaths.some((d) => d.isPlayer)) fail("player never died");
// An AFK solo player must NOT limp to the enrage — dying to the mechanics
// comes first. (Enrage math itself is covered by scenario 1's countdown.)
if (t2 >= NIGHTMARE_STANDARD.idleS + ENRAGE_S) fail("AFK player survived to the enrage");
if (!snap2.threat.every((r) => !r.alive)) fail("defeat fired with a hero still alive");
if (!announcements.some((a) => a.includes("party has fallen"))) fail("defeat never announced");
// Frozen after defeat: no reset, no regen, exactly one fightEnd.
const hpAfterLoss = snap2.hp;
for (let i = 0; i < 50; i++) fight2.tick(DT);
if (fight2.snapshot().hp !== hpAfterLoss) fail("sim did not freeze after defeat");
if (fightEnds.length !== 1) fail("fightEnd fired more than once");
console.log("SCENARIO 2 (AFK solo player: P1 pressure kills, defeat, sim frozen): ALL CHECKS PASSED");

// ---------------------------------------------------------------------------
// Scenario 3: the threat stance (2026-08-03). `THREAT.tank`'s automatic 5×
// is gone — threat is 1× per point of damage unless the hero HOLDS a stance
// (shared/types.ts ThreatStance). Pavlov's *Discrimination* is the first.
//
// Threat banked / damage dealt is exact regardless of crits, phase armor or
// Marks, because `landHit` banks threat on the damage it actually dealt. So
// the ratio IS the multiplier, and this asserts it three ways: 1× with the
// stance down, the hero's own multiplier with it up, and 1× again for a hero
// who has no stance at all (Freud) even when the toggle is pressed.
// ---------------------------------------------------------------------------
function bankRatio(hero, stanceOn) {
  const f = new BossFight(NIGHTMARE_STANDARD, hero, [], hooks);
  // Idle out, then get into P1 where the boss takes full damage.
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);
  f.setThreatStance(stanceOn);
  const mine = () => f.snapshot().threat.find((r) => r.isPlayer).value;
  const before = mine();
  let dealt = 0;
  for (let i = 0; i < 40; i++) {
    dealt += f.landHit(f.castBasic(1.0));
    f.tick(DT);
  }
  return { ratio: (mine() - before) / dealt, active: f.threatStanceActive };
}

const stanceOff = bankRatio(PAVLOV, false);
const stanceOn = bankRatio(PAVLOV, true);
const noStance = bankRatio(FREUD, true);
console.log(
  `\nscenario 3: Pavlov banks ${stanceOff.ratio.toFixed(2)}× with Discrimination down, ` +
    `${stanceOn.ratio.toFixed(2)}× held (stance says ${PAVLOV.threatStance.multiplier}×); ` +
    `Freud (no stance) ${noStance.ratio.toFixed(2)}×`
);
if (Math.abs(stanceOff.ratio - THREAT.damage) > 1e-6) {
  fail(`stance down should bank ${THREAT.damage}×, banked ${stanceOff.ratio}`);
}
if (Math.abs(stanceOn.ratio - PAVLOV.threatStance.multiplier) > 1e-6) {
  fail(`stance held should bank ${PAVLOV.threatStance.multiplier}×, banked ${stanceOn.ratio}`);
}
if (!stanceOn.active || stanceOff.active) fail("threatStanceActive disagrees with the stance");
// The rule change with teeth: a hero whose data says "tank" but who has no
// stance authored can no longer get the multiplier for free. Freud is not a
// tank, but he is the hero in the repo with no stance — same assertion.
if (Math.abs(noStance.ratio - THREAT.damage) > 1e-6) {
  fail(`a hero with no stance must bank ${THREAT.damage}×, banked ${noStance.ratio}`);
}
if (noStance.active) fail("a hero with no stance reported an active stance");
if (THREAT.tank !== undefined) fail("THREAT.tank is back — the automatic tank 5× must stay dead");
console.log("SCENARIO 3 (threat stance replaces the automatic tank 5×): ALL CHECKS PASSED");

// ---------------------------------------------------------------------------
// Scenario 4: Pavlov's kit against the role contract (doc 08 §3).
//
// Re-derives every base from `(budget × weight × share) ÷ (casts/s × beat)`
// and checks the shipped integers land on it. This is the guard that keeps
// shared/heroes/pavlov.ts honest when someone "just nudges" a number: the
// boss's HP curve is derived FROM these budgets, so a nudge here is a stealth
// difficulty change everywhere.
// ---------------------------------------------------------------------------
const CONTRACT = {
  budget: 95, // reference DPS for a base-100 hero
  rates: { s1: 7.5, s2: 5, s3: 2.4, s4: 1, s5: 24.1 }, // casts per minute
  // Half of skill casts land on the payoff beat; F is quoted per cast; `basic`
  // is the average of the three beats. All three apply only to a hero who HAS
  // a beat cycle — Pavlov no longer does (shared/heroes/pavlov.ts `beats`), so
  // every one of his slots derives at 1.0 and every base sits correspondingly
  // higher for the same share. `bf` below is the switch, and it is what makes
  // deleting a beat set without re-deriving fail this check.
  beat: { skill: 1.2, basic: 1.1, flat: 1 },
  // Tank row, with Pavlov's documented E/R swap: E carries the 15% (as a team
  // heal), R the 5% damage. E+R = 20% either way, which is the bucket the
  // optimizer checks.
  share: { s1: 0.35, s2: 0.15, s3: 0.05, s4: 0.2, s5: 0.25 },
  ultimate: { dmg: 0.75, heal: 0.25, direct: 0.3, foreignMix: 1.25 },
  // `pairingsToCondition` is a 1..3 roll averaging 2, and the budget prices ~1
  // pairing per UCS, so an expected TWO UCS arm one CS and the S1 slot's 7.5
  // casts/min run 5.0 : 2.5. Derived from the spec below rather than written
  // out, so the day someone widens the roll this check moves with it.
  csCadence: null, // filled in from PAVLOV_CONDITIONING once it is in scope
};
{
  // Expected pairings per CS = the mean of the inclusive 1..3 roll. At the ~1
  // pairing per UCS the NS cooldown holds (checked below), that is the number
  // of UCS casts each CS costs, which splits the S1 slot's 7.5 casts/min.
  const { min, max } = PAVLOV_CONDITIONING.pairingsToCondition;
  const perCs = (min + max) / 2;
  const cs = CONTRACT.rates.s1 / (perCs + 1);
  CONTRACT.csCadence = { ucs: CONTRACT.rates.s1 - cs, cs };
  console.log(
    `  CS cadence: pairings roll ${min}..${max} (mean ${perCs}) → ${CONTRACT.csCadence.ucs.toFixed(3)} UCS : ${cs.toFixed(3)} CS per minute`
  );
}
const weight = PAVLOV.baseDamage / 100;
const perCast = (slot, beat) =>
  (CONTRACT.budget * weight * CONTRACT.share[slot]) / ((CONTRACT.rates[slot] / 60) * beat);
// Doc 02 quotes every base as a fixed integer, so the shipped number must be
// the derived one ROUNDED — nothing looser. (A percentage tolerance would have
// to be wide enough to cover the smallest base's rounding cost, which for the
// 64-point S3 is 0.5%, and that width is enough to hide a real edit.)
const exact = (label, got, want) => {
  const off = Math.abs(got - want) / want;
  console.log(`  ${label}: ${got} vs ${want.toFixed(2)} derived (${(off * 100).toFixed(2)}% rounding)`);
  if (got !== Math.round(want)) fail(`${label} is ${got}, but the contract derives ${want.toFixed(2)} → ${Math.round(want)}`);
};
const near = (label, got, want, tolPct) => {
  const off = Math.abs(got - want) / want;
  console.log(`  ${label}: ${got} vs ${want.toFixed(2)} derived (${(off * 100).toFixed(2)}% off)`);
  if (off > tolPct / 100) fail(`${label} off contract by ${(off * 100).toFixed(2)}% (max ${tolPct}%)`);
};

console.log(`\nscenario 4: Pavlov vs the tank row at weight ${weight} (budget ${CONTRACT.budget * weight}/s)`);
const shareSum = Object.values(CONTRACT.share).reduce((a, b) => a + b, 0);
if (Math.abs(shareSum - 1) > 1e-9) fail(`contract shares sum to ${shareSum}, not 1`);
if (PAVLOV.role !== "tank") fail(`Pavlov's role is ${PAVLOV.role}, but his numbers derive at the tank weight`);
const flat = PAVLOV.beats === undefined;
const bfBasic = flat ? CONTRACT.beat.flat : CONTRACT.beat.basic;
const bfSkill = flat ? CONTRACT.beat.flat : CONTRACT.beat.skill;
console.log(`  beat cycle: ${flat ? "NONE — every slot derives at x1" : "yes"}`);
exact("S5 NS basic", PAVLOV.basic.base, perCast("s5", bfBasic));
// S1 is spent lumpy across UCS + CS; what must hold is the SLOT's per-minute total.
{
  const ucs = PAVLOV.palette.find((p) => p.id === "pavlov.ucs").base;
  const cs = PAVLOV.palette.find((p) => p.id === "pavlov.cs").base;
  const got = CONTRACT.csCadence.ucs * ucs + CONTRACT.csCadence.cs * cs;
  near("S1 UCS+CS per minute", got, perCast("s1", bfSkill) * CONTRACT.rates.s1, 0.5);
}
exact("S2 Spontaneous Recovery heal", PAVLOV.defense.heal, perCast("s2", bfSkill));
exact("S3 Generalization", PAVLOV.chain.base, perCast("s3", bfSkill));
{
  const f = (CONTRACT.budget * weight * CONTRACT.share.s4) / (CONTRACT.rates.s4 / 60);
  exact("S4 Extinction direct", PAVLOV.ultimate.base, f * CONTRACT.ultimate.dmg * CONTRACT.ultimate.direct);
  exact(
    "S4 Extinction per Mark",
    PAVLOV.ultimate.perMark,
    (f * CONTRACT.ultimate.dmg * (1 - CONTRACT.ultimate.direct)) /
      (PAVLOV.ultimate.maxMarksConsumed * CONTRACT.ultimate.foreignMix)
  );
  exact("S4 Extinction team heal", PAVLOV.ultimate.heal, f * CONTRACT.ultimate.heal);
}
// Generalization must keep sourcing the sheet's assumed +15% attack buff at
// 0.60 coverage (`buffs.attack`), or the boss's HP curve silently gets easier.
{
  const vuln = PAVLOV.chain.effects.find((e) => e.kind === "vulnerability");
  const duty = vuln.durationMs / PAVLOV.chain.cooldownMs;
  console.log(`  Generalization: +${vuln.magnitude * 100}% for ${vuln.durationMs / 1000}s / ${PAVLOV.chain.cooldownMs / 1000}s CD = ${duty.toFixed(2)} duty`);
  if (Math.abs(vuln.magnitude - 0.15) > 1e-9) fail("vulnerability is no longer the sheet's +15%");
  if (Math.abs(duty - 0.6) > 1e-9) fail(`duty ${duty.toFixed(2)} ≠ the sheet's 0.60 buffs.attack coverage`);
}
// The 3:1 UCS:CS cadence is only real if a UCR window cannot be stuffed with
// bells: the NS cooldown must keep it to ≤2 rings per window (mash ≈ 1.2
// expected pairings per UCS — the ~1 the budget prices; at Freud's 600 ms it
// was 7 rings, ~3.6 pairings, a 1:1 cadence paying the slot +36%) while still
// leaving slack to deliver the basic's own 24.1 casts/min share.
{
  const cdS = PAVLOV.basic.cooldownMs / 1000;
  const bells = Math.ceil(PAVLOV_CONDITIONING.ucrWindowS / cdS);
  const maxRate = 60 / cdS;
  console.log(
    `  NS cadence: ${cdS}s CD → ${bells} bells per ${PAVLOV_CONDITIONING.ucrWindowS}s UCR window, ${maxRate.toFixed(1)}/min max vs ${CONTRACT.rates.s5} budgeted`
  );
  if (bells > 2) fail(`NS CD ${cdS}s fits ${bells} bells in one UCR window — pairing spam re-opens the +36% S1 leak`);
  if (maxRate < CONTRACT.rates.s5 * 1.15) {
    fail(`NS CD ${cdS}s caps the basic at ${maxRate.toFixed(1)}/min — not enough slack to deliver the budgeted ${CONTRACT.rates.s5}/min`);
  }
}
// Backward pairing must be time-bounded and the E refund gated — either leak
// mints free CS at normal play rates (~1.6/min and ~1.25/min extra against a
// budget of 1.875 total).
{
  const g = PAVLOV_CONDITIONING.backwardGraceS;
  if (!(g > 0 && g <= PAVLOV_CONDITIONING.ucrWindowS)) {
    fail(`backwardGraceS is ${g} — backward pairing must be bounded (0 < grace ≤ ucrWindowS)`);
  }
  const refund = PAVLOV.defense.effects.find((e) => e.kind === "pairing.refund");
  if (!refund || refund.requiresSelfState !== "extinguished") {
    fail("pairing.refund must be gated requiresSelfState:'extinguished' — ungated it is a +24% S1 budget leak");
  }
}
// The pairing's Focus reward belongs to S1 — the food — and NOT to the bell.
// On the basic it would pay for pressing a button; on S1 it can only be earned
// by a bell and a food that actually met.
{
  const onPalette = PAVLOV.palette.find((p) => p.effects.some((e) => e.kind === "pairing.focus"));
  const grant = onPalette?.effects.find((e) => e.kind === "pairing.focus");
  if (!grant || !(grant.magnitude > 0)) fail("S1 lost its pairing.focus reward");
  if (PAVLOV.basic.effects.some((e) => e.kind === "pairing.focus")) {
    fail("pairing.focus is on the bell — it must sit on S1, or ringing alone pays Focus");
  }
  // Ceiling check: banking stops while CONDITIONED, so pairing events cannot
  // outrun pairingsToCondition × the CS rate. The target is a 1..3 roll now,
  // so the ceiling takes the WORST case (max — the slowest cycle banks the
  // most pairings). Keep the earn under a third of the 120/min pool regen or
  // Focus stops being a constraint on this hero.
  const maxPairings = PAVLOV_CONDITIONING.pairingsToCondition.max;
  const csPerMin = CONTRACT.rates.s1 / (maxPairings + 1);
  const focusPerMin = csPerMin * maxPairings * grant.magnitude;
  console.log(
    `  pairing reward: ${grant.magnitude} Focus × ≤${(csPerMin * maxPairings).toFixed(1)} pairings/min = ${focusPerMin.toFixed(0)}/min vs 120/min regen`
  );
  if (focusPerMin > 40) fail(`pairing.focus pays up to ${focusPerMin.toFixed(0)} Focus/min — a third of the pool's own regen`);
}
// The dome is a BOSS-side outgoing cut, not player mitigation — that is the
// only reason a 60% number can coexist with the 0.40 mitigation cap.
{
  const dome = PAVLOV.ultimate.effects.find((e) => e.kind === "zone.extinction");
  if (!dome || dome.magnitude <= COMBAT.maxMitigation) fail("Extinction's dome lost its boss-side magnitude");
  const mits = [
    ...PAVLOV.palette.flatMap((p) => p.effects.filter((e) => e.kind === "mitigation.grant")),
    PAVLOV.defense.mitigation,
  ].map((m) => m.magnitude);
  const stacked = mits.reduce((a, b) => a + b, 0);
  console.log(`  mitigation from the kit: ${mits.join(" + ")} = ${stacked} (cap ${COMBAT.maxMitigation}), dome ${dome.magnitude} boss-side`);
  if (stacked > COMBAT.maxMitigation) fail(`Pavlov alone stacks ${stacked} mitigation, over the ${COMBAT.maxMitigation} cap`);
}
console.log("SCENARIO 4 (Pavlov on the tank row of the role contract): ALL CHECKS PASSED");

// ---------------------------------------------------------------------------
// Scenario 5: Pavlov's conditioning loop, end to end through the live sim.
//
// Math.random is pinned to 0.999 for the whole scenario, which makes the run
// deterministic AND meaningful: no crits (0.999 > critChance), simultaneous/
// backward pairings never take (0.999 ≥ their chances) — so every Pairing
// below is the DELAY pairing (chance 1.0), the play the budget's skill
// ceiling is about. Casts within one tick share simT, so damage comparisons
// are exact ratios.
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999;
  const condStates = [];
  const procs = [];
  const locks5 = [];
  const focusGains = [];
  const f = new BossFight(NIGHTMARE_STANDARD, PAVLOV, [], {
    ...hooks,
    lockPaletteSlot: (i, ms) => locks5.push({ i, ms }),
    defenseProc: (n) => procs.push(n),
    gainFocus: (n) => focusGains.push(n),
    conditioningChanged: (s) => condStates.push(s),
  });
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);
  const cond = () => condStates[condStates.length - 1];

  // CS is gated until his own loop opens it.
  if (f.castPalette(1, 1.0) !== null) fail("CS castable with no CONDITIONED state");

  // A bell with no food anywhere near it pairs nothing — and must therefore
  // pay no Focus. Checked BEFORE the good pairings so the counter starts
  // clean, then ticked past the UCR window so the stray bell cannot pair
  // with the loop's first food.
  f.landHit(f.castBasic(1.0));
  for (let i = 0; i < Math.ceil((PAVLOV_CONDITIONING.ucrWindowS + 2) / DT); i++) f.tick(DT);
  if (focusGains.length) fail(`a bell outside every window paid ${focusGains.join("+")} Focus`);

  // The 1..3 target is rolled with the same pinned Math.random, so it lands on
  // the TOP of the range here (1 + floor(0.999 × 3) = 3): the slowest cycle the
  // spec can produce, which is the one worth asserting — it exercises banking,
  // the cap, and the threshold in order. A player's 1-in-3 fast cycle is the
  // same code path with the roll landing on 1.
  const target = PAVLOV_CONDITIONING.pairingsToCondition.max;
  const pairingFocus = PAVLOV.palette
    .flatMap((p) => p.effects)
    .find((e) => e.kind === "pairing.focus").magnitude;
  // Bell, then food while it rings: the delay pairing takes every time, 1 each
  // — and each landed pairing pays the S1 Focus reward exactly once.
  for (let p = 1; p <= target; p++) {
    f.landHit(f.castBasic(1.0));
    f.landHit(f.castPalette(0, 1.0));
    if (focusGains.length !== p || focusGains[p - 1] !== pairingFocus) {
      fail(`pairing ${p} paid [${focusGains.join(", ")}] Focus, expected ${p} × ${pairingFocus}`);
    }
    if (p < target) {
      if (cond()?.pairings !== p || cond()?.conditioned) {
        fail(`after ${p} delay pairing(s) the sim reports ${cond()?.pairings ?? "nothing"} banked, expected ${p}`);
      }
    } else if (!cond()?.conditioned) {
      fail(`${target} pairings did not condition the boss`);
    }
  }
  // Banking resets on condition, so the next cycle starts from zero.
  if (cond()?.pairings !== 0) fail(`pairings did not reset on CONDITIONED (${cond()?.pairings})`);

  // CS: castable now, pays 3 Marks, consumes the state.
  const cs = f.castPalette(1, 1.0);
  if (!cs) fail("CS refused while CONDITIONED");
  f.landHit(cs);
  if (f.snapshot().marks !== 3) fail(`CS placed ${f.snapshot().marks} Marks, expected 3 (mark.grant)`);
  if (cond()?.conditioned) fail("CS did not consume CONDITIONED");
  if (f.castPalette(1, 1.0) !== null) fail("CS castable after its state was consumed");

  // NO BEAT CYCLE: the sim must ignore the beat argument for this hero on
  // every slot, not just the basic. Catches the cycle being wired back in.
  const bellLow = f.landHit(f.castBasic(0.8));
  const bellHigh = f.landHit(f.castBasic(1.5));
  if (bellLow !== bellHigh) {
    fail(`bell paid ${bellLow} at beat 0.8 and ${bellHigh} at 1.5 — a beatless hero is riding the cycle`);
  }
  const ucsLow = f.landHit(f.castPalette(0, 0.8));
  const ucsHigh = f.landHit(f.castPalette(0, 1.5));
  if (ucsLow !== ucsHigh) {
    fail(`UCS paid ${ucsLow} at beat 0.8 and ${ucsHigh} at 1.5 — a beatless hero is riding the cycle`);
  }

  // Generalization: the boss takes exactly +15% from the same hit afterward.
  const d1 = f.landHit(f.castBasic(1.0));
  f.landHit(f.castChain(1.0));
  const d2 = f.landHit(f.castBasic(1.0));
  if (Math.abs(d2 / d1 - 1.15) > 1e-9) {
    fail(`vulnerability multiplied a basic by ${(d2 / d1).toFixed(4)}, expected exactly 1.15`);
  }

  // The CR debuff: with the beat gate gone, every Nth bell staggers the boss.
  // Counted from a known point rather than "did it ever proc" — the old test
  // passed on whichever bell happened to be third, which would have kept
  // passing if the counter were off by one.
  const every = PAVLOV_CONDITIONING.crStaggerEveryNthBell;
  const crProcs = () => procs.filter((p) => p === "Conditioned Response").length;
  // Bells have already been rung above, so first walk to a proc to learn where
  // in its cycle the counter sits. Inside `every` bells one MUST land.
  let aligned = false;
  for (let i = 0; i < every && !aligned; i++) {
    const was = crProcs();
    f.castBasic(1.0);
    aligned = crProcs() === was + 1;
  }
  if (!aligned) fail(`no CR stagger in ${every} consecutive bells while the response was up`);
  // Now the counter is on a boundary, so the next full cycle is exact.
  const before = crProcs();
  for (let i = 1; i < every; i++) f.castBasic(1.0);
  if (crProcs() !== before) fail(`a bell before the ${every}th of its cycle proc'd the CR stagger`);
  f.castBasic(1.0);
  if (crProcs() !== before + 1) fail(`the ${every}th bell did not proc exactly one CR stagger`);

  // Extinction: pays out the Marks, wipes his own conditioning.
  const total = f.castUltimate();
  if (!(total > 0)) fail("Extinction fizzled with 3 Marks banked");
  if (!cond()?.extinguished || cond()?.conditioned) fail("Extinction did not leave him extinguished");
  if (f.castPalette(1, 1.0) !== null) fail("CS castable after Extinction wiped the conditioning");

  // Spontaneous Recovery: one free Pairing back — and only one per extinction.
  const focusBeforeE = focusGains.length;
  f.castDefense();
  if (cond()?.pairings !== 1) fail(`post-Extinction E refunded ${cond()?.pairings}, expected 1`);
  // The refund is a GIFT, not a pairing: no bell met any food, so S1's reward
  // must not fire. Otherwise E turns 20 Focus into a partial rebate on itself.
  if (focusGains.length !== focusBeforeE) fail("E's Pairing refund paid the S1 pairing Focus");
  f.castDefense();
  if (cond()?.pairings !== 1) fail("E refunded a second Pairing in the same extinction");
  // Team heal on a full-HP player converts to Amp through the doc-02 overheal rule.
  if (!(f.snapshot().amp > 0)) fail("team heal produced no Amp from a full-HP player's share");

  // Chain kits never Fixate: ride into P2 and answer "wrongly" on purpose.
  let guard = 0;
  while (f.snapshot().phase !== "p2" && guard++ < 5000) f.tick(DT);
  if (f.snapshot().phase !== "p2") fail("never reached P2");
  f.notifyP2Stage(3);
  const locksBefore = locks5.length;
  const p2hit = f.castPalette(0, 1.0);
  if (!p2hit) fail("UCS refused during P2");
  if (!p2hit.grantsDebuffStack) fail("chain-kit P2 cast did not count as a correct answer");
  f.landHit(p2hit);
  if (locks5.length !== locksBefore) fail("chain-kit palette cast Fixated in P2");
  if (f.snapshot().debuffStacks < 1) fail("chain-kit P2 cast granted no wound stack");

  Math.random = realRandom;
  console.log(
    `\nscenario 5: ${target} delay pairs (rolled target) → CONDITIONED → CS (3 Marks) → +15% vuln exact → CR stagger → Extinction wipe → E refund once → no P2 Fixation`
  );
  console.log(
    `  pairing Focus paid this run: [${focusGains.join(", ")}] — one per pairing that landed, none for the missed bell or E's refund`
  );
  console.log("SCENARIO 5 (Pavlov's conditioning loop in the live sim): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 6: Skinner's kit against the healer budget (docs 03 §7 / 08 §3).
//
// The first OFF-TEMPLATE hero: shares re-authored (20 dmg / 30 schedules /
// 20 procs / 30 ult), no beat cycle (a Fixed Ratio that varied by beat would
// not be fixed), every base at factor 1.0. This scenario restates that
// arithmetic and checks the shipped integers — the guard that keeps
// shared/heroes/skinner.ts honest.
// ---------------------------------------------------------------------------
const { SKINNER, SKINNER_REINFORCEMENT } = await import(
  pathToFileURL(await bundle("shared/heroes/skinner.ts")).href
);
{
  const S = SKINNER_REINFORCEMENT;
  const budgetPerMin = 95 * (SKINNER.baseDamage / 100) * 60; // 3,420
  if (SKINNER.role !== "healer") fail("Skinner is not a healer");
  if (SKINNER.beats) fail("Skinner grew a beat cycle — a Fixed Ratio must stay fixed");
  if (!SKINNER.reinforcement) fail("Skinner has no reinforcement spec");

  // Schedules: one shared cast budget (7.5/min), equal EV 137 by design.
  const scheduleEV = (budgetPerMin * 0.3) / 7.5;
  exact("schedule EV (FR total)", S.schedules.fixedRatio.teamTotal, scheduleEV);
  const vrEV =
    S.schedules.variableRatio.low * (1 - S.schedules.variableRatio.highChance) +
    S.schedules.variableRatio.high * S.schedules.variableRatio.highChance;
  exact("VR expected value", vrEV, scheduleEV);
  const fiTicks = S.schedules.fixedInterval.durationMs / S.schedules.fixedInterval.periodMs;
  near("FI per-cast total", S.schedules.fixedInterval.tickTeamTotal * fiTicks, scheduleEV, 1.5);
  const viTicks =
    (S.schedules.variableInterval.durationMs / 1000) * S.schedules.variableInterval.tickChancePerSec;
  near("VI expected per-cast total", S.schedules.variableInterval.tickTeamTotal * viTicks, scheduleEV, 1.5);

  // Procs: 20% share = 684/min. Positive at its 230-team-DPS calibration
  // (~34.2 procs/min), Negative at two clean dodgers (~20/min).
  const procBudget = budgetPerMin * 0.2;
  near("Positive proc budget", ((230 * 60) / S.positiveDamagePerProc) * S.procHeal.positive, procBudget, 1.5);
  near("Negative proc budget", (2 * (60 / S.negativeCleanSeconds)) * S.procHeal.negative, procBudget, 1.5);
  if (S.procMitigation.magnitude > COMBAT.maxMitigation) fail("Punishment proc alone exceeds the mitigation cap");

  // Ultimate: 30% = 1,026/cast → 30% direct + 70% payload at 9 expected stacks.
  const ultPerCast = budgetPerMin * 0.3;
  exact("Shaping direct (ult.heal)", SKINNER.ultimate.heal, ultPerCast * 0.3);
  exact("Shaping per Approximation", S.shaping.perApproximation, (ultPerCast * 0.7) / 9);
  if (SKINNER.ultimate.perMark !== 0 || SKINNER.ultimate.maxMarksConsumed !== 0) {
    fail("Skinner's F consumes boss Marks — the documented exception (docs 03 §7) says it must not");
  }

  // Basic: 20% = 684/min ÷ 24.1 = 28.4 budget, authored at HALF and reached
  // only at the reference ~5 average Response Strength stacks.
  const basicBudget = (budgetPerMin * 0.2) / 24.1;
  exact("basic base (half the slot)", SKINNER.basic.base, basicBudget / 2);
  exact("Response Strength stack cost (one schedule cast)", S.responseStrength.healPerStack, scheduleEV);
  const refStacks = 5;
  near(
    "basic at reference stacks",
    SKINNER.basic.base * (1 + S.responseStrength.damagePerStack * refStacks),
    basicBudget,
    1.5
  );
  console.log(`\nscenario 6: Skinner vs the healer row at weight ${SKINNER.baseDamage / 100} (budget ${budgetPerMin}/min, off-template shares 20/30/20/30)`);
  console.log("SCENARIO 6 (Skinner vs the healer budget): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 7: Skinner's operant engine, end to end through the live sim.
// Math.random pinned per step: 0.999 kills crits and VR jackpots; 0.1 forces
// the jackpot when the slot machine is the thing under test.
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999;
  const operant = [];
  const buffs7 = [];
  const announces7 = [];
  const f = new BossFight(NIGHTMARE_STANDARD, SKINNER, [], {
    ...hooks,
    announce: (t) => announces7.push(t),
    playerBuff: (name) => buffs7.push(name),
    operantChanged: (s) => operant.push(s),
  });
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);

  // Baseline basic with zero Response Strength — half the slot budget.
  const basicCold = f.castBasic(1.0).damage;

  // Let the boss connect a few times so heals have something to heal.
  for (let i = 0; i < Math.ceil(8 / DT); i++) f.tick(DT);

  // Fixed Ratio heals the (solo) party.
  f.castPalette(0, 1.0);
  // Two more FR casts bank ≥137 effective healing → Response Strength.
  for (let i = 0; i < Math.ceil(6 / DT); i++) f.tick(DT);
  f.castPalette(0, 1.0);
  for (let i = 0; i < Math.ceil(6 / DT); i++) f.tick(DT);
  f.castPalette(0, 1.0);
  if (!buffs7.some((b) => b.startsWith("Response Strength"))) {
    fail("three FR casts into a wounded player banked no Response Strength");
  }
  const basicWarm = f.castBasic(1.0).damage;
  if (!(basicWarm > basicCold)) {
    fail(`Response Strength did not raise the basic (${basicCold} → ${basicWarm})`);
  }

  // Toggles: R flips the consequence, E flips the contingency; both report.
  if (f.operant.consequence !== "reinforcement") fail("consequence did not start at reinforcement");
  if (f.castChain(1.0) !== null) fail("consequence toggle returned a hit — it must be free of the projectile path");
  if (f.operant.consequence !== "punishment") fail("R did not flip to Punishment");
  const eLabel = f.castDefense();
  if (f.operant.contingency !== "negative" || !/Negative/.test(eLabel ?? "")) {
    fail(`E did not flip to Negative (label ${eLabel})`);
  }
  f.castDefense(); // back to positive for the proc test
  if (f.operant.contingency !== "positive") fail("E did not flip back to Positive");

  // Positive + Punishment: ~400 damage dealt → a proc → self mitigation up,
  // and an Approximation banked.
  const mitBefore = f.snapshot().mitigation;
  let guard = 0;
  while (f.snapshot().mitigation <= mitBefore && guard++ < 120) {
    const hit = f.castBasic(1.0);
    if (hit) f.landHit(hit);
    f.tick(DT);
  }
  if (f.snapshot().mitigation <= mitBefore) fail("Positive/Punishment procs never granted mitigation");
  if (!buffs7.some((b) => b.startsWith("Approximation"))) fail("procs banked no Approximation");

  // VR jackpot on demand: pin the roll under highChance.
  Math.random = () => 0.1;
  f.castPalette(1, 1.0);
  if (!announces7.some((a) => /JACKPOT/.test(a))) fail("forced VR jackpot did not announce");
  Math.random = () => 0.999;

  // Shaping consumes the banked Approximations.
  f.castUltimate();
  if (!announces7.some((a) => /releases Shaping/.test(a))) {
    fail("Shaping consumed no Approximations despite live stacks");
  }

  // Fixed Interval ticks heal over its window (the player is still wounded).
  f.castPalette(2, 1.0);
  const buffCount = buffs7.length;
  for (let i = 0; i < Math.ceil(9 / DT); i++) f.tick(DT);
  if (!buffs7.slice(buffCount - 2).some((b) => /Fixed Interval/.test(b))) {
    fail("FI cast raised no HoT buff");
  }

  Math.random = realRandom;
  console.log(
    "\nscenario 7: FR heals → Response Strength doubles the basic → toggles flip (E/R) → Positive/Punishment procs mitigation + Approximations → forced VR JACKPOT → Shaping consumes the board → FI HoT runs"
  );
  console.log("SCENARIO 7 (Skinner's operant engine in the live sim): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 8: Erikson's kit against the DPS row of the role contract.
//
// Same derivation as Pavlov's (scenario 4) on the DPS shares, with the two
// places Erikson's shape moves a rate (shared/heroes/erikson.ts header): the
// add-on basic fires once per palette cast, so S5 is priced at S1's 7.5/min;
// and S1's 7.5 casts are 3.75 PAIRS, a pair split 1/3 stage, 2/3 virtue.
// ---------------------------------------------------------------------------
const { ERIKSON, ERIKSON_PSYCHOSOCIAL } = await import(
  pathToFileURL(await bundle("shared/heroes/erikson.ts")).href
);
{
  const DPS_SHARE = { s1: 0.4, s2: 0.09, s3: 0.06, s4: 0.2, s5: 0.25 };
  const w = ERIKSON.baseDamage / 100;
  const perCastAt = (slot, perMin) => (CONTRACT.budget * w * DPS_SHARE[slot]) / (perMin / 60);
  console.log(`\nscenario 8: Erikson vs the DPS row at weight ${w} (budget ${CONTRACT.budget * w}/s)`);
  if (ERIKSON.role !== "dps") fail(`Erikson's role is ${ERIKSON.role}, but his numbers derive at the DPS row`);
  if (ERIKSON.beats) fail("Erikson grew a beat cycle — the stages are a sequence, not a clock");
  if (!ERIKSON.psychosocial) fail("Erikson has no psychosocial spec");
  if (ERIKSON_PSYCHOSOCIAL.stages.length !== 8) fail("Erikson's chart must have eight stages");

  const pairsPerMin = CONTRACT.rates.s1 / 2;
  exact("S5 add-on basic (at the palette's cadence)", ERIKSON.basic.base, perCastAt("s5", CONTRACT.rates.s1));
  const pair = perCastAt("s1", pairsPerMin);
  const stage = ERIKSON.palette.find((p) => p.id === "erikson.stage").base;
  const virtue = ERIKSON.palette.find((p) => p.id === "erikson.virtue").base;
  near("S1 stage + virtue per pair", stage + virtue, pair, 0.5);
  exact("S1 Life Stage (1/3 of a pair)", stage, pair / 3);
  exact("S2 Moratorium heal", ERIKSON.defense.heal, perCastAt("s2", CONTRACT.rates.s2));
  exact("S3 Identity Crisis", ERIKSON.chain.base, perCastAt("s3", CONTRACT.rates.s3));
  const ult = perCastAt("s4", CONTRACT.rates.s4);
  exact("S4 Life Review direct", ERIKSON.ultimate.base, ult * CONTRACT.ultimate.direct);
  // Payload priced at the virtues a reference player has when F is up: one
  // per pair, pairsPerMin per minute of cooldown, capped at maxVirtues.
  const expectedVirtues = Math.min(
    ERIKSON_PSYCHOSOCIAL.maxVirtues,
    pairsPerMin * (ERIKSON.ultimate.cooldownMs / 60_000)
  );
  exact("S4 Life Review per virtue", ERIKSON.ultimate.perMark, (ult * (1 - CONTRACT.ultimate.direct)) / expectedVirtues);
  // The pair refund must be paid for by the keys' price: a correct pair nets
  // two scaffold palette casts, or Focus (which caps every hero's cast rate)
  // lets him out-cast the budget — a flat +10 on 8-Focus keys simulated +160%.
  {
    const { PALETTE_FOCUS_COST } = await import(pathToFileURL(await bundle("shared/fight/costs.ts")).href);
    const net = ERIKSON.palette.reduce((n, p) => n + (p.focusCost ?? PALETTE_FOCUS_COST), 0) - ERIKSON_PSYCHOSOCIAL.pairFocusRefund;
    console.log(`  pair Focus: ${ERIKSON.palette.map((p) => p.focusCost).join(" + ")} − ${ERIKSON_PSYCHOSOCIAL.pairFocusRefund} refund = ${net} (scaffold pair ${2 * PALETTE_FOCUS_COST})`);
    if (net !== 2 * PALETTE_FOCUS_COST) fail(`a correct pair nets ${net} Focus, budget assumes ${2 * PALETTE_FOCUS_COST}`);
  }
  if (ERIKSON.ultimate.maxMarksConsumed !== ERIKSON_PSYCHOSOCIAL.maxVirtues) {
    fail("Life Review's consumption cap must equal the virtue cap");
  }
  // Round trip: the shipped integers at reference cadence sum back to budget.
  const realised =
    (ERIKSON.basic.base * CONTRACT.rates.s1 +
      (stage + virtue) * pairsPerMin +
      ERIKSON.defense.heal * CONTRACT.rates.s2 +
      ERIKSON.chain.base * CONTRACT.rates.s3 +
      (ERIKSON.ultimate.base + ERIKSON.ultimate.perMark * expectedVirtues) * CONTRACT.rates.s4) /
    60;
  near("kit total, DPS", realised, CONTRACT.budget * w, 0.5);
  console.log("SCENARIO 8 (Erikson on the DPS row of the role contract): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 9: Erikson's rotation, end to end through the live sim —
// 1-2 pairs, the add-on gate, the unmatched virtue, the loop past stage 8,
// and Life Review spending virtues (never the team's Marks).
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999; // no crits: damage ratios are the kit's ratios
  const states = [];
  const procs = [];
  const refunds = [];
  const f = new BossFight(NIGHTMARE_STANDARD, ERIKSON, [], {
    ...hooks,
    psychosocialChanged: (s) => states.push(s),
    defenseProc: (name) => procs.push(name),
    gainFocus: (n) => refunds.push(n),
  });
  const ps = () => f.psychosocialFor("player");
  if (!states.length || states[0].stage !== 0) fail("the opening stage was not reported before the first press");
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);

  if (f.castBasic(1.0) !== null) fail("the add-on fired before any key 1 or 2");
  const stageHit = f.castPalette(0, 1.0);
  if (!ps().armed || !ps().addon) fail("key 1 did not arm the virtue and grant the add-on");
  if (f.castBasic(1.0) === null) fail("the add-on after key 1 was refused");
  if (f.castBasic(1.0) !== null) fail("a second add-on fired off one key 1");
  const virtueHit = f.castPalette(1, 1.0);
  if (ps().stage !== 1 || ps().virtues !== 1 || ps().armed) fail(`key 2 did not complete stage 1 (${JSON.stringify(ps())})`);
  if (!procs.includes("Trust vs Mistrust → Hope")) fail(`the pair was not named over the boss (${procs.join(" | ")})`);
  if (refunds.join() !== String(ERIKSON_PSYCHOSOCIAL.pairFocusRefund)) fail(`a completed pair refunded [${refunds}] Focus`);
  if (f.castBasic(1.0) === null) fail("the add-on after key 2 was refused");
  const want = ERIKSON.palette[1].base / ERIKSON.palette[0].base;
  const got = virtueHit.damage / stageHit.damage;
  if (Math.abs(got / want - 1) > 0.02) fail(`virtue/stage damage ${got.toFixed(3)}, kit says ${want.toFixed(3)}`);

  // Key 2 with nothing armed: the weak hit, no stack, no advance.
  const lone = f.castPalette(1, 1.0);
  const loneWant = ERIKSON_PSYCHOSOCIAL.unmatchedVirtueMult;
  if (Math.abs(lone.damage / virtueHit.damage / loneWant - 1) > 0.02) {
    fail(`unmatched virtue paid ${(lone.damage / virtueHit.damage).toFixed(3)} of a matched one, kit says ${loneWant}`);
  }
  if (ps().stage !== 1 || ps().virtues !== 1) fail("an unmatched virtue moved the rotation");
  if (refunds.length !== 1) fail("an unmatched virtue refunded Focus");

  // Seven more pairs: the pointer walks 2..8 and loops back to stage 1.
  for (let i = 0; i < 7; i++) {
    f.castPalette(0, 1.0);
    f.castPalette(1, 1.0);
  }
  if (ps().stage !== 0) fail(`after eight pairs the pointer is at stage ${ps().stage + 1}, not back at 1`);
  if (ps().virtues !== 8) fail(`eight pairs banked ${ps().virtues} virtues`);
  f.castPalette(0, 1.0);
  f.castPalette(1, 1.0);
  if (ps().virtues !== 8) fail("virtues ran past the cap");

  // Life Review spends the virtues, leaves the stage alone and the Marks too.
  const marksBefore = f.snapshot().marks;
  const stageBefore = ps().stage;
  const ultDamage = f.castUltimate();
  if (ps().virtues !== 0) fail("Life Review did not spend the virtues");
  if (ps().stage !== stageBefore) fail("Life Review moved the stage pointer");
  if (f.snapshot().marks !== marksBefore) fail("Life Review touched the team's Mark board");
  if (!(ultDamage > ERIKSON.ultimate.base)) fail(`Life Review paid ${ultDamage}, no more than its direct share`);

  Math.random = realRandom;
  console.log(
    `\nscenario 9: gate held · pair named · virtue/stage ${got.toFixed(2)} · unmatched ${(lone.damage / virtueHit.damage).toFixed(2)} · loop past stage 8 · 8-virtue Life Review ${Math.round(ultDamage)}`
  );
  console.log("SCENARIO 9 (Erikson's life-cycle rotation in the live sim): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 10: Ainsworth on the tank row (Pavlov's derivation, his E/R swap),
// with the S1 slot spent across the four styles at the reference cadence.
// ---------------------------------------------------------------------------
const { AINSWORTH } = await import(pathToFileURL(await bundle("shared/heroes/ainsworth.ts")).href);
{
  const w = AINSWORTH.baseDamage / 100;
  console.log(`\nscenario 10: Ainsworth vs the tank row at weight ${w} (budget ${CONTRACT.budget * w}/s)`);
  if (AINSWORTH.role !== "tank") fail(`Ainsworth's role is ${AINSWORTH.role}, but her numbers derive at the tank row`);
  if (AINSWORTH.beats) fail("Ainsworth grew a beat cycle — her kit is flat");
  if (!AINSWORTH.threatStance) fail("Ainsworth has no threat stance — a tank without one banks 1×");
  const at = (slot) => (CONTRACT.budget * w * CONTRACT.share[slot]) / (CONTRACT.rates[slot] / 60);
  exact("S5 Sensitivity", AINSWORTH.basic.base, at("s5"));
  // S1: cadence (per min) and weight per style; key 4 is priced at its
  // 30 s cooldown's realistic 1.5/min, the other three share the rest.
  const STYLE = {
    "ainsworth.secure": { perMin: 2, weight: 1.0 },
    "ainsworth.avoidant": { perMin: 2, weight: 1.3 },
    "ainsworth.ambivalent": { perMin: 2, weight: 0.9 },
    "ainsworth.disorganized": { perMin: 1.5, weight: 0.5 },
  };
  const cadence = Object.values(STYLE).reduce((n, s) => n + s.perMin, 0);
  if (Math.abs(cadence - CONTRACT.rates.s1) > 1e-9) fail(`style cadence sums to ${cadence}/min, the slot runs ${CONTRACT.rates.s1}`);
  const slotPerMin = at("s1") * CONTRACT.rates.s1;
  const x = slotPerMin / Object.values(STYLE).reduce((n, s) => n + s.perMin * s.weight, 0);
  for (const p of AINSWORTH.palette) exact(`S1 ${p.name}`, p.base, x * STYLE[p.id].weight);
  const disorg = AINSWORTH.palette.find((p) => p.id === "ainsworth.disorganized");
  if (60_000 / disorg.cooldownMs < STYLE[disorg.id].perMin) fail("Disorganized is priced above what its cooldown allows");
  near("S1 per minute", AINSWORTH.palette.reduce((n, p) => n + p.base * STYLE[p.id].perMin, 0), slotPerMin, 0.5);
  exact("S2 Safe Haven heal", AINSWORTH.defense.heal, at("s2"));
  exact("S3 Strange Situation", AINSWORTH.chain.base, at("s3"));
  const f = at("s4");
  exact("S4 Earned Security direct", AINSWORTH.ultimate.base, f * CONTRACT.ultimate.dmg * CONTRACT.ultimate.direct);
  exact(
    "S4 Earned Security per Mark",
    AINSWORTH.ultimate.perMark,
    (f * CONTRACT.ultimate.dmg * (1 - CONTRACT.ultimate.direct)) / (AINSWORTH.ultimate.maxMarksConsumed * CONTRACT.ultimate.foreignMix)
  );
  exact("S4 Earned Security team heal", AINSWORTH.ultimate.heal, f * CONTRACT.ultimate.heal);
  const vuln = AINSWORTH.chain.effects.find((e) => e.kind === "vulnerability");
  const duty = vuln.durationMs / AINSWORTH.chain.cooldownMs;
  if (Math.abs(vuln.magnitude - 0.15) > 1e-9 || Math.abs(duty - 0.6) > 1e-9) {
    fail(`Strange Situation sources +${vuln.magnitude * 100}% at ${duty.toFixed(2)} duty, the sheet assumes +15% at 0.60`);
  }
  console.log("SCENARIO 10 (Ainsworth on the tank row of the role contract): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 11: Ainsworth's styles in the live sim, in a two-player party —
// the variety gate and own cooldown, team immunity (not on herself), the
// deferred-not-dropped stagger, the heal cut, the taunt, the cleanse, the
// Sensitivity answer and the threat shed.
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999; // no crits
  const procs = [];
  const lockLog = [];
  const f = BossFight.forParty(
    NIGHTMARE_STANDARD,
    [
      { id: "ains", name: "Ainsworth", hero: AINSWORTH, input: true },
      { id: "mate", name: "Freud", hero: FREUD, input: true },
    ],
    { ...hooks, defenseProc: (n) => procs.push(n), lockPaletteSlot: (i, ms) => lockLog.push({ i, ms }) }
  );
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);
  f.nextOutgoingAt = 1e9; // the boss holds its swings: every hit below is placed by hand
  const A = f.actorBy("ains");
  const M = f.actorBy("mate");
  const idx = (id) => AINSWORTH.palette.findIndex((p) => p.id === id);
  const run = (s) => { for (let i = 0; i < Math.round(s / DT); i++) f.tick(DT); };

  // Variety gate: Disorganized first is refused; after two styles it casts.
  if (f.castPaletteAs("ains", idx("ainsworth.disorganized"), 1) !== null) fail("Disorganized cast with no styles behind it");
  M.fixationUntil = f.simT + 5;
  const ampBefore = f.amp;
  f.castPaletteAs("ains", idx("ainsworth.secure"), 1);
  if (M.fixationUntil !== -1) fail("Secure did not lift the teammate's Fixation");
  if (!(f.amp > ampBefore)) fail("Secure opened no Exploration window");
  if (f.castPaletteAs("ains", idx("ainsworth.disorganized"), 1) !== null) fail("Disorganized cast after only ONE other style");

  // Avoidant: threat shed, and hits deferred, not dropped.
  A.threat = 1000;
  f.castPaletteAs("ains", idx("ainsworth.avoidant"), 1);
  if (Math.abs(A.threat - 750) > 1e-6) fail(`Avoidant left threat at ${A.threat}, not 750`);
  const hp0 = A.hp;
  const mit = f.mitigationFor(A);
  f.hitCombatant(A, 200);
  if (A.hp !== hp0) fail("a hit under Masked Distress landed at once");
  run(4.6);
  const bled = hp0 - A.hp;
  const want = 200 * (1 - mit);
  if (Math.abs(bled - want) > 0.5) fail(`Masked Distress bled ${bled.toFixed(1)}, the mitigated hit was ${want.toFixed(1)}`);

  // Disorganized now casts: immunity for the teammate, not for herself; own cooldown.
  const dis = f.castPaletteAs("ains", idx("ainsworth.disorganized"), 1);
  if (!dis) fail("Disorganized refused after Secure and Avoidant inside 8 s");
  if (!lockLog.some((l) => l.ms === 30_000)) fail("Disorganized did not lock its slot for its 30 s cooldown");
  const mHp = M.hp;
  f.hitCombatant(M, 300);
  if (M.hp !== mHp || !procs.includes("Sheltered")) fail("the sheltered teammate took the hit");
  const aHp = A.hp;
  f.hitCombatant(A, 100);
  if (!(A.hp < aHp)) fail("Disorganized sheltered Ainsworth herself");
  f.castPaletteAs("ains", idx("ainsworth.secure"), 1);
  f.castPaletteAs("ains", idx("ainsworth.ambivalent"), 1);
  if (f.castPaletteAs("ains", idx("ainsworth.disorganized"), 1) !== null) fail("Disorganized recast inside its cooldown");
  run(3.2);
  f.hitCombatant(M, 100);
  if (!(M.hp < mHp)) fail("the teammate was still immune after 3 s");

  // Ambivalent (cast above): the taunt and the heal cut.
  f.castPaletteAs("ains", idx("ainsworth.ambivalent"), 1);
  if (f.topThreatTarget()?.id !== "ains") fail("Ambivalent did not taunt the boss onto her");
  A.hp = A.hpMax - 400;
  const healed = f.healCombatant(A, 100, "test", null);
  if (Math.abs(healed - 50) > 1e-6) fail(`a 100 heal under Resistant landed ${healed}, not 50`);

  // Sensitivity: a basic inside 1.5 s of the teammate's hit heals them.
  run(4.5); // past every window above
  M.hp = M.hpMax - 300;
  f.hitCombatant(M, 50);
  const before = M.hp;
  f.castBasicAs("ains", 1);
  const answered = M.hp - before;
  const sens = AINSWORTH.basic.effects[0].magnitude;
  if (Math.abs(answered - sens) > 1e-6 || !procs.includes("Sensitivity")) fail(`Sensitivity healed ${answered}, kit says ${sens}`);
  run(2);
  f.hitCombatant(M, 50);
  run(1.6);
  const late = M.hp;
  f.castBasicAs("ains", 1);
  if (M.hp !== late) fail("Sensitivity answered a signal older than its window");

  // Strange Situation sheds half the threat before its own hit banks.
  A.threat = 1000;
  f.castChainAs("ains", 1);
  if (Math.abs(A.threat - 500) > 1e-6) fail(`Strange Situation left threat at ${A.threat}, not 500`);

  Math.random = realRandom;
  console.log(`\nscenario 11: gate · cleanse · Exploration · threat shed · stagger bled ${bled.toFixed(0)}/${want.toFixed(0)} · teammate sheltered, she is not · cooldown · taunt · heal cut 50% · Sensitivity +${answered}`);
  console.log("SCENARIO 11 (Ainsworth's attachment styles in the live sim): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 12: Piaget on the healer row (Skinner's budget, weight 0.60), with
// his own shares 20 basic / 30 palette / 15 E / 10 R / 25 F and every stage
// the same EV — a stage is a delivery shape, not more throughput.
// ---------------------------------------------------------------------------
const { PIAGET, PIAGET_DEVELOPMENT } = await import(pathToFileURL(await bundle("shared/heroes/piaget.ts")).href);
const PIAGET_SHARE = { s1: 0.3, s2: 0.15, s3: 0.1, s4: 0.25, s5: 0.2 };
{
  const w = PIAGET.baseDamage / 100;
  console.log(`\nscenario 12: Piaget vs the healer row at weight ${w} (budget ${CONTRACT.budget * w}/s)`);
  if (PIAGET.role !== "healer") fail(`Piaget's role is ${PIAGET.role}, but his numbers derive at the healer row`);
  if (PIAGET.beats) fail("Piaget grew a beat cycle — his kit is flat");
  if (Math.abs(Object.values(PIAGET_SHARE).reduce((a, b) => a + b, 0) - 1) > 1e-9) fail("Piaget's shares do not sum to 1");
  const at = (slot) => (CONTRACT.budget * w * PIAGET_SHARE[slot]) / (CONTRACT.rates[slot] / 60);
  exact("S5 Assimilation", PIAGET.basic.base, at("s5"));
  for (const p of PIAGET.palette) {
    const heal = p.effects.find((e) => ["heal.hot", "heal.single", "conservation", "shield.team"].includes(e.kind));
    if (!heal) fail(`${p.name} carries no heal payload`);
    exact(`S1 ${p.name}`, heal.magnitude, at("s1"));
    if (p.base !== 0) fail(`${p.name} deals damage — his stages heal`);
  }
  exact("S2 Accommodation shield", PIAGET.defense.effects.find((e) => e.kind === "shield.team").magnitude, at("s2"));
  exact("S3 Object Permanence heal", PIAGET.chain.effects.find((e) => e.kind === "ally.undying").magnitude, at("s3"));
  const f = at("s4");
  exact("S4 Equilibration direct heal", PIAGET.ultimate.heal, f * CONTRACT.ultimate.direct);
  exact(
    "S4 Equilibration per Mark",
    PIAGET.ultimate.effects.find((e) => e.kind === "equilibration.release").magnitude,
    (f * (1 - CONTRACT.ultimate.direct)) / (PIAGET.ultimate.maxMarksConsumed * CONTRACT.ultimate.foreignMix)
  );
  // The sequence price: a perfect 1→2→3→4 nets exactly four scaffold casts.
  const keys = PIAGET.palette.reduce((n, p) => n + (p.focusCost ?? 8), 0);
  if (keys - PIAGET_DEVELOPMENT.sequenceFocusRefund !== 4 * 8) {
    fail(`a perfect sequence nets ${keys - PIAGET_DEVELOPMENT.sequenceFocusRefund} Focus, the heals are priced at ${4 * 8}`);
  }
  // Five forms, four stages: every form answered by exactly one stage.
  const FORMS = ["age.infant", "age.toddler", "age.child", "age.school", "age.adolescent"];
  for (const tag of FORMS) {
    const n = PIAGET.palette.filter((p) => p.answersTags?.includes(tag)).length;
    if (n !== 1) fail(`${tag} is answered by ${n} stages, not one`);
  }
  console.log("SCENARIO 12 (Piaget on the healer row of the role contract): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 13: Piaget's stages in the live sim, two-player party — tag-based
// Shapeshift answers (Preoperational answers two forms), the sequence refund,
// heal-over-time, Centration, Conservation, shields (absorb, then Amp),
// Object Permanence, and Equilibration as a 0-damage ultimate that resolves.
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999;
  const procs = [];
  const focus = [];
  const f = BossFight.forParty(
    NIGHTMARE_STANDARD,
    [
      { id: "pia", name: "Piaget", hero: PIAGET, input: true },
      { id: "mate", name: "Freud", hero: FREUD, input: true },
    ],
    { ...hooks, defenseProc: (n) => procs.push(n), gainFocus: (n, who) => focus.push({ n, who }) }
  );
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);
  f.nextOutgoingAt = 1e9;
  const P = f.actorBy("pia");
  const M = f.actorBy("mate");
  const run = (s) => { for (let i = 0; i < Math.round(s / DT); i++) f.tick(DT); };

  // Sequence: 1 2 3 4 refunds once; 1 3 does not.
  f.castPaletteAs("pia", 0, 1);
  f.castPaletteAs("pia", 1, 1);
  f.castPaletteAs("pia", 2, 1);
  f.castPaletteAs("pia", 3, 1);
  if (focus.length !== 1 || focus[0].n !== PIAGET_DEVELOPMENT.sequenceFocusRefund) fail(`in-order stages refunded ${JSON.stringify(focus)}`);
  run(3);
  f.castPaletteAs("pia", 0, 1);
  f.castPaletteAs("pia", 2, 1);
  f.castPaletteAs("pia", 1, 1);
  f.castPaletteAs("pia", 3, 1);
  if (focus.length !== 1) fail("an out-of-order run refunded Focus");
  run(9); // let the shields from key 4 lapse

  // Centration: all of it on the most wounded.
  M.hp = M.hpMax - 500;
  P.hp = P.hpMax - 100;
  const m0 = M.hp, p0 = P.hp;
  f.castPaletteAs("pia", 1, 1);
  if (Math.abs(M.hp - m0 - 137) > 1e-6 || P.hp !== p0) fail(`Centration healed Freud ${M.hp - m0}, Piaget ${P.hp - p0}`);

  // Circular Reaction: nothing now, 137 over the next 6 s, on the most wounded.
  const m1 = M.hp;
  f.castPaletteAs("pia", 0, 1);
  if (M.hp !== m1) fail("Circular Reaction healed up front");
  run(6.2);
  if (Math.abs(M.hp - m1 - 137) > 0.5) fail(`Circular Reaction healed ${(M.hp - m1).toFixed(1)} over 6 s, not 137`);

  // Conservation: HP shared out evenly (same fraction), then the team heal.
  M.hp = 200;
  P.hp = 1000;
  f.castPaletteAs("pia", 2, 1);
  if (Math.abs(M.hp / M.hpMax - P.hp / P.hpMax) > 1e-6) fail(`Conservation left ${M.hp} vs ${P.hp}`);
  if (Math.abs(M.hp + P.hp - (1200 + 137)) > 1) fail(`Conservation total ${M.hp + P.hp}, not 1200 + 137`);
  if (!procs.includes("Conserved")) fail("Conservation floated nothing");

  // Hypothetical: a shield soaks the hit, the rest fades into Amp.
  M.hp = M.hpMax;
  f.castPaletteAs("pia", 3, 1);
  const each = 137 / 2;
  const mit = f.mitigationFor(M);
  f.hitCombatant(M, 40 / (1 - mit));
  if (M.hp !== M.hpMax) fail("a hit smaller than the shield reached HP");
  const amp0 = f.amp;
  run(8.2);
  if (!(f.amp > amp0)) fail("the unspent shield paid no Amp on expiry");
  if (M.shields.length !== 0) fail("the shield outlived its 8 s");
  void each;

  // Object Permanence: no lower than 1 HP for 4 s, then the heal.
  run(1);
  M.hp = 50;
  P.hp = P.hpMax;
  f.castChainAs("pia", 1);
  f.hitCombatant(M, 5_000);
  if (M.hp !== 1 || !M.alive) fail(`Object Permanence let Freud fall to ${M.hp}`);
  run(4.2);
  if (Math.abs(M.hp - 1 - 143) > 1e-6) fail(`Object Permanence released ${M.hp - 1}, not 143`);
  f.hitCombatant(M, 5_000);
  if (M.alive) fail("Object Permanence held past its window");

  // Equilibration: 0 damage, resolves, heals 257 + 80 per Mark.
  P.hp = P.hpMax - 900;
  const marks = f.marks.length;
  const ph = P.hp;
  const dmg = f.castUltimateAs("pia");
  if (dmg !== 0) fail(`Equilibration dealt ${dmg} damage`);
  if (!f.ultimateResolvedAs("pia")) fail("a 0-damage ultimate did not count as resolved");
  const spent = Math.min(marks, PIAGET.ultimate.maxMarksConsumed);
  if (Math.abs(P.hp - ph - (257 + 80 * spent)) > 1e-6) fail(`Equilibration healed the lone survivor ${P.hp - ph}, want ${257 + 80 * spent}`);

  // Shapeshift: tag answers. Preoperational is right for the toddler AND the child.
  const g = BossFight.forParty(NIGHTMARE_STANDARD, [{ id: "pia", name: "Piaget", hero: PIAGET, input: true }], { ...hooks });
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) g.tick(DT);
  g.enterPhase("p2");
  const answer = (stage, key) => { g.notifyP2Stage(stage); g.actorBy("pia").fixationUntil = -1; return g.castPaletteAs("pia", key, 1); };
  for (const [stage, key] of [[0, 0], [1, 1], [2, 1], [3, 2], [4, 3]]) {
    const h = answer(stage, key);
    if (!h?.grantsDebuffStack) fail(`stage ${stage} answered with key ${key + 1} was not right`);
  }
  const wrong = answer(1, 0);
  if (wrong?.grantsDebuffStack) fail("Sensorimotor answered the toddler");

  Math.random = realRandom;
  console.log(`\nscenario 13: sequence refund once · Centration · Circular Reaction 137/6 s · Conservation evens · shield soaks then Amp · Object Permanence 1 HP then +143 · Equilibration resolves at 0 damage · 5 forms / 4 stages answered`);
  console.log("SCENARIO 13 (Piaget's stages in the live sim): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 14: Bandura on the flex row (weight 0.85, DPS shares), with the
// palette priced at the reference motivation mix.
// ---------------------------------------------------------------------------
const { BANDURA, BANDURA_MODELING } = await import(pathToFileURL(await bundle("shared/heroes/bandura.ts")).href);
const DPS_SHARE = { s1: 0.4, s2: 0.09, s3: 0.06, s4: 0.2, s5: 0.25 };
{
  const w = BANDURA.baseDamage / 100;
  console.log(`\nscenario 14: Bandura vs the flex row at weight ${w} (budget ${CONTRACT.budget * w}/s)`);
  if (BANDURA.role !== "flex") fail(`Bandura's role is ${BANDURA.role}`);
  if (BANDURA.beats) fail("Bandura grew a beat cycle");
  const at = (slot) => (CONTRACT.budget * w * DPS_SHARE[slot]) / (CONTRACT.rates[slot] / 60);
  exact("S5 Modeled Aggression", BANDURA.basic.base, at("s5"));
  const ms = BANDURA_MODELING;
  const mix = 0.5 * ms.motivatedMult + 0.45 * ms.unmotivatedMult + 0.05 * ms.emptyMult;
  for (const p of BANDURA.palette) exact(`S1 ${p.name} (mean ×${mix.toFixed(3)})`, p.base, at("s1") / mix);
  if (BANDURA.palette.length !== ms.slots) fail("palette keys and retention slots disagree");
  exact("S2 Self-Efficacy heal", BANDURA.defense.heal, at("s2"));
  exact("S3 Bobo Doll", BANDURA.chain.base, at("s3"));
  const f = at("s4");
  exact("S4 Reciprocal Determinism direct", BANDURA.ultimate.base, f * CONTRACT.ultimate.direct);
  exact(
    "S4 Reciprocal Determinism per Mark",
    BANDURA.ultimate.perMark,
    (f * (1 - CONTRACT.ultimate.direct)) / (BANDURA.ultimate.maxMarksConsumed * CONTRACT.ultimate.foreignMix)
  );
  console.log("SCENARIO 14 (Bandura on the flex row of the role contract): ALL CHECKS PASSED");
}

// ---------------------------------------------------------------------------
// Scenario 15: Bandura's observational learning in the live sim — attention
// follows salience (and a pin), retention fills from the model's casts,
// reproduction pays HIS base at the motivation rate and spends the slot,
// rehearsal on an empty slot, a copied heal keeps its shape at his number,
// solo he models the boss, the Bobo doll soaks and rebounds, copies fade.
// ---------------------------------------------------------------------------
{
  const realRandom = Math.random;
  Math.random = () => 0.999; // no crits: Freud's copies are unmotivated unless answered right
  const states = [];
  const f = BossFight.forParty(
    NIGHTMARE_STANDARD,
    [
      { id: "ban", name: "Bandura", hero: BANDURA, input: true },
      { id: "fre", name: "Freud", hero: FREUD, input: true },
      { id: "pia", name: "Piaget", hero: PIAGET, input: true },
    ],
    { ...hooks, modelingChanged: (s, who) => who === "ban" && states.push(s) }
  );
  if (!states.length || states.at(-1).slots.some((x) => x !== null)) fail("Bandura opened without four empty slots on the HUD");
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 1) / DT); i++) f.tick(DT);
  f.nextOutgoingAt = 1e9;
  const B = f.actorBy("ban");
  const run = (s) => { for (let i = 0; i < Math.round(s / DT); i++) f.tick(DT); };

  // Attention: Freud deals damage, so Freud is the model.
  f.landHitAs("fre", f.castPaletteAs("fre", 0, 1));
  if (f.modelOf(B)?.id !== "fre") fail(`Bandura watches ${f.modelOf(B)?.id}, not the salient Freud`);
  // Retention: Freud's next casts fill slots.
  f.castPaletteAs("fre", 1, 1);
  f.castChainAs("fre", 1);
  const held = states.at(-1).slots.filter(Boolean).map((s) => s.id);
  for (const id of ["freud.stage.oral", "freud.stage.anal", "freud.free-association"]) if (!held.includes(id)) fail(`${id} was not retained (${held})`);
  // Reproduction: his base × 0.8 (unmotivated), and the slot empties.
  const slotOf = (id) => B.retained.findIndex((r) => r?.view.id === id);
  const k = slotOf("freud.stage.anal");
  const copy = f.castPaletteAs("ban", k, 1);
  const want = f.resolveHitFor ? 0 : null;
  void want;
  const plain = (base) => resolveHit({ base, beat: 1, marks: f.marks.length - 0, amp: f.amp, gear: 1, format: "match", isSkill: true });
  if (Math.abs(copy.damage - plain(292 * 0.8)) > 1e-6) fail(`an unmotivated copy dealt ${copy.damage}, want ${plain(292 * 0.8)}`);
  if (B.retained[k] !== null) fail("the reproduced slot was not spent");
  // Rehearsal: the empty slot still swings at half.
  const reh = f.castPaletteAs("ban", k, 1);
  if (Math.abs(reh.damage - plain(292 * 0.5)) > 1e-6) fail(`rehearsal dealt ${reh.damage}, want ${plain(292 * 0.5)}`);

  // Pin Piaget, watch a Centration, copy it: one target healed for HIS base.
  f.setModelAs("ban", "pia");
  if (f.modelOf(B)?.id !== "pia" || !states.at(-1).pinned) fail("the pin did not move attention to Piaget");
  f.castPaletteAs("pia", 1, 1);
  const j = slotOf("piaget.preoperational");
  if (j < 0) fail("Centration was not retained");
  const fre = f.actorBy("fre");
  fre.hp = fre.hpMax - 600;
  const h0 = fre.hp;
  const healCopy = f.castPaletteAs("ban", j, 1);
  if (healCopy.damage !== 0) fail("a copied heal dealt damage");
  if (Math.abs(fre.hp - h0 - 292 * 0.8) > 1e-6) fail(`the copied Centration healed ${fre.hp - h0}, want ${292 * 0.8}`);
  f.setModelAs("ban", null);

  // Motivation: a copy of a right Shapeshift answer pays the full rate.
  f.enterPhase("p2");
  f.notifyP2Stage(0);
  f.setModelAs("ban", "fre");
  f.castPaletteAs("fre", 0, 1); // oral answers the infant: rewarded
  const mk = slotOf("freud.stage.oral");
  if (!B.retained[mk]?.view.motivated) fail("a right answer was not retained as motivated");
  const full = f.castPaletteAs("ban", mk, 1);
  if (!full.grantsDebuffStack) fail("Bandura's reproduction did not count as right during Shapeshift");
  f.enterPhase("p1");
  f.nextOutgoingAt = 1e9;

  // Fade: unrehearsed copies are gone after retentionMs.
  f.castPaletteAs("fre", 2, 1);
  run(BANDURA_MODELING.retentionMs / 1000 + 0.5);
  if (B.retained.some((r) => r !== null)) fail("retained copies outlived their 20 s");

  // Solo: nobody to watch, so the boss's blows fill the slots.
  const s = BossFight.forParty(NIGHTMARE_STANDARD, [{ id: "ban", name: "Bandura", hero: BANDURA, input: true }], { ...hooks });
  for (let i = 0; i < Math.ceil((NIGHTMARE_STANDARD.idleS + 3) / DT); i++) s.tick(DT);
  const SB = s.actorBy("ban");
  if (!SB.retained.some((r) => r?.view.id === "boss.strike" && r.view.motivated)) fail("solo Bandura did not model the boss's blow");
  // Bobo Doll: the next single-target blow hits the doll; half rebounds at the end.
  s.castChainAs("ban", 1);
  const hpB = SB.hp;
  const bossHp = s.hp;
  s.bossStrike(100, "threat");
  if (SB.hp !== hpB) fail("the blow reached Bandura through the doll");
  for (let i = 0; i < Math.round(4.2 / DT); i++) s.tick(DT);
  const rebound = 100 * s.dmgMult * s.sizeMult * BANDURA.chain.effects[0].magnitude;
  if (!(bossHp - s.hp >= rebound - 1e-6)) fail(`the doll rebounded ${(bossHp - s.hp).toFixed(1)}, want ≥ ${rebound}`);

  Math.random = realRandom;
  console.log(`\nscenario 15: attention · retention · copy ×0.8 spent · rehearsal ×0.5 · pinned Centration copy heals ${Math.round(292 * 0.8)} · motivated right answer · copies fade · solo models the boss · Bobo doll soaks and rebounds`);
  console.log("SCENARIO 15 (Bandura's observational learning in the live sim): ALL CHECKS PASSED");
}
