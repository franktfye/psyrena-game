// Scratch driver: contact sheets for every animation group in a GLB via the
// anim-probe.html scratch page. One PNG per clip: 2 camera rows x 6 pose cols.
//   node tools/anim-contact-sheet.mjs [glbUrlPath] [outDir]
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const FILE = process.argv[2] ?? "/assets/work/pavlov/pavlov_animation.glb";
const OUT = process.argv[3] ?? "/tmp/animprobe";
const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5173";
const POSES = 6;

fs.mkdirSync(OUT, { recursive: true });

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
    "--window-size=300,380",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 300, height: 380 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

await page.goto(`${BASE}/anim-probe.html?file=${encodeURIComponent(FILE)}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__READY__, { timeout: 60000 });
const groups = await page.evaluate(() => window.__GROUPS__);
console.log("groups:", JSON.stringify(groups));

const times = Array.from({ length: POSES }, (_, i) => i / (POSES - 1));
const alphas = [-Math.PI / 2 + 0.6, 0]; // three-quarter front, side

for (const g of groups) {
  const dataUrl = await page.evaluate(
    (name, times, alphas) => window.__SHEET__(name, times, alphas),
    g.name, times, alphas
  );
  const safe = g.name.replace(/[^\w.-]/g, "_");
  fs.writeFileSync(`${OUT}/${safe}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log("wrote", `${OUT}/${safe}.png`);
}

await browser.close();
