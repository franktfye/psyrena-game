// Intro-guide verification driver — the one-page guide between login and the
// hero picker: renders with its three Civitai icons, shows the right controls
// card per input mode, Continue lands on the picker, and the old #keys legend
// is gone from the document.
// Usage: node introcheck.mjs   (PSYRENA_URL to override the target)
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5199/";
const OUT = process.env.INTRO_OUT ?? ".";
const logs = [];

function watch(page, tag) {
  page.on("console", (m) => logs.push(`[${tag} ${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[${tag} pageerror] ${e.message}`));
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--disable-features=WebGPU", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function toIntro(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#auth", { timeout: 20000 });
  const loginForm = await page.$('#auth input[placeholder="username"]');
  if (loginForm) {
    await page.type('#auth input[placeholder="username"]', USER);
    await page.type('#auth input[type="password"]', PW);
    await page.click("#auth button.cta");
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll("#auth button.cta")].some((b) => /continue/i.test(b.textContent)),
    { timeout: 30000 }
  );
  // All three card icons decoded (not 404/placeholder).
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll("#auth .gcard img")];
      return imgs.length === 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    },
    { timeout: 15000 }
  );
}

const fail = [];
try {
  // ---- desktop -------------------------------------------------------------
  {
    const page = await browser.newPage();
    watch(page, "desktop");
    await page.setViewport({ width: 1600, height: 900 });
    await toIntro(page, BASE);
    const kws = await page.evaluate(() => document.querySelector("#auth .intro").textContent);
    if (!/wasd/i.test(kws)) fail.push("desktop intro missing keyboard keywords");
    if (await page.$("#keys")) fail.push("#keys legend still in document");
    await page.screenshot({ path: `${OUT}/intro-desktop.png` });
    await page.click("#auth .intro .cta");
    await page.waitForFunction(
      () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
      { timeout: 15000 }
    );
    await page.screenshot({ path: `${OUT}/picker-after-intro.png` });
    await page.close();
  }
  // ---- touch, phone landscape ---------------------------------------------
  {
    const page = await browser.newPage();
    watch(page, "touch");
    await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
    await toIntro(page, `${BASE}?controls=touch`);
    const kws = await page.evaluate(() => document.querySelector("#auth .intro").textContent);
    if (!/left stick/i.test(kws)) fail.push("touch intro missing touch keywords");
    if (/wasd/i.test(kws)) fail.push("touch intro leaks keyboard keywords");
    await page.screenshot({ path: `${OUT}/intro-touch.png` });
    await page.close();
  }
} finally {
  await browser.close();
}

const errs = logs.filter((l) => /error|pageerror/.test(l) && !/favicon/.test(l));
if (errs.length) { console.log("console errors:"); for (const e of errs) console.log(" ", e); }
if (fail.length) { console.log("FAIL:"); for (const f of fail) console.log(" ", f); process.exit(1); }
console.log("introcheck OK");
