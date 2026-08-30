// Codex UI verification: opens the hero codex, screenshots the Skills tab,
// a ? popup, and the Stats tab. Reuses hudcheck.mjs's login flow.
// Usage: node codexcheck.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5173/";
const OUT = process.env.OUT_DIR ?? "/tmp";

const MOBILE = process.argv.includes("--mobile");
// Phones are gated to landscape by the rotate overlay, so the mobile codex
// is verified in the form factor it will actually be used in.
const VIEW = MOBILE
  ? { width: 844, height: 390, isMobile: true, hasTouch: true }
  : { width: 1400, height: 900 };
const TAG = MOBILE ? "codex-m" : "codex";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--disable-features=WebGPU",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    `--window-size=${VIEW.width},${VIEW.height}`,
  ],
});

const page = await browser.newPage();
await page.setViewport(VIEW);
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#auth", { timeout: 20000 });
const loginForm = await page.$('#auth input[placeholder="username"]');
if (loginForm) {
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
  () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click();
});
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });

// Open the codex by clicking the player-frame portrait.
await page.waitForSelector(".player-frame, #player-hud", { timeout: 30000 }).catch(() => {});
await page.evaluate(() => {
  const portrait = document.querySelector("img[alt], .portrait, #player-hud img");
  (portrait ?? document.querySelector("#player-hud")).dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForSelector("#hero-codex", { timeout: 10000 });

const tab = async (label) => {
  await page.evaluate((l) => {
    [...document.querySelectorAll("#hero-codex .tabs button")]
      .find((b) => b.textContent.trim() === l)
      ?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 300));
};

await tab("SKILLS");
await page.screenshot({ path: `${OUT}/${TAG}-skills.png` });

// Open the ? popup on the first skill.
await page.evaluate(() => document.querySelector("#hero-codex .skill .qbtn")?.click());
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${OUT}/${TAG}-skills-pop.png` });

await tab("STATS");
await page.screenshot({ path: `${OUT}/${TAG}-stats.png` });

// Open a stats ? popup.
await page.evaluate(() => document.querySelector("#hero-codex .shead .qbtn")?.click());
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${OUT}/${TAG}-stats-pop.png` });

const errs = logs.filter((l) => l.startsWith("[pageerror]") || l.startsWith("[error]"));
console.log(errs.length ? errs.join("\n") : "no page errors");
await browser.close();
