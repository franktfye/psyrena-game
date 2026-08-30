// Verifies two movement fixes:
//  1. Opening a panel (hero codex) while WASD is held must not leave the hero
//     stuck moving — input clears while a panel is open, and stays cleared.
//  2. The ground magnet parks the hero's soles on the pavement (small
//     deadband), including shortly after a jump lands.
// Usage: PSY_URL=http://host:port/ node tools/stuck-move-e2e.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.PSY_URL || "http://127.0.0.1:5173/";
// Swiftshader renders at ~5 fps here, which halves the dt-capped physics
// rate — so every state check below POLLS for the state instead of sleeping
// a wall-clock guess.
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new",
  args: ["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--window-size=1600,900"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 });
const logs = []; p.on("pageerror", e => logs.push("ERR " + e.message));
await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

const res = []; const check = (n, ok, d = "") => { res.push(ok); console.log(`${ok?"PASS":"FAIL"}  ${n}${d?`  — ${d}`:""}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await p.waitForSelector("#auth", { timeout: 20000 });
if (await p.$('#auth input[placeholder="username"]')) {
  await p.type('#auth input[placeholder="username"]', USER);
  await p.type('#auth input[type="password"]', PW);
  await p.click("#auth button.cta");
}
await p.waitForFunction(() => [...document.querySelectorAll("#auth button.cta")].some(x=>/enter/i.test(x.textContent)), { timeout: 30000 });
await p.evaluate(() => [...document.querySelectorAll("#auth button.cta")].find(x=>/enter/i.test(x.textContent)).click());
await p.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
await p.waitForFunction(() => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active, { timeout: 120000 });
check("village boots", true);

const heroPos = () => p.evaluate(() => {
  const n = window.psyrena.manager.active.transformNodes.find(n => n.name === "freud");
  return n ? { x: n.position.x, z: n.position.z } : null;
});
const dist = (a, b2) => Math.hypot(a.x - b2.x, a.z - b2.z);

// ---- A: plain movement still works ---------------------------------------
// S (backward, toward the camera) — W runs straight into the plaza statue
// collider a few centimetres ahead of the spawn spot.
const a0 = await heroPos();
await p.keyboard.down("s"); await sleep(800); await p.keyboard.up("s"); await sleep(150);
const a1 = await heroPos();
check("S moves the hero", dist(a0, a1) > 0.1, `${dist(a0, a1).toFixed(2)} m`);

// ---- B: panel opened mid-walk must stop movement -------------------------
await p.keyboard.down("w"); await sleep(250);
await p.evaluate(() => document.querySelector("#player-hud img")?.click()); // codex opens, W still down
await sleep(250);
check("codex is open", await p.evaluate(() => Boolean(document.getElementById("hero-codex"))));
const b0 = await heroPos(); await sleep(600); const b1 = await heroPos();
check("movement stops while the codex is open", dist(b0, b1) < 0.02, `${dist(b0, b1).toFixed(3)} m over 0.6 s`);
await p.keyboard.up("w"); // release while the panel is still open
await p.keyboard.press("Escape"); await sleep(250);
check("codex closed", await p.evaluate(() => !document.getElementById("hero-codex")));
const b2 = await heroPos(); await sleep(700); const b3 = await heroPos();
check("hero is NOT stuck moving after close", dist(b2, b3) < 0.02, `${dist(b2, b3).toFixed(3)} m over 0.7 s`);

// ---- C: ground gap -------------------------------------------------------
// The idle "greeting" clip gestures (a foot can lift), so a single snapshot
// over-reads the gap. Sample for a while and judge the BEST moment — the
// servo's job is that the neutral stance touches the pavement.
const groundErr = () => p.evaluate(() => {
  const scene = window.psyrena.manager.active;
  const wrapper = scene.transformNodes.find(n => n.name === "freud");
  const body = wrapper.getChildMeshes().find(m => m.getTotalVertices?.() > 0);
  body.refreshBoundingInfo(true, false);
  return body.getBoundingInfo().boundingBox.minimumWorld.y - wrapper.absolutePosition.y;
});
const settledErr = async (samples = 10, gapMs = 200) => {
  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const e = await groundErr();
    if (Math.abs(e) < Math.abs(best)) best = e;
    await sleep(gapMs);
  }
  return best;
};
await sleep(1500); // let the 5 Hz servo settle at idle
const e0 = await settledErr();
check("standing soles sit on the pavement", Math.abs(e0) < 0.012, `${(e0 * 100).toFixed(1)} cm`);

const heroY = () => p.evaluate(() => window.psyrena.manager.active.transformNodes.find(n => n.name === "freud").position.y);
await p.keyboard.press(" "); // jump
let rose = false;
try {
  await p.waitForFunction(() => {
    const n = window.psyrena.manager.active.transformNodes.find(n => n.name === "freud");
    return n.position.y > 0.1;
  }, { timeout: 5000, polling: 50 });
  rose = true;
} catch { /* never left the ground */ }
check("jump leaves the ground", rose);
await p.waitForFunction(() => {
  const n = window.psyrena.manager.active.transformNodes.find(n => n.name === "freud");
  return n.position.y === 0;
}, { timeout: 8000, polling: 50 });
check("jump state fully returned to ground", Math.abs(await heroY()) < 0.001);
await sleep(1200); // land recovery + servo re-settle
const e1 = await settledErr();
check("soles back on the pavement after landing", Math.abs(e1) < 0.012, `${(e1 * 100).toFixed(1)} cm`);

console.log(logs.slice(0, 5).join("\n") || "(no page errors)");
const bad = res.filter(x => !x).length;
console.log(`\n${res.length - bad}/${res.length} checks passed`);
await b.close();
process.exit(bad ? 1 : 0);
