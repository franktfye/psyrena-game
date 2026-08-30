import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium", headless: "new",
  args: ["--no-sandbox","--enable-gpu","--ignore-gpu-blocklist","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("done"), { timeout: 90000 });
const out = await page.evaluate(() => {
  const eng = window.psyrena.engine;
  const caps = eng.getCaps();
  const cache = eng.getLoadedTexturesCache();
  const byFmt = {};
  let uncompressedBytes = 0, bc7Bytes = 0;
  for (const t of cache) {
    const f = t.format ?? "undefined";
    byFmt[f] = (byFmt[f] ?? 0) + 1;
    let px = t.width * t.height * (t.generateMipMaps ? 4/3 : 1) * (t.isCube ? 6 : 1);
    uncompressedBytes += px * 4;
    bc7Bytes += px * 1;
  }
  return {
    s3tc: !!caps.s3tc, bptc: !!caps.bptc, etc2: !!caps.etc2, astc: !!caps.astc,
    textureCount: cache.length,
    formatHistogram: byFmt,
    ifAllUncompressedMB: +(uncompressedBytes/1048576).toFixed(1),
    ifAllBC7MB: +(bc7Bytes/1048576).toFixed(1),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
