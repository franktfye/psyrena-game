// Scratch driver: equip one pet, walk the hero, and report/shoot its clips.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petanim.mjs husky /tmp/husky
// Writes <out>-idle.png and <out>-walk.png, prints the clip roles it resolved.
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const PET = process.argv[2] ?? "husky";
const OUT = process.argv[3] ?? `/tmp/pet-${PET}`;
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";

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
// Pre-seed the account-scoped wardrobe so the pet is equipped at scene build.
await page.evaluate((pet) => {
  localStorage.setItem(
    "psyrena_wardrobe:frank",
    JSON.stringify({ skin: "default", pet, petChosen: true })
  );
}, PET);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

await page.waitForSelector("#auth", { timeout: 20000 });
if (await page.$('#auth input[placeholder="username"]')) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}
// Intro guide sits between login and the picker - click Continue through it.
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("#auth button.cta")];
  btns.find((b) => /continue/i.test(b.textContent))?.click();
  return btns.some((b) => /enter/i.test(b.textContent));
}, { timeout: 30000, polling: 300 });
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth .hero")].some((t) => /pavlov/i.test(t.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth .hero")].find((t) => /pavlov/i.test(t.textContent)).click();
});
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click();
});
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 300000, polling: 1000 }
);
await page
  .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), {
    timeout: 120000,
    polling: 1000,
  })
  .catch(() => logs.push("[warn] textures not all ready"));

const found = await page
  .waitForFunction(
    (pet) => {
      const s = window.psyrena.manager.active;
      const n = s.transformNodes.find((t) => t.name === `pet_${pet}`);
      return n && n.getChildMeshes().length > 0;
    },
    { timeout: 60000, polling: 1000 },
    PET
  )
  .then(() => true)
  .catch(() => false);
if (!found) {
  console.log(`FAIL ${PET}: follower node never appeared`);
  console.log(logs.slice(-25).join("\n"));
  await browser.close();
  process.exit(1);
}

await page.evaluate((pet) => {
  const s = window.psyrena.manager.active;
  const node = s.transformNodes.find((t) => t.name === `pet_${pet}`);
  const c = s.activeCamera;
  s.onBeforeRenderObservable.add(() => {
    const p = node.getAbsolutePosition();
    c.alpha = 0.9;
    c.beta = 1.2;
    c.radius = 3.2;
    c.target.set(p.x, p.y + 0.3, p.z);
  });
}, PET);

/** Clip roster + who is playing, read off the live scene. */
const probe = (pet) => {
  const s = window.psyrena.manager.active;
  const node = s.transformNodes.find((t) => t.name === `pet_${pet}`);
  const meshes = node.getChildMeshes();
  let min = null;
  let max = null;
  for (const m of meshes) {
    if (!m.getTotalVertices?.()) continue;
    m.refreshBoundingInfo(true);
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    const mn = bb.minimumWorld;
    const mx = bb.maximumWorld;
    if (!min) {
      min = { x: mn.x, y: mn.y, z: mn.z };
      max = { x: mx.x, y: mx.y, z: mx.z };
    } else
      for (const k of ["x", "y", "z"]) {
        min[k] = Math.min(min[k], mn[k]);
        max[k] = Math.max(max[k], mx[k]);
      }
  }
  // Gap to the heel spot — what the follower's walk/run threshold reads.
  const heroNode = s.transformNodes.find((t) => t.name === "freud");
  let gap = null;
  if (heroNode) {
    const ry = heroNode.rotation.y;
    const fx = -Math.sin(ry);
    const fz = -Math.cos(ry);
    const tx = heroNode.position.x - fx * 0.95 - fz * 0.75;
    const tz = heroNode.position.z - fz * 0.95 + fx * 0.75;
    gap = +Math.hypot(tx - node.position.x, tz - node.position.z).toFixed(3);
  }
  return {
    gap,
    playing: s.animationGroups.filter((g) => g.isPlaying).map((g) => `${g.name}@${g.speedRatio.toFixed(2)}`),
    all: s.animationGroups.map((g) => g.name),
    models: node.getChildren().length,
    enabled: node.getChildren().filter((k) => k.isEnabled?.()).length,
    h: min ? +(max.y - min.y).toFixed(3) : null,
    minY: min ? +min.y.toFixed(3) : null,
  };
};

// Idle: give it long enough to pass SIT_AFTER_S and cycle at least twice.
await new Promise((r) => setTimeout(r, 3000));
console.log(`${PET} idle-1:`, JSON.stringify(await page.evaluate(probe, PET)));
await page.screenshot({ path: `${OUT}-idle.png` });
await new Promise((r) => setTimeout(r, 7000));
console.log(`${PET} idle-2:`, JSON.stringify(await page.evaluate(probe, PET)));

await page.focus("canvas");
await page.keyboard.down("w");
await new Promise((r) => setTimeout(r, 2500));
console.log(`${PET} walking:`, JSON.stringify(await page.evaluate(probe, PET)));
await page.screenshot({ path: `${OUT}-walk.png` });
// Sprint: open the gap past RUN_M so a pet with both gaits switches to `run`.
await page.keyboard.down("Shift");
await new Promise((r) => setTimeout(r, 3500));
console.log(`${PET} sprinting:`, JSON.stringify(await page.evaluate(probe, PET)));
await page.screenshot({ path: `${OUT}-run.png` });
await page.keyboard.up("Shift");
await page.keyboard.up("w");

// Framerate-independent check of the walk→run threshold: shove the hero 3 m
// clear (under SNAP_M, so the pet chases rather than teleports) and sample
// while the gap is still wide. At 2 fps the chase never opens a real gap on
// its own, so sprinting alone cannot exercise this.
await new Promise((r) => setTimeout(r, 3000));
// Pin the hero 2.5 m ahead of the pet EVERY FRAME. A one-shot shove is closed
// inside a single tick here (the chase gain takes ~89 % of a 2.8 m gap when dt
// is capped at 0.1), so only a sustained gap can hold the follower in `run`.
await page.evaluate((pet) => {
  const s = window.psyrena.manager.active;
  const node = s.transformNodes.find((t) => t.name === `pet_${pet}`);
  const h = s.transformNodes.find((t) => t.name === "freud");
  s.onBeforeRenderObservable.add(() => {
    h.position.x = node.position.x + 2.5;
    h.position.z = node.position.z + 2.5;
  });
}, PET);
await new Promise((r) => setTimeout(r, 4000));
const far = await page.evaluate(probe, PET);
console.log(`${PET} far-chase:`, JSON.stringify({ gap: far.gap, playing: far.playing }));
await page.screenshot({ path: `${OUT}-run.png` });

const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
if (errs.length) console.log("errors:\n" + errs.slice(0, 10).join("\n"));
await browser.close();
