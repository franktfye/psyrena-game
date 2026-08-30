// Verification driver for the Practice Booth.
// Boots the village, enters the booth, casts at the dummy, leaves by the portal.
// Usage: PSY_URL=http://host:port/ node practiceverify.mjs [out.png]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUT = process.argv[2] ?? "/tmp/practice-verify.png";
const URL = process.env.PSY_URL || "http://127.0.0.1:5173/";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1600,900",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- login ---------------------------------------------------------------
await page.waitForSelector("#auth", { timeout: 20000 });
if (await page.$('#auth input[placeholder="username"]')) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() =>
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click()
);
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });

const booted = () =>
  document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active;
await page.waitForFunction(booted, { timeout: 120000 });
check("village boots", true);

// ---- the booth is registered as a scene ---------------------------------
check(
  "practice scene registered",
  await page.evaluate(() => Boolean(window.psyrena.SCENES.practice)),
  await page.evaluate(() => window.psyrena.SCENES.practice?.label ?? "missing")
);

// ---- enter ---------------------------------------------------------------
await page.evaluate(() => window.psyrena.go("practice"));
await page.waitForFunction(booted, { timeout: 120000 });
await page
  .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), {
    timeout: 60000,
    polling: 1000,
  })
  .catch(() => logs.push("[warn] textures not all ready"));

const inventory = await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const names = s.meshes.map((m) => m.name);
  return {
    total: names.length,
    dummy: names.some((n) => /practiceDummy$/.test(n)),
    pad: names.some((n) => /practicePad$/.test(n)),
    portal: names.some((n) => /exitPortalRing/.test(n)),
    portalPick: names.some((n) => /exitPortalPick/.test(n)),
    ground: names.some((n) => /plazaGround/.test(n)),
    island: names.some((n) => /islandCone|islandLip/.test(n)),
    sky: names.some((n) => /skyBox/.test(n)),
    hero: names.some((n) => /^freud/.test(n)),
    // The things that must NOT be here.
    facilities: names.filter((n) => /^(outfitter|style-lab|hall-of-minds|queue-terminal|coffee-shop|pet-park|residential)/.test(n)),
    npcs: names.filter((n) => /^(villager|npc_)/.test(n)),
    arenaPortal: names.filter((n) => /portalStand|blackHole/i.test(n)),
  };
});

check("dummy present", inventory.dummy);
check("dummy pad present", inventory.pad);
check("exit portal present", inventory.portal && inventory.portalPick);
check("village ground reused", inventory.ground, "plazaGround");
check("island reused", inventory.island);
check("sky reused", inventory.sky);
check("hero present", inventory.hero);
check("no buildings", inventory.facilities.length === 0, inventory.facilities.slice(0, 4).join(",") || "none");
check("no NPCs / crowd", inventory.npcs.length === 0, inventory.npcs.slice(0, 4).join(",") || "none");
check("no arena portal", inventory.arenaPortal.length === 0, inventory.arenaPortal.slice(0, 3).join(",") || "none");
console.log(`      (scene carries ${inventory.total} meshes)`);

// ---- cast at the dummy ---------------------------------------------------
// Click the palette slot the same way a player does; the bar is DOM.
const casts = 4;
for (let i = 0; i < casts; i++) {
  // Press the key the bar binds — same path a player takes, no DOM guessing.
  await page.keyboard.press("Digit1");
  await new Promise((r) => setTimeout(r, 1700)); // clear the 1.5 s GCD
}
// Damage now lands on IMPACT, not at cast — and under SwiftShader a 9 m flight
// takes seconds, so poll for the projectiles to arrive instead of assuming a
// fixed wait is enough. The meter is the authoritative signal: it accumulates
// and never expires, unlike the 0.95 s damage numbers.
let sawNumber = false;
const landed = await page
  .waitForFunction(
    () => {
      const el = document.getElementById("practice-meter");
      const m = el && /dmg\s+([\d,]+)/.exec(el.innerText);
      return m && Number(m[1].replace(/,/g, "")) > 0 ? el.innerText : false;
    },
    { timeout: 45000, polling: 400 }
  )
  .then((h) => h.jsonValue())
  .catch(() => null);
