// Scratch driver: static-model screenshots via anim-probe.html from 4 yaws.
//   node probe-shot.mjs <glbUrlPath> <outDir>
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const FILE = process.argv[2];
const OUT = process.argv[3] ?? "/tmp/probeshot";
const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5199";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=400,400"],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`${BASE}/anim-probe.html?file=${encodeURIComponent(FILE)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__READY__, { timeout: 60000 });

// name → arc-rotate alpha: looking from +Z at the model = "front" if nose +Z
const views = { "from+Z": Math.PI / 2, "from-Z": -Math.PI / 2, "from+X": 0, "from-X": Math.PI, top: Math.PI / 2 };
for (const [name, alpha] of Object.entries(views)) {
  await page.evaluate(
    (a, isTop) => {
      const cam = window.scene?.activeCamera ?? window.cam;
      const c = BABYLON.Engine.Instances[0].scenes[0].activeCamera;
      c.alpha = a;
      c.beta = isTop ? 0.05 : Math.PI / 2.2;
    },
    alpha,
    name === "top"
  );
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
}
await browser.close();
