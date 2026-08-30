// Temporary verification driver — logs in, aims the hub camera, screenshots.
// Usage: node camshot.mjs <out.png> <alpha> <beta> <radius> [tx ty tz]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const [OUT = "/tmp/cam.png", ALPHA = "0.6", BETA = "1.1", RADIUS = "12", TX = "0", TY = "0", TZ = "0"] =
  process.argv.slice(2);
const URL = "http://127.0.0.1:5173/";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-webgpu",
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

try {
  await page.waitForSelector("#auth", { timeout: 20000 });
  const login = await page.$('#auth input[placeholder="username"]');
  if (login) {
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
  const findEnter = () =>
    [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent));
  await page.waitForFunction(findEnter, { timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => /enter/i.test(b.textContent))
      .click();
  });
  await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
} catch (e) {
  logs.push(`[auth] ${e.message}`);
}

await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 120000 }
);

// Wait for every texture to be ready — software GL decodes slowly and a
// half-streamed hub screenshots as white boxes.
await page
  .waitForFunction(
    () => window.psyrena.manager.active.textures.every((t) => t.isReady()),
    { timeout: 60000, polling: 1000 }
  )
  .catch(() => logs.push("[warn] textures not all ready before timeout"));

await page.evaluate(
  (a, b, r, tx, ty, tz) => {
    const s = window.psyrena.manager.active;
    const c = s.activeCamera;
    // Re-assert every frame AFTER the hero controller's tick (observer order
    // is insertion order) — otherwise the follow-cam snaps back to Freud.
    s.onBeforeRenderObservable.add(() => {
      c.alpha = a;
      c.beta = b;
      c.radius = r;
      c.target.set(tx, ty, tz);
    });
  },
  Number(ALPHA), Number(BETA), Number(RADIUS), Number(TX), Number(TY), Number(TZ)
);
await new Promise((r) => setTimeout(r, 6000)); // software GL needs frames to settle
await page.screenshot({ path: OUT });
console.log(OUT);
console.log(logs.filter((l) => !/^\[log\]/.test(l)).slice(0, 15).join("\n") || "(clean)");
await browser.close();
