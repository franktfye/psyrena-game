/**
 * Headless check for PRACTICE MODE (not shipped — dev tool): the two
 * practice bots (shared/bosses/practiceBots.ts) fill in around a driven
 * Freud, and the design contract is asserted both ways:
 *
 *   - STANDARD: the trio clears before the enrage (bots carry a learning run)
 *   - NIGHTMARE: the trio never clears (bots do not carry a challenge run)
 *
 * The driven player runs the same focus/GCD-constrained rotation the bot-mode
 * calibration used (2026-08-05 sim grid): hold-to-loop basic, palette on the
 * GCD under the 100-pool / 2-per-s Focus economy, correct P2 answers, E when
 * meaningfully hurt. Majority verdicts over N runs — single runs ride crit
 * and jackpot RNG.
 *
 * Run: node tools/practice-sim-check.mjs
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function bundle(entry) {
  const f = join(mkdtempSync(join(tmpdir(), "psyrena-practice-")), "mod.mjs");
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

const DT = 0.1;
const GCD_S = 1.5;
const SLOT_CD_S = 3.0;
const PALETTE_FOCUS = 8;
const BEATS = [0.8, 1.0, 1.5];

const bots = practiceBotsFor("freud");
if (bots.length !== 2 || !bots.some((b) => b.role === "tank") || !bots.some((b) => b.role === "healer")) {
  console.error("FAIL: practiceBotsFor('freud') must field the tank + healer pair");
  process.exit(1);
}

function run(diffKey) {
  const spec = DIFFICULTY[diffKey];
  let playerDead = false;
  let focus = 100;
  let taken = 0;
  let healed = 0;
  const fight = new BossFight(
    NIGHTMARE_STANDARD,
    FREUD,
    practiceBotsFor("freud"),
    {
      announce: () => {},
      setBossPhase: () => {},
      bossStrike: () => {},
      damagePlayer: (n) => (taken += n),
      healPlayer: (n) => (healed += n),
      playerBuff: () => {},
      lockPaletteSlot: () => {},
      playerHitReaction: () => {},
      gainFocus: (n) => (focus = Math.min(100, focus + n)),
      combatantDied: (_n, isPlayer) => {
        if (isPlayer) playerDead = true;
      },
      fightEnd: () => {},
    },
    { hpMult: spec.hpMult, dmgMult: spec.dmgMult }
  );

  let t = 0;
  let gcdAt = 0;
  let basicAt = 0;
  let defenseAt = 0;
  const slotAt = FREUD.palette.map(() => 0);
  let p2Stage = -1;

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
      if (stage !== p2Stage) {
        p2Stage = stage;
        fight.notifyP2Stage(stage);
      }
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
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

const std = Array.from({ length: N }, () => run("standard"));
const stdWins = std.filter((r) => r.win);
console.log(
  `standard: ${stdWins.length}/${N} wins, median kill ${
    stdWins.length ? Math.round(stdWins.map((r) => r.t).sort((a, b) => a - b)[Math.floor(stdWins.length / 2)]) : "—"
  }s (enrage ${NIGHTMARE_STANDARD.enrageCycles * 210}s of phase time)`
);
if (stdWins.length < Math.ceil(N * 0.7)) {
  fail(`practice trio should clear STANDARD reliably — won ${stdWins.length}/${N}`);
}

const nm = Array.from({ length: N }, () => run("nightmare"));
const nmWins = nm.filter((r) => r.win).length;
console.log(`nightmare: ${nmWins}/${N} wins (bots are DESIGNED to fail here)`);
if (nmWins > 0) {
  fail(`practice trio must NOT clear NIGHTMARE — won ${nmWins}/${N}`);
}

console.log("\nPRACTICE-MODE CHECKS PASSED");
