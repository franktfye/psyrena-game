// Checks the practice meter does not overlap the touch skill buttons.
// Usage: PSY_URL=http://host:port/ node tools/practice-mobile-e2e.mjs [out.png]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";
const OUT = process.argv[2] ?? "/tmp/pm.png";
const URL = (process.env.PSY_URL || "http://127.0.0.1:5173/") + "?controls=touch";
const b = await puppeteer.launch({ executablePath:"/usr/bin/chromium", headless:"new",
  args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage();
// iPhone-ish landscape, the orientation the game plays in.
await p.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const res=[]; const check=(n,ok,d="")=>{res.push(ok);console.log(`${ok?"PASS":"FAIL"}  ${n}${d?`  — ${d}`:""}`);};
await p.goto(URL,{waitUntil:"domcontentloaded",timeout:60000});
await p.waitForSelector("#auth",{timeout:20000});
if (await p.$('#auth input[placeholder="username"]')) {
  await p.type('#auth input[placeholder="username"]',USER);
  await p.type('#auth input[type="password"]',PW);
  await p.click("#auth button.cta"); }
await p.waitForFunction(()=>[...document.querySelectorAll("#auth button.cta")].some(x=>/enter/i.test(x.textContent)),{timeout:30000});
await p.evaluate(()=>[...document.querySelectorAll("#auth button.cta")].find(x=>/enter/i.test(x.textContent)).click());
await p.waitForFunction(()=>!document.getElementById("auth"),{timeout:30000});
const booted=()=>document.getElementById("boot")?.classList.contains("done")&&window.psyrena?.manager?.active;
await p.waitForFunction(booted,{timeout:120000});
check("touch scheme active", await p.evaluate(()=>document.body.dataset.controls==="touch"), await p.evaluate(()=>document.body.dataset.controls));
await p.evaluate(()=>window.psyrena.go("practice"));
await p.waitForFunction(booted,{timeout:120000});
await p.waitForFunction(()=>window.psyrena.manager.active.textures.every(t=>t.isReady()),{timeout:60000,polling:1000}).catch(()=>{});
// put some numbers in it so it is at full height
for (let i=0;i<3;i++){ await p.keyboard.press("Digit1"); await new Promise(r=>setTimeout(r,600)); }
await new Promise(r=>setTimeout(r,6000));
const geo = await p.evaluate(()=>{
  const m=document.getElementById("practice-meter");
  if(!m) return null;
  const r=m.getBoundingClientRect();
  const btns=[...document.querySelectorAll("button")].filter(b=>{const x=b.getBoundingClientRect();return x.width>40&&x.height>40;})
    .map(b=>{const x=b.getBoundingClientRect();return {t:(b.textContent||"").trim().slice(0,12),x:Math.round(x.left),y:Math.round(x.top),w:Math.round(x.width),h:Math.round(x.height)};});
  const hit=btns.filter(x=>!(r.right<=x.x||r.left>=x.x+x.w||r.bottom<=x.y||r.top>=x.y+x.h));
  return { meter:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
           vw:innerWidth, vh:innerHeight, buttons:btns.length, overlaps:hit };
});
check("meter exists", Boolean(geo), geo?`${geo.meter.w}x${geo.meter.h} at ${geo.meter.x},${geo.meter.y}`:"missing");
check("anchored to the top", Boolean(geo && geo.meter.y < 20), geo?`top ${geo.meter.y}px`:"");
check("horizontally centred", Boolean(geo && Math.abs((geo.meter.x+geo.meter.w/2)-geo.vw/2) < 6), geo?`centre ${Math.round(geo.meter.x+geo.meter.w/2)} of ${geo.vw/2}`:"");
check("small: under a third of the height", Boolean(geo && geo.meter.h < geo.vh/3), geo?`${geo.meter.h}px of ${geo.vh}px`:"");
check("clear of every touch button", Boolean(geo && geo.overlaps.length===0), geo?(geo.overlaps.map(o=>o.t).join(",")||`checked ${geo.buttons} buttons`):"");
await p.screenshot({path:OUT});
console.log("\n"+OUT);
const bad=res.filter(x=>!x).length;
console.log(`\n${res.length-bad}/${res.length} checks passed`);
await b.close(); process.exit(bad?1:0);
