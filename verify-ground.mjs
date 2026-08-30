// Scratch verification driver: Pavlov walk-start / jump grounding + Druzhok
// idle/walk model swap sizing. Logs in as frank, picks Pavlov, then measures
// the hero body's lowest vertex relative to the wrapper (0 = soles on
// pavement) through idle → walk → stop → jump, and the pet models' bounds.
//   node verify-ground.mjs <outDir>
import puppeteer from "puppeteer-core";
import fs from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUT = process.argv[2] ?? "/tmp/verify-ground";
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const logs = [];
page.on("console", (m) => { const t = m.text(); if (!/^\[?(log|info)/.test(m.type())) logs.push(`[${m.type()}] ${t}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// --- login ---
await page.waitForSelector("#auth", { timeout: 20000 });
const login = await page.$('#auth input[placeholder="username"]');
if (login) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}

// --- hero picker: select Pavlov, then Enter ---
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth .nm")].some((n) => /pavlov/i.test(n.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  const nm = [...document.querySelectorAll("#auth .nm")].find((n) => /pavlov/i.test(n.textContent));
  nm.closest("[role=button], .tile, div").click();
});
await new Promise((r) => setTimeout(r, 500));
// Intro guide sits between login and the picker - click Continue through it.
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("#auth button.cta")];
  btns.find((b) => /continue/i.test(b.textContent))?.click();
  return btns.some((b) => /enter/i.test(b.textContent));
}, { timeout: 30000, polling: 300 });
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent))?.click();
});
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });

// --- boot ---
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 420000, polling: 1000 }
);
await page
  .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), { timeout: 120000, polling: 1000 })
  .catch(() => logs.push("[warn] textures not all ready"));
await new Promise((r) => setTimeout(r, 4000));

// One measurement: hero sole error + pet state. Runs inside the page.
const sample = () =>
  page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const wrapper = s.getTransformNodeByName("freud");
    const body = s.meshes.find((m) => m.name.startsWith("freud_") && m.getTotalVertices?.() > 0);
    let sole = null;
    if (body && wrapper) {
      body.refreshBoundingInfo(true, false);
      sole = body.getBoundingInfo().boundingBox.minimumWorld.y - wrapper.absolutePosition.y;
    }
    const petRoot = s.transformNodes.find((n) => n.name.startsWith("pet_"));
    let pet = null;
    if (petRoot) {
      const models = petRoot.getChildMeshes(true).filter((m) => m.parent === petRoot);
      pet = {
        rootY: +petRoot.position.y.toFixed(3),
        models: models.map((m) => {
          const on = m.isEnabled();
          let b = null;
          if (on) {
            const bb = m.getHierarchyBoundingVectors();
            b = {
              h: +(bb.max.y - bb.min.y).toFixed(3),
              l: +(bb.max.z - bb.min.z).toFixed(3),
              w: +(bb.max.x - bb.min.x).toFixed(3),
              minY: +bb.min.y.toFixed(3),
            };
          }
          return { name: m.name, on, b };
        }),
      };
    }
    return { sole: sole === null ? null : +sole.toFixed(3), hero: wrapper ? +wrapper.position.y.toFixed(3) : null, pet };
  });

const series = async (label, ms, step) => {
  const t0 = Date.now();
  const out = [];
  while (Date.now() - t0 < ms) {
    const v = await sample();
    out.push({ t: +((Date.now() - t0) / 1000).toFixed(2), sole: v.sole });
    await new Promise((r) => setTimeout(r, step));
  }
  const soles = out.map((o) => o.sole).filter((x) => x !== null);
  console.log(`${label}: min=${Math.min(...soles).toFixed(3)} max=${Math.max(...soles).toFixed(3)} n=${soles.length}`);
  return out;
};

const report = { logs };

// idle settle
report.idleSeries = await series("idle", 6000, 300);
report.idlePet = (await sample()).pet;
await page.screenshot({ path: `${OUT}/1-idle.png` });

// walk start — the old bug: body plays ~1 m under, servo crawls it back
await page.keyboard.down("w");
report.walkSeries = await series("walk", 4000, 150);
report.walkPet = (await sample()).pet;
await page.screenshot({ path: `${OUT}/2-walk.png` });
await page.keyboard.up("w");
await new Promise((r) => setTimeout(r, 2500));
report.stopPet = (await sample()).pet;
await page.screenshot({ path: `${OUT}/3-stopped.png` });

// jump — the old bug: whole arc ~1 m low, lands underground
await page.keyboard.press(" ");
report.jumpSeries = await series("jump", 3000, 120);
await new Promise((r) => setTimeout(r, 1500));
report.afterJump = await sample();
await page.screenshot({ path: `${OUT}/4-after-jump.png` });

// second jump while walking (the spam case)
await page.keyboard.down("w");
await new Promise((r) => setTimeout(r, 800));
await page.keyboard.press(" ");
report.jumpWalkSeries = await series("jump+walk", 3000, 120);
await page.keyboard.up("w");
await new Promise((r) => setTimeout(r, 1800));
report.final = await sample();
await page.screenshot({ path: `${OUT}/5-final.png` });

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log("final sole err:", report.final.sole, "hero y:", report.final.hero);
console.log("pet idle:", JSON.stringify(report.idlePet));
console.log("pet walk:", JSON.stringify(report.walkPet));
console.log("pet stop:", JSON.stringify(report.stopPet));
console.log("page issues:", logs.slice(0, 10).join("\n") || "(clean)");
await browser.close();
