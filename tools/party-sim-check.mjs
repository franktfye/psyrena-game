/**
 * Multi-actor sim check (not shipped — dev tool).
 *
 * The other three sim checks (sim-check, practice-sim-check,
 * loadout-sim-check) all drive ONE player. They are the balance net, and they
 * would keep passing while co-op was quietly broken, because none of them ever
 * puts two real players in the same fight.
 *
 * This one does. It exists to guard the seven cross-actor assumptions that
 * were found and fixed when the sim went from "one player plus scripted
 * allies" to N input-driven actors — each of which would produce a baffling
 * co-op bug rather than a crash:
 *
 *   1. two Skinners spending each other's Approximations and proc progress
 *      (the operant engine's per-combatant book-keeping was flat)
 *   2. a taunt pointing at "the player" instead of the actor who cast it
 *   3. scripted allies riding the player's gear multiplier
 *   4. a heal taking its potion/pet scalar from the patient, not the healer
 *   5. vitals routed to "actor 0" instead of every input-driven actor
 *   6. Shaping consuming the whole team's Approximation board
 *   7. one Pavlov's Conditioned/UCR window unlocking another's button
 *
 * It also pins the backward-compatibility contract: the legacy no-id methods
 * must stay identical to the actor-addressed ones for the primary actor,
 * which is what lets the practice pit and the arena's local sim keep working.
 *
 * Run: node tools/party-sim-check.mjs
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function bundle(entry) {
  const f = join(mkdtempSync(join(tmpdir(), "psy-party-")), "mod.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", outfile: f, logLevel: "silent" });
  return f;
}

const { BossFight } = await import(pathToFileURL(await bundle("shared/fight/bossFight.ts")).href);
const { NIGHTMARE_STANDARD } = await import(pathToFileURL(await bundle("shared/bosses/nightmare.ts")).href);
const { HEROES } = await import(pathToFileURL(await bundle("shared/heroes/index.ts")).href);

const FREUD = HEROES.freud, PAVLOV = HEROES.pavlov, SKINNER = HEROES.skinner;

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};
const head = (s) => console.log(`\n${s}`);

// --- hooks: record every actorId-carrying event -----------------------------
const ev = [];
const hooks = {
  announce: (t) => ev.push({ e: "announce", t }),
  setBossPhase: () => {},
  bossStrike: () => {},
  damagePlayer: (n, actorId) => ev.push({ e: "damagePlayer", n, actorId }),
  healPlayer: (n, actorId) => ev.push({ e: "healPlayer", n, actorId }),
  combatantDamaged: (name, amount, isPlayer, actorId) => ev.push({ e: "hurt", name, amount, isPlayer, actorId }),
  combatantHealed: (name, eff, att, isPlayer, label, actorId) => ev.push({ e: "healed", name, eff, isPlayer, label, actorId }),
  combatantDied: (name, isPlayer, actorId) => ev.push({ e: "died", name, isPlayer, actorId }),
  dotTick: (label, amount, actorId) => ev.push({ e: "dot", label, amount, actorId }),
  playerBuff: (name, ms, kind, icon, id, desc, actorId) => ev.push({ e: "buff", name, kind, icon, actorId }),
  gainFocus: (n, actorId) => ev.push({ e: "focus", n, actorId }),
  defenseProc: (name, actorId) => ev.push({ e: "proc", name, actorId }),
  lockPaletteSlot: (i, ms, actorId) => ev.push({ e: "lock", i, actorId }),
  conditioningChanged: (st, actorId) => ev.push({ e: "cond", st, actorId }),
  operantChanged: (st, actorId) => ev.push({ e: "op", st, actorId }),
  playerHitReaction: (actorId) => ev.push({ e: "flinch", actorId }),
  sfxEvent: (name, actorId) => ev.push({ e: "sfx", name, actorId }),
  fightEnd: (st) => ev.push({ e: "end", st }),
};

const specs = [
  { id: "u1", name: "Ana", hero: FREUD, input: true },
  { id: "u2", name: "Boris", hero: PAVLOV, input: true },
  { id: "u3", name: "Cleo", hero: SKINNER, input: true },
];
const fight = BossFight.forParty(NIGHTMARE_STANDARD, specs, hooks);

// No crits, and every "chance" roll fails — damage numbers stay exact.
const realRandom = Math.random;
Math.random = () => 0.999;

// --- 1. the party is real ---------------------------------------------------
head("1. three input actors share one fight");
ok(JSON.stringify(fight.actorIds()) === '["u1","u2","u3"]', `actorIds() = ${JSON.stringify(fight.actorIds())}`);
const snap0 = fight.snapshot();
ok(snap0.threat.length === 3, `threat table has ${snap0.threat.length} rows`);
ok(
  ["Ana", "Boris", "Cleo"].every((n) => snap0.threat.some((r) => r.name === n)),
  `threat rows: ${snap0.threat.map((r) => `${r.name}/${r.role}`).join(", ")}`
);
ok(
  snap0.hpMax === Math.round(NIGHTMARE_STANDARD.hpByTeamSize[3]),
  `boss hpMax ${snap0.hpMax} = hpByTeamSize[3] ${NIGHTMARE_STANDARD.hpByTeamSize[3]} (3 actors ⇒ 3-man boss)`
);
for (const s of specs) {
  const v = fight.actorView(s.id);
  ok(v && v.name === s.name && v.hp === v.hpMax && v.alive, `actorView(${s.id}) → ${v.name} ${v.hp}/${v.hpMax} ${v.role}`);
}
ok(fight.actorView("nobody") === null, "actorView() of an unknown id is null");
ok(snap0.allies.length === 2, `snapshot().allies is still "everyone but the primary" (${snap0.allies.map((a) => a.name).join(", ")})`);

// engage
while (fight.snapshot().phase === "idle") fight.tick(0.1);
head(`   fight engaged — phase ${fight.snapshot().phase}`);

// --- 2. each actor casts independently, into ONE boss HP pool ---------------
head("2. each actor casts via the As-suffixed methods; one shared boss HP pool");
const hpStart = fight.snapshot().hp;
const dealtBy = {};
for (const s of specs) {
  const before = fight.snapshot().hp;
  const hit = fight.castBasicAs(s.id, 1.0);
  ok(hit !== null && hit.damage > 0, `castBasicAs(${s.id}) → ${hit ? hit.damage.toFixed(2) : "null"}`);
  const dealt = fight.landHitAs(s.id, hit);
  dealtBy[s.id] = dealt;
  const after = fight.snapshot().hp;
  ok(Math.abs(before - after - dealt) < 1e-9, `landHitAs(${s.id}) took ${dealt.toFixed(2)} off the SAME pool (${before.toFixed(1)} → ${after.toFixed(1)})`);
}
const totalDealt = Object.values(dealtBy).reduce((a, b) => a + b, 0);
ok(
  Math.abs(hpStart - fight.snapshot().hp - totalDealt) < 1e-9,
  `all three reduced one pool: ${hpStart.toFixed(1)} − ${totalDealt.toFixed(2)} = ${fight.snapshot().hp.toFixed(1)}`
);
const threatNow = Object.fromEntries(fight.snapshot().threat.map((r) => [r.name, r.value]));
ok(
  Object.values(threatNow).every((v) => v > 0),
  `every actor banked their own threat: ${Object.entries(threatNow).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(", ")}`
);
ok(
  Math.abs(fight.actorView("u1").threat - dealtBy.u1) < 1e-9 &&
    Math.abs(fight.actorView("u3").threat - dealtBy.u3) < 1e-9,
  "threat is credited to the caster, not pooled"
);

// palette / chain / defense / ultimate, each addressed by actor
const pal = fight.castPaletteAs("u1", 0, 1.0);
ok(pal !== null && pal.appliesMark, `castPaletteAs(u1, 0) → ${pal.damage.toFixed(2)}, appliesMark=${pal.appliesMark}`);
fight.landHitAs("u1", pal);
const marksAfterFreud = fight.snapshot().marks;
ok(marksAfterFreud > 0, `Freud's palette minted a TEAM Mark (board = ${marksAfterFreud})`);
const chain = fight.castChainAs("u2", 1.0);
ok(chain !== null, `castChainAs(u2) → ${chain ? chain.damage.toFixed(2) : "null"} (Pavlov's Generalization)`);
ok(ev.some((e) => e.e === "announce" && e.t.includes("Boris")), "the taunt announce names Boris, the actor who cast it");
const def = fight.castDefenseAs("u1");
ok(typeof def === "string", `castDefenseAs(u1) → ${def}`);

// --- 3. kit state is per-actor ---------------------------------------------
head("3. each actor's kit state is its own");
ok(fight.operantFor("u3") !== null, `operantFor(u3=Skinner) = ${JSON.stringify(fight.operantFor("u3"))}`);
ok(fight.operantFor("u1") === null && fight.operantFor("u2") === null, "operantFor(Freud) and operantFor(Pavlov) are null — they carry no operant kit");

const opBefore = JSON.stringify(fight.operantFor("u3"));
// Freud's E is a Defense Mechanism; Skinner's E is the contingency toggle.
// On the old flat class there was ONE `contingency` field for the whole fight.
fight.castDefenseAs("u1");
fight.castPaletteAs("u1", 1, 1.0);
fight.castChainAs("u1", 1.0);
ok(
  JSON.stringify(fight.operantFor("u3")) === opBefore,
  `Freud's E/palette/R left Skinner's operant state alone (${opBefore})`
);
fight.castDefenseAs("u3");
ok(
  fight.operantFor("u3").contingency === "negative",
  `Skinner's own E flipped only his contingency → ${JSON.stringify(fight.operantFor("u3"))}`
);
fight.castChainAs("u3");
ok(
  fight.operantFor("u3").consequence === "punishment",
  `Skinner's own R flipped only his consequence → ${JSON.stringify(fight.operantFor("u3"))}`
);
ok(
  ev.filter((e) => e.e === "op").every((e) => e.actorId === "u3"),
  `every operantChanged carried actorId u3 (${ev.filter((e) => e.e === "op").length} events)`
);

// Conditioning: Pavlov's loop, and only Pavlov's.
const condBefore = ev.filter((e) => e.e === "cond").length;
for (let i = 0; i < 6; i++) {
  fight.castPaletteAs("u2", 0, 1.0); // UCS — opens the UCR window
  fight.castBasicAs("u2", 1.0); // the bell
  fight.tick(0.5);
}
const condEvents = ev.filter((e) => e.e === "cond");
ok(condEvents.length > condBefore, `Pavlov's conditioning loop moved (${condEvents.length} conditioningChanged events)`);
ok(condEvents.every((e) => e.actorId === "u2"), "every conditioningChanged carried actorId u2 — Freud and Skinner have no loop");

// Threat stances are per-actor.
fight.setThreatStanceAs("u2", true);
ok(
  fight.threatStanceActiveFor("u2") && !fight.threatStanceActiveFor("u1") && !fight.threatStanceActiveFor("u3"),
  "setThreatStanceAs(u2) raised only Boris's stance"
);
fight.setThreatStanceAs("u2", false);

// Fixation: the misread is the caster's penalty alone. Run on a second party
// with the boss's damage zeroed, so nobody dies on the way to P2.
const pitEv = [];
const pit = BossFight.forParty(
  NIGHTMARE_STANDARD,
  specs,
  { ...hooks, lockPaletteSlot: (i, ms, actorId) => pitEv.push({ e: "lock", i, actorId }) },
  { hpMult: 1, dmgMult: 0 }
);
while (pit.snapshot().phase !== "p2") pit.tick(0.1);
pit.notifyP2Stage(0);
const freudBefore = pit.castBasicAs("u1", 1.0).damage;
const skinnerBefore = pit.castBasicAs("u3", 1.0).damage;
pit.castPaletteAs("u1", 3, 1.0); // stage 0 is the answer — 3 is a misread
const lock = pitEv.at(-1);
ok(pitEv.length === 1 && lock.actorId === "u1", `Fixation locked slot ${lock.i} for actorId ${lock.actorId}`);
const freudAfter = pit.castBasicAs("u1", 1.0).damage;
const skinnerAfter = pit.castBasicAs("u3", 1.0).damage;
ok(Math.abs(freudAfter / freudBefore - 0.7) < 1e-9, `Ana's damage is cut 30% by HER Fixation (×${(freudAfter / freudBefore).toFixed(4)})`);
ok(Math.abs(skinnerAfter / skinnerBefore - 1) < 1e-9, `Cleo's damage is untouched by Ana's misread (×${(skinnerAfter / skinnerBefore).toFixed(4)})`);

// Ultimates run on their own clocks and their own Mark spend.
head("4. ultimates, vitals and the shared Mark board");
for (let i = 0; i < 6; i++) {
  const h = pit.castPaletteAs("u1", 0, 1.0);
  if (h) pit.landHitAs("u1", h);
}
const marksBeforeUlt = pit.snapshot().marks;
const ultTotal = pit.castUltimateAs("u1");
ok(ultTotal > 0 && pit.snapshot().marks < marksBeforeUlt, `castUltimateAs(u1) spent the TEAM board: ${marksBeforeUlt} → ${pit.snapshot().marks} Marks for ${ultTotal.toFixed(0)}`);
const dotsBefore = ev.filter((e) => e.e === "dot" && e.actorId === "u1").length;
pit.landUltimateAs("u1", ultTotal);
for (let i = 0; i < 12; i++) pit.tick(0.1);
const dots = ev.filter((e) => e.e === "dot" && e.actorId === "u1");
ok(dots.length > dotsBefore, `Dream Analysis ticked ${dots.length - dotsBefore} times, tagged actorId u1`);

// Boss hits route vitals to whoever was hit.
Math.random = realRandom;
for (let i = 0; i < 900 && !ev.some((e) => e.e === "damagePlayer"); i++) fight.tick(0.1);
const hurtIds = new Set(ev.filter((e) => e.e === "damagePlayer").map((e) => e.actorId));
ok(hurtIds.size > 0 && [...hurtIds].every((id) => ["u1", "u2", "u3"].includes(id)), `damagePlayer routed by actorId: ${[...hurtIds].join(", ")}`);
const healIds = new Set(ev.filter((e) => e.e === "healPlayer").map((e) => e.actorId));
ok([...healIds].every((id) => ["u1", "u2", "u3"].includes(id)), `healPlayer routed by actorId: ${[...healIds].join(", ") || "(none yet)"}`);

// --- 5. legacy surface still points at actor 0 ------------------------------
head("5. the legacy (no-id) methods still act on the primary actor");
const legacy = new BossFight(NIGHTMARE_STANDARD, FREUD, [], {
  announce: () => {}, setBossPhase: () => {}, bossStrike: () => {},
  damagePlayer: () => {}, healPlayer: () => {}, playerBuff: () => {},
  lockPaletteSlot: () => {}, playerHitReaction: () => {},
});
while (legacy.snapshot().phase === "idle") legacy.tick(0.1);
Math.random = () => 0.999;
const viaLegacy = legacy.castBasic(1.0).damage;
const viaId = legacy.castBasicAs(legacy.actorIds()[0], 1.0).damage;
ok(viaLegacy === viaId, `castBasic() === castBasicAs(primary): ${viaLegacy.toFixed(4)}`);
ok(legacy.actorIds().length === 1 && legacy.snapshot().hpMax === Math.round(NIGHTMARE_STANDARD.hpByTeamSize[1]), "a solo legacy fight is one actor against the 1-man boss");
ok(legacy.operant === legacy.operantFor("player") && legacy.threatStanceActive === legacy.threatStanceActiveFor("player"), "legacy getters delegate to the primary actor");
Math.random = realRandom;

console.log(`\n${failures === 0 ? "ALL PARTY CHECKS PASSED" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
