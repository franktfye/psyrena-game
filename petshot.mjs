// Scratch driver: log in as Pavlov, screenshot Druzhok at heel in the hub.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petshot.mjs <out.png>
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUT = process.argv[2] ?? "/tmp/pet.png";
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

await page.waitForSelector("#auth", { timeout: 20000 });
const login = await page.$('#auth input[placeholder="username"]');
if (login) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}
// Hero picker: select Pavlov, then Enter.
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
  .catch(() => logs.push("[warn] textures not all ready before timeout"));

// Wait for the pet follower to spawn and have its model under it.
await page
  .waitForFunction(
    () => {
      const s = window.psyrena.manager.active;
      const pet = s.transformNodes.find((n) => n.name === "pet_druzhok");
      return pet && pet.getChildMeshes().length > 0;
    },
    { timeout: 60000, polling: 1000 }
  )
  .catch(() => logs.push("[warn] pet_druzhok node not found"));

// Aim at the pet from the hub camera and report measurements.
const info = await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const pet = s.transformNodes.find((n) => n.name === "pet_druzhok");
  if (!pet) return { error: "no pet node" };
  pet.computeWorldMatrix(true);
  const p = pet.getAbsolutePosition();
  const kids = pet.getChildren();
  const enabled = kids.filter((k) => k.isEnabled?.());
  let bounds = null;
  const vis = pet.getChildMeshes().find((m) => m.isEnabled());
  const rootChild = kids.find((k) => k.isEnabled?.() && k.getChildMeshes);
  if (rootChild) {
    const b = rootChild.getHierarchyBoundingVectors(true);
    bounds = {
      h: +(b.max.y - b.min.y).toFixed(3),
      l: +(b.max.z - b.min.z).toFixed(3),
      w: +(b.max.x - b.min.x).toFixed(3),
      minY: +b.min.y.toFixed(3),
    };
  }
  const c = s.activeCamera;
  s.onBeforeRenderObservable.add(() => {
    c.alpha = 0.9;
    c.beta = 1.25;
    c.radius = 4.5;
    c.target.set(p.x, p.y + 0.4, p.z);
  });
  return {
    pos: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    children: kids.map((k) => `${k.name}${k.isEnabled?.() ? "" : " (disabled)"}`),
    enabledCount: enabled.length,
    visMesh: vis?.name ?? null,
    bounds,
  };
});
console.log(JSON.stringify(info, null, 1));
await new Promise((r) => setTimeout(r, 8000)); // software GL needs frames to settle
await page.screenshot({ path: OUT });
console.log(OUT);
console.log(logs.filter((l) => !/^\[log\]/.test(l)).slice(0, 15).join("\n") || "(clean)");
await browser.close();
