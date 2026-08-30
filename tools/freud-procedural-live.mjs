// Live-walk proof: click Walk, take two frames ~300ms apart, diff material.
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox","--enable-gpu","--ignore-gpu-blocklist","--enable-unsafe-webgpu",
    "--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--window-size=1600,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:5173/freud-procedural.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.freudViewer?.ready === true, { timeout: 120000, polling: 500 });
await page.click("#a-walk");
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: "/tmp/freud-live-a.png" });
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: "/tmp/freud-live-b.png" });
const anim = await page.evaluate(() => window.freudViewer.controller.active);
console.log("anim:", anim);
console.log(logs.filter((l) => !/^\[log\]/.test(l)).slice(0, 15).join("\n") || "(clean)");
await browser.close();
