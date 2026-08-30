// VFX polish verification driver — logs in, picks a hero, casts in the
// village, screenshots projectiles mid-flight.
// Usage: node vfxshot.mjs <hero:pavlov|freud> <outPrefix> [--ucs]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const [HERO = "pavlov", PREFIX = "/tmp/vfx"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const UCS = process.argv.includes("--ucs");
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
    "--window-size=1600,900",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// Auth: handle both the login form and a remembered-session hero picker.
await page.waitForSelector("#auth", { timeout: 20000 });
const login = await page.$('#auth input[placeholder="username"]');
if (login) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}
// Hero picker: click the tile whose name matches.
// Intro guide sits between login and the picker - click Continue through it.
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("#auth button.cta")];
  btns.find((b) => /continue/i.test(b.textContent))?.click();
  return btns.some((b) => /enter/i.test(b.textContent));
}, { timeout: 30000, polling: 300 });
await page.waitForFunction(
  (hero) =>
    [...document.querySelectorAll("#auth .hero .nm")].some((n) =>
      n.textContent.toLowerCase().includes(hero)
    ),
  { timeout: 30000 },
  HERO
);
await page.evaluate((hero) => {
  const nm = [...document.querySelectorAll("#auth .hero .nm")].find((n) =>
    n.textContent.toLowerCase().includes(hero)
  );
  nm.closest(".hero").click();
}, HERO);
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")]
    .find((b) => /enter/i.test(b.textContent))
    ?.click();
});
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });

await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 300000, polling: 1000 }
);
await page
  .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), {
    timeout: 60000,
    polling: 1000,
  })
  .catch(() => logs.push("[warn] textures not all ready"));
await new Promise((r) => setTimeout(r, 3000));

// Side-on camera so the flight path crosses the frame instead of receding.
await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const c = s.activeCamera;
  if (c.upperRadiusLimit !== undefined) c.upperRadiusLimit = 30;
  window.__vfxCam = s.onBeforeRenderObservable.add(() => {
    c.alpha += 0.0; // keep whatever yaw; just pull back a bit
    c.radius = 6.2;
    c.beta = 1.25;
  });
});

const shoot = async (tag, fire, delays) => {
  await fire();
  for (const d of delays) {
    await new Promise((r) => setTimeout(r, d));
    await page.screenshot({ path: `${PREFIX}_${tag}_${d}.png` });
  }
  await new Promise((r) => setTimeout(r, 1500));
};

// Basic attack: fires only via pointer events on the canvas.
const canvasClick = async () => {
  await page.mouse.click(800, 430);
};

await shoot("basic1", canvasClick, [180, 400]);
await shoot("basic2", canvasClick, [250, 600]);
if (UCS) {
  await shoot("ucs", async () => {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })));
  }, [250, 550, 900]);
}

console.log(logs.filter((l) => /error|fail/i.test(l)).slice(0, 20).join("\n") || "no errors");
await browser.close();
