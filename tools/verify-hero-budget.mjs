/**
 * Verify every shipped hero kit against the boss-math sheet.
 *
 * The sheet is ground truth, and it is a CLOSED LOOP: hero bases decide team
 * DPS, team DPS decides the boss's HP curve, and the HP curve decides whether
 * a 3-player team with no gear clears before the enrage timer. Hand-editing a
 * base in `shared/heroes/` therefore invalidates a boss HP number derived from
 * it, and nothing else in the build would notice.
 *
 * This is what notices. It re-derives each slot from the role contract —
 *
 *     base = (budget × role weight × share) ÷ (casts per minute / 60 × beat factor)
 *
 * — and fails if the shipped integer is not the correct rounding of it, or if
 * the kit no longer sums back to the hero's output budget.
 *
 * Run: node --experimental-strip-types tools/verify-hero-budget.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Must register before the shared model is pulled in, hence the dynamic import.
register("./ts-resolve-hook.mjs", import.meta.url);
const { FREUD } = await import("../shared/heroes/freud.ts");
const { COMBAT } = await import("../shared/combat.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// `docs/` is gitignored — the sheet is the designer's local export, not repo
// content. Anyone who has it gets the check; anyone who does not is not
// blocked by a file they were never given. Point at it explicitly with
// PSYRENA_BOSS_MATH=/path/to/export.json or as argv[2].
const sheetPath =
  process.argv[2] ??
  process.env.PSYRENA_BOSS_MATH ??
  join(root, "docs/psyrena-boss-math-nightmare-3p.json");

if (!existsSync(sheetPath)) {
  console.log(`SKIP — no boss-math export at ${sheetPath}`);
  console.log("Export one from admin/boss-math, or set PSYRENA_BOSS_MATH.");
  process.exit(0);
}
const sheet = JSON.parse(readFileSync(sheetPath, "utf8"));

const problems = [];
const check = (label, actual, expected, tolerance = 0) => {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) problems.push(`${label}: shipped ${actual}, sheet wants ${expected}`);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${String(actual).padStart(8)}  expected ${expected}`
  );
};

// ---- the contract inputs, read from the sheet rather than restated ---------
const budget = sheet.skillBudget.budgetDpsForBase100Hero;
const { payoff, foreign } = sheet.skillBudget.referenceExecution;
const directShare = sheet.skillBudget.ultimateDirectShare;
const [b1, b2, b3] = sheet.constants.beats;

// Beat factors: skills get `payoff` of their casts on the ×1.5 beat and the
// rest spread over the other two; basics simply average all three.
const bfSkill = payoff * b3 + (1 - payoff) * ((b1 + b2) / 2);
const bfBasic = (b1 + b2 + b3) / 3;
// A hero with no `beats` never sees the cycle, so EVERY slot derives at 1.0
// and every base has to be correspondingly higher to pay the same share.
// Reading the field here is what makes it load-bearing: delete a beat set
// without re-deriving the kit and this check fails.
const basicFactor = (hero) => (hero.beats ? bfBasic : 1);
const skillFactor = (hero) => (hero.beats ? bfSkill : 1);

const verifyHero = (hero) => {
  console.log(`\n${hero.displayName}  [${hero.role}]`);
  const row = sheet.roleContract.contract[sheet.roleContract.roleGroupOfRole[hero.role]];
  const rates = Object.fromEntries(
    sheet.skillBudget.distributionByRole[sheet.roleContract.roleGroupOfRole[hero.role]].slots.map(
      (s) => [s.n, s.castsPerMin]
    )
  );
  const weight = hero.baseDamage / 100;
  const total = budget * weight;
  const perSlot = (n) => total * row.mix[n];
  const derive = (n, bf) => perSlot(n) / ((rates[n] / 60) * bf);

  check("S5 basic base", hero.basic.base, Math.round(derive(5, basicFactor(hero))));
  check("S1 palette base", hero.palette[0].base, Math.round(derive(1, skillFactor(hero))));
  check("S2 defense heal", hero.defense.heal ?? 0, Math.round(derive(2, skillFactor(hero))));
  check("S3 chain base", hero.chain.base, Math.round(derive(3, skillFactor(hero))));

  // S4 carries no beat factor — the ultimate does not ride the cycle.
  const ultPerCast = perSlot(4) / (rates[4] / 60);
  const direct = ultPerCast * directShare;
  const markValueMult = (1 - foreign) * 1 + foreign * (1 + COMBAT.crossConsumptionBonus);
  const perMark = (ultPerCast - direct) / (hero.ultimate.maxMarksConsumed * markValueMult);
  check("S4 ultimate direct", hero.ultimate.base, Math.round(direct));
  check("S4 ultimate perMark", hero.ultimate.perMark, Math.round(perMark));

  // Mitigation must match the role row and stay inside the global cap.
  const want = row.mitigation.find((m) => m.slot === 2);
  if (want) {
    check("S2 mitigation magnitude", hero.defense.mitigation?.magnitude ?? 0, want.mag, 1e-9);
    check("S2 mitigation seconds", (hero.defense.mitigation?.durationMs ?? 0) / 1000, want.durS);
  }
  if ((hero.defense.mitigation?.magnitude ?? 0) > COMBAT.maxMitigation) {
    problems.push(`${hero.id}: one mitigation source exceeds the ${COMBAT.maxMitigation} cap`);
  }

  // ---- round-trip: do the shipped integers still sum to the budget? -------
  const realised =
    hero.basic.base * (rates[5] / 60) * basicFactor(hero) +
    hero.palette[0].base * (rates[1] / 60) * skillFactor(hero) +
    (hero.defense.heal ?? 0) * (rates[2] / 60) * skillFactor(hero) +
    hero.chain.base * (rates[3] / 60) * skillFactor(hero) +
    (hero.ultimate.base + hero.ultimate.perMark * hero.ultimate.maxMarksConsumed * markValueMult) *
      (rates[4] / 60);
  const drift = (realised / total - 1) * 100;
  console.log(
    `  ${Math.abs(drift) < 0.5 ? "PASS" : "FAIL"}  ${"budget round-trip".padEnd(34)} ${realised.toFixed(3).padStart(8)}  expected ${total} (${drift >= 0 ? "+" : ""}${drift.toFixed(3)}%)`
  );
  if (Math.abs(drift) >= 0.5) {
    problems.push(`${hero.id}: kit sums to ${realised.toFixed(2)} DPS, budget is ${total}`);
  }
};

console.log(`Boss-math sheet: ${sheet.schema}, exported ${sheet.exportedAt}`);
console.log(`Beat factors — skills ${bfSkill.toFixed(4)}, basics ${bfBasic.toFixed(4)}`);

verifyHero(FREUD);

if (problems.length) {
  console.error(`\n${problems.length} kit(s) drifted from the sheet:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nThe boss HP curve is derived from these numbers. Change the sheet in\n" +
      "admin/boss-math and re-export — do not edit the kit alone."
  );
  process.exit(1);
}
console.log("\nAll shipped kits reproduce the sheet.");
