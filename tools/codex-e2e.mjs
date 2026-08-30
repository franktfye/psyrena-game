// Verifies the skill hover bubble and the hero codex behind the avatar.
// Usage: PSY_URL=http://host:port/ node tools/codex-e2e.mjs [out.png]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUT = process.argv[2] ?? "/tmp/codex.png";
const URL = process.env.PSY_URL || "http://127.0.0.1:5173/";
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new",
  args: ["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--window-size=1600,900"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 });
const logs = []; p.on("pageerror", e => logs.push("ERR " + e.message));
await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

const res = []; const check = (n, ok, d = "") => { res.push(ok); console.log(`${ok?"PASS":"FAIL"}  ${n}${d?`  — ${d}`:""}`); };

await p.waitForSelector("#auth", { timeout: 20000 });
if (await p.$('#auth input[placeholder="username"]')) {
  await p.type('#auth input[placeholder="username"]', USER);
  await p.type('#auth input[type="password"]', PW);
  await p.click("#auth button.cta");
}
await p.waitForFunction(() => [...document.querySelectorAll("#auth button.cta")].some(x=>/enter/i.test(x.textContent)), { timeout: 30000 });
await p.evaluate(() => [...document.querySelectorAll("#auth button.cta")].find(x=>/enter/i.test(x.textContent)).click());
await p.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
const booted = () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active;
await p.waitForFunction(booted, { timeout: 120000 });
check("village boots", true);

// ---- hover bubble --------------------------------------------------------
const slot = await p.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find(x => /oral/i.test(x.textContent || "")));
const box = await slot.asElement()?.boundingBox();
check("palette button found", Boolean(box));
if (box) {
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise(r => setTimeout(r, 500));
}
const tip = await p.evaluate(() => {
  const el = document.getElementById("skill-tip");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { on: el.classList.contains("on"), text: el.innerText.replace(/\n+/g," | "),
           onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
});
check("hover opens the bubble", Boolean(tip && tip.on), tip ? tip.text.slice(0, 70) : "no element");
check("bubble has the numbers line", Boolean(tip && /253/.test(tip.text)), tip ? (tip.text.match(/253[^|]*/)??[""])[0].slice(0,40) : "");
check("bubble has how to use", Boolean(tip && /HOW TO USE/.test(tip.text)));
check("bubble stays on screen", Boolean(tip && tip.onScreen));
check("no dash characters in bubble copy", Boolean(tip && !/[—–]/.test(tip.text)), tip ? (tip.text.match(/[—–].{0,20}/)??["clean"])[0] : "");
await p.screenshot({ path: OUT.replace(/\.png$/, "-tooltip.png") });

// ---- codex ---------------------------------------------------------------
await p.mouse.move(5, 5);
await p.evaluate(() => document.querySelector("#player-hud img")?.click());
await new Promise(r => setTimeout(r, 500));
const codex = await p.evaluate(() => {
  const el = document.getElementById("hero-codex");
  return el ? { text: el.innerText.replace(/\n+/g," | "), tabs: [...el.querySelectorAll(".tabs button")].map(b=>b.textContent) } : null;
});
check("avatar click opens the codex", Boolean(codex), codex ? codex.tabs.join(",") : "not opened");
check("has character intro", Boolean(codex && /The Analyst/.test(codex.text)));

const tabText = async (label) => {
  await p.evaluate((l) => [...document.querySelectorAll("#hero-codex .tabs button")].find(b=>b.textContent===l)?.click(), label);
  await new Promise(r => setTimeout(r, 350));
  return p.evaluate(() => document.querySelector("#hero-codex .body").innerText.replace(/\n+/g," | "));
};
const man = await tabText("THE MAN");
check("has the real Freud", /1856 to 1939/.test(man) && /psychoanalysis/i.test(man));
check("states evidence status", /Historical/i.test(man));
const skills = await tabText("SKILLS");
check("skills tab lists all five", ["Id, Ego, Superego","Psychosexual","Defense Mechanism","Free Association","Dream Analysis"].every(n=>skills.includes(n)));
const qn = await p.evaluate(() => document.querySelectorAll("#hero-codex .skill .qbtn").length);
check("each skill carries a ? popup", qn === 5, `${qn}/5`);
await p.evaluate(() => document.querySelector("#hero-codex .skill .qbtn")?.click());
await new Promise(r => setTimeout(r, 300));
const popTxt = await p.evaluate(() => document.getElementById("codex-pop")?.innerText.replace(/\n+/g," | ") ?? "");
check("skill popup says how to use", /HOW TO USE/.test(popTxt), popTxt.slice(0, 50));
const stats = await tabText("STATS");
await p.screenshot({ path: OUT });
check("stats show attributes", /Health/.test(stats) && /Mitigation/.test(stats) && /Clarity/.test(stats));
check("stats show the damage terms", /Base/.test(stats) && /Marks/.test(stats) && /Gear/.test(stats) && /Format/.test(stats));
check("stats show live effects section", /EFFECTS ON YOU/.test(stats));
check("stats flag unwired stats honestly", /Coming later/.test(stats));

// ---- system tab: music + voice controls ----------------------------------
const system = await tabText("SYSTEM");
await p.screenshot({ path: OUT.replace(/\.png$/, "-system.png") });
check("system tab shows music and voice rows", /MUSIC/.test(system) && /Track/.test(system) && /Voice lines/.test(system));
const toggle = async (i) => p.evaluate((ix) => [...document.querySelectorAll("#hero-codex .sys-toggle")][ix]?.click(), i);
const key = async (k) => p.evaluate((kk) => localStorage.getItem(kk), k);
await toggle(0);
check("music toggle persists the mute key", (await key("psyrena.musicMuted")) === "1");
await toggle(0);
check("music toggle clears the mute key", (await key("psyrena.musicMuted")) === null);
const pick = async (v) => p.evaluate((val) => {
  const s = document.querySelector("#hero-codex .sys-select");
  s.value = val; s.dispatchEvent(new Event("change"));
}, v);
const opts = await p.evaluate(() => [...document.querySelectorAll("#hero-codex .sys-select option")].map(o => o.value));
check("dropdown lists auto + all eight tracks", opts.length === 9 && opts[0] === "", `${opts.length} options`);
check("pick-only tracks are offered", opts.includes("drafts_in_my_phone") && opts.includes("kinetic_glass_loop_origin"));
await pick("kinetic_glass_loop");
check("track pick persists", (await key("psyrena.musicTrack")) === "kinetic_glass_loop");
await pick("drafts_in_my_phone");
check("pick-only track pick persists", (await key("psyrena.musicTrack")) === "drafts_in_my_phone");
await pick("");
check("auto clears the track key", (await key("psyrena.musicTrack")) === null);
await toggle(1);
check("voice toggle works from system tab", (await key("psyrena.voiceMuted")) === "1");
await toggle(1);
check("voice toggle clears the key", (await key("psyrena.voiceMuted")) === null);

const all = [...(codex?.text ?? ""), man, skills, stats, system].join(" ");
check("no dash characters anywhere in codex copy", !/[—–]/.test(all), (all.match(/[—–].{0,24}/)??["clean"])[0]);

console.log("\n" + OUT);
console.log(logs.slice(0,5).join("\n") || "(no page errors)");
const bad = res.filter(x=>!x).length;
console.log(`\n${res.length - bad}/${res.length} checks passed`);
await b.close();
process.exit(bad ? 1 : 0);
