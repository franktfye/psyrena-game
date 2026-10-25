#!/usr/bin/env node
// Headless check of the survival elites against the real SurvivalSim
// (docs/survival-design.md §4.3):
//   - every hero in the roster (shared/heroes) has an elite of their own, so a
//     new hero cannot ship into survival without one (§4.3 "New heroes");
//   - The Imitator (Bandura) retains what hits it, reproduces it as a labelled
//     telegraph (harder when the original crit), and Bandura's Bobo Doll
//     Deters it, which his reproductions extend;
//   - The Tall Glass (Piaget) pours tall ↔ wide, spills when wide, and
//     Piaget's Concrete Operational Conserves it, longer after 1 → 2 → 3.
//
//   node --experimental-strip-types tools/survival-elites-check.mjs
import { SurvivalSim } from "../shared/survival/sim.ts";
import { OLD_KOWLOON } from "../shared/survival/map/oldKowloon.ts";
import { ELITES, ELITE_RULES, IMITATOR_RULES, TALL_GLASS_RULES } from "../shared/survival/content.ts";
import { HEROES } from "../shared/heroes/index.ts";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

const missing = Object.keys(HEROES).filter((id) => !ELITES.some((e) => e.hero === id));
check(missing.length === 0, `every roster hero has an elite${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);

/** A solo sim with one elite spawned beside the player; minions cleared so only the elite acts. */
function solo(hero) {
  const sim = new SurvivalSim({ difficulty: "lucid", map: OLD_KOWLOON, players: [{ id: "p1", hero, role: HEROES[hero].role }], seed: 7 });
  sim.spawnElite();
  const h = sim.hostiles.at(-1);
  const me = sim.players[0];
  h.x = me.x + 4;
  h.z = me.z;
  return { sim, h, me };
}
/** Tick with the player pinned in place and full HP, so nothing dies under the test. */
function run(sim, me, s, onTick) {
  for (let t = 0; t < s; t += 0.05) {
    sim.hostiles = sim.hostiles.filter((x) => x.kind === "elite");
    me.hp = me.hpMax;
    sim.tick(0.05);
    onTick?.(sim.drainEvents());
  }
}
const cast = (slotId, kind) => ({ player: "p1", slotId, kind });

// ---- The Imitator -----------------------------------------------------------------
{
  const { sim, h, me } = solo("bandura");
  check(h.def === "imitator" && h.model === "sv-imitator", "solo Bandura spawns The Imitator");
  sim.hitHostile(h.id, 50, true, cast("bandura.modeled-aggression", "basic"));
  sim.hitHostile(h.id, 121, false, cast("bandura.self-efficacy", "defense"));
  check(h.retained.length === 2 && h.retained[0].name === "Modeled Aggression" && h.retained[0].crit, "it retains the skills that hit it, by name, crit remembered");
  const labels = [];
  run(sim, me, 14, () => { for (const hz of sim.hazards) if (!labels.includes(hz.label)) labels.push(hz.label); });
  check(labels.includes("COPIED! Modeled Aggression"), `a crit comes back as a motivated copy (${labels.join(" · ")})`);
  check(labels.includes("COPIED: Self-Efficacy"), "the next retained skill is reproduced after it, oldest first");
  check(h.retained.length === 0, "a reproduction empties its slot");

  sim.hitHostile(h.id, 50, false, cast("bandura.modeled-aggression", "basic"));
  const hp0 = h.hp;
  let deterred = null;
  sim.hitHostile(h.id, 100, false, cast("bandura.bobo-doll", "chain"));
  for (const e of sim.drainEvents()) if (e.type === "eliteDebuff") deterred = e.name;
  check(deterred === "Deterred", "Bandura's Bobo Doll Deters it");
  check(h.retained.length === 0, "Deterred wipes what it learned");
  check(hp0 - h.hp === Math.round(100 * (1 + ELITES.find((e) => e.id === "imitator").vuln)), `Deterred strips Defended and adds vulnerability (${hp0 - h.hp})`);
  sim.hitHostile(h.id, 10, false, cast("freud.oral", "palette"));
  check(h.retained.length === 0, "while Deterred it does not watch");
  const until = h.debuffUntil;
  for (let i = 0; i < 6; i++) sim.hitHostile(h.id, 10, false, cast(`bandura.observe-${(i % 4) + 1}`, "palette"));
  check(Math.abs(h.debuffUntil - until - IMITATOR_RULES.maxExtendS) < 1e-6, "Bandura's reproductions extend Deterred, capped");
}

// ---- The Tall Glass ---------------------------------------------------------------
{
  const { sim, h, me } = solo("piaget");
  check(h.def === "tallglass" && h.form === "tall", "solo Piaget spawns The Tall Glass, tall");
  const seen = new Set();
  const forms = new Set();
  run(sim, me, 14, () => { forms.add(h.form); for (const hz of sim.hazards) seen.add(hz.label); });
  check(forms.has("tall") && forms.has("wide"), "it pours between tall and wide");
  check(seen.has("POUR") && seen.has("SPILL"), `each pour splashes and the wide glass spills (${[...seen].join(" · ")})`);

  let name = null;
  const t0 = sim.t;
  sim.hitHostile(h.id, 0, false, cast("piaget.concrete", "palette"));
  for (const e of sim.drainEvents()) if (e.type === "eliteDebuff") name = e.name;
  check(name === "Conserved" && h.form === undefined, "Concrete Operational Conserves it (no form)");
  check(Math.abs(h.debuffUntil - t0 - 10) < 1e-6, "Conserved lasts 10 s");
  const before = new Set(sim.hazards.map((z) => z.id));
  let poured = false;
  run(sim, me, 8, () => { poured ||= sim.hazards.some((z) => z.label === "POUR" && z.owner === h.id && !before.has(z.id)); });
  check(h.form === undefined && !poured, "Conserved, it stops pouring");
}
{
  const { sim, h } = solo("piaget");
  let name = null;
  sim.hitHostile(h.id, 0, false, cast("piaget.sensorimotor", "palette"));
  sim.tick(0.6);
  sim.hitHostile(h.id, 0, false, cast("piaget.preoperational", "palette"));
  sim.tick(0.6);
  const t0 = sim.t;
  sim.hitHostile(h.id, 0, false, cast("piaget.concrete", "palette"));
  for (const e of sim.drainEvents()) if (e.type === "eliteDebuff") name = e.name;
  check(name === "Conserved: in order!", "1 → 2 → 3 in order is called out");
  check(Math.abs(h.debuffUntil - t0 - 10 - TALL_GLASS_RULES.sequenceBonusS) < 1e-6, "and Conserved holds longer");
}

// ---- Wane still applies (§4.2: the debuff accelerates, it doesn't gate) ------------
{
  const { sim, h } = solo("freud");
  sim.t = h.born + ELITE_RULES.waneAfterS + 1;
  const hp0 = h.hp;
  sim.hitHostile(h.id, 100, false, cast("freud.basic", "basic"));
  check(hp0 - h.hp === 100, "any elite Wanes after 40 s");
}

console.log(failed ? `\n${failed} failed` : "\nall elite checks passed");
process.exit(failed ? 1 : 0);
