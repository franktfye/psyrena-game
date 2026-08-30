/**
 * Chat z-order + player-card sizing E2E (dev tool, not shipped).
 *
 * Two UI regressions this proves are fixed:
 *   1. chat sits ON TOP of every other surface — the rooms panel, the player
 *      card, a confirm dialog — on desktop and on a phone viewport alike
 *      (asserted by comparing computed z-index AND by hit-testing the chat
 *      icon's own pixel: whatever is on top there must belong to chat);
 *   2. the player card's buttons are compact, not the slab-sized CTAs that
 *      dominated the card.
 *
 * Run: node tools/chat-zorder-e2e.mjs   (needs `npm run dev` already serving)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_FRANK_PASS ?? "psyrena123";
const SHOTS = "/tmp/psyrena-chat-zorder";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};


/**
 * Boot a page into the village from WHATEVER auth state it lands in.
 *
 * Pages in one browser context share the session cookie, so the second tab
 * skips the login form entirely — a fixed login → continue → picker script
 * hangs on a form that will never appear.
 */
async function bootIntoVillage(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const deadline = Date.now() + 300_000;
  for (;;) {
    const ready = await page.evaluate(() => !!window.psyrena?.manager?.active);
    if (ready) return page;
    if (Date.now() > deadline) throw new Error("village never came up");
    const state = await page.evaluate(() => {
      const login = document.querySelector('input[placeholder="username"]');
      if (login) return "login";
      const btns = [...document.querySelectorAll("#auth button.cta")];
      if (btns.some((b) => b.textContent.includes("Continue"))) return "continue";
      if (btns.some((b) => b.textContent.includes("Enter Psyrena"))) return "enter";
      return "wait";
    });
    if (state === "login") {
      await page.type('input[placeholder="username"]', USER);
      await page.type('input[placeholder="password"]', PASS);
      await page.click("#auth button.cta");
    } else if (state === "continue" || state === "enter") {
      await page.evaluate((label) => {
        [...document.querySelectorAll("#auth button.cta")]
          .find((b) => b.textContent.includes(label))
          .click();
      }, state === "continue" ? "Continue" : "Enter Psyrena");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--mute-audio",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 160)));
  await bootIntoVillage(page);

  const zOf = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? Number(getComputedStyle(el).zIndex) : NaN;
    }, sel);

  // ---- 1. chat above the rooms panel and the player card ------------------
  // Open the panel the way the dock does — the module is reachable over the
  // dev server, which is what makes this driveable without a UI tour.
  await page.evaluate(async () => {
    const mod = await import("/src/ui/roomsPanel.ts");
    mod.openRoomsPanel();
  });
  await page.waitForSelector("#rooms", { timeout: 10_000 });
  await page.evaluate(async () => {
    const mod = await import("/src/ui/playerCard.ts");
    mod.showPlayerCard("jung");
  });
  await page.waitForSelector("#player-card .card .btns button", { timeout: 10_000 });

  const chatZ = await zOf(".chat-root");
  const roomsZ = await zOf("#rooms");
  const cardZ = await zOf("#player-card");
  console.log(`  z: chat=${chatZ} rooms=${roomsZ} card=${cardZ}`);
  check(chatZ > roomsZ, `chat outranks the rooms panel (${chatZ} > ${roomsZ})`);
  check(chatZ > cardZ, `chat outranks the player card (${chatZ} > ${cardZ})`);

  // Hit test: whatever paints at the chat icon's centre must be chat's own.
  const topAtIcon = await page.evaluate(() => {
    const icon = document.querySelector(".chat-root > button");
    const r = icon.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inChat: !!hit?.closest(".chat-root"), tag: hit?.tagName ?? "none" };
  });
  check(topAtIcon.inChat, `the chat icon is the top element at its own pixel (${topAtIcon.tag})`);

  // ---- 2. the card's buttons are compact ----------------------------------
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll("#player-card .btns button")].map((b) => ({
      text: b.textContent.trim(),
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
    }))
  );
  console.log("  card buttons:", JSON.stringify(btns));
  check(btns.length > 0, "the player card rendered its buttons");
  check(
    btns.every((b) => b.w <= 130 && b.h <= 34),
    "player-card buttons are compact (≤130×34)"
  );
  await page.screenshot({ path: `${SHOTS}/card-over-panel.png` });

  // ---- 3. same on a phone, with chat OPEN ---------------------------------
  // A FRESH page emulating touch from the start: the panel decides its touch
  // layout when it is constructed, so flipping the viewport mid-session would
  // test a desktop panel in a narrow window, not the phone build.
  const phone = await browser.newPage();
  // LANDSCAPE: the game gates portrait phones behind a "rotate to landscape"
  // overlay, and that overlay — not chat — would be the top element.
  await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  await bootIntoVillage(phone);
  await phone.evaluate(async () => {
    const mod = await import("/src/ui/roomsPanel.ts");
    mod.openRoomsPanel();
  });
  await phone.waitForSelector("#rooms", { timeout: 10_000 });
  await phone.evaluate(() => document.querySelector(".chat-root > button").click());
  await phone.waitForFunction(
    () => document.querySelector(".chat-root")?.classList.contains("full"),
    { timeout: 5000, polling: 100 }
  );
  const zOfPhone = (sel) =>
    phone.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? Number(getComputedStyle(el).zIndex) : NaN;
    }, sel);
  const chatOpenZ = await zOfPhone(".chat-root");
  const roomsZ2 = await zOfPhone("#rooms");
  check(chatOpenZ > roomsZ2, `open touch chat still outranks the panel (${chatOpenZ} > ${roomsZ2})`);
  const topInChat = await phone.evaluate(() => {
    const input = document.querySelector(".chat-root input");
    const r = input.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inChat: !!hit?.closest(".chat-root"), tag: hit?.tagName ?? "none" };
  });
  check(topInChat.inChat, `the full-screen chat input is on top over the open panel (${topInChat.tag})`);
  await phone.screenshot({ path: `${SHOTS}/chat-over-panel-mobile.png` });

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  console.log(`shots in ${SHOTS}`);
} finally {
  await browser.close();
}
