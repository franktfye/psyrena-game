/**
 * Regression test for Pavlov's Extinction takeover (dev tool, not shipped).
 *
 * The bug this pins: `createHeroAnimator`'s `fullBodyClips` list is BOTH the
 * "stop the siblings" set and the set that gets the end observer which drops
 * the `takenOver` flag. `cast_f` — Pavlov's dedicated 2 s ultimate clip, and
 * the only clip no other hero reaches — was missing from it, so pressing F in
 * the practice pit left the flag up forever: locomotion pinned at zero weight,
 * the rig frozen on the last Extinction frame, and `busy()`/`poseSettled()`
 * latched false for the rest of the scene (which also stalls the ground magnet).
 *
 * It reads the Babylon animation groups directly rather than looking at pixels,
 * because "stuck" here is a weight-blend fact, not a rendering one.
 *
 * The tail of the run then drives the conditioning loop through the real HUD:
 * `pairingsToCondition` is a hidden 1..3 roll, so the buff tile must not print
 * a denominator and CS must still light up inside `max` clean pairings. The
 * loop's arithmetic is sim-check scenario 5's job; this is the UI half.
 *
 * Run: npx vite --port 5199 &  node server/index.mjs &
 *      E2E_URL=http://localhost:5199/ node tools/pavlov-ult-anim-e2e.mjs
 */
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5199/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // ---- log in as Pavlov ----------------------------------------------------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await Promise.all([page.waitForSelector("#auth .hero", { timeout: 20_000 }), page.click("#auth button.cta")]);
  const tile = await page.evaluateHandle(
    () => [...document.querySelectorAll("#auth .hero")].find((t) => t.textContent?.includes("Pavlov")) ?? null
  );
  if (!tile.asElement()) throw new Error("no Pavlov tile in the hero picker");
  await tile.asElement().click();
  await sleep(300);
  const enter = await page.evaluateHandle(
    () => [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent ?? "")) ?? null
  );
  await enter.asElement().click();

  const booted = () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active;
  await page.waitForFunction(booted, { timeout: 240_000 });
  check("entered as pavlov", (await page.evaluate(() => window.psyrena.profile.selectedHero)) === "pavlov");

  // ---- the practice pit is the scene that builds the hero in "fight" style --
  await page.evaluate(() => window.psyrena.go("practice"));
  await page.waitForFunction(booted, { timeout: 240_000 });
  await sleep(3_000); // let the glb land and the idle loop settle

  /** Weights of the clips that decide whether he is posing or standing. */
  const weights = () =>
    page.evaluate(() => {
      const groups = window.psyrena.manager.active.animationGroups;
      const w = (name) => {
        const g = groups.find((g) => g.name.toLowerCase() === name);
        if (!g) return null;
        // A finished one-shot has no animatable left, which is a weight of 0 as
        // far as "is this clip driving bones" goes — the sentinel that matters.
        const a = g.animatables?.[0];
        return { weight: a ? a.weight : 0, playing: g.isPlaying };
      };
      return { idle: w("idle"), castF: w("cast_f"), cast: w("cast"), names: groups.map((g) => g.name) };
    });

  const before = await weights();
  check("rig carries a cast_f clip", before.castF !== null, before.names.join(","));
  check("idle drives the rig at rest", (before.idle?.weight ?? 0) > 0.8, `idle weight ${before.idle?.weight?.toFixed(3)}`);

  // ---- press F, let the 2 s clip run out, then look again -------------------
  await page.keyboard.press("KeyF");
  await sleep(600);
  const during = await weights();
  check("Extinction takes the body over", (during.castF?.weight ?? 0) > 0.5, `cast_f weight ${during.castF?.weight?.toFixed(3)}`);
  check(
    "idle yields while the ult plays",
    (during.idle?.weight ?? 1) < 0.5,
    `idle weight ${during.idle?.weight?.toFixed(3)}`
  );

  // cast_f is 2.0 s at ratio 1.0; give it the clip plus the weight slew.
  await sleep(4_000);
  const after = await weights();
  check(
    "cast_f releases the rig when it ends",
    (after.castF?.weight ?? 1) < 0.05,
    `cast_f weight ${after.castF?.weight?.toFixed(3)}, playing=${after.castF?.playing}`
  );
  check(
    "hero returns to idle after Extinction",
    (after.idle?.weight ?? 0) > 0.8,
    `idle weight ${after.idle?.weight?.toFixed(3)}`
  );

  // ---- and the takeover flag really cleared: a later cast must still read ---
  // Checked on the CAST clip, not on idle being low: a stuck takeover ALSO
  // holds idle at zero, so "idle is low" alone passes on the broken build.
  await page.keyboard.press("Digit1");
  await sleep(500);
  const recast = await weights();
  check(
    "a later cast still drives the rig after an Extinction",
    (recast.cast?.weight ?? 0) > 0.5,
    `cast weight ${recast.cast?.weight?.toFixed(3)}, idle ${recast.idle?.weight?.toFixed(3)}`
  );

  // ---- the conditioning loop, through the real HUD -------------------------
  // `pairingsToCondition` is a hidden 1..3 roll now, so the tile must NOT print
  // a denominator (it would be a lie two cycles in three) and CS must light up
  // within `max` clean pairings, however the roll landed.
  const hudText = () =>
    page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

  let conditioned = false;
  let sawTile = false;
  for (let i = 0; i < 6 && !conditioned; i++) {
    await page.mouse.click(640, 300); // NS bell is LMB (basicAttack.ts) — ring first
    await sleep(250);
    await page.keyboard.press("Digit1"); // UCS — food while the bell rings
    await sleep(1_800);
    const t = await hudText();
    if (/Pairing \d+ banked/.test(t)) sawTile = true;
    if (/CONDITIONED/i.test(t)) conditioned = true;
  }
  check("conditioning reaches CONDITIONED", conditioned);
  const finalText = await hudText();
  check(
    "the pairing tile hides the rolled target",
    !/Pairing \d+\s*\/\s*\d+/.test(finalText),
    sawTile ? 'saw "Pairing N banked"' : "no pairing tile seen (conditioned on the first roll)"
  );
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = failed ? 1 : 0;
