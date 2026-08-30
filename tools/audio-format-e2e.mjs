/**
 * Audio format E2E — proves the browser can actually DECODE the shipped
 * Opus-in-WebM, not merely fetch it.
 *
 * A 200 on every URL says nothing about playability: a container the browser
 * refuses lands as `error` on the element, and every playback path in this game
 * swallows that into silence (playSfx's catch, the voice helper's onerror
 * fallthrough). So this checks readiness and decoded duration per file, plus
 * canPlayType for the container itself.
 *
 * Covers one file from each encoder path — OST, hero VO, boss VO, SFX — since
 * they use different bitrates and channel counts.
 *
 * Usage: E2E_URL=http://localhost:5173 node tools/audio-format-e2e.mjs
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};

const SAMPLES = [
  ["OST (96k stereo)", "/assets/village/ost/firelight_1.webm"],
  ["OST boss (96k stereo)", "/assets/bosses/ost/siege_triumph.webm"],
  ["hero VO (24k mono)", "/assets/heroes/voice/idle_01.webm"],
  ["hero VO pavlov", "/assets/heroes/voice/pavlov/cast_cs.webm"],
  ["hero VO skinner", "/assets/heroes/voice/skinner/cast_shaping.webm"],
  ["boss VO void", "/assets/bosses/voice/start_activate.webm"],
  ["boss VO memory", "/assets/bosses/voice/stage_adult_laugh.webm"],
  ["SFX (48k)", "/assets/sfx/eldritch-blast-001.webm"],
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });

const support = await page.evaluate(() => ({
  webmOpus: document.createElement("audio").canPlayType('audio/webm; codecs="opus"'),
  oggOpus: document.createElement("audio").canPlayType('audio/ogg; codecs="opus"'),
}));
check(support.webmOpus === "probably" || support.webmOpus === "maybe",
  `canPlayType audio/webm;codecs=opus -> "${support.webmOpus}"`);
console.log(`  (audio/ogg;codecs=opus -> "${support.oggOpus}" — the container Safari refuses)`);

for (const [label, url] of SAMPLES) {
  const r = await page.evaluate(
    (u) =>
      new Promise((resolve) => {
        const a = new Audio(u);
        const done = (v) => resolve(v);
        a.onloadedmetadata = () =>
          done({ ok: true, duration: a.duration, readyState: a.readyState });
        a.onerror = () =>
          done({ ok: false, code: a.error?.code, message: a.error?.message ?? "" });
        setTimeout(() => done({ ok: false, message: "timeout" }), 15000);
        a.load();
      }),
    BASE + url
  );
  check(
    r.ok && Number.isFinite(r.duration) && r.duration > 0.1,
    `${label}: ${r.ok ? `decoded, ${r.duration.toFixed(2)}s` : `FAILED (${r.message || "code " + r.code})`} — ${url}`
  );
}

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall audio decodes");
