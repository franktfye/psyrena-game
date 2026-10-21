#!/usr/bin/env node
// Headless balance check for the survival sim (docs/survival-design.md §11).
// Bot heroes at Freud's reference DPS (~95/s: a hit every 0.6 s) against the
// real SurvivalSim on the real map. Two policies:
//   smart — kites away from the crowd, steps out of telegraphs and burns, stands
//           in the right Recall circle, walks to pickups;
//   naive — stands still and shoots.
//
//   node --experimental-strip-types tools/survival-sim-check.mjs [--difficulty lucid] [--runs 3]
import { SurvivalSim } from "../shared/survival/sim.ts";
import { OLD_KOWLOON } from "../shared/survival/map/oldKowloon.ts";
import { MINIONS, ELITES, BOSS_RULES, HERO_WALK } from "../shared/survival/content.ts";

// Rule (§3.0): every enemy is slower than a walking hero.
const tooFast = [...MINIONS, ...ELITES].filter((m) => m.speed >= HERO_WALK).map((m) => m.id);
if (tooFast.length || BOSS_RULES.walk >= HERO_WALK) { console.error("enemies as fast as a hero:", tooFast); process.exit(1); }

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const difficulty = arg("--difficulty", "lucid");
const runs = Number(arg("--runs", "3"));
const DT = 0.05;

function run(policy, seed) {
  const sim = new SurvivalSim({ difficulty, map: OLD_KOWLOON, players: [{ id: "p1", hero: "freud", role: "dps" }], seed });
  let atk = 0;
  const me = sim.players[0];
  for (let step = 0; step < 20 * 60 * 60 && sim.phase !== "victory" && sim.phase !== "defeat"; step++) {
    sim.tick(DT);
    sim.drainEvents();
    if (!me.alive) continue;
    let mx = 0, mz = 0;
    if (policy === "smart") {
      // Away from nearby enemies, weighted by closeness.
      for (const h of sim.hostiles) {
        const dx = me.x - h.x, dz = me.z - h.z, d = Math.hypot(dx, dz) || 1;
        const keep = h.kind === "boss" ? 8 : 6;
        if (d < keep) { const w = h.kind === "boss" ? 4 : 1; mx += (w * dx) / d / d; mz += (w * dz) / d / d; }
      }
      for (const hz of sim.hazards) {
        const dx = me.x - hz.x, dz = me.z - hz.z, d = Math.hypot(dx, dz) || 1;
        if (!hz.fake && d < hz.r + 1.2) { mx += (dx / d) * 3; mz += (dz / d) * 3; }
      }
      if (sim.recall) {
        const c = sim.recall.circles[sim.recall.correct];
        mx = c.x - me.x; mz = c.z - me.z;
      } else if (sim.pickups.length && Math.hypot(mx, mz) < 0.05) {
        const p = sim.pickups[0];
        mx = p.x - me.x; mz = p.z - me.z;
      }
      // Drift back toward the middle of the map so kiting does not pin us in a corner.
      mx += -me.x * 0.004; mz += -me.z * 0.004;
      const len = Math.hypot(mx, mz);
      if (len > 1e-3) {
        const sp = 3.4 * me.moveMult * DT * Math.min(1, len * 4);
        sim.setPlayerPos("p1", me.x + (mx / len) * sp, me.z + (mz / len) * sp);
      }
    }
    atk -= DT;
    if (atk <= 0) {
      const tgt = sim.nearestHostile(me.x, me.z, 14);
      if (tgt) sim.hitHostile(tgt.id, 60, false, { player: "p1", slotId: "freud.basic", kind: "basic" });
      atk = 0.6;
    }
  }
  const s = sim.statsNow;
  return { wave: sim.wave, cleared: s.wavesCleared, phase: sim.phase, kills: s.kills, recall: `${s.recallRight}/${s.recallTotal}`, minutes: (s.durationS / 60).toFixed(1) };
}

for (const policy of ["naive", "smart"]) {
  const res = [];
  for (let i = 0; i < runs; i++) res.push(run(policy, 100 + i));
  console.log(`${difficulty} · ${policy}: ` + res.map((r) => `cleared ${r.cleared} (${r.phase}, ${r.kills} kills, recall ${r.recall}, ${r.minutes} min)`).join(" | "));
}
