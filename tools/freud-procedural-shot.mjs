// Capture driver for public/freud-procedural.html — same launch flags as tools/probe/camshot.mjs.
// Usage: node /tmp/freud-shot.mjs <out.png> [query] [waitMs] [click]
//   query  e.g. "anim=walk&phase=0.25"
//   click  optional element id to click before shooting (e.g. "a-stop", "glb")
import puppeteer from "puppeteer-core";

const [OUT = "/tmp/freud.png", QUERY = "", WAIT = "4000", CLICK = ""] = process.argv.slice(2);
const URL = "http://localhost:5173/freud-procedural.html" + (QUERY ? "?" + QUERY : "");

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

await page.waitForFunction(() => window.freudViewer?.ready === true, { timeout: 120000, polling: 500 });
if (CLICK) {
  await page.click("#" + CLICK);
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, Number(WAIT))); // software GL needs frames to settle
const info = await page.evaluate(() => ({
  verts: window.freudViewer.vertexCount,
  joints: window.freudViewer.jointCount,
  anim: window.freudViewer.controller.active,
  status: document.getElementById("status").textContent,
}));
await page.screenshot({ path: OUT });
console.log(OUT);
console.log(JSON.stringify(info));
console.log(logs.filter((l) => !/^\[log\]/.test(l)).slice(0, 15).join("\n") || "(clean)");
await browser.close();