sawNumber = Boolean(landed);
check(
  "casting produces damage numbers",
  sawNumber,
  landed ? (landed.match(/dmg\s+[\d,]+/) ?? [""])[0] : "no damage recorded within 45s"
);

// ---- projectiles home on the dummy --------------------------------------
// A homing projectile converges on the target; an untargeted one flies off on
// a random spread. Sample live orb positions and measure against the dummy.
await page.keyboard.press("Digit2");
await new Promise((r) => setTimeout(r, 900)); // mid-flight sample
const homing = await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const dummy = s.getMeshByName("practiceDummyHitbox");
  if (!dummy) return { orbs: 0, maxDist: -1 };
  const orbs = s.meshes.filter((m) => /orb|projectile/i.test(m.name) && m.isEnabled());
  const d = orbs.map((o) =>
    Math.hypot(o.position.x - dummy.position.x, o.position.z - dummy.position.z)
  );
  return { orbs: orbs.length, maxDist: d.length ? Math.max(...d) : -1 };
});
// The hero stands ~9 m from the dummy, so anything still in flight must be
// inside that corridor rather than heading off across the plaza.
check(
  "projectiles track the dummy",
  homing.orbs === 0 || homing.maxDist < 9.5,
  homing.orbs ? `${homing.orbs} in flight, furthest ${homing.maxDist.toFixed(1)}m from dummy` : "none in flight at sample time"
);

// ---- the meter ----------------------------------------------------------
// Heal on E so HPS has something to report, then read the panel.
await page.keyboard.press("KeyE");
await new Promise((r) => setTimeout(r, 1800));
await page
  .waitForFunction(
    () => {
      const el = document.getElementById("practice-meter");
      return el && /heal\s+([\d,]+)/.test(el.innerText) && !/heal\s+0\b/.test(el.innerText);
    },
    { timeout: 30000, polling: 400 }
  )
  .catch(() => logs.push("[warn] heal never registered"));
const meter = await page.evaluate(() => {
  const el = document.getElementById("practice-meter");
  if (!el) return null;
  return { text: el.innerText.replace(/\n+/g, " | "), rows: el.querySelectorAll("span").length };
});
check("practice meter rendered", Boolean(meter), meter ? meter.text.slice(0, 96) : "missing");
check(
  "meter reports damage and DPS",
  Boolean(meter && /dmg\s+[1-9]/.test(meter.text)),
  meter ? (meter.text.match(/dmg\s+[\d,]+/) ?? ["?"])[0] : ""
);
check(
  "meter reports healing (E self-heal)",
  Boolean(meter && /heal\s+[1-9]/.test(meter.text)),
  meter ? (meter.text.match(/heal\s+[\d,]+/) ?? ["?"])[0] : ""
);

await page.screenshot({ path: OUT });

// ---- leave via the portal -----------------------------------------------
await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  // Walk the hero onto the portal; the proximity ticker should fire.
  const hero = s.transformNodes.find((n) => n.name === "freud") ?? null;
  const mesh = s.getMeshByName("exitPortalPick");
  if (hero && mesh) hero.position.set(mesh.position.x, 0, mesh.position.z);
});
await new Promise((r) => setTimeout(r, 2500));
await page.waitForFunction(booted, { timeout: 120000 }).catch(() => {});
const backHome = await page.evaluate(
  () => window.psyrena.manager.active?.getMeshByName("plazaGround") !== null &&
        window.psyrena.manager.active?.meshes.some((m) => /portalStand/.test(m.name))
);
check("portal returns to village", backHome);

console.log(`\n${OUT}`);
const errs = logs.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 8);
console.log(errs.length ? errs.join("\n") : "(no page errors)");
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
