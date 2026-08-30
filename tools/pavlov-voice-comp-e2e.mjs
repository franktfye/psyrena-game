/**
 * Targeted e2e for the Pavlov VO pack + the queue comp tip (dev tool).
 *
 *  - hub idle VO: after ~8 s at rest the chat shows `Pavlov muses: "…"` and
 *    the client fetched an idle mp3 from /assets/heroes/voice/pavlov/
 *  - hub cast VO: pressing "1" (UCS) fetches cast_ucs.mp3
 *  - comp tip: frank (pavlov) + jung (pavlov) in one party → the rooms panel
 *    warns about the doubled tank, and the queue button stays enabled
 *
 * ⚠️ RUN WITH `CHROME_GPU=1`. The idle-VO check is NOT reliable without it,
 * and the failure looks like a product bug rather than a harness one: the hero
 * controller clamps its tick to `dt = Math.min(0.1, …)` (the standard
 * spiral-of-death guard), so under software GL at ~2 fps idle time accrues at
 * 0.2 s per real second. The 8 s idle threshold then needs ~40 s of wall clock
 * and the 12 s wait below reports "no `Pavlov muses:` caption" on a hub that is
 * working perfectly. On the real GPU it fires on schedule.
 *
 * Run: npx vite --port 5199 &  then  E2E_URL=http://localhost:5199/ CHROME_GPU=1 node tools/pavlov-voice-comp-e2e.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5199/";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/psyrena-voice-comp-e2e";
mkdirSync(SHOTS, { recursive: true });

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(username, password) {
  const res = await fetch(`${URL.replace(/\/$/, "")}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`${username} login -> ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function api(cookie, path, body) {
  const res = await fetch(`${URL.replace(/\/$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

const gpuArgs = process.env.CHROME_GPU
  ? ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan"]
  : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--window-size=1280,800", ...gpuArgs],
  defaultViewport: { width: 1280, height: 800 },
});

let page;
try {
  page = await browser.newPage();
  const voiceHits = [];
  page.on("response", (r) => {
    if (r.url().includes("/assets/heroes/voice/pavlov/")) {
      voiceHits.push({ url: r.url().split("/").pop(), status: r.status() });
    }
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[page error]", m.text());
  });

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ---- auth: frank → Pavlov → enter ---------------------------------------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await Promise.all([
    page.waitForSelector("#auth .hero", { timeout: 15_000 }),
    page.click("#auth button.cta"),
  ]);
  const pavlovTile = await page.evaluateHandle(() => {
    const tiles = [...document.querySelectorAll("#auth .hero")];
    return tiles.find((t) => t.textContent?.includes("Pavlov")) ?? null;
  });
  await pavlovTile.asElement().click();
  await sleep(300);
  const enter = await page.evaluateHandle(() => {
    return [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent ?? "")) ?? null;
  });
  await enter.asElement().click();
  await page.waitForFunction(() => window.psyrena?.profile !== undefined, { timeout: 240_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("UCS")),
    { timeout: 60_000 }
  );
  console.log("village: booted as Pavlov");

  // Any stale room/queue from other runs would hide the lobby flow.
  await page.evaluate(async () => {
    await fetch("/api/rooms/leave", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await fetch("/api/queue/leave", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  });

  // ---- idle VO: stand still, expect the musing + the mp3 fetch -------------
  await sleep(12_000);
  const mused = await page.evaluate(() => /Pavlov muses:/.test(document.body.textContent ?? ""));
  if (!mused) fail("no `Pavlov muses:` caption in the page after 12 s at rest");
  const idleHit = voiceHits.find((h) => h.url.startsWith("idle_"));
  if (!idleHit) fail(`no idle mp3 fetched — voice hits: ${JSON.stringify(voiceHits)}`);
  else if (![200, 206].includes(idleHit.status)) fail(`idle mp3 ${idleHit.url} -> ${idleHit.status}`);
  console.log(`idle VO: caption + ${idleHit?.url} (${idleHit?.status})`);

  // ---- cast VO: press 1 (UCS) → cast_ucs.mp3 -------------------------------
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })));
  await sleep(1_200);
  const castHit = voiceHits.find((h) => h.url.startsWith("cast_ucs"));
  if (!castHit) fail(`no cast_ucs mp3 fetched — voice hits: ${JSON.stringify(voiceHits)}`);
  else if (![200, 206].includes(castHit.status)) fail(`cast mp3 -> ${castHit.status}`);
  console.log(`cast VO: ${castHit?.url} (${castHit?.status})`);
  await page.screenshot({ path: `${SHOTS}/1-village-voice.png` });

  // ---- comp tip: frank + jung, both Pavlov = 2 tanks -----------------------
  const jung = await apiLogin("jung", "psyrena123");
  await api(jung, "/api/rooms/leave", {}).catch(() => {});
  await api(jung, "/api/queue/leave", {}).catch(() => {});
  await api(jung, "/api/select-hero", { hero: "pavlov" });
  await page.evaluate(async () => {
    const post = (p, b) =>
      fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    await post("/api/rooms/create", { name: "Comp Tip E2E", isPublic: false });
    await post("/api/rooms/invite", { username: "jung" });
  });
  const lobby = await api(jung, "/api/lobby");
  const invite = lobby.invites.find((i) => i.roomName === "Comp Tip E2E");
  if (!invite) throw new Error("jung never saw the invite");
  await api(jung, "/api/rooms/join", { roomId: invite.roomId });

  await page.click('[aria-label="Boss Queue"]');
  // One 2.5 s poll cycle so the panel sees jung in the party.
  await page.waitForFunction(
    () => /Comp tip:/.test(document.body.textContent ?? ""),
    { timeout: 15_000 }
  );
  const tip = await page.evaluate(() => {
    const m = (document.body.textContent ?? "").match(/Comp tip:[^.]*\.[^.]*\./);
    return m?.[0] ?? null;
  });
  if (!/2 tanks/.test(tip ?? "")) fail(`comp tip text unexpected: ${tip}`);
  console.log("comp tip:", tip);
  const queueEnabled = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Queue as Party/.test(x.textContent ?? ""));
    return b ? !b.disabled : null;
  });
  if (queueEnabled !== true) fail("Queue as Party button missing or disabled — the tip must never gate");
  console.log("queue button: enabled (tip is advisory)");
  await page.screenshot({ path: `${SHOTS}/2-comp-tip.png` });

  console.log(process.exitCode ? "VOICE+COMP TEST FAILED" : "VOICE + COMP TIP: ALL CHECKS PASSED");
} catch (e) {
  process.exitCode = 1;
  console.error("DRIVER ERROR:", e.message);
  if (page) await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
