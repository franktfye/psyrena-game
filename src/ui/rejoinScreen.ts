/**
 * "Your fight is still going." — the one screen a reload mid-fight sees after
 * login, in place of the intro guide and the hero picker (authFlow.ts). Lazy:
 * every login asks the server, almost none need this, and the boot chunk is a
 * ratchet (CLAUDE.md rule 2).
 */
import { enterFullscreen } from "./fullscreen";
import { setArenaRejoin, type RejoinInfo } from "../fight/rejoin";
import { setPracticeMode } from "../fight/practice";
import { DIFFICULTY_ORDER, setDifficulty, type FightDifficulty } from "../fight/difficulty";
import { setPendingRun } from "../survival/pending";

/**
 * Walk back into the fight (main.ts, after the auth flow). No admission gate —
 * this is the seat the player already holds (the server treats a re-begin as
 * the same entry) — and no practice flag may leak into it.
 */
export async function enterRejoin(info: RejoinInfo, go: (id: "arena" | "kowloon") => Promise<void>): Promise<void> {
  if (info.kind === "boss") {
    setPracticeMode(false);
    if ((DIFFICULTY_ORDER as readonly string[]).includes(info.difficulty)) setDifficulty(info.difficulty as FightDifficulty);
    setArenaRejoin(info);
    await go("arena");
  } else {
    setPendingRun(info.difficulty as "lucid" | "deep" | "terror", { session: info.session });
    await go("kowloon");
  }
}

/** What the server says this player can walk back into (GET /api/rejoin), or null. Never throws. */
export async function fetchRejoin(): Promise<RejoinInfo | null> {
  try {
    const res = await fetch("/api/rejoin", { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as { kind: string | null };
    return body.kind === "boss" || body.kind === "survival" ? (body as RejoinInfo) : null;
  } catch {
    return null;
  }
}

/** Give the seat up instead: the same post a normal exit makes. */
async function abandon(info: RejoinInfo): Promise<void> {
  await fetch(info.kind === "boss" ? "/api/fight/sim/end" : "/api/survival/leave", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}

function el(tag: string, cls: string, text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

/**
 * Resolves true to go back in, false when the player gives the seat up (the
 * normal exit — a boss fight already in combat counts that as leaving it).
 * Reuses the intro guide's styles (authFlow.ts CSS), so it looks like the
 * screen it replaces. The tap is kept on purpose: fullscreen and audio need a
 * gesture on phones, which the picker's Enter used to provide.
 */
export function rejoinScreen(root: HTMLElement, info: RejoinInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const what = info.kind === "boss" ? "Your boss fight is still going" : "Your Dream Siege is still going";
    const back = el("button", "cta", "Return to the fight") as HTMLButtonElement;
    back.type = "button";
    const leave = el("button", "", "Leave it and go to the village") as HTMLButtonElement;
    leave.type = "button";
    leave.style.cssText =
      "font:inherit;font-size:12px;letter-spacing:.12em;color:#b8a878;background:none;border:0;text-decoration:underline;cursor:pointer;padding:6px";
    back.addEventListener("click", () => {
      // Synchronously in the tap, as the picker's Enter does.
      if (document.body.dataset.controls === "touch") void enterFullscreen();
      resolve(true);
    });
    leave.addEventListener("click", async () => {
      leave.disabled = back.disabled = true;
      await abandon(info);
      resolve(false);
    });
    const page = el("div", "intro");
    page.append(el("div", "ittl gold-text", "WELCOME BACK"), el("div", "isub", what.toUpperCase()), back, leave);
    root.classList.add("wow");
    root.replaceChildren(page);
    back.focus();
  });
}
