// Scratch driver for petprobe.html: screenshot every pet clip with the
// follower's yaw applied, next to the red expected-facing arrow.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petprobe.mjs <outdir>
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const OUTDIR = process.argv[2] ?? "/tmp/petprobe";
const URL = (process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/").replace(/\/$/, "");
mkdirSync(OUTDIR, { recursive: true });

const QUARTER = Math.PI / 2;
// file, follower yaw (modelYaw as tick applies it), label
const MODELS = [
  ["pet_robot.glb", 0, "robot-static"],
  ["pet_robot_walk.glb", -QUARTER, "robot-walk"],
  ["pet_corgi.glb", Math.PI, "corgi"],
  ["pet_husky.glb", Math.PI, "husky"],
  ["pet_black_cat.glb", Math.PI, "blackcat"],
  ["pet_dinosaur.glb", Math.PI, "dino"],
  ["pet_unicorn.glb", Math.PI, "unicorn"],
  ["pet_druzhok_idle.glb", Math.PI, "druzhok-idle"],
  ["pet_druzhok_walk.glb", Math.PI, "druzhok-walk"],
];

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
    "--window-size=900,900",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${URL}/tools/probe/petprobe.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.probeReady === true, { timeout: 60000 });

for (const [file, yaw, label] of MODELS) {
  const clips = await page.evaluate((f, y) => window.probeLoad(f, y), file, yaw);
  console.log(label, "clips:", JSON.stringify(clips));
  for (const clip of [null, ...clips]) {
    const cn = clip ?? "rest";
    await page.evaluate((c) => window.probeClip(c), clip);
    await page.evaluate(() => window.probeCam("top"));
    await new Promise((r) => setTimeout(r, clip ? 700 : 300));
    await page.screenshot({ path: `${OUTDIR}/${label}-${cn}-top.png` });
    await page.evaluate(() => window.probeCam("side"));
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: `${OUTDIR}/${label}-${cn}-side.png` });
  }
}
const noise = logs.filter((l) => !/^\[log\]|^\[debug\]|^\[info\]/.test(l)).slice(0, 8);
if (noise.length) console.log("console:", noise.join("\n"));
console.log("done ->", OUTDIR);
await browser.close();
